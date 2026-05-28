use std::collections::VecDeque;
use std::fs::File;
use std::sync::atomic::AtomicU64;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, Sender, SyncSender},
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::{
    audio_quality::AudioQuality, fft_player::FFTPlayer, player::AudioInfo, utils::build_audio_info,
};
use anyhow::Context;
use ffmpeg_audio::{AudioReader, ResampleOptions, Resampler};
use parking_lot::{Condvar, Mutex, RwLock};
use rodio::Source;
use rodio::source::SeekError;
use tracing::{error, warn};

const FRAME_BUFFER_CAPACITY: usize = 64;
const FFT_TARGET_RATE: u32 = 44100;

struct AudioChunk {
    player_samples: Vec<f32>,
    fft_samples: Vec<f32>,
}

struct Shared {
    buffer: Mutex<VecDeque<AudioChunk>>,
    is_eof: AtomicBool,
    is_stopping: AtomicBool,
    condvar: Condvar,
}

pub enum ControlMessage {
    Seek(Duration),
    Close,
}

struct DecoderMetadata {
    total_duration: Option<Duration>,
    audio_info: AudioInfo,
    audio_quality: AudioQuality,
}

pub struct FFmpegDecoder {
    shared: Arc<Shared>,
    decoder_thread: Option<JoinHandle<()>>,
    control_tx: Sender<ControlMessage>,
    sample_rate: u32,
    channels: u16,
    total_duration: Option<Duration>,
    audio_info: AudioInfo,
    audio_quality: AudioQuality,
    local_buffer: VecDeque<f32>,
    fft_player: Arc<RwLock<FFTPlayer>>,
    samples_played: Arc<AtomicU64>,
}

struct DecoderInitData {
    reader: AudioReader,
    player_resampler: Resampler,
    fft_resampler: Resampler,
    total_duration: Option<Duration>,
    audio_info: AudioInfo,
    audio_quality: AudioQuality,
}

#[derive(Clone)]
pub struct FFmpegDecoderHandle {
    control_tx: Sender<ControlMessage>,
}

impl FFmpegDecoderHandle {
    pub fn seek(&self, pos: Duration) -> Result<(), mpsc::SendError<ControlMessage>> {
        self.control_tx.send(ControlMessage::Seek(pos))
    }
}

impl FFmpegDecoder {
    pub fn new(
        path: String,
        fft_player: Arc<RwLock<FFTPlayer>>,
        target_channels: u16,
        target_sample_rate: u32,
    ) -> anyhow::Result<(Self, FFmpegDecoderHandle, Arc<AtomicU64>)> {
        let shared = Arc::new(Shared {
            buffer: Mutex::new(VecDeque::with_capacity(FRAME_BUFFER_CAPACITY)),
            is_eof: AtomicBool::new(false),
            is_stopping: AtomicBool::new(false),
            condvar: Condvar::new(),
        });

        let (control_tx, control_rx) = mpsc::channel();
        let (init_tx, init_rx) = mpsc::sync_channel(1);

        let decoder_thread = {
            let shared = shared.clone();
            thread::spawn(move || {
                decoder_thread_entry(
                    path,
                    target_channels,
                    target_sample_rate,
                    shared,
                    control_rx,
                    init_tx,
                );
            })
        };

        let metadata = init_rx.recv()??;

        let handle = FFmpegDecoderHandle {
            control_tx: control_tx.clone(),
        };

        let samples_played = Arc::new(AtomicU64::new(0));

        let decoder = Self {
            shared,
            decoder_thread: Some(decoder_thread),
            control_tx,
            sample_rate: target_sample_rate,
            channels: target_channels,
            total_duration: metadata.total_duration,
            audio_info: metadata.audio_info,
            audio_quality: metadata.audio_quality,
            local_buffer: VecDeque::new(),
            fft_player,
            samples_played: samples_played.clone(),
        };

        Ok((decoder, handle, samples_played))
    }

