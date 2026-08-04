use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use crossbeam_channel::{unbounded, Sender};
use crossbeam_utils::sync::{Parker, Unparker};
use ffmpeg_audio::{AudioReader, ResampleOptions};
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapCons, HeapRb,
};
use tracing::warn;

use crate::{
    audio_quality::AudioQuality,
    player::{AudioInfo, CustomMediaSource},
    utils::build_audio_info,
};

const GAPLESS_PREBUFFER_DURATION_MS: u32 = 1_000;
const AUDIO_BUFFER_DURATION_MS: u32 = 6_000;
const MAX_AUDIO_BUFFER_SAMPLES: usize = 4_000_000;
const TRAILING_SILENCE_THRESHOLD: f32 = 0.005_623_413;

#[derive(Clone, Default)]
pub struct DecoderSharedState {
    pub flush_req: Arc<AtomicBool>,
    pub flush_ack: Arc<AtomicBool>,
    pub is_eof: Arc<AtomicBool>,
    pub natural_eof: Arc<AtomicBool>,
    pub decoded_samples_at_eof: Arc<AtomicU64>,
    pub trailing_silence_samples: Arc<AtomicU64>,
    pub is_shutdown: Arc<AtomicBool>,
    pub info: AudioInfo,
    pub quality: AudioQuality,
}

pub enum DecoderCommand {
    Seek(Duration),
}

pub struct AudioSource<C> {
    consumer: C,
    unparker: Unparker,
    shared_state: DecoderSharedState,

    watermark: usize,
    ready_watermark: usize,

    samples_counter: Arc<AtomicU64>,
}

#[derive(Clone)]
pub(crate) struct TailTransitionProbe {
    flush_req: Arc<AtomicBool>,
    natural_eof: Arc<AtomicBool>,
    decoded_samples_at_eof: Arc<AtomicU64>,
    trailing_silence_samples: Arc<AtomicU64>,
    samples_counter: Arc<AtomicU64>,
}

impl<C> AudioSource<C> {
    pub fn audio_info(&self) -> AudioInfo {
        self.shared_state.info.clone()
    }

    pub fn audio_quality(&self) -> AudioQuality {
        self.shared_state.quality.clone()
    }

    pub(crate) fn tail_transition_probe(&self) -> TailTransitionProbe {
        TailTransitionProbe {
            flush_req: Arc::clone(&self.shared_state.flush_req),
            natural_eof: Arc::clone(&self.shared_state.natural_eof),
            decoded_samples_at_eof: Arc::clone(&self.shared_state.decoded_samples_at_eof),
            trailing_silence_samples: Arc::clone(&self.shared_state.trailing_silence_samples),
            samples_counter: Arc::clone(&self.samples_counter),
        }
    }
}

impl<C: Consumer<Item = f32>> AudioSource<C> {
    pub fn is_ready(&self) -> bool {
        let buffered_samples = self.consumer.occupied_len();
        buffered_samples >= self.ready_watermark
            || (buffered_samples > 0 && self.shared_state.is_eof.load(Ordering::Acquire))
    }
}

impl TailTransitionProbe {
    pub(crate) fn is_flushing(&self) -> bool {
        self.flush_req.load(Ordering::Acquire)
    }

    pub(crate) fn is_in_trimmable_tail(&self, preserved_samples: usize) -> bool {
        if self.is_flushing() || !self.natural_eof.load(Ordering::Acquire) {
            return false;
        }

        let decoded_samples = self.decoded_samples_at_eof.load(Ordering::Relaxed);
        let trailing_samples = self.trailing_silence_samples.load(Ordering::Relaxed);
        let Some(transition_sample) =
            tail_transition_sample(decoded_samples, trailing_samples, preserved_samples as u64)
        else {
            return false;
        };
        self.samples_counter.load(Ordering::Relaxed) >= transition_sample
    }
}

impl<C: Consumer<Item = f32>> Iterator for AudioSource<C> {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.shared_state.flush_req.load(Ordering::Acquire) {
            self.consumer.clear();
            self.shared_state.flush_ack.store(true, Ordering::Release);
            self.unparker.unpark();
            return Some(0.0);
        }

        if let Some(sample) = self.consumer.try_pop() {
            self.samples_counter.fetch_add(1, Ordering::Relaxed);
            if self.consumer.occupied_len() < self.watermark {
                self.unparker.unpark();
            }
            Some(sample)
        } else {
            if self.shared_state.is_eof.load(Ordering::Acquire) {
                None
            } else {
                self.unparker.unpark();
                Some(0.0)
            }
        }
    }
}

