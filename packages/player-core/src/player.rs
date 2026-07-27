use std::{
    collections::VecDeque,
    fmt::Debug,
    fs::File,
    io::{Cursor, Read, Seek},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
    time::Duration,
};

use super::fft_player::FFTPlayer;
use crate::{
    AudioPlayerEventSender, AudioPlayerMessageReceiver, AudioPlayerMessageSender, AudioThreadEvent,
    AudioThreadEventMessage, AudioThreadMessage, SongData, audio_quality::AudioQuality,
    ffmpeg_decoder::FFmpegDecoder, media_controls::SystemMediaManager,
};
use anyhow::Context;
use cpal::traits::{DeviceTrait as _, HostTrait as _, StreamTrait as _};
use now_playing_controls::model::{NowPlayingOptions, SystemMediaEvent};
use parking_lot::RwLock as ParkingLotRwLock;
use ringbuf::traits::Consumer;
use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock as TokioRwLock, mpsc::UnboundedReceiver, watch};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

pub struct AudioPlayer {
    evt_sender: AudioPlayerEventSender,
    msg_sender: AudioPlayerMessageSender,
    msg_receiver: AudioPlayerMessageReceiver,

    cpal_device: cpal::Device,
    cpal_config: cpal::StreamConfig,
    current_stream: Option<cpal::Stream>,
    cpal_state: CpalCallbackState,
    target_channels: u16,
    target_sample_rate: u32,

    is_playing_tx: watch::Sender<bool>,
    is_playing_rx: watch::Receiver<bool>,
    current_song_token: Option<CancellationToken>,
    cancel_token: CancellationToken,

    media_manager: Arc<SystemMediaManager>,
    current_decoder_handle: Option<FFmpegDecoder>,
    volume: f32,
    current_song: Option<SongData>,
    current_playback_id: String,
    current_audio_info: Arc<TokioRwLock<AudioInfo>>,
    current_audio_quality: Arc<TokioRwLock<AudioQuality>>,
    playback_state: Arc<ParkingLotRwLock<PlaybackState>>,
    npc_event_rx: UnboundedReceiver<SystemMediaEvent>,
    fft_player: Arc<ParkingLotRwLock<FFTPlayer>>,
}

#[derive(Clone, Debug)]
pub struct CpalCallbackState {
    pub volume_bits: Arc<AtomicU32>,
    pub loudness_gain_bits: Arc<AtomicU32>,
    pub track_finished: Arc<AtomicBool>,
    pub consumed_frames: Arc<AtomicU64>,
}

impl Default for CpalCallbackState {
    fn default() -> Self {
        Self {
            volume_bits: Arc::new(AtomicU32::new(1.0_f32.to_bits())),
            loudness_gain_bits: Arc::new(AtomicU32::new(1.0_f32.to_bits())),
            track_finished: Arc::new(AtomicBool::new(false)),
            consumed_frames: Arc::new(AtomicU64::new(0)),
        }
    }
}

const TARGET_TRACK_LOUDNESS_LUFS: f32 = -12.0;
const MIN_TRACK_GAIN_DB: f32 = -18.0;
const MAX_TRACK_GAIN_DB: f32 = 8.0;
const MAX_TRACK_GAIN: f32 = 2.511_886_4;
const NORMALIZED_PEAK_CEILING: f32 = 0.891_250_9;
const TRACK_GAIN_RISE_MS: f32 = 250.0;
const TRACK_GAIN_FALL_MS: f32 = 50.0;
const PEAK_LIMITER_LOOKAHEAD_MS: u32 = 5;
const PEAK_LIMITER_ATTACK_MS: f32 = 1.0;
const PEAK_LIMITER_RELEASE_MS: f32 = 100.0;
const PEAK_LIMITER_SCRATCH_MS: u32 = 100;

fn loudness_normalization_gain(enabled: bool, integrated_loudness_lufs: Option<f64>) -> f32 {
    if !enabled {
        return 1.0;
    }

    let Some(loudness) = integrated_loudness_lufs
        .map(|value| value as f32)
        .filter(|value| value.is_finite())
    else {
        return 1.0;
    };

    let gain_db =
        (TARGET_TRACK_LOUDNESS_LUFS - loudness).clamp(MIN_TRACK_GAIN_DB, MAX_TRACK_GAIN_DB);
    10.0_f32.powf(gain_db / 20.0)
}

fn smoothing_coefficient(time_ms: f32, sample_rate: u32) -> f32 {
    1.0 - (-1_000.0 / (time_ms * sample_rate.max(1) as f32)).exp()
}

fn frames_for_duration(sample_rate: u32, duration_ms: u32) -> usize {
    ((u64::from(sample_rate) * u64::from(duration_ms)).div_ceil(1_000)) as usize
}

struct OutputGainState {
    current_track_gain: f32,
    track_gain_rise_coefficient: f32,
    track_gain_fall_coefficient: f32,
}

impl OutputGainState {
    fn sanitize_target_gain(target_track_gain: f32) -> f32 {
        if target_track_gain.is_finite() {
            target_track_gain.clamp(0.0, MAX_TRACK_GAIN)
        } else {
            1.0
        }
    }

