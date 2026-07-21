import {
	fftDataAtom,
	fftDataRangeAtom,
	isLyricPageOpenedAtom,
	lowFreqVolumeAtom,
	musicIdAtom,
	musicPlayingAtom,
	musicPlayingPositionAtom,
} from "@applemusic-like-lyrics/react-full";
import { useAtomValue, useStore } from "jotai";
import { type FC, useEffect } from "react";
import {
	currentRhythmAnalysisAtom,
	rhythmVisualResetAtom,
} from "../../states/appAtoms.ts";
import type {
	RhythmAnalysis,
	RhythmBeatPoint,
	RhythmOnsetPoint,
	RhythmTimedValue,
} from "../../utils/db-client.ts";
import { emitAudioThread } from "../../utils/player.ts";

export const SILENT_RHYTHM_VOLUME = 0.0001;

const ANALYSIS_FADE_IN_MS = 300;
const BEAT_DECAY_MS = 180;
const ONSET_DECAY_MS = 140;
const ATTACK_MS = 35;
const RELEASE_MS = 240;

interface SpectralFluxState {
	lastFrame: number[] | null;
	lastSource: number[] | null;
	fluxHistory: number[];
	energyPeak: number;
	target: number;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
	}
	return sorted[middle] ?? 0;
}

function lowerBound<T extends { timeMs: number }>(
	values: readonly T[],
	timeMs: number,
): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((values[middle]?.timeMs ?? Number.POSITIVE_INFINITY) < timeMs) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

function sampleEnergy(
	values: readonly RhythmTimedValue[],
	timeMs: number,
): number {
	if (values.length === 0) return 0;
	const nextIndex = lowerBound(values, timeMs);
	if (nextIndex === 0) return clamp01(values[0]?.value ?? 0);
	if (nextIndex >= values.length) {
		return clamp01(values[values.length - 1]?.value ?? 0);
	}

	const previous = values[nextIndex - 1];
	const next = values[nextIndex];
	if (!(previous && next)) return 0;
	const span = next.timeMs - previous.timeMs;
	if (span <= 0) return clamp01(next.value);
	const amount = clamp01((timeMs - previous.timeMs) / span);
	return clamp01(previous.value + (next.value - previous.value) * amount);
}

function sampleDecayingPoints<T extends RhythmBeatPoint | RhythmOnsetPoint>(
	values: readonly T[],
	timeMs: number,
	decayMs: number,
	getValue: (point: T) => number,
): number {
	let index = lowerBound(values, timeMs);
	if (values[index]?.timeMs !== timeMs) index--;
	let result = 0;
	for (; index >= 0; index--) {
		const point = values[index];
		if (!point) break;
		const age = timeMs - point.timeMs;
		if (age > decayMs * 5) break;
		result = Math.max(
			result,
			clamp01(getValue(point)) * Math.exp(-age / decayMs),
		);
	}
	return clamp01(result);
}

function sampleAnalysis(analysis: RhythmAnalysis, timeMs: number): number {
	const energy = sampleEnergy(analysis.energyEnvelope, timeMs);
	const onset = sampleDecayingPoints(
		analysis.onsets,
		timeMs,
		ONSET_DECAY_MS,
		(point) => point.strength,
	);
	const beat = sampleDecayingPoints(
		analysis.beats,
		timeMs,
		BEAT_DECAY_MS,
		(point) => point.strength * point.confidence * clamp01(analysis.confidence),
	);
	return clamp01(energy * 0.3 + onset * 0.45 + beat * 0.25);
}

function resetSpectralFlux(
	state: SpectralFluxState,
	currentSource: number[] | null,
): void {
	state.lastFrame = null;
	state.lastSource = currentSource;
	state.fluxHistory = [];
	state.energyPeak = 0;
	state.target = 0;
}

function updateSpectralFlux(
	state: SpectralFluxState,
	spectrum: number[],
): number {
	if (spectrum === state.lastSource) return state.target;
	state.lastSource = spectrum;
	if (spectrum.length === 0) {
		state.target = 0;
		return 0;
	}

	const frame = spectrum.map((value) => Math.log1p(Math.max(0, value)));
	const previous = state.lastFrame;
	state.lastFrame = frame;

	const energy = frame.reduce((sum, value) => sum + value, 0) / frame.length;
	state.energyPeak = Math.max(energy, state.energyPeak * 0.97);
	const normalizedEnergy =
		state.energyPeak > Number.EPSILON ? energy / state.energyPeak : 0;

	if (!previous || previous.length !== frame.length) {
		state.target = clamp01(normalizedEnergy * 0.2);
		return state.target;
	}

	let squaredFlux = 0;
	for (let index = 0; index < frame.length; index++) {
		const difference = Math.max(
			0,
			(frame[index] ?? 0) - (previous[index] ?? 0),
		);
		squaredFlux += difference * difference;
	}
	const flux = Math.sqrt(squaredFlux / frame.length);
	state.fluxHistory.push(flux);
	if (state.fluxHistory.length > 40) state.fluxHistory.shift();

	const baseline = median(state.fluxHistory);
	const deviations = state.fluxHistory.map((value) =>
		Math.abs(value - baseline),
	);
	const deviation = median(deviations);
	const threshold = baseline + deviation * 1.5;
	const normalizedFlux = clamp01(
		(flux - threshold) / Math.max(deviation * 6, baseline * 0.5, 0.0001),
	);

	state.target = clamp01(normalizedEnergy * 0.25 + normalizedFlux * 0.75);
	return state.target;
}