    pub fn audio_info(&self) -> AudioInfo {
        self.audio_info.clone()
    }

    pub fn audio_quality(&self) -> AudioQuality {
        self.audio_quality.clone()
    }
}

fn decoder_thread_entry(
    path: String,
    target_channels: u16,
    target_sample_rate: u32,
    shared: Arc<Shared>,
    control_rx: Receiver<ControlMessage>,
    init_tx: SyncSender<anyhow::Result<DecoderMetadata>>,
) {
    let init_result = setup_decoder_resources(&path, target_channels, target_sample_rate);

    let mut init_data = match init_result {
        Ok(data) => {
            let metadata = DecoderMetadata {
                total_duration: data.total_duration,
                audio_info: data.audio_info.clone(),
                audio_quality: data.audio_quality.clone(),
            };
            if init_tx.send(Ok(metadata)).is_err() {
                return;
            }
            data
        }
        Err(e) => {
            let _ = init_tx.send(Err(e));
            return;
        }
    };

    run_decoding_loop(&mut init_data, shared, &control_rx);
}

fn setup_decoder_resources(
    path: &str,
    target_channels: u16,
    target_sample_rate: u32,
) -> anyhow::Result<DecoderInitData> {
    let file = File::open(path).with_context(|| format!("打开 {path} 文件失败"))?;
    let reader = AudioReader::new(file).with_context(|| format!("初始化音频解码器失败: {path}"))?;

    let total_duration = reader.duration();
    let source_info = reader.source_info().clone();
    let audio_info = build_audio_info(&reader);
    let audio_quality = AudioQuality::from_source_info(&source_info);

    let player_opts = ResampleOptions::new()
        .sample_rate(target_sample_rate.cast_signed())
        .channels(target_channels as i32)
        .format::<f32>();

    let player_resampler = reader
        .build_resampler(player_opts)
        .context("创建播放用重采样器失败")?;

    let fft_opts = ResampleOptions::new()
        .sample_rate(FFT_TARGET_RATE.cast_signed())
        .channels(1)
        .format::<f32>();

    let fft_resampler = reader
        .build_resampler(fft_opts)
        .context("创建 FFT 用重采样器失败")?;

    Ok(DecoderInitData {
        reader,
        player_resampler,
        fft_resampler,
        total_duration,
        audio_info,
        audio_quality,
    })
}

fn run_decoding_loop(
    data: &mut DecoderInitData,
    shared: Arc<Shared>,
    control_rx: &Receiver<ControlMessage>,
) {
    let mut is_eof_reached = false;

    'main_loop: loop {
        if is_eof_reached {
            match control_rx.recv() {
                Ok(ControlMessage::Seek(pos)) => {
                    if execute_seek(data, &shared, pos) {
                        is_eof_reached = false;
                    }
                    continue 'main_loop;
                }
                Ok(ControlMessage::Close) => {
                    break 'main_loop;
                }
                Err(_) => {
                    break 'main_loop;
                }
            }
        } else {
            match control_rx.try_recv() {
                Ok(ControlMessage::Seek(pos)) => {
                    execute_seek(data, &shared, pos);
                    continue 'main_loop;
                }
                Ok(ControlMessage::Close) => {
                    break 'main_loop;
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => {
                    break 'main_loop;
                }
            }
        }

        if shared.is_stopping.load(Ordering::Acquire) {
            break 'main_loop;
        }

        {
            let mut buffer = shared.buffer.lock();
            while buffer.len() >= FRAME_BUFFER_CAPACITY
                && !shared.is_stopping.load(Ordering::Acquire)
            {
                shared.condvar.wait(&mut buffer);
            }

            if shared.is_stopping.load(Ordering::Acquire) {
                break 'main_loop;
            }
        }

        match data.reader.receive_frame() {
            Ok(Some(frame)) => {
                let mut player_samples = Vec::new();
                let mut fft_samples = Vec::new();

                if data
                    .player_resampler
                    .process::<f32>(Some(&frame))
                    .is_ok_and(|has_data| has_data)
                {
                    player_samples.extend_from_slice(data.player_resampler.output_as::<f32>());
                }

                if data
                    .fft_resampler
                    .process::<f32>(Some(&frame))
                    .is_ok_and(|has_data| has_data)
                {
                    fft_samples.extend_from_slice(data.fft_resampler.output_as::<f32>());
                }

                let chunk = AudioChunk {
                    player_samples,
                    fft_samples,
                };

                let mut buffer = shared.buffer.lock();
                buffer.push_back(chunk);
                shared.condvar.notify_one();
            }
            Ok(None) => {
                shared.is_eof.store(true, Ordering::Release);
                shared.condvar.notify_all();
                is_eof_reached = true;
            }
            Err(e) => {
                error!("解码错误: {e}");
                break 'main_loop;
            }
        }
    }
    shared.is_eof.store(true, Ordering::Release);
    shared.condvar.notify_all();
}