    fn new(sample_rate: u32, initial_track_gain: f32) -> Self {
        Self {
            current_track_gain: Self::sanitize_target_gain(initial_track_gain),
            track_gain_rise_coefficient: smoothing_coefficient(TRACK_GAIN_RISE_MS, sample_rate),
            track_gain_fall_coefficient: smoothing_coefficient(TRACK_GAIN_FALL_MS, sample_rate),
        }
    }

    fn is_unity(&self, target_track_gain: f32) -> bool {
        self.current_track_gain == 1.0 && target_track_gain == 1.0
    }

    fn advance_frame(&mut self, target_track_gain: f32) -> f32 {
        let target_track_gain = Self::sanitize_target_gain(target_track_gain);
        let track_coefficient = if target_track_gain < self.current_track_gain {
            self.track_gain_fall_coefficient
        } else {
            self.track_gain_rise_coefficient
        };
        self.current_track_gain +=
            (target_track_gain - self.current_track_gain) * track_coefficient;
        if (target_track_gain - self.current_track_gain).abs() < 1.0e-6 {
            self.current_track_gain = target_track_gain;
        }
        self.current_track_gain
    }
}

/// Channel-linked limiter that looks ahead inside the already-buffered CPAL
/// callback block. This avoids adding playback latency while keeping all
/// scratch storage outside the real-time callback.
struct LinkedBlockLimiter {
    current_gain: f32,
    attack_coefficient: f32,
    release_coefficient: f32,
    lookahead_frames: usize,
    frame_peaks: Vec<f32>,
    future_peaks: Vec<f32>,
    peak_queue: VecDeque<(usize, f32)>,
}

impl LinkedBlockLimiter {
    fn new(sample_rate: u32) -> Self {
        let lookahead_frames = frames_for_duration(sample_rate, PEAK_LIMITER_LOOKAHEAD_MS).max(1);
        let scratch_frames =
            frames_for_duration(sample_rate, PEAK_LIMITER_SCRATCH_MS).max(lookahead_frames + 1);
        Self {
            current_gain: 1.0,
            attack_coefficient: smoothing_coefficient(PEAK_LIMITER_ATTACK_MS, sample_rate),
            release_coefficient: smoothing_coefficient(PEAK_LIMITER_RELEASE_MS, sample_rate),
            lookahead_frames,
            frame_peaks: vec![0.0; scratch_frames],
            future_peaks: vec![0.0; scratch_frames],
            peak_queue: VecDeque::with_capacity(lookahead_frames + 1),
        }
    }

    fn process_block(&mut self, samples: &mut [f32], channel_count: usize, enforce_ceiling: bool) {
        if !enforce_ceiling && self.current_gain == 1.0 {
            return;
        }

        let channel_count = channel_count.max(1);
        if !enforce_ceiling {
            for frame in samples.chunks_mut(channel_count) {
                self.release_gain();
                self.apply_gain(frame);
            }
            return;
        }

        let chunk_samples = self.frame_peaks.len().saturating_mul(channel_count);
        for chunk in samples.chunks_mut(chunk_samples.max(channel_count)) {
            self.process_limited_chunk(chunk, channel_count);
        }
    }

    fn process_limited_chunk(&mut self, samples: &mut [f32], channel_count: usize) {
        let frame_count = samples.len().div_ceil(channel_count);
        for (frame_index, frame) in samples.chunks_mut(channel_count).enumerate() {
            let mut frame_peak = 0.0_f32;
            for sample in frame {
                if sample.is_finite() {
                    frame_peak = frame_peak.max(sample.abs());
                } else {
                    *sample = 0.0;
                }
            }
            self.frame_peaks[frame_index] = frame_peak;
        }

        // A monotonic queue gives every frame the maximum peak in its forward
        // lookahead window in amortized O(1), without allocating in the callback.
        self.peak_queue.clear();
        let mut next_frame = 0;
        for frame_index in 0..frame_count {
            while self
                .peak_queue
                .front()
                .is_some_and(|(queued_frame, _)| *queued_frame < frame_index)
            {
                self.peak_queue.pop_front();
            }

            let window_end = (frame_index + self.lookahead_frames).min(frame_count - 1);
            while next_frame <= window_end {
                let peak = self.frame_peaks[next_frame];
                while self
                    .peak_queue
                    .back()
                    .is_some_and(|(_, queued_peak)| *queued_peak <= peak)
                {
                    self.peak_queue.pop_back();
                }
                self.peak_queue.push_back((next_frame, peak));
                next_frame += 1;
            }
            self.future_peaks[frame_index] = self.peak_queue.front().map_or(0.0, |(_, peak)| *peak);
        }

        for (frame_index, frame) in samples.chunks_mut(channel_count).enumerate() {
            let required_gain = Self::gain_for_peak(self.future_peaks[frame_index]);
            if required_gain < self.current_gain {
                self.current_gain += (required_gain - self.current_gain) * self.attack_coefficient;
            } else {
                self.release_gain();
                self.current_gain = self.current_gain.min(required_gain);
            }

            let hard_bound = Self::gain_for_peak(self.frame_peaks[frame_index]);
            // Callback boundaries cannot see the next block, so the current-frame
            // bound remains an instantaneous safety net for boundary transients.
            self.current_gain = self.current_gain.min(hard_bound);
            self.apply_gain(frame);
        }
    }

    fn gain_for_peak(peak: f32) -> f32 {
        if peak > NORMALIZED_PEAK_CEILING {
            NORMALIZED_PEAK_CEILING / peak
        } else {
            1.0
        }
    }