/**
 * 将本地整轨分析或分析完成前的全频谱 flux 适配到现有背景强度接口。
 */
export const LocalRhythmVisualContext: FC = () => {
	const store = useStore();
	const fftDataRange = useAtomValue(fftDataRangeAtom);
	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const musicPlaying = useAtomValue(musicPlayingAtom);

	useEffect(() => {
		emitAudioThread("setFFTRange", {
			fromFreq: fftDataRange[0],
			toFreq: fftDataRange[1],
		});
	}, [fftDataRange]);

	useEffect(() => {
		if (!(isLyricPageOpened && musicPlaying)) {
			store.set(lowFreqVolumeAtom, SILENT_RHYTHM_VOLUME);
			return;
		}

		let animationFrame = 0;
		let lastFrameTime = performance.now();
		let lastPosition: number | null = null;
		let lastMusicId = "";
		let lastGeneration = -1;
		let lastResetSignal = store.get(rhythmVisualResetAtom);
		let analysisBlend = 0;
		let smoothedValue = 0;
		const spectralState: SpectralFluxState = {
			lastFrame: null,
			lastSource: null,
			fluxHistory: [],
			energyPeak: 0,
			target: 0,
		};

		const resetSmoothing = (spectrum: number[] | null) => {
			smoothedValue = 0;
			lastPosition = null;
			resetSpectralFlux(spectralState, spectrum);
		};

		const update = (frameTime: number) => {
			const deltaMs = Math.min(100, Math.max(0, frameTime - lastFrameTime));
			lastFrameTime = frameTime;

			const musicId = store.get(musicIdAtom);
			const position = store.get(musicPlayingPositionAtom);
			const spectrum = store.get(fftDataAtom);
			const rhythmState = store.get(currentRhythmAnalysisAtom);
			const generation = rhythmState?.generation ?? -1;
			const resetSignal = store.get(rhythmVisualResetAtom);

			if (musicId !== lastMusicId || generation !== lastGeneration) {
				lastMusicId = musicId;
				lastGeneration = generation;
				analysisBlend = 0;
				resetSmoothing(spectrum);
			}
			if (resetSignal !== lastResetSignal) {
				lastResetSignal = resetSignal;
				resetSmoothing(spectrum);
			}

			if (
				lastPosition !== null &&
				(position < lastPosition - 20 ||
					Math.abs(position - lastPosition) > Math.max(250, deltaMs * 3))
			) {
				resetSmoothing(spectrum);
			}
			lastPosition = position;

			const fallback = updateSpectralFlux(spectralState, spectrum);
			const analysis =
				rhythmState?.musicId === musicId ? rhythmState.analysis : null;
			let target = fallback;
			if (analysis) {
				analysisBlend = Math.min(
					1,
					analysisBlend + deltaMs / ANALYSIS_FADE_IN_MS,
				);
				const analyzed = sampleAnalysis(analysis, position);
				target = fallback + (analyzed - fallback) * analysisBlend;
			} else if (rhythmState && rhythmState.musicId !== musicId) {
				target = 0;
			}

			const smoothingMs = target > smoothedValue ? ATTACK_MS : RELEASE_MS;
			const smoothing = 1 - Math.exp(-deltaMs / smoothingMs);
			smoothedValue += (target - smoothedValue) * smoothing;
			store.set(
				lowFreqVolumeAtom,
				Math.max(SILENT_RHYTHM_VOLUME, clamp01(smoothedValue)),
			);

			animationFrame = requestAnimationFrame(update);
		};

		animationFrame = requestAnimationFrame(update);
		return () => {
			cancelAnimationFrame(animationFrame);
			store.set(lowFreqVolumeAtom, SILENT_RHYTHM_VOLUME);
		};
	}, [isLyricPageOpened, musicPlaying, store]);

	return null;
};