fn execute_seek(data: &mut DecoderInitData, shared: &Arc<Shared>, pos: Duration) -> bool {
    if data.reader.seek(pos).is_err() {
        error!("跳转失败");
        return false;
    }
    let _ = data.player_resampler.flush();
    let _ = data.fft_resampler.flush();

    let mut buffer = shared.buffer.lock();
    buffer.clear();
    shared.is_eof.store(false, Ordering::SeqCst);
    shared.condvar.notify_all();
    true
}

impl Iterator for FFmpegDecoder {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(sample) = self.local_buffer.pop_front() {
            self.samples_played.fetch_add(1, Ordering::Relaxed);
            return Some(sample);
        }

        let mut shared_buffer_lock = self.shared.buffer.lock();

        while shared_buffer_lock.is_empty() {
            if self.shared.is_eof.load(Ordering::Acquire)
                || self.shared.is_stopping.load(Ordering::Acquire)
            {
                return None;
            }
            self.shared.condvar.wait(&mut shared_buffer_lock);
        }

        let chunk = shared_buffer_lock.pop_front().unwrap();

        self.shared.condvar.notify_one();
        drop(shared_buffer_lock);

        if !chunk.fft_samples.is_empty()
            && let Some(mut player) = self.fft_player.try_write()
        {
            player.push_samples(&chunk.fft_samples);
        }

        self.local_buffer.extend(chunk.player_samples);

        let sample = self.local_buffer.pop_front();
        if sample.is_some() {
            self.samples_played.fetch_add(1, Ordering::Relaxed);
        }
        sample
    }
}

impl Source for FFmpegDecoder {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> std::num::NonZeroU16 {
        std::num::NonZeroU16::new(self.channels).expect("音频声道数为 0")
    }

    fn sample_rate(&self) -> std::num::NonZeroU32 {
        std::num::NonZeroU32::new(self.sample_rate).expect("音频采样率为 0")
    }

    fn total_duration(&self) -> Option<Duration> {
        self.total_duration
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        if self.control_tx.send(ControlMessage::Seek(pos)).is_err() {
            warn!("无法发送跳转命令，解码器线程可能已 panic");
            return Err(SeekError::NotSupported {
                underlying_source: "FFmpegDecoder",
            });
        }
        self.local_buffer.clear();
        self.samples_played.store(0, Ordering::SeqCst);

        Ok(())
    }
}

impl Drop for FFmpegDecoder {
    fn drop(&mut self) {
        self.shared.is_stopping.store(true, Ordering::Release);
        self.shared.condvar.notify_all();
        let _ = self.control_tx.send(ControlMessage::Close);

        if let Some(handle) = self.decoder_thread.take()
            && let Err(e) = handle.join()
        {
            error!("解码器线程 panic: {e:?}");
        }
    }
}