    fn release_gain(&mut self) {
        if self.current_gain != 1.0 {
            self.current_gain += (1.0 - self.current_gain) * self.release_coefficient;
            if (1.0 - self.current_gain).abs() < 1.0e-6 {
                self.current_gain = 1.0;
            }
        }
    }

    fn apply_gain(&self, frame: &mut [f32]) {
        if self.current_gain != 1.0 {
            for sample in frame {
                *sample = (*sample * self.current_gain)
                    .clamp(-NORMALIZED_PEAK_CEILING, NORMALIZED_PEAK_CEILING);
            }
        }
    }
}

#[derive(Default, Debug)]
pub struct PlaybackState {
    pub base_time_sec: f64,
    pub samples_counter: Option<Arc<AtomicU64>>,
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub name: String,
    pub artist: String,
    pub album: String,
    pub lyric: String,
    #[serde(skip)]
    pub cover_media_type: String,
    #[serde(skip)]
    pub cover: Option<Vec<u8>>,
    pub duration: f64,
}

impl Debug for AudioInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioInfo")
            .field("name", &self.name)
            .field("artist", &self.artist)
            .field("album", &self.album)
            .field("lyric", &self.lyric)
            .field("cover_media_type", &self.cover_media_type)
            .field("cover", &self.cover.as_ref().map(|x| x.len()))
            .field("duration", &self.duration)
            .finish()
    }
}

pub trait CustomMediaSource: Read + Seek + Send + 'static {}
impl<T: Read + Seek + Send + 'static> CustomMediaSource for T {}

pub struct AudioPlayerConfig {
    pub media_controls_options: NowPlayingOptions,
}

impl AudioPlayer {
    pub fn new(
        config: AudioPlayerConfig,
        evt_sender: AudioPlayerEventSender,
    ) -> anyhow::Result<Self> {
        let (msg_sender, msg_receiver) = tokio::sync::mpsc::unbounded_channel();

        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .context("未找到系统默认音频输出设备")?;

        let default_config = device.default_output_config()?;
        let target_channels = default_config.channels();
        let target_sample_rate = default_config.sample_rate();
        let cpal_config: cpal::StreamConfig = default_config.into();

        info!(
            "初始化 Cpal 音频设备: {}, 声道数: {}, 采样率: {}",
            device.description()?.name(),
            target_channels,
            target_sample_rate
        );

        let current_audio_info = Arc::new(TokioRwLock::new(AudioInfo::default()));
        let current_audio_quality = Arc::new(TokioRwLock::new(AudioQuality::default()));
        let fft_player = Arc::new(ParkingLotRwLock::new(FFTPlayer::new(target_sample_rate)));
        let playback_state = Arc::new(ParkingLotRwLock::new(PlaybackState::default()));
        let cpal_state = CpalCallbackState::default();

        let (manager_instance, npc_event_rx) =
            SystemMediaManager::spawn(Some(config.media_controls_options));
        let media_manager = Arc::new(manager_instance);

        let (is_playing_tx, is_playing_rx) = watch::channel(false);
        let mut is_playing_rx_for_timeline = is_playing_rx.clone();

        let audio_info_reader = current_audio_info.clone();
        let emitter_pos = AudioPlayerEventEmitter::new(evt_sender.clone());
        let media_manager_for_task = media_manager.clone();
        let playback_state_for_timeline = playback_state.clone();
        let cancel_token = CancellationToken::new();
        let timeline_token = cancel_token.clone();

        tokio::task::spawn(async move {
            let mut time_it = tokio::time::interval(Duration::from_secs(1));

            loop {
                if !*is_playing_rx_for_timeline.borrow() {
                    tokio::select! {
                        _ = timeline_token.cancelled() => { break; }
                        res = is_playing_rx_for_timeline.changed() => {
                            if res.is_err() { break; }
                            continue;
                        }
                    }
                }

                tokio::select! {
                    _ = timeline_token.cancelled() => break,
                    res = is_playing_rx_for_timeline.changed() => {
                        if res.is_err() {
                            break;
                        }

                        continue;
                    }
                    _ = time_it.tick() => {
                        let (base_time, counter_clone) = {
                            let state = playback_state_for_timeline.read();
                            (state.base_time_sec, state.samples_counter.clone())
                        };

                        let duration = audio_info_reader.read().await.duration;
                        if duration > 0.0 {
                            let played_time = if let Some(counter) = &counter_clone {
                                let samples = counter.load(Ordering::Relaxed) as f64;
                                let rate = target_sample_rate as f64;
                                let ch = target_channels as f64;
                                samples / (rate * ch)
                            } else {
                                0.0
                            };

                            let local_current_pos = (base_time + played_time).min(duration);

                            let _ = emitter_pos
                                .emit(AudioThreadEvent::PlayPosition {
                                    position: local_current_pos,
                                })
                                .await;

                            media_manager_for_task.update_timeline(local_current_pos, duration);
                        }
                    }
                }
            }
        });

        Ok(Self {
            evt_sender,
            msg_sender,
            msg_receiver,
            cpal_device: device,
            cpal_config,
            current_stream: None,
            cpal_state,
            target_channels,
            target_sample_rate,
            is_playing_tx,
            is_playing_rx,
            current_song_token: None,
            cancel_token,
            media_manager,
            current_decoder_handle: None,
            volume: 1.0,
            current_song: None,
            current_playback_id: String::new(),
            current_audio_info,
            current_audio_quality,
            playback_state,
            npc_event_rx,
            fft_player,
        })
    }

