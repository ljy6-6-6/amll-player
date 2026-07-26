use std::{
    f32::consts::PI,
    fs::File,
    io::{Read, Seek},
    path::Path,
};

use anyhow::Context;
use bs1770::{ChannelLoudnessMeter, gated_mean, reduce_stereo};
use ffmpeg_audio::{AudioError, AudioReader, ResampleOptions};
use serde::{Deserialize, Serialize};
use tracing::warn;

pub const RHYTHM_ANALYZER_VERSION: u32 = 3;
pub const LOUDNESS_ANALYZER_VERSION: u32 = 1;

const TARGET_SAMPLE_RATE: u32 = 22_050;
const LOUDNESS_SAMPLE_RATE: u32 = 48_000;
const FFT_SIZE: usize = 1_024;
const HOP_SIZE: usize = 256;
const BAND_COUNT: usize = 5;
const BAND_EDGES_HZ: [f32; BAND_COUNT + 1] = [30.0, 150.0, 400.0, 1_200.0, 3_500.0, 11_025.0];
const MIN_TEMPO_BPM: f32 = 55.0;
const MAX_TEMPO_BPM: f32 = 210.0;
const MAX_RECOVERABLE_DECODE_ERRORS: usize = 8;
/// Calibrates `sqrt(sum of squared Hann-windowed bin magnitudes)` back to an
/// approximate PCM RMS scale so `band_levels` is comparable with `energy_scale`.
const BAND_LEVEL_SCALE: f32 = 2.828_427;