impl<C> Drop for AudioSource<C> {
    fn drop(&mut self) {
        self.shared_state.is_shutdown.store(true, Ordering::Release);
        self.unparker.unpark();
    }
}

pub struct SpawnedDecoder {
    pub source: AudioSource<HeapCons<f32>>,
    pub fft_consumer: HeapCons<f32>,
    pub handle: FFmpegDecoder,
    pub samples_counter: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct FFmpegDecoder {
    cmd_tx: Sender<DecoderCommand>,
    unparker: Unparker,
    flush_req: Arc<AtomicBool>,
    natural_eof: Arc<AtomicBool>,
}

fn wait_for_flush_ack(shared_state: &DecoderSharedState, parker: &Parker) -> bool {
    loop {
        if shared_state.is_shutdown.load(Ordering::Acquire) {
            return false;
        }
        if shared_state.flush_ack.load(Ordering::Acquire) {
            return true;
        }
        parker.park();
    }
}

fn samples_for_duration(sample_rate: u32, channels: u16, duration_ms: u32) -> usize {
    let channels = usize::from(channels).max(1);
    ((sample_rate as usize).saturating_mul(duration_ms as usize) / 1_000).saturating_mul(channels)
}

fn tail_transition_sample(
    decoded_samples: u64,
    trailing_samples: u64,
    preserved_samples: u64,
) -> Option<u64> {
    if trailing_samples <= preserved_samples || trailing_samples > decoded_samples {
        return None;
    }

    Some(decoded_samples - trailing_samples + preserved_samples)
}

fn audio_buffer_layout(target_sample_rate: u32, target_channels: u16) -> (usize, usize) {
    let channels = usize::from(target_channels).max(1);
    let aligned_limit = (MAX_AUDIO_BUFFER_SAMPLES / channels).max(1) * channels;
    let desired_capacity = samples_for_duration(
        target_sample_rate,
        target_channels,
        AUDIO_BUFFER_DURATION_MS,
    );
    let capacity = desired_capacity.max(channels).min(aligned_limit);
    let ready_watermark = samples_for_duration(
        target_sample_rate,
        target_channels,
        GAPLESS_PREBUFFER_DURATION_MS,
    )
    .max(channels)
    .min(capacity);
    (capacity, ready_watermark)
}

fn fft_buffer_capacity_for_audio(audio_buffer_capacity: usize, target_channels: u16) -> usize {
    audio_buffer_capacity / usize::from(target_channels).max(1)
}

struct TrailingSilenceTracker {
    channels: u64,
    decoded_samples: u64,
    last_audible_sample_end: u64,
}

impl TrailingSilenceTracker {
    fn new(channels: u16) -> Self {
        Self {
            channels: u64::from(channels).max(1),
            decoded_samples: 0,
            last_audible_sample_end: 0,
        }
    }

    fn observe(&mut self, samples: &[f32]) {
        let decoded_before = self.decoded_samples;
        for (index, sample) in samples.iter().enumerate() {
            if !sample.is_finite() || sample.abs() > TRAILING_SILENCE_THRESHOLD {
                let absolute_sample = decoded_before.saturating_add(index as u64);
                self.last_audible_sample_end = absolute_sample
                    .saturating_div(self.channels)
                    .saturating_add(1)
                    .saturating_mul(self.channels);
            }
        }
        self.decoded_samples = self.decoded_samples.saturating_add(samples.len() as u64);
    }

    fn trailing_silence_samples(&self) -> u64 {
        if self.last_audible_sample_end == 0 {
            0
        } else {
            self.decoded_samples
                .saturating_sub(self.last_audible_sample_end)
        }
    }

    fn reset(&mut self) {
        self.decoded_samples = 0;
        self.last_audible_sample_end = 0;
    }
}

impl FFmpegDecoder {
    pub fn seek(&self, target: Duration) -> anyhow::Result<()> {
        // 先让音频回调进入排空态并失效旧的自然结束信息，避免跳转命令尚未被
        // 解码线程处理时将旧位置的尾部误认为已经结束或仍可切换。
        self.flush_req.store(true, Ordering::Release);
        self.natural_eof.store(false, Ordering::Release);
        if let Err(error) = self.cmd_tx.send(DecoderCommand::Seek(target)) {
            self.flush_req.store(false, Ordering::Release);
            return Err(error.into());
        }
        self.unparker.unpark();
        Ok(())
    }