    pub fn handler(&self) -> AudioPlayerHandle {
        AudioPlayerHandle::new(self.msg_sender.clone())
    }

    fn emitter(&self) -> AudioPlayerEventEmitter {
        AudioPlayerEventEmitter::new(self.evt_sender.clone())
    }

    pub async fn run(mut self) {
        let mut check_end_interval = tokio::time::interval(Duration::from_millis(50));

        loop {
            tokio::select! {
                biased;
                msg = self.msg_receiver.recv() => {
                    if let Some(msg) = msg {
                        if let Some(AudioThreadMessage::Close) = &msg.data { break; }
                        if let Err(err) = self.process_message(msg).await {
                            warn!("处理音频线程消息时出错：{err:?}");
                        }
                    } else { break; }
                },
                msg = self.npc_event_rx.recv() => {
                    if let Some(event) = msg {
                        self.media_manager
                            .handle_event(event, &self.handler(), &self.evt_sender)
                            .await;
                    }
                },
                _ = check_end_interval.tick() => {
                    if self.cpal_state.track_finished.load(Ordering::Acquire) && self.current_song.is_some() {
                        let music_id = self
                            .current_song
                            .as_ref()
                            .map(SongData::get_id)
                            .unwrap_or_default();
                        let playback_id = self.current_playback_id.clone();
                        self.current_stream = None;

                        {
                            let mut state = self.playback_state.write();
                            state.base_time_sec = 0.0;
                        }

                        self.current_song = None;

                        self.cpal_state
                            .track_finished
                            .store(false, Ordering::Release);

                        let _ = self.is_playing_tx.send(false);

                        if let Err(e) = self
                            .emitter()
                            .emit(AudioThreadEvent::TrackEnded {
                                music_id,
                                playback_id,
                            })
                            .await
                        {
                            warn!("发送 TrackEnded 事件失败：{e:?}");
                        }
                    }
                }
            }
        }
    }

    pub async fn process_message(
        &mut self,
        msg: AudioThreadEventMessage<AudioThreadMessage>,
    ) -> anyhow::Result<()> {
        let emitter = self.emitter();
        if let Some(ref data) = msg.data {
            match data {
                AudioThreadMessage::ResumeAudio => {
                    if let Some(stream) = &self.current_stream {
                        let _ = stream.play();
                    }
                    let _ = self.is_playing_tx.send(true);
                    self.media_manager.update_play_state(true);
                    let _ = emitter
                        .emit(AudioThreadEvent::PlayStatus { is_playing: true })
                        .await;
                }
                AudioThreadMessage::PauseAudio => {
                    if let Some(stream) = &self.current_stream {
                        let _ = stream.pause();
                    }
                    let _ = self.is_playing_tx.send(false);
                    self.media_manager.update_play_state(false);
                    let _ = emitter
                        .emit(AudioThreadEvent::PlayStatus { is_playing: false })
                        .await;
                }
                AudioThreadMessage::ResumeOrPauseAudio => {
                    let is_playing_now = !*self.is_playing_rx.borrow();

                    if let Some(stream) = &self.current_stream {
                        if is_playing_now {
                            let _ = stream.play();
                        } else {
                            let _ = stream.pause();
                        }
                    }

                    let _ = self.is_playing_tx.send(is_playing_now);
                    self.media_manager.update_play_state(is_playing_now);
                    let _ = emitter
                        .emit(AudioThreadEvent::PlayStatus {
                            is_playing: is_playing_now,
                        })
                        .await;
                }
                AudioThreadMessage::SeekAudio { position } => {
                    if let Some(handle) = &self.current_decoder_handle {
                        let seek_pos = Duration::from_secs_f64(*position);

                        if handle.seek(seek_pos).is_err() {
                            warn!("发送跳转命令失败, 解码器可能已关闭");
                        } else {
                            self.cpal_state
                                .track_finished
                                .store(false, Ordering::Release);
                            self.cpal_state.consumed_frames.store(0, Ordering::Release);

                            let fft_player_clone = self.fft_player.clone();
                            tokio::task::spawn_blocking(move || {
                                fft_player_clone.write().clear();
                            })
                            .await?;

                            let is_playing = *self.is_playing_rx.borrow();
                            {
                                let mut state = self.playback_state.write();
                                state.base_time_sec = *position;
                                if let Some(counter) = &state.samples_counter {
                                    counter.store(0, Ordering::SeqCst);
                                }
                            }

                            self.media_manager.update_play_state(is_playing);
                        }
                    } else {
                        warn!("找不到解码器句柄, 无法执行跳转");
                    }
                }
                AudioThreadMessage::PlayAudio {
                    song,
                    loudness_normalization,
                    playback_id,
                    start_paused,
                } => {
                    let initial_track_gain =
                        loudness_normalization
                            .as_ref()
                            .map_or(1.0, |normalization| {
                                loudness_normalization_gain(
                                    normalization.enabled,
                                    normalization.integrated_loudness_lufs,
                                )
                            });
                    self.cpal_state
                        .loudness_gain_bits
                        .store(initial_track_gain.to_bits(), Ordering::Release);
                    self.cpal_state
                        .track_finished
                        .store(false, Ordering::Release);
                    self.current_song = Some(song.clone());
                    self.current_playback_id = playback_id.clone().unwrap_or_default();
                    self.start_playing_song(true, *start_paused).await?;
                }
                AudioThreadMessage::SetVolume { volume } => {
                    self.volume = (*volume as f32).clamp(0.0, 1.0);
                    self.cpal_state
                        .volume_bits
                        .store(self.volume.to_bits(), Ordering::Relaxed);

                    let _ = emitter
                        .emit(AudioThreadEvent::VolumeChanged {
                            volume: self.volume as f64,
                        })
                        .await;
                }
                AudioThreadMessage::SetLoudnessNormalization {
                    music_id,
                    enabled,
                    integrated_loudness_lufs,
                    sample_peak: _,
                } => {
                    let is_current_song = self
                        .current_song
                        .as_ref()
                        .is_some_and(|song| song.get_id() == *music_id);
                    if is_current_song {
                        let target_gain =
                            loudness_normalization_gain(*enabled, *integrated_loudness_lufs);
                        self.cpal_state
                            .loudness_gain_bits
                            .store(target_gain.to_bits(), Ordering::Release);
                    }
                }
                AudioThreadMessage::SetFFTRange { from_freq, to_freq } => {
                    let fft_player_clone = self.fft_player.clone();
                    let (from_freq, to_freq) = (*from_freq, *to_freq);
                    tokio::task::spawn_blocking(move || {
                        fft_player_clone.write().set_freq_range(from_freq, to_freq);
                    })
                    .await?;
                }
                AudioThreadMessage::SetMediaControlsEnabled { enabled } => {
                    self.media_manager.set_enabled(*enabled);
                }
                AudioThreadMessage::StopAudio => {
                    self.current_stream = None;

                    {
                        let mut state = self.playback_state.write();
                        state.base_time_sec = 0.0;
                    }
                    let _ = self.is_playing_tx.send(false);
                    self.media_manager.update_play_state(false);
                    let _ = emitter
                        .emit(AudioThreadEvent::PlayStatus { is_playing: false })
                        .await;
                }
                AudioThreadMessage::ToggleShuffle => {
                    let _ = emitter
                        .emit(AudioThreadEvent::HardwareMediaCommand {
                            command: "toggleShuffle".into(),
                        })
                        .await;
                }
                AudioThreadMessage::ToggleRepeat => {
                    let _ = emitter
                        .emit(AudioThreadEvent::HardwareMediaCommand {
                            command: "toggleRepeat".into(),
                        })
                        .await;
                }
                AudioThreadMessage::SetPlaybackRate { rate } => {
                    self.media_manager.update_playback_rate(*rate);
                }
                AudioThreadMessage::UpdatePlayMode {
                    is_shuffling,
                    repeat_mode,
                } => {
                    self.media_manager
                        .update_play_mode(*is_shuffling, *repeat_mode);
                }
                _ => {}
            }
        }
        emitter.ret_none(msg).await?;
        Ok(())
    }