fn can_skip_decode_error(error: &AudioError, skipped_errors: usize) -> bool {
    skipped_errors < MAX_RECOVERABLE_DECODE_ERRORS
        && matches!(
            error,
            AudioError::FFmpeg(code, _) if *code == ffmpeg_audio::sys::AVERROR_INVALIDDATA
        )
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmBeatPoint {
    pub time_ms: u64,
    pub strength: f32,
    pub confidence: f32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmOnsetPoint {
    pub time_ms: u64,
    pub strength: f32,
    pub bands: [f32; BAND_COUNT],
    /// Absolute per-band linear level (approximate PCM RMS units) around the
    /// onset. `bands` is per-band normalized novelty and deliberately loudness
    /// invariant, so it cannot tell a loud kick from a quiet shaker; this field
    /// restores that cross-band loudness ranking for visual amplitude mapping.
    #[serde(default)]
    pub band_levels: [f32; BAND_COUNT],
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmTempoSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub bpm: f32,
    pub confidence: f32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmTimedValue {
    pub time_ms: u64,
    pub value: f32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackLoudnessAnalysis {
    pub analyzer_version: u32,
    pub integrated_loudness_lufs: Option<f32>,
    /// Maximum absolute sample value after the 48 kHz stereo analysis resample.
    pub sample_peak: f32,
}

impl TrackLoudnessAnalysis {
    pub fn is_current(&self) -> bool {
        self.analyzer_version == LOUDNESS_ANALYZER_VERSION
            && self
                .integrated_loudness_lufs
                .is_none_or(|loudness| loudness.is_finite())
            && self.sample_peak.is_finite()
            && self.sample_peak >= 0.0
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmAnalysis {
    pub analyzer_version: u32,
    pub duration_ms: u64,
    pub global_bpm: Option<f32>,
    pub confidence: f32,
    pub beats: Vec<RhythmBeatPoint>,
    pub onsets: Vec<RhythmOnsetPoint>,
    pub tempo_segments: Vec<RhythmTempoSegment>,
    pub energy_envelope: Vec<RhythmTimedValue>,
    /// Absolute P95 frame RMS before `energy_envelope` is normalized. Keeping
    /// this scalar makes the relative envelope comparable across tracks without
    /// duplicating another full-length time series in the cache.
    #[serde(default)]
    pub energy_scale: f32,
    /// Per-track perceived loudness. This has its own version so adding it does
    /// not invalidate otherwise compatible rhythm caches or the legacy schema.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loudness: Option<TrackLoudnessAnalysis>,
}

impl RhythmAnalysis {
    fn empty(duration_ms: u64) -> Self {
        Self {
            analyzer_version: RHYTHM_ANALYZER_VERSION,
            duration_ms,
            global_bpm: None,
            confidence: 0.0,
            beats: Vec::new(),
            onsets: Vec::new(),
            tempo_segments: Vec::new(),
            energy_envelope: Vec::new(),
            energy_scale: 0.0,
            loudness: Some(TrackLoudnessAnalysis {
                analyzer_version: LOUDNESS_ANALYZER_VERSION,
                integrated_loudness_lufs: None,
                sample_peak: 0.0,
            }),
        }
    }

    pub fn has_current_loudness_analysis(&self) -> bool {
        self.loudness
            .as_ref()
            .is_some_and(TrackLoudnessAnalysis::is_current)
    }
}

struct TrackLoudnessMeter {
    left: ChannelLoudnessMeter,
    right: ChannelLoudnessMeter,
    sample_peak: f32,
}

impl TrackLoudnessMeter {
    fn new(sample_rate: u32) -> Self {
        Self {
            left: ChannelLoudnessMeter::new(sample_rate),
            right: ChannelLoudnessMeter::new(sample_rate),
            sample_peak: 0.0,
        }
    }

    fn clean_sample(sample: f32) -> f32 {
        if sample.is_finite() { sample } else { 0.0 }
    }

    fn push_interleaved_stereo(&mut self, samples: &[f32]) {
        self.left.push(
            samples
                .chunks_exact(2)
                .map(|frame| Self::clean_sample(frame[0])),
        );
        self.right.push(
            samples
                .chunks_exact(2)
                .map(|frame| Self::clean_sample(frame[1])),
        );
        for &sample in samples {
            self.sample_peak = self.sample_peak.max(Self::clean_sample(sample).abs());
        }
    }

    fn push_dual_mono(&mut self, samples: &[f32]) {
        self.left
            .push(samples.iter().copied().map(Self::clean_sample));
        self.right
            .push(samples.iter().copied().map(Self::clean_sample));
        for &sample in samples {
            self.sample_peak = self.sample_peak.max(Self::clean_sample(sample).abs());
        }
    }

    fn finish(self) -> TrackLoudnessAnalysis {
        let left = self.left.into_100ms_windows();
        let right = self.right.into_100ms_windows();
        let stereo = reduce_stereo(left.as_ref(), right.as_ref());
        let integrated_loudness_lufs = if stereo.len() >= 4 {
            let loudness = gated_mean(stereo.as_ref()).loudness_lkfs();
            loudness.is_finite().then_some(loudness)
        } else {
            None
        };

        TrackLoudnessAnalysis {
            analyzer_version: LOUDNESS_ANALYZER_VERSION,
            integrated_loudness_lufs,
            sample_peak: self.sample_peak,
        }
    }
}

/// Decode a local audio file independently from the playback decoder and analyze
/// the complete track. The playback ring buffer is deliberately not involved.
pub fn analyze_rhythm_file(path: impl AsRef<Path>) -> anyhow::Result<RhythmAnalysis> {
    let path = path.as_ref();
    let file = File::open(path)
        .with_context(|| format!("failed to open audio file {}", path.display()))?;
    analyze_rhythm_source(file)
        .with_context(|| format!("failed to analyze audio file {}", path.display()))
}

/// Decode any seekable media source to 22.05 kHz mono PCM before analysis.
pub fn analyze_rhythm_source<T>(source: T) -> anyhow::Result<RhythmAnalysis>
where
    T: Read + Seek + Send + 'static,
{
    let mut reader = AudioReader::new(source).context("failed to initialize audio decoder")?;
    let options = ResampleOptions::new()
        .sample_rate(TARGET_SAMPLE_RATE as i32)
        .channels(1)
        .format::<f32>();
    let mut resampler = reader
        .build_resampler(options)
        .context("failed to initialize rhythm analysis resampler")?;
    let loudness_options = ResampleOptions::new()
        .sample_rate(LOUDNESS_SAMPLE_RATE as i32)
        .channels(2)
        .format::<f32>();
    let mut loudness_resampler = reader
        .build_resampler(loudness_options)
        .context("failed to initialize loudness analysis resampler")?;
    let mut loudness_meter = TrackLoudnessMeter::new(LOUDNESS_SAMPLE_RATE);
    let mut pcm = Vec::new();

    let mut recoverable_decode_errors = 0;
    loop {
        let frame = match reader.receive_frame() {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(error) if can_skip_decode_error(&error, recoverable_decode_errors) => {
                recoverable_decode_errors += 1;
                warn!(
                    error = %error,
                    skipped_errors = recoverable_decode_errors,
                    "skipping recoverable damaged audio data during rhythm analysis"
                );
                continue;
            }
            Err(error) => {
                return Err(error).context("failed while decoding audio for rhythm analysis");
            }
        };
        if resampler
            .process::<f32>(Some(&frame))
            .context("failed to resample audio for rhythm analysis")?
        {
            pcm.extend_from_slice(resampler.output_as::<f32>());
        }
        if loudness_resampler
            .process::<f32>(Some(&frame))
            .context("failed to resample audio for loudness analysis")?
        {
            loudness_meter.push_interleaved_stereo(loudness_resampler.output_as::<f32>());
        }
    }

    while resampler
        .process::<f32>(None)
        .context("failed to flush rhythm analysis resampler")?
    {
        pcm.extend_from_slice(resampler.output_as::<f32>());
    }

    while loudness_resampler
        .process::<f32>(None)
        .context("failed to flush loudness analysis resampler")?
    {
        loudness_meter.push_interleaved_stereo(loudness_resampler.output_as::<f32>());
    }

    analyze_mono_pcm_with_loudness(&pcm, TARGET_SAMPLE_RATE, Some(loudness_meter.finish()))
}

/// Analyze a complete mono PCM signal. This pure boundary is intentionally free
/// from FFmpeg, CPAL, Tauri, SQLite, and wall-clock state so it can be tested with
/// deterministic synthetic signals.
pub fn analyze_mono_pcm(samples: &[f32], sample_rate: u32) -> anyhow::Result<RhythmAnalysis> {
    anyhow::ensure!(sample_rate > 0, "sample rate must be greater than zero");

    let mut loudness_meter = TrackLoudnessMeter::new(sample_rate);
    loudness_meter.push_dual_mono(samples);
    analyze_mono_pcm_with_loudness(samples, sample_rate, Some(loudness_meter.finish()))
}

fn analyze_mono_pcm_with_loudness(
    samples: &[f32],
    sample_rate: u32,
    loudness: Option<TrackLoudnessAnalysis>,
) -> anyhow::Result<RhythmAnalysis> {
    let duration_ms = samples_to_ms(samples.len() as f64, sample_rate);
    if samples.is_empty() {
        let mut analysis = RhythmAnalysis::empty(duration_ms);
        analysis.loudness = loudness;
        return Ok(analysis);
    }

    let frame_count = samples.len().div_ceil(HOP_SIZE);
    let mut previous_spectrum = vec![0.0_f32; FFT_SIZE / 2 + 1];
    let mut raw_flux = vec![[0.0_f32; BAND_COUNT]; frame_count];
    let mut band_linear = vec![[0.0_f32; BAND_COUNT]; frame_count];
    let mut rms = vec![0.0_f32; frame_count];
    let bin_bands = frequency_bin_bands(sample_rate);
    let window = hann_window();
    let mut real = vec![0.0_f32; FFT_SIZE];
    let mut imaginary = vec![0.0_f32; FFT_SIZE];
    let mut current_spectrum = vec![0.0_f32; FFT_SIZE / 2 + 1];

    for frame_index in 0..frame_count {
        let start = frame_index * HOP_SIZE;
        let mut square_sum = 0.0_f32;
        for index in 0..FFT_SIZE {
            let sample = samples
                .get(start + index)
                .copied()
                .filter(|value| value.is_finite())
                .unwrap_or(0.0);
            square_sum += sample * sample;
            real[index] = sample * window[index];
            imaginary[index] = 0.0;
        }
        rms[frame_index] = (square_sum / FFT_SIZE as f32).sqrt();

        fft_in_place(&mut real, &mut imaginary);
        let mut band_bin_counts = [0_usize; BAND_COUNT];
        let mut band_energy = [0.0_f32; BAND_COUNT];
        for bin in 1..=FFT_SIZE / 2 {
            let magnitude =
                (real[bin] * real[bin] + imaginary[bin] * imaginary[bin]).sqrt() / FFT_SIZE as f32;
            current_spectrum[bin] = (1.0 + magnitude * 64.0).ln();
            if let Some(band) = bin_bands[bin] {
                band_energy[band] += magnitude * magnitude;
            }
        }
        for band in 0..BAND_COUNT {
            band_linear[frame_index][band] = band_energy[band].sqrt() * BAND_LEVEL_SCALE;
        }
        for bin in 1..=FFT_SIZE / 2 {
            if let Some(band) = bin_bands[bin] {
                // SuperFlux-style comparison against a small frequency-neighbourhood
                // in the preceding frame reduces vibrato-created false positives.
                let previous_local_max = previous_spectrum[bin.saturating_sub(1)]
                    .max(previous_spectrum[bin])
                    .max(previous_spectrum[(bin + 1).min(FFT_SIZE / 2)]);
                raw_flux[frame_index][band] +=
                    (current_spectrum[bin] - previous_local_max).max(0.0);
                band_bin_counts[band] += 1;
            }
        }
        previous_spectrum.copy_from_slice(&current_spectrum);
        for band in 0..BAND_COUNT {
            if band_bin_counts[band] > 0 {
                raw_flux[frame_index][band] /= band_bin_counts[band] as f32;
            }
        }
    }

    let normalized_bands = normalize_band_flux(&raw_flux);
    let novelty = combine_band_novelty(&normalized_bands);
    let onset_frames = pick_onset_frames(&novelty);
    let onsets = onset_frames
        .iter()
        .map(|&frame| RhythmOnsetPoint {
            time_ms: frame_to_ms(frame as f64, sample_rate).min(duration_ms),
            strength: unit(novelty[frame]),
            bands: normalized_bands[frame].map(unit),
            band_levels: onset_band_levels(&band_linear, frame),
        })
        .collect::<Vec<_>>();
    let (energy_envelope, energy_scale) = make_energy_envelope(&rms, sample_rate, duration_ms);

    let tempo_envelope = smooth_tempo_envelope(&novelty, &onset_frames);
    let global_tempo = estimate_tempo(&tempo_envelope, sample_rate);
    let (global_bpm, confidence, beats, tempo_segments) = match global_tempo {
        Some(tempo) => {
            let beats = build_beat_grid(&tempo_envelope, tempo, sample_rate, duration_ms);
            let coverage = beat_coverage(&beats);
            let confidence = unit(tempo.confidence * (0.75 + 0.25 * coverage));
            let segments =
                estimate_tempo_segments(&tempo_envelope, sample_rate, duration_ms, tempo);
            (Some(tempo.bpm), confidence, beats, segments)
        }
        None => (None, 0.0, Vec::new(), Vec::new()),
    };

    Ok(RhythmAnalysis {
        analyzer_version: RHYTHM_ANALYZER_VERSION,
        duration_ms,
        global_bpm,
        confidence,
        beats,
        onsets,
        tempo_segments,
        energy_envelope,
        energy_scale,
        loudness,
    })
}

fn samples_to_ms(samples: f64, sample_rate: u32) -> u64 {
    ((samples * 1_000.0 / sample_rate as f64).max(0.0)).round() as u64
}

fn frame_to_ms(frame: f64, sample_rate: u32) -> u64 {
    samples_to_ms(frame * HOP_SIZE as f64 + FFT_SIZE as f64 * 0.5, sample_rate)
}

fn frame_boundary_to_ms(frame: usize, sample_rate: u32) -> u64 {
    samples_to_ms(frame as f64 * HOP_SIZE as f64, sample_rate)
}

fn unit(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn hann_window() -> Vec<f32> {
    (0..FFT_SIZE)
        .map(|index| 0.5 - 0.5 * (2.0 * PI * index as f32 / (FFT_SIZE - 1) as f32).cos())
        .collect()
}

fn frequency_bin_bands(sample_rate: u32) -> Vec<Option<usize>> {
    let nyquist = sample_rate as f32 / 2.0;
    (0..=FFT_SIZE / 2)
        .map(|bin| {
            let frequency = bin as f32 * sample_rate as f32 / FFT_SIZE as f32;
            (0..BAND_COUNT).find(|&band| {
                let lower = BAND_EDGES_HZ[band];
                let upper = BAND_EDGES_HZ[band + 1].min(nyquist);
                frequency >= lower
                    && if band + 1 == BAND_COUNT {
                        frequency <= upper
                    } else {
                        frequency < upper
                    }
            })
        })
        .collect()
}

fn fft_in_place(real: &mut [f32], imaginary: &mut [f32]) {
    debug_assert_eq!(real.len(), imaginary.len());
    debug_assert!(real.len().is_power_of_two());
    let size = real.len();

    let mut reversed = 0_usize;
    for index in 1..size {
        let mut bit = size >> 1;
        while reversed & bit != 0 {
            reversed ^= bit;
            bit >>= 1;
        }
        reversed ^= bit;
        if index < reversed {
            real.swap(index, reversed);
            imaginary.swap(index, reversed);
        }
    }

    let mut length = 2;
    while length <= size {
        let angle = -2.0 * PI / length as f32;
        let step_real = angle.cos();
        let step_imaginary = angle.sin();
        for block_start in (0..size).step_by(length) {
            let mut twiddle_real = 1.0_f32;
            let mut twiddle_imaginary = 0.0_f32;
            for offset in 0..length / 2 {
                let even = block_start + offset;
                let odd = even + length / 2;
                let odd_real = real[odd] * twiddle_real - imaginary[odd] * twiddle_imaginary;
                let odd_imaginary = real[odd] * twiddle_imaginary + imaginary[odd] * twiddle_real;
                let even_real = real[even];
                let even_imaginary = imaginary[even];
                real[even] = even_real + odd_real;
                imaginary[even] = even_imaginary + odd_imaginary;
                real[odd] = even_real - odd_real;
                imaginary[odd] = even_imaginary - odd_imaginary;

                let next_real = twiddle_real * step_real - twiddle_imaginary * step_imaginary;
                twiddle_imaginary = twiddle_real * step_imaginary + twiddle_imaginary * step_real;
                twiddle_real = next_real;
            }
        }
        length <<= 1;
    }
}

fn percentile(values: impl IntoIterator<Item = f32>, fraction: f32) -> f32 {
    let mut values = values
        .into_iter()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return 0.0;
    }
    values.sort_unstable_by(f32::total_cmp);
    let index = ((values.len() - 1) as f32 * fraction.clamp(0.0, 1.0)).round() as usize;
    values[index]
}

fn normalize_band_flux(raw_flux: &[[f32; BAND_COUNT]]) -> Vec<[f32; BAND_COUNT]> {
    let mut scales = [0.0_f32; BAND_COUNT];
    for band in 0..BAND_COUNT {
        scales[band] = percentile(raw_flux.iter().map(|frame| frame[band]), 0.9).max(1.0e-7);
    }

    let mut mean = [0.0_f32; BAND_COUNT];
    let mut deviation = [0.02_f32; BAND_COUNT];
    let mut result = vec![[0.0_f32; BAND_COUNT]; raw_flux.len()];
    for (frame_index, flux) in raw_flux.iter().enumerate() {
        for band in 0..BAND_COUNT {
            let scaled = (flux[band] / scales[band]).min(12.0);
            let excess = scaled - mean[band] - deviation[band] * 0.35;
            let normalized = 1.0 - (-excess.max(0.0) / (deviation[band] * 2.5 + 0.08)).exp();
            result[frame_index][band] = unit(normalized);

            // Update after measuring the current frame so a transient is not used
            // to raise its own threshold. Slow release follows section loudness.
            let delta = scaled - mean[band];
            mean[band] += delta * 0.018;
            deviation[band] += (delta.abs() - deviation[band]) * 0.018;
        }
    }
    result
}

fn combine_band_novelty(bands: &[[f32; BAND_COUNT]]) -> Vec<f32> {
    bands
        .iter()
        .map(|values| {
            let mut sorted = *values;
            sorted.sort_unstable_by(|left, right| right.total_cmp(left));
            let strongest = (sorted[0] + sorted[1]) * 0.5;
            let average = values.iter().sum::<f32>() / BAND_COUNT as f32;
            unit(strongest * 0.68 + average * 0.32)
        })
        .collect()
}

/// Peak linear band level inside the same ±3 frame neighbourhood used for
/// onset peak picking, so the reported level still captures the transient when
/// the spectral-flux peak leads or trails the energy peak by a frame or two.
fn onset_band_levels(band_linear: &[[f32; BAND_COUNT]], frame: usize) -> [f32; BAND_COUNT] {
    if band_linear.is_empty() {
        return [0.0; BAND_COUNT];
    }
    let start = frame.saturating_sub(3);
    let end = (frame + 3).min(band_linear.len() - 1);
    let mut levels = [0.0_f32; BAND_COUNT];
    for frame_levels in &band_linear[start..=end] {
        for band in 0..BAND_COUNT {
            levels[band] = levels[band].max(frame_levels[band]);
        }
    }
    levels.map(|value| if value.is_finite() { value.max(0.0) } else { 0.0 })
}

fn pick_onset_frames(novelty: &[f32]) -> Vec<usize> {
    if novelty.len() < 3 {
        return Vec::new();
    }
    let mut candidates = Vec::new();
    for frame in 1..novelty.len() - 1 {
        let start = frame.saturating_sub(3);
        let end = (frame + 3).min(novelty.len() - 1);
        let is_peak = (start..=end).all(|nearby| {
            nearby == frame
                || novelty[frame] > novelty[nearby]
                || (nearby > frame && novelty[frame] == novelty[nearby])
        });
        if is_peak && novelty[frame] >= 0.14 {
            if let Some(previous) = candidates.last_mut()
                && frame - *previous < 4
            {
                if novelty[frame] > novelty[*previous] {
                    *previous = frame;
                }
                continue;
            }
            candidates.push(frame);
        }
    }
    candidates
}

fn make_energy_envelope(
    rms: &[f32],
    sample_rate: u32,
    duration_ms: u64,
) -> (Vec<RhythmTimedValue>, f32) {
    let scale = percentile(rms.iter().copied(), 0.95);
    if scale <= 1.0e-8 {
        return (Vec::new(), 0.0);
    }
    const FRAMES_PER_POINT: usize = 4;
    let mut points = Vec::with_capacity(rms.len().div_ceil(FRAMES_PER_POINT));
    for start in (0..rms.len()).step_by(FRAMES_PER_POINT) {
        let block = &rms[start..(start + FRAMES_PER_POINT).min(rms.len())];
        let mean = block.iter().sum::<f32>() / block.len() as f32;
        points.push(RhythmTimedValue {
            time_ms: frame_to_ms(start as f64, sample_rate).min(duration_ms),
            value: unit(mean / scale),
        });
    }
    (points, scale)
}

fn smooth_tempo_envelope(novelty: &[f32], onset_frames: &[usize]) -> Vec<f32> {
    let mut peaks = vec![0.0_f32; novelty.len()];
    for &frame in onset_frames {
        peaks[frame] = novelty[frame];
    }
    let mut smoothed = vec![0.0_f32; novelty.len()];
    const KERNEL: [f32; 5] = [0.12, 0.24, 0.28, 0.24, 0.12];
    for (frame, value) in smoothed.iter_mut().enumerate() {
        for (kernel_index, weight) in KERNEL.iter().enumerate() {
            let source = frame as isize + kernel_index as isize - 2;
            if source >= 0 && (source as usize) < peaks.len() {
                *value += peaks[source as usize] * weight;
            }
        }
    }
    smoothed
}

#[derive(Clone, Copy, Debug)]
struct TempoEstimate {
    bpm: f32,
    confidence: f32,
    period_frames: f32,
}

fn estimate_tempo(envelope: &[f32], sample_rate: u32) -> Option<TempoEstimate> {
    let frames_per_second = sample_rate as f32 / HOP_SIZE as f32;
    let min_lag = (frames_per_second * 60.0 / MAX_TEMPO_BPM).ceil() as usize;
    let max_lag = (frames_per_second * 60.0 / MIN_TEMPO_BPM).floor() as usize;
    if max_lag < min_lag
        || envelope.len() < max_lag.max((frames_per_second * 4.0) as usize)
        || envelope.iter().sum::<f32>() < 0.8
    {
        return None;
    }

    let mut correlation = vec![0.0_f32; max_lag * 2 + 1];
    // Correlations above the allowed tempo range are still useful for
    // rejecting half/third-tempo interpretations near the upper boundary.
    for lag in (min_lag / 3).max(1)..correlation.len() {
        if lag >= envelope.len() {
            break;
        }
        let mut product = 0.0_f32;
        let mut left_power = 0.0_f32;
        let mut right_power = 0.0_f32;
        for index in lag..envelope.len() {
            let left = envelope[index];
            let right = envelope[index - lag];
            product += left * right;
            left_power += left * left;
            right_power += right * right;
        }
        correlation[lag] = product / (left_power * right_power).sqrt().max(1.0e-8);
    }

    let mut scores = vec![0.0_f32; max_lag + 1];
    for lag in min_lag..=max_lag {
        let double = correlation.get(lag * 2).copied().unwrap_or(0.0);
        let half = correlation.get(lag / 2).copied().unwrap_or(0.0);
        let third_lag = (lag as f32 / 3.0).round() as usize;
        let third = correlation.get(third_lag).copied().unwrap_or(0.0);
        // A candidate whose half-lag is already strongly periodic is usually
        // the half-tempo interpretation. Penalizing that ambiguity keeps a
        // 120 BPM click train at 120 instead of systematically choosing 60.
        let harmonic_score = correlation[lag] + double * 0.35 - half * 0.25 - third * 0.20;
        let bpm = frames_per_second * 60.0 / lag as f32;
        let tempo_prior = (-0.5 * ((bpm / 120.0).log2() / 1.25).powi(2)).exp();
        scores[lag] = (harmonic_score.max(0.0) / 1.35) * (0.95 + tempo_prior * 0.05);
    }
    let (best_lag, &best_score) = (min_lag..=max_lag)
        .map(|lag| (lag, &scores[lag]))
        .max_by(|left, right| left.1.total_cmp(right.1))?;
    if best_score < 0.08 {
        return None;
    }

    let baseline = percentile(scores[min_lag..=max_lag].iter().copied(), 0.5);
    let contrast = unit((best_score - baseline) / (1.0 - baseline).max(1.0e-6));
    let left = scores[best_lag.saturating_sub(1).max(min_lag)];
    let right = scores[(best_lag + 1).min(max_lag)];
    let denominator = left - 2.0 * best_score + right;
    let offset = if denominator.abs() > 1.0e-6 {
        (0.5 * (left - right) / denominator).clamp(-0.5, 0.5)
    } else {
        0.0
    };
    let refined_period_frames = best_lag as f32 + offset;
    let raw_bpm = frames_per_second * 60.0 / refined_period_frames;
    if !raw_bpm.is_finite() {
        return None;
    }
    let bpm = raw_bpm.clamp(MIN_TEMPO_BPM, MAX_TEMPO_BPM);
    let period_frames = frames_per_second * 60.0 / bpm;
    let event_count = envelope.iter().filter(|value| **value >= 0.08).count() as f32;
    let expected_beats = envelope.len() as f32 / period_frames;
    let density = unit(event_count / (expected_beats * 3.0).max(1.0));
    let confidence = unit(best_score * 0.58 + contrast * 0.32 + density * 0.10);
    if confidence < 0.12 {
        None
    } else {
        Some(TempoEstimate {
            bpm,
            confidence,
            period_frames,
        })
    }
}

fn build_beat_grid(
    envelope: &[f32],
    tempo: TempoEstimate,
    sample_rate: u32,
    duration_ms: u64,
) -> Vec<RhythmBeatPoint> {
    if envelope.is_empty() || tempo.period_frames < 1.0 {
        return Vec::new();
    }
    let phase_steps = (tempo.period_frames * 4.0).ceil() as usize;
    let mut best_phase = 0.0_f32;
    let mut best_phase_score = f32::NEG_INFINITY;
    for step in 0..phase_steps {
        let phase = step as f32 / 4.0;
        let mut position = phase;
        let mut score = 0.0_f32;
        let mut count = 0_usize;
        while position < envelope.len() as f32 {
            let center = position.round() as usize;
            let start = center.saturating_sub(2);
            let end = (center + 2).min(envelope.len() - 1);
            score += envelope[start..=end]
                .iter()
                .copied()
                .fold(0.0_f32, f32::max);
            count += 1;
            position += tempo.period_frames;
        }
        let normalized = score / count.max(1) as f32;
        if normalized > best_phase_score {
            best_phase_score = normalized;
            best_phase = phase;
        }
    }

    let search_radius = (tempo.period_frames * 0.16).round().clamp(2.0, 8.0) as usize;
    let mut beats = Vec::new();
    let mut expected = best_phase;
    while expected < envelope.len() as f32 {
        let center = expected.round() as usize;
        let start = center.saturating_sub(search_radius);
        let end = (center + search_radius).min(envelope.len() - 1);
        let mut selected = center.min(envelope.len() - 1);
        let mut selected_score = 0.0_f32;
        for candidate in start..=end {
            let timing_penalty = (candidate as f32 - expected).abs() / search_radius as f32 * 0.18;
            let score = envelope[candidate] - timing_penalty;
            if score > selected_score {
                selected = candidate;
                selected_score = score;
            }
        }
        let local_strength = unit(envelope[selected] * 2.2);
        let selected_frame = if local_strength >= 0.06 {
            selected as f64
        } else {
            expected as f64
        };
        let time_ms = frame_to_ms(selected_frame, sample_rate).min(duration_ms);
        if beats
            .last()
            .is_none_or(|previous: &RhythmBeatPoint| previous.time_ms < time_ms)
        {
            beats.push(RhythmBeatPoint {
                time_ms,
                strength: local_strength,
                confidence: unit(tempo.confidence * (0.32 + local_strength * 0.68)),
            });
        }
        expected += tempo.period_frames;
    }
    beats
}

fn beat_coverage(beats: &[RhythmBeatPoint]) -> f32 {
    if beats.is_empty() {
        return 0.0;
    }
    unit(beats.iter().filter(|beat| beat.strength >= 0.12).count() as f32 / beats.len() as f32)
}

fn estimate_tempo_segments(
    envelope: &[f32],
    sample_rate: u32,
    duration_ms: u64,
    global: TempoEstimate,
) -> Vec<RhythmTempoSegment> {
    let frames_per_second = sample_rate as f32 / HOP_SIZE as f32;
    let window_frames = (frames_per_second * 18.0).round() as usize;
    if envelope.len() < window_frames + window_frames / 3 {
        return vec![RhythmTempoSegment {
            start_ms: 0,
            end_ms: duration_ms,
            bpm: global.bpm,
            confidence: global.confidence,
        }];
    }

    let mut raw_segments = Vec::new();
    for start in (0..envelope.len()).step_by(window_frames) {
        let end = (start + window_frames).min(envelope.len());
        let estimate = estimate_tempo(&envelope[start..end], sample_rate).unwrap_or(global);
        let start_ms = frame_boundary_to_ms(start, sample_rate).min(duration_ms);
        let end_ms = frame_boundary_to_ms(end, sample_rate).min(duration_ms);
        if start_ms >= end_ms {
            continue;
        }
        raw_segments.push(RhythmTempoSegment {
            start_ms,
            end_ms,
            bpm: estimate.bpm,
            confidence: estimate.confidence,
        });
    }

    let mut merged: Vec<RhythmTempoSegment> = Vec::new();
    for segment in raw_segments {
        if let Some(previous) = merged.last_mut()
            && (previous.bpm - segment.bpm).abs() <= previous.bpm * 0.025
        {
            let previous_duration = previous.end_ms.saturating_sub(previous.start_ms) as f32;
            let segment_duration = segment.end_ms.saturating_sub(segment.start_ms) as f32;
            let total_duration = (previous_duration + segment_duration).max(1.0);
            previous.bpm = (previous.bpm * previous_duration + segment.bpm * segment_duration)
                / total_duration;
            previous.confidence = unit(
                (previous.confidence * previous_duration + segment.confidence * segment_duration)
                    / total_duration,
            );
            previous.end_ms = segment.end_ms;
            continue;
        }
        merged.push(segment);
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn high_frequency_click_track(bpm: f32, seconds: f32) -> Vec<f32> {
        let mut pcm = vec![0.0_f32; (TARGET_SAMPLE_RATE as f32 * seconds) as usize];
        let beat_period = TARGET_SAMPLE_RATE as f32 * 60.0 / bpm;
        let mut beat = TARGET_SAMPLE_RATE as f32 * 0.25;
        while beat < pcm.len() as f32 {
            let start = beat.round() as usize;
            let burst_length = (TARGET_SAMPLE_RATE as f32 * 0.012) as usize;
            for offset in 0..burst_length.min(pcm.len() - start) {
                let decay = 1.0 - offset as f32 / burst_length as f32;
                pcm[start + offset] +=
                    (2.0 * PI * 6_500.0 * offset as f32 / TARGET_SAMPLE_RATE as f32).sin()
                        * decay
                        * 0.8;
            }
            beat += beat_period;
        }
        pcm
    }

    #[test]
    fn ffmpeg_invalid_data_errors_are_recoverable_only_within_budget() {
        let damaged_frame = AudioError::FFmpeg(
            ffmpeg_audio::sys::AVERROR_INVALIDDATA,
            "invalid data".to_owned(),
        );
        let unrelated_ffmpeg_error = AudioError::FFmpeg(-1, "unrelated".to_owned());

        assert!(can_skip_decode_error(&damaged_frame, 0));
        assert!(can_skip_decode_error(
            &damaged_frame,
            MAX_RECOVERABLE_DECODE_ERRORS - 1
        ));
        assert!(!can_skip_decode_error(
            &damaged_frame,
            MAX_RECOVERABLE_DECODE_ERRORS
        ));
        assert!(!can_skip_decode_error(&unrelated_ffmpeg_error, 0));
        assert!(!can_skip_decode_error(&AudioError::Eof, 0));
    }

    #[test]
    fn silence_has_no_false_rhythm() {
        let pcm = vec![0.0_f32; TARGET_SAMPLE_RATE as usize * 6];
        let analysis = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
        assert_eq!(analysis.global_bpm, None);
        assert_eq!(analysis.confidence, 0.0);
        assert!(analysis.beats.is_empty());
        assert!(analysis.onsets.is_empty());
        assert!(analysis.energy_envelope.is_empty());
        assert_eq!(analysis.energy_scale, 0.0);
        let loudness = analysis
            .loudness
            .expect("silence should be marked as analyzed");
        assert!(loudness.is_current());
        assert_eq!(loudness.integrated_loudness_lufs, None);
        assert_eq!(loudness.sample_peak, 0.0);
    }

    #[test]
    fn integrated_loudness_tracks_perceived_amplitude() {
        let pcm = (0..TARGET_SAMPLE_RATE as usize * 3)
            .map(|sample| {
                (2.0 * PI * 1_000.0 * sample as f32 / TARGET_SAMPLE_RATE as f32).sin() * 0.4
            })
            .collect::<Vec<_>>();
        let quieter_pcm = pcm.iter().map(|sample| sample * 0.5).collect::<Vec<_>>();
        let loud = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
        let quiet = analyze_mono_pcm(&quieter_pcm, TARGET_SAMPLE_RATE).unwrap();
        let loudness = loud.loudness.unwrap();
        let quiet_loudness = quiet.loudness.unwrap();
        let difference = loudness.integrated_loudness_lufs.unwrap()
            - quiet_loudness.integrated_loudness_lufs.unwrap();

        assert!(
            (difference - 6.0206).abs() < 0.05,
            "difference was {difference}"
        );
        assert!((loudness.sample_peak - 0.4).abs() < 1.0e-4);
        assert!((quiet_loudness.sample_peak - 0.2).abs() < 1.0e-4);
    }

    #[test]
    fn energy_scale_preserves_absolute_pcm_level() {
        let pcm = (0..TARGET_SAMPLE_RATE as usize * 2)
            .map(|sample| {
                (2.0 * PI * 440.0 * sample as f32 / TARGET_SAMPLE_RATE as f32).sin() * 0.6
            })
            .collect::<Vec<_>>();
        let quieter_pcm = pcm.iter().map(|sample| sample * 0.25).collect::<Vec<_>>();
        let loud = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
        let quiet = analyze_mono_pcm(&quieter_pcm, TARGET_SAMPLE_RATE).unwrap();

        assert!(loud.energy_scale > 0.0);
        assert!((loud.energy_scale / quiet.energy_scale - 4.0).abs() < 1.0e-4);
        assert_eq!(loud.energy_envelope.len(), quiet.energy_envelope.len());
        for (loud_point, quiet_point) in loud
            .energy_envelope
            .iter()
            .zip(quiet.energy_envelope.iter())
        {
            assert!((loud_point.value - quiet_point.value).abs() < 1.0e-5);
        }
    }

    #[test]
    fn high_frequency_clicks_are_detected_without_bass() {
        let pcm = high_frequency_click_track(120.0, 12.0);
        let analysis = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
        let bpm = analysis.global_bpm.expect("expected a tempo estimate");
        assert!((115.0..=125.0).contains(&bpm), "unexpected BPM: {bpm}");
        assert!(
            analysis.confidence > 0.2,
            "low confidence: {}",
            analysis.confidence
        );
        assert!(
            analysis.onsets.len() >= 18,
            "too few onsets: {}",
            analysis.onsets.len()
        );
        assert!(
            analysis.beats.len() >= 18,
            "too few beats: {}",
            analysis.beats.len()
        );
        assert!(analysis.onsets.iter().any(|onset| onset.bands[4] > 0.4));
    }

    #[test]
    fn fast_high_frequency_rhythm_does_not_collapse_to_half_or_third_tempo() {
        for expected_bpm in [174.0_f32, 205.0, 210.0] {
            let pcm = high_frequency_click_track(expected_bpm, 16.0);
            let analysis = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
            let bpm = analysis.global_bpm.expect("expected a fast tempo estimate");
            assert!(
                (bpm - expected_bpm).abs() <= 6.0,
                "expected about {expected_bpm} BPM, detected {bpm} BPM"
            );
        }
    }

    fn dual_band_track(seconds: f32) -> Vec<f32> {
        let mut pcm = vec![0.0_f32; (TARGET_SAMPLE_RATE as f32 * seconds) as usize];
        let mut write_burst = |start_s: f32, freq: f32, amp: f32, length_s: f32| {
            let start = (TARGET_SAMPLE_RATE as f32 * start_s) as usize;
            let burst_length = (TARGET_SAMPLE_RATE as f32 * length_s) as usize;
            for offset in 0..burst_length.min(pcm.len().saturating_sub(start)) {
                let decay = 1.0 - offset as f32 / burst_length as f32;
                pcm[start + offset] +=
                    (2.0 * PI * freq * offset as f32 / TARGET_SAMPLE_RATE as f32).sin()
                        * decay
                        * amp;
            }
        };
        let mut cursor = 0.25_f32;
        while cursor + 0.5 < seconds {
            // 响亮的低频鼓与安静的高频 tick 交替出现。
            write_burst(cursor, 80.0, 0.7, 0.04);
            write_burst(cursor + 0.25, 6_500.0, 0.06, 0.012);
            cursor += 0.5;
        }
        pcm
    }

    #[test]
    fn band_levels_capture_absolute_band_loudness() {
        let pcm = dual_band_track(12.0);
        let analysis = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();

        let mut kick_low_levels = Vec::new();
        let mut tick_high_levels = Vec::new();
        for onset in &analysis.onsets {
            // kick 落在 mod 500 ≈ 250 处,tick 落在 mod 500 ≈ 0 处;
            // frame_to_ms 的窗中心偏移约 +23ms,±40ms 容差足够覆盖。
            let phase_ms = onset.time_ms % 500;
            let near_kick = phase_ms.abs_diff(250) <= 40;
            let near_tick =
                onset.time_ms >= 400 && phase_ms.min(500 - phase_ms) <= 40;
            if near_kick {
                kick_low_levels.push(onset.band_levels[0]);
            } else if near_tick {
                tick_high_levels.push(onset.band_levels[4]);
            }
        }

        assert!(
            kick_low_levels.len() >= 8,
            "too few kick onsets: {}",
            kick_low_levels.len()
        );
        assert!(
            tick_high_levels.len() >= 8,
            "too few tick onsets: {}",
            tick_high_levels.len()
        );
        let kick_low = percentile(kick_low_levels.iter().copied(), 0.5);
        let tick_high = percentile(tick_high_levels.iter().copied(), 0.5);
        assert!(kick_low >= 0.05, "kick band level too small: {kick_low}");
        assert!(tick_high > 0.0, "tick band level missing: {tick_high}");
        assert!(
            kick_low >= tick_high * 4.0,
            "absolute band loudness ranking lost: kick={kick_low} tick={tick_high}"
        );

        let value = serde_json::to_value(&analysis).unwrap();
        let first_onset = value["onsets"][0]
            .as_object()
            .expect("onset should serialize as object");
        assert!(first_onset.contains_key("bandLevels"));
        assert!(first_onset.get("band_levels").is_none());

        let mut legacy_value = serde_json::to_value(&analysis).unwrap();
        for onset in legacy_value["onsets"].as_array_mut().unwrap() {
            onset.as_object_mut().unwrap().remove("bandLevels");
        }
        let restored: RhythmAnalysis = serde_json::from_value(legacy_value).unwrap();
        assert!(
            restored
                .onsets
                .iter()
                .all(|onset| onset.band_levels == [0.0; BAND_COUNT])
        );
    }

    #[test]
    fn json_contract_is_camel_case_and_round_trips() {
        let analysis = RhythmAnalysis::empty(1_234);
        let value = serde_json::to_value(&analysis).unwrap();
        assert_eq!(value["analyzerVersion"], RHYTHM_ANALYZER_VERSION);
        assert_eq!(value["durationMs"], 1_234);
        assert!(value["globalBpm"].is_null());
        assert_eq!(value["energyScale"], 0.0);
        assert_eq!(
            value["loudness"]["analyzerVersion"],
            LOUDNESS_ANALYZER_VERSION
        );
        assert!(value["loudness"]["integratedLoudnessLufs"].is_null());
        assert!(value.get("analyzer_version").is_none());
        let restored: RhythmAnalysis = serde_json::from_value(value).unwrap();
        assert_eq!(analysis, restored);

        let mut legacy_value = serde_json::to_value(&analysis).unwrap();
        legacy_value.as_object_mut().unwrap().remove("energyScale");
        legacy_value.as_object_mut().unwrap().remove("loudness");
        let restored_legacy: RhythmAnalysis = serde_json::from_value(legacy_value).unwrap();
        assert_eq!(restored_legacy.energy_scale, 0.0);
        assert_eq!(restored_legacy.loudness, None);
        assert!(!restored_legacy.has_current_loudness_analysis());
    }
}