    pub fn spawn<T: CustomMediaSource>(
        source: T,
        target_channels: u16,
        target_sample_rate: u32,
    ) -> anyhow::Result<SpawnedDecoder> {
        let mut reader = AudioReader::new(source)?;

        let src_info = reader.source_info();

        let info = build_audio_info(&reader);
        let quality = AudioQuality::from_source_info(src_info);

        let audio_options = ResampleOptions::new()
            .sample_rate(target_sample_rate.cast_signed())
            .channels(target_channels.cast_signed().into())
            .format::<f32>();

        let fft_options = ResampleOptions::new()
            .sample_rate(target_sample_rate.cast_signed())
            .channels(1)
            .format::<f32>();

        let mut audio_resampler = reader.build_resampler(audio_options)?;
        let mut fft_resampler = reader.build_resampler(fft_options)?;

        let (buffer_capacity, ready_watermark) =
            audio_buffer_layout(target_sample_rate, target_channels);
        let audio_rb = HeapRb::<f32>::new(buffer_capacity);
        let (mut audio_producer, audio_consumer) = audio_rb.split();

        // FFT 消费速度跟随实际播放帧；它必须与音频环形缓冲覆盖相同的时长，
        // 否则扩大音频预读后会丢掉尚未播放区间的频谱采样。
        let fft_buffer_capacity = fft_buffer_capacity_for_audio(buffer_capacity, target_channels);
        let fft_rb = HeapRb::<f32>::new(fft_buffer_capacity);
        let (mut fft_producer, fft_consumer) = fft_rb.split();

        let (cmd_tx, cmd_rx) = unbounded::<DecoderCommand>();
        let parker = Parker::new();
        let unparker = parker.unparker().clone();

        let shared_state = DecoderSharedState {
            info,
            quality,
            ..Default::default()
        };

        let samples_counter = Arc::new(AtomicU64::new(0));

        let source = AudioSource {
            consumer: audio_consumer,
            unparker: unparker.clone(),
            shared_state: shared_state.clone(),
            watermark: buffer_capacity / 2,
            ready_watermark,
            samples_counter: samples_counter.clone(),
        };

        let handle = FFmpegDecoder {
            cmd_tx,
            unparker: unparker.clone(),
            flush_req: Arc::clone(&shared_state.flush_req),
            natural_eof: Arc::clone(&shared_state.natural_eof),
        };

        let mut trailing_silence_tracker = TrailingSilenceTracker::new(target_channels);
        let mut tail_tracking_reliable = true;
        thread::spawn(move || loop {
            if shared_state.is_shutdown.load(Ordering::Acquire) {
                break;
            }

            while let Ok(cmd) = cmd_rx.try_recv() {
                match cmd {
                    DecoderCommand::Seek(target) => {
                        shared_state.flush_req.store(true, Ordering::Release);
                        if !wait_for_flush_ack(&shared_state, &parker) {
                            return;
                        }

                        let seek_succeeded = match reader
                            .seek(target, ffmpeg_audio::SeekMode::Accurate)
                        {
                            Ok(()) => true,
                            Err(error) => {
                                warn!("跳转音频解码位置失败，禁用当前歌曲的尾部近静音跳过: {error:?}");
                                false
                            }
                        };
                        let audio_flush_succeeded = match audio_resampler.flush() {
                            Ok(()) => true,
                            Err(error) => {
                                warn!("跳转时重置音频重采样器失败，禁用当前歌曲的尾部近静音跳过: {error:?}");
                                false
                            }
                        };
                        if let Err(error) = fft_resampler.flush() {
                            warn!("跳转时重置 FFT 重采样器失败: {error:?}");
                        }

                        trailing_silence_tracker.reset();
                        tail_tracking_reliable = seek_succeeded && audio_flush_succeeded;
                        shared_state
                            .decoded_samples_at_eof
                            .store(0, Ordering::Relaxed);
                        shared_state
                            .trailing_silence_samples
                            .store(0, Ordering::Relaxed);
                        shared_state.natural_eof.store(false, Ordering::Release);
                        shared_state.is_eof.store(false, Ordering::Release);
                        shared_state.flush_req.store(false, Ordering::Release);
                        shared_state.flush_ack.store(false, Ordering::Release);
                    }
                }
            }

            if shared_state.is_eof.load(Ordering::Acquire) {
                parker.park();
                continue;
            }

            match reader.receive_frame() {
                Ok(Some(frame)) => {
                    if let Ok(true) = fft_resampler.process::<f32>(Some(&frame)) {
                        let fft_data = fft_resampler.output_as::<f32>();
                        let _ = fft_producer.push_slice(fft_data);
                    }

                    match audio_resampler.process::<f32>(Some(&frame)) {
                        Ok(true) => {
                            let audio_data = audio_resampler.output_as::<f32>();
                            let mut written = 0;
                            while written < audio_data.len() {
                                if shared_state.is_shutdown.load(Ordering::Acquire) {
                                    return;
                                }
                                if !cmd_rx.is_empty() {
                                    break;
                                }

                                let pushed = audio_producer.push_slice(&audio_data[written..]);
                                trailing_silence_tracker
                                    .observe(&audio_data[written..written + pushed]);
                                written += pushed;

                                if pushed == 0 {
                                    parker.park();
                                }
                            }
                        }
                        Ok(false) => {}
                        Err(error) => {
                            tail_tracking_reliable = false;
                            warn!("重采样音频帧失败，禁用当前歌曲的尾部近静音跳过: {error:?}");
                        }
                    }
                }
                Ok(None) => {
                    let mut interrupted_for_command = false;
                    loop {
                        match audio_resampler.process::<f32>(None) {
                            Ok(true) => {
                                let audio_data = audio_resampler.output_as::<f32>();
                                let mut written = 0;
                                while written < audio_data.len() {
                                    if shared_state.is_shutdown.load(Ordering::Acquire) {
                                        return;
                                    }
                                    if !cmd_rx.is_empty() {
                                        interrupted_for_command = true;
                                        break;
                                    }

                                    let pushed =
                                        audio_producer.push_slice(&audio_data[written..]);
                                    trailing_silence_tracker
                                        .observe(&audio_data[written..written + pushed]);
                                    written += pushed;

                                    if pushed == 0 {
                                        parker.park();
                                    }
                                }

                                if interrupted_for_command {
                                    break;
                                }
                            }
                            Ok(false) => break,
                            Err(error) => {
                                tail_tracking_reliable = false;
                                warn!("排空音频重采样器失败: {error:?}");
                                break;
                            }
                        }
                    }

                    if interrupted_for_command {
                        continue;
                    }

                    loop {
                        match fft_resampler.process::<f32>(None) {
                            Ok(true) => {
                                let fft_data = fft_resampler.output_as::<f32>();
                                let _ = fft_producer.push_slice(fft_data);
                            }
                            Ok(false) => break,
                            Err(error) => {
                                warn!("排空 FFT 重采样器失败: {error:?}");
                                break;
                            }
                        }
                    }

                    let trailing_silence_samples = if tail_tracking_reliable {
                        trailing_silence_tracker.trailing_silence_samples()
                    } else {
                        0
                    };
                    shared_state
                        .decoded_samples_at_eof
                        .store(trailing_silence_tracker.decoded_samples, Ordering::Relaxed);
                    shared_state
                        .trailing_silence_samples
                        .store(trailing_silence_samples, Ordering::Relaxed);
                    shared_state
                        .natural_eof
                        .store(tail_tracking_reliable, Ordering::Release);
                    shared_state.is_eof.store(true, Ordering::Release);
                }
                Err(e) => {
                    warn!("解码线程发生错误: {e:?}");
                    shared_state
                        .decoded_samples_at_eof
                        .store(0, Ordering::Relaxed);
                    shared_state
                        .trailing_silence_samples
                        .store(0, Ordering::Relaxed);
                    shared_state.natural_eof.store(false, Ordering::Release);
                    shared_state.is_eof.store(true, Ordering::Release);
                }
            }
        });

        Ok(SpawnedDecoder {
            source,
            fft_consumer,
            handle,
            samples_counter,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source_with_buffered_samples(
        buffered_samples: usize,
        ready_watermark: usize,
        eof: bool,
    ) -> AudioSource<HeapCons<f32>> {
        let ring = HeapRb::<f32>::new(32);
        let (mut producer, consumer) = ring.split();
        let _ = producer.push_slice(&vec![0.25; buffered_samples]);
        let parker = Parker::new();
        let shared_state = DecoderSharedState::default();
        shared_state.is_eof.store(eof, Ordering::Release);
        AudioSource {
            consumer,
            unparker: parker.unparker().clone(),
            shared_state,
            watermark: 16,
            ready_watermark,
            samples_counter: Arc::new(AtomicU64::new(0)),
        }
    }

    fn source_with_trailing_silence(
        buffered_samples: usize,
        decoded_samples: u64,
        trailing_silence_samples: u64,
        consumed_samples: u64,
        natural_eof: bool,
    ) -> AudioSource<HeapCons<f32>> {
        let source = source_with_buffered_samples(buffered_samples, 5, true);
        source
            .shared_state
            .decoded_samples_at_eof
            .store(decoded_samples, Ordering::Relaxed);
        source
            .shared_state
            .trailing_silence_samples
            .store(trailing_silence_samples, Ordering::Relaxed);
        source
            .shared_state
            .natural_eof
            .store(natural_eof, Ordering::Release);
        source
            .samples_counter
            .store(consumed_samples, Ordering::Relaxed);
        source
    }

    #[test]
    fn audio_buffer_keeps_six_seconds_for_common_output_and_caps_large_layouts() {
        assert_eq!(audio_buffer_layout(48_000, 2), (576_000, 96_000));
        assert_eq!(fft_buffer_capacity_for_audio(576_000, 2), 288_000);
        assert_eq!(samples_for_duration(44_101, 3, 1_500), 198_453);

        let (capacity, ready_watermark) = audio_buffer_layout(192_000, 8);
        assert_eq!(capacity, MAX_AUDIO_BUFFER_SAMPLES);
        assert_eq!(ready_watermark, 1_536_000);
        assert_eq!(capacity % 8, 0);

        let (extreme_capacity, extreme_ready) = audio_buffer_layout(u32::MAX, u16::MAX);
        assert!((1..=MAX_AUDIO_BUFFER_SAMPLES).contains(&extreme_capacity));
        assert!(extreme_ready <= extreme_capacity);
        assert_eq!(extreme_capacity % u16::MAX as usize, 0);
        assert_eq!(
            fft_buffer_capacity_for_audio(extreme_capacity, u16::MAX),
            extreme_capacity / u16::MAX as usize
        );
    }

    #[test]
    fn trailing_silence_tracker_uses_the_last_audible_sample() {
        let mut tracker = TrailingSilenceTracker::new(2);
        tracker.observe(&[0.01, 0.0, 0.0, 0.0]);
        tracker.observe(&[0.0, 0.0]);
        assert_eq!(tracker.trailing_silence_samples(), 4);
        assert_eq!(tracker.trailing_silence_samples() % 2, 0);

        tracker.observe(&[f32::NAN, 0.0]);
        assert_eq!(tracker.trailing_silence_samples(), 0);

        tracker.reset();
        tracker.observe(&[0.0; 12]);
        assert_eq!(tracker.trailing_silence_samples(), 0);

        tracker.observe(&[TRAILING_SILENCE_THRESHOLD, -TRAILING_SILENCE_THRESHOLD]);
        assert_eq!(tracker.trailing_silence_samples(), 0);
        tracker.observe(&[TRAILING_SILENCE_THRESHOLD * 1.01, 0.0]);
        tracker.observe(&[0.0, 0.0]);
        assert_eq!(tracker.trailing_silence_samples(), 2);

        tracker.reset();
        tracker.observe(&[0.01]);
        tracker.observe(&[0.0, 0.0]);
        tracker.observe(&[0.0]);
        assert_eq!(tracker.trailing_silence_samples(), 2);
    }

    #[test]
    fn trailing_silence_tracker_counts_only_each_committed_ring_segment() {
        let ring = HeapRb::<f32>::new(4);
        let (mut producer, mut consumer) = ring.split();
        let input = [0.01, 0.0, 0.0, 0.0, 0.0, 0.0];
        let mut tracker = TrailingSilenceTracker::new(2);
        let mut written = 0;

        let pushed = producer.push_slice(&input[written..]);
        tracker.observe(&input[written..written + pushed]);
        written += pushed;
        assert_eq!(pushed, 4);

        assert_eq!(consumer.try_pop(), Some(0.01));
        assert_eq!(consumer.try_pop(), Some(0.0));

        let pushed = producer.push_slice(&input[written..]);
        tracker.observe(&input[written..written + pushed]);
        written += pushed;
        assert_eq!(pushed, 2);
        assert_eq!(written, input.len());
        assert_eq!(tracker.decoded_samples, input.len() as u64);
        assert_eq!(tracker.trailing_silence_samples(), 4);
    }

    #[test]
    fn source_trims_only_a_natural_buffered_tail_after_the_preserved_window() {
        assert!(
            source_with_trailing_silence(12, 100, 40, 70, true)
                .tail_transition_probe()
                .is_in_trimmable_tail(10)
        );
        assert!(
            !source_with_trailing_silence(12, 100, 40, 69, true)
                .tail_transition_probe()
                .is_in_trimmable_tail(10)
        );
        assert!(
            !source_with_trailing_silence(12, 100, 40, 70, false)
                .tail_transition_probe()
                .is_in_trimmable_tail(10)
        );
        assert!(
            !source_with_trailing_silence(12, 100, 10, 100, true)
                .tail_transition_probe()
                .is_in_trimmable_tail(10)
        );

        let source = source_with_trailing_silence(12, 100, 40, 70, true);
        source.shared_state.flush_req.store(true, Ordering::Release);
        assert!(!source.tail_transition_probe().is_in_trimmable_tail(4));
    }

    #[test]
    fn tail_transition_rejects_inconsistent_or_unpreservable_metadata() {
        assert_eq!(tail_transition_sample(100, 40, 10), Some(70));
        assert_eq!(tail_transition_sample(100, 10, 10), None);
        assert_eq!(tail_transition_sample(100, 101, 10), None);
    }

    #[test]
    fn seek_blocks_old_eof_and_tail_before_the_decoder_handles_the_command() {
        let (cmd_tx, cmd_rx) = unbounded();
        let parker = Parker::new();
        let flush_req = Arc::new(AtomicBool::new(false));
        let natural_eof = Arc::new(AtomicBool::new(true));
        let decoder = FFmpegDecoder {
            cmd_tx,
            unparker: parker.unparker().clone(),
            flush_req: Arc::clone(&flush_req),
            natural_eof: Arc::clone(&natural_eof),
        };

        decoder.seek(Duration::from_secs(12)).unwrap();

        assert!(flush_req.load(Ordering::Acquire));
        assert!(!natural_eof.load(Ordering::Acquire));
        assert!(matches!(
            cmd_rx.try_recv(),
            Ok(DecoderCommand::Seek(target)) if target == Duration::from_secs(12)
        ));
    }

    #[test]
    fn prepared_source_waits_for_the_prebuffer_watermark() {
        assert!(!source_with_buffered_samples(4, 5, false).is_ready());
        assert!(source_with_buffered_samples(5, 5, false).is_ready());
    }

    #[test]
    fn short_finished_source_is_ready_but_empty_source_is_not() {
        assert!(source_with_buffered_samples(2, 5, true).is_ready());
        assert!(!source_with_buffered_samples(0, 5, true).is_ready());
    }

    #[test]
    fn flush_clears_old_samples_and_wakes_the_waiting_decoder() {
        let ring = HeapRb::<f32>::new(8);
        let (mut producer, consumer) = ring.split();
        assert_eq!(producer.push_slice(&[0.25, 0.5]), 2);

        let parker = Parker::new();
        let shared_state = DecoderSharedState::default();
        shared_state.flush_req.store(true, Ordering::Release);
        let samples_counter = Arc::new(AtomicU64::new(0));
        let mut source = AudioSource {
            consumer,
            unparker: parker.unparker().clone(),
            shared_state: shared_state.clone(),
            watermark: 4,
            ready_watermark: 4,
            samples_counter: samples_counter.clone(),
        };

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let waiter_state = shared_state.clone();
        let waiter = thread::spawn(move || {
            let _ = done_tx.send(wait_for_flush_ack(&waiter_state, &parker));
        });

        assert_eq!(source.next(), Some(0.0));
        assert!(done_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        waiter.join().unwrap();
        assert_eq!(samples_counter.load(Ordering::Acquire), 0);

        shared_state.flush_req.store(false, Ordering::Release);
        shared_state.flush_ack.store(false, Ordering::Release);
        assert_eq!(producer.push_slice(&[0.75]), 1);
        assert_eq!(source.next(), Some(0.75));
    }

    #[test]
    fn dropping_source_wakes_a_parked_flush_waiter() {
        let ring = HeapRb::<f32>::new(4);
        let (_, consumer) = ring.split();
        let parker = Parker::new();
        let shared_state = DecoderSharedState::default();
        shared_state.flush_req.store(true, Ordering::Release);
        let source = AudioSource {
            consumer,
            unparker: parker.unparker().clone(),
            shared_state: shared_state.clone(),
            watermark: 2,
            ready_watermark: 2,
            samples_counter: Arc::new(AtomicU64::new(0)),
        };

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let waiter_state = shared_state.clone();
        let waiter = thread::spawn(move || {
            let _ = done_tx.send(wait_for_flush_ack(&waiter_state, &parker));
        });

        drop(source);
        assert!(!done_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        waiter.join().unwrap();
    }
}