    async fn start_playing_song(
        &mut self,
        clear_sink: bool,
        start_paused: bool,
    ) -> anyhow::Result<()> {
        if clear_sink {
            self.current_stream = None;
            self.current_decoder_handle = None;
            let fft_player_clone = self.fft_player.clone();
            tokio::task::spawn_blocking(move || {
                fft_player_clone.write().clear();
            })
            .await?;
        }

        let song_data = self.current_song.clone().context("没有当前歌曲可播放")?;

        self.emitter()
            .emit(AudioThreadEvent::LoadingAudio {
                music_id: song_data.get_id(),
            })
            .await?;

        let source_stream: Box<dyn CustomMediaSource> =
            if song_data.file_path.starts_with("http://") || song_data.file_path.starts_with("https://") {
                let bytes = reqwest::get(&song_data.file_path)
                    .await
                    .with_context(|| format!("下载 {} 失败", song_data.file_path))?
                    .bytes()
                    .await
                    .with_context(|| format!("读取 {} 响应失败", song_data.file_path))?;
                Box::new(Cursor::new(bytes.to_vec()))
            } else {
                let file = File::open(&song_data.file_path)
                    .with_context(|| format!("打开 {} 失败", song_data.file_path))?;
                Box::new(file)
            };

        let target_channels = self.target_channels;
        let target_sample_rate = self.target_sample_rate;

        let source_result = tokio::task::spawn_blocking(move || {
            FFmpegDecoder::spawn(source_stream, target_channels, target_sample_rate)
        })
        .await?;

        let spawned = source_result?;
        self.current_decoder_handle = Some(spawned.handle);
        {
            let mut state = self.playback_state.write();
            state.samples_counter = Some(spawned.samples_counter);
            state.base_time_sec = 0.0;
        }
        let info = spawned.source.audio_info();
        let quality = spawned.source.audio_quality();

        *self.current_audio_info.write().await = info.clone();
        *self.current_audio_quality.write().await = quality.clone();

        let mut audio_iter = spawned.source;
        let cpal_state_clone = self.cpal_state.clone();

        cpal_state_clone
            .track_finished
            .store(false, Ordering::Release);
        cpal_state_clone.consumed_frames.store(0, Ordering::Release);
        cpal_state_clone
            .volume_bits
            .store(self.volume.to_bits(), Ordering::Relaxed);

        let channels = target_channels as u64;
        let channel_count = usize::from(target_channels).max(1);
        let initial_track_gain =
            f32::from_bits(cpal_state_clone.loudness_gain_bits.load(Ordering::Acquire));
        let mut output_gain_state = OutputGainState::new(target_sample_rate, initial_track_gain);
        let mut peak_limiter = LinkedBlockLimiter::new(target_sample_rate);

        let stream = self.cpal_device.build_output_stream(
            &self.cpal_config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let current_volume =
                    f32::from_bits(cpal_state_clone.volume_bits.load(Ordering::Relaxed));
                let target_track_gain =
                    f32::from_bits(cpal_state_clone.loudness_gain_bits.load(Ordering::Acquire));
                let mut eof_reached = false;
                let mut local_consumed_samples = 0;
                let unity_gain = output_gain_state.is_unity(target_track_gain);
                let mut enforce_peak_ceiling = false;

                for frame in data.chunks_mut(channel_count) {
                    let track_gain = if unity_gain {
                        1.0
                    } else {
                        output_gain_state.advance_frame(target_track_gain)
                    };
                    enforce_peak_ceiling |= track_gain != 1.0;
                    for sample in frame.iter_mut() {
                        if let Some(s) = audio_iter.next() {
                            let adjusted_sample = s * track_gain;
                            *sample = if adjusted_sample.is_finite() {
                                adjusted_sample
                            } else {
                                0.0
                            };
                            local_consumed_samples += 1;
                        } else {
                            *sample = 0.0;
                            eof_reached = true;
                        }
                    }
                }

                peak_limiter.process_block(data, channel_count, enforce_peak_ceiling);
                if current_volume != 1.0 {
                    for sample in data {
                        *sample *= current_volume;
                    }
                }

                if local_consumed_samples > 0 {
                    let frames_played = local_consumed_samples / channels;
                    cpal_state_clone
                        .consumed_frames
                        .fetch_add(frames_played, Ordering::Relaxed);
                }

                if eof_reached {
                    cpal_state_clone
                        .track_finished
                        .store(true, Ordering::Relaxed);
                }
            },
            |err| error!("Cpal 音频流发生错误: {err}"),
            None,
        )?;

        if !start_paused {
            stream.play()?;
        }

        self.current_stream = Some(stream);

        self.spawn_fft_pacemaker(spawned.fft_consumer, target_sample_rate);

        self.media_manager.update_metadata(&info);
        self.media_manager.update_play_state(!start_paused);
        let _ = self.is_playing_tx.send(!start_paused);

        self.emitter()
            .emit(AudioThreadEvent::LoadAudio {
                music_id: song_data.get_id(),
                music_info: Box::new(info),
                quality,
            })
            .await?;
        self.emitter()
            .emit(AudioThreadEvent::PlayStatus {
                is_playing: !start_paused,
            })
            .await?;

        Ok(())
    }

    fn spawn_fft_pacemaker<C>(&mut self, mut fft_consumer: C, target_sample_rate: u32)
    where
        C: Consumer<Item = f32> + Send + 'static,
    {
        if let Some(old_token) = self.current_song_token.take() {
            old_token.cancel();
        }

        let song_token = CancellationToken::new();
        self.current_song_token = Some(song_token.clone());

        let cpal_state_fft = self.cpal_state.clone();
        let fft_player_clone = self.fft_player.clone();
        let emitter_fft = self.emitter();
        let mut is_playing_rx = self.is_playing_rx.clone();

        tokio::task::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(50));
            let mut last_consumed = 0;
            let mut pull_buf = vec![0.0; 4096];

            {
                *fft_player_clone.write() = FFTPlayer::new(target_sample_rate);
            }

            loop {
                if !*is_playing_rx.borrow() {
                    tokio::select! {
                        _ = song_token.cancelled() => break,
                        res = is_playing_rx.changed() => {
                            if res.is_err() { break; }
                            continue;
                        }
                    }
                }

                tokio::select! {
                    _ = song_token.cancelled() => break,
                    res = is_playing_rx.changed() => {
                        if res.is_err() { break; }
                        continue;
                    }
                    _ = interval.tick() => {
                        let current_frames = cpal_state_fft.consumed_frames.load(Ordering::Acquire);
                        let diff = current_frames.saturating_sub(last_consumed) as usize;
                        last_consumed = current_frames;

                        if diff > 0 {
                            let mut pulled_total = 0;
                            while pulled_total < diff {
                                let to_pull = (diff - pulled_total).min(pull_buf.len());
                                let n = fft_consumer.pop_slice(&mut pull_buf[..to_pull]);
                                if n == 0 {
                                    break;
                                }

                                fft_player_clone.write().push_samples(&pull_buf[..n]);
                                pulled_total += n;
                            }

                            let mut fft_result = vec![0.0; 128];
                            if fft_player_clone.write().read(&mut fft_result) {
                                let _ = emitter_fft
                                    .emit(AudioThreadEvent::FFTData { data: fft_result })
                                    .await;
                            }
                        }
                    }
                }
            }
        });
    }
}

impl Drop for AudioPlayer {
    fn drop(&mut self) {
        self.cancel_token.cancel();
        if let Some(token) = &self.current_song_token {
            token.cancel();
        }
    }
}

#[derive(Debug, Clone)]
pub struct AudioPlayerHandle {
    msg_sender: AudioPlayerMessageSender,
}
impl AudioPlayerHandle {
    pub(crate) fn new(msg_sender: AudioPlayerMessageSender) -> Self {
        Self { msg_sender }
    }
    pub async fn send(
        &self,
        msg: AudioThreadEventMessage<AudioThreadMessage>,
    ) -> anyhow::Result<()> {
        self.msg_sender.send(msg)?;
        Ok(())
    }
    pub async fn send_anonymous(&self, msg: AudioThreadMessage) -> anyhow::Result<()> {
        self.msg_sender
            .send(AudioThreadEventMessage::new("".into(), Some(msg)))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bs1770::{ChannelLoudnessMeter, gated_mean, reduce_stereo};

    fn integrated_stereo_loudness(samples: &[f32], sample_rate: u32) -> f32 {
        let mut left = ChannelLoudnessMeter::new(sample_rate);
        let mut right = ChannelLoudnessMeter::new(sample_rate);
        left.push(samples.chunks_exact(2).map(|frame| frame[0]));
        right.push(samples.chunks_exact(2).map(|frame| frame[1]));

        let left_windows = left.into_100ms_windows();
        let right_windows = right.into_100ms_windows();
        let stereo = reduce_stereo(left_windows.as_ref(), right_windows.as_ref());
        gated_mean(stereo.as_ref()).loudness_lkfs()
    }

    fn process_normalized_pcm(
        samples: &[f32],
        sample_rate: u32,
        callback_frames: usize,
        track_gain: f32,
    ) -> Vec<f32> {
        let mut output = samples.to_vec();
        let mut limiter = LinkedBlockLimiter::new(sample_rate);
        for callback in output.chunks_mut(callback_frames * 2) {
            for sample in callback.iter_mut() {
                *sample *= track_gain;
            }
            limiter.process_block(callback, 2, true);
        }
        output
    }

    #[test]
    fn loudness_target_reaches_minus_twelve_lufs_with_safe_gain_bounds() {
        let attenuated = loudness_normalization_gain(true, Some(-10.0));
        let unchanged = loudness_normalization_gain(true, Some(-12.0));
        let boosted = loudness_normalization_gain(true, Some(-24.0));
        let small_town_summer = loudness_normalization_gain(true, Some(-19.272_02));

        assert!((attenuated - 10.0_f32.powf(-2.0 / 20.0)).abs() < 1.0e-6);
        assert_eq!(unchanged, 1.0);
        assert!((boosted - MAX_TRACK_GAIN).abs() < 1.0e-6);
        assert!((small_town_summer - 10.0_f32.powf(7.272_02 / 20.0)).abs() < 1.0e-6);
        assert_eq!(loudness_normalization_gain(false, Some(-10.0)), 1.0);
        assert_eq!(loudness_normalization_gain(true, None), 1.0);
        assert_eq!(loudness_normalization_gain(true, Some(f64::NAN)), 1.0);
    }

    #[test]
    fn peak_limiter_caps_the_first_hot_frame_and_links_all_channels() {
        let mut limiter = LinkedBlockLimiter::new(48_000);
        let mut frame = [1.4, 0.35, -0.7];

        limiter.process_block(&mut frame, 3, true);

        let output_peak = frame
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
        assert!(output_peak <= NORMALIZED_PEAK_CEILING + 1.0e-6);
        assert!(output_peak > 0.8);
        assert!((frame[0] / frame[1] - 4.0).abs() < 1.0e-6);
        assert!((frame[0] / frame[2] + 2.0).abs() < 1.0e-6);
    }

    #[test]
    fn active_peak_limiter_replaces_non_finite_samples_with_silence() {
        let mut limiter = LinkedBlockLimiter::new(48_000);
        let mut samples = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 1.5];

        limiter.process_block(&mut samples, 2, true);

        assert!(samples.iter().all(|sample| sample.is_finite()));
        assert_eq!(samples[0], 0.0);
        assert_eq!(samples[1], 0.0);
        assert_eq!(samples[2], 0.0);
        assert!(samples[3].abs() <= NORMALIZED_PEAK_CEILING + 1.0e-6);
    }

    #[test]
    fn peak_limiter_uses_callback_lookahead_without_delaying_samples() {
        let mut limiter = LinkedBlockLimiter::new(1_000);
        let mut samples = vec![0.1_f32; 16];
        samples[10] = 2.0;
        samples[11] = 1.0;

        limiter.process_block(&mut samples, 2, true);

        assert!(
            samples[0] < 0.1,
            "future peak did not start the attack early"
        );
        assert!(
            samples
                .iter()
                .all(|sample| sample.abs() <= NORMALIZED_PEAK_CEILING + 1.0e-6)
        );
        assert!((samples[10] / samples[11] - 2.0).abs() < 1.0e-6);
        assert_eq!(samples.len(), 16);
    }

    #[test]
    fn peak_limiter_releases_smoothly_and_is_sample_rate_independent() {
        fn gain_after_release(sample_rate: u32, release_frames: u32) -> (f32, f32) {
            let mut limiter = LinkedBlockLimiter::new(sample_rate);
            let mut hot = [2.0, -1.0];
            limiter.process_block(&mut hot, 2, true);
            let reduced_gain = limiter.current_gain;

            for _ in 0..release_frames {
                let mut quiet = [0.1, -0.05];
                limiter.process_block(&mut quiet, 2, true);
            }
            (reduced_gain, limiter.current_gain)
        }

        let (reduced_48k, released_48k) = gain_after_release(48_000, 4_800);
        let (reduced_96k, released_96k) = gain_after_release(96_000, 9_600);

        assert!(released_48k > reduced_48k);
        assert!(released_48k < 1.0);
        assert!((reduced_48k - reduced_96k).abs() < 1.0e-6);
        assert!((released_48k - released_96k).abs() < 1.0e-4);

        let (_, released_after_one_second) = gain_after_release(48_000, 48_000);
        assert!(released_after_one_second > 0.999);
    }

    #[test]
    fn dynamic_limiter_brings_quiet_high_peak_audio_close_to_target_loudness() {
        let sample_rate = 48_000;
        let frame_count = sample_rate as usize * 6;
        let mut input = Vec::with_capacity(frame_count * 2);
        for frame_index in 0..frame_count {
            let phase =
                2.0 * std::f32::consts::PI * 1_000.0 * frame_index as f32 / sample_rate as f32;
            let sample = phase.sin() * 0.1;
            input.extend_from_slice(&[sample, sample]);
        }

        let initial_loudness = integrated_stereo_loudness(&input, sample_rate);
        let calibration_gain = 10.0_f32.powf((-19.5 - initial_loudness) / 20.0);
        for sample in &mut input {
            *sample *= calibration_gain;
        }
        for second in 0..6 {
            let impulse_frame = second * sample_rate as usize + sample_rate as usize / 2;
            input[impulse_frame * 2] = 0.8;
            input[impulse_frame * 2 + 1] = -0.8;
        }

        let input_loudness = integrated_stereo_loudness(&input, sample_rate);
        let track_gain = loudness_normalization_gain(true, Some(input_loudness as f64));
        let output_127 = process_normalized_pcm(&input, sample_rate, 127, track_gain);
        let output_480 = process_normalized_pcm(&input, sample_rate, 480, track_gain);
        let output_loudness_127 = integrated_stereo_loudness(&output_127, sample_rate);
        let output_loudness_480 = integrated_stereo_loudness(&output_480, sample_rate);

        let input_peak = input
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
        let old_static_gain = track_gain.min(NORMALIZED_PEAK_CEILING / input_peak);
        let old_output: Vec<_> = input
            .iter()
            .map(|sample| sample * old_static_gain)
            .collect();
        let old_output_loudness = integrated_stereo_loudness(&old_output, sample_rate);
        let output_peak = output_127
            .iter()
            .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));

        assert!((output_loudness_127 - TARGET_TRACK_LOUDNESS_LUFS).abs() < 0.6);
        assert!(output_peak <= NORMALIZED_PEAK_CEILING + 1.0e-6);
        assert!(output_loudness_127 - old_output_loudness > 4.0);
        assert!((output_loudness_127 - output_loudness_480).abs() < 0.2);
    }

    #[test]
    fn disabled_peak_limiter_preserves_pcm_bits() {
        let mut limiter = LinkedBlockLimiter::new(48_000);
        let mut frame = [0.99_f32, -0.99, 0.25];
        let original = frame.map(f32::to_bits);

        limiter.process_block(&mut frame, 3, false);

        assert_eq!(frame.map(f32::to_bits), original);
        assert_eq!(limiter.current_gain, 1.0);
    }

    #[test]
    fn output_gain_converges_smoothly_without_overshooting() {
        let mut state = OutputGainState::new(48_000, 1.0);
        let target = 10.0_f32.powf(-6.0 / 20.0);
        let mut previous = state.current_track_gain;

        for _ in 0..48_000 {
            let _ = state.advance_frame(target);
            assert!(state.current_track_gain <= previous);
            assert!(state.current_track_gain >= target);
            previous = state.current_track_gain;
        }

        assert!((state.current_track_gain - target).abs() < 0.01);
    }

    #[test]
    fn cached_gain_is_active_from_the_first_frame() {
        let target = 10.0_f32.powf(-6.0 / 20.0);
        let mut state = OutputGainState::new(48_000, target);

        assert_eq!(state.current_track_gain, target);
        assert_eq!(state.advance_frame(target), target);
    }

    #[test]
    fn disabled_normalization_uses_the_unity_fast_path() {
        let state = OutputGainState::new(48_000, 1.0);

        assert!(state.is_unity(1.0));
        assert_eq!(1.25_f32 * 0.8 * state.current_track_gain, 1.0);
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AudioPlayerEventEmitter {
    evt_sender: AudioPlayerEventSender,
}
impl AudioPlayerEventEmitter {
    pub(crate) fn new(evt_sender: AudioPlayerEventSender) -> Self {
        Self { evt_sender }
    }
    pub async fn emit(&self, msg: AudioThreadEvent) -> anyhow::Result<()> {
        self.evt_sender
            .send(AudioThreadEventMessage::new("".into(), Some(msg)))?;
        Ok(())
    }
    pub async fn ret_none(
        &self,
        req: AudioThreadEventMessage<AudioThreadMessage>,
    ) -> anyhow::Result<()> {
        self.evt_sender.send(req.to_none())?;
        Ok(())
    }
}
