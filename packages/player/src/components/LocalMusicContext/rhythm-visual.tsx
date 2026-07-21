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
import { type FC, useEffect, useLayoutEffect } from "react";
import {
	currentRhythmAnalysisAtom,
	rhythmVisualResetAtom,
} from "../../states/appAtoms.ts";
import { emitAudioThread } from "../../utils/player.ts";
import {
	advanceRhythmVisualVolume,
	clamp01,
	MAX_RHYTHM_VISUAL_VOLUME,
	mapRhythmTargetToVolume,
	sampleAnalysisTarget,
	smootherStep01,
} from "./rhythm-visual-signal.ts";

export const SILENT_RHYTHM_VOLUME = 0.0001;

const ANALYSIS_FADE_IN_MS = 500;
const ANALYSIS_FALLBACK_WEIGHT = 0.1;

interface SpectralFluxState {
	lastFrame: number[] | null;
	lastSource: number[] | null;
	fluxHistory: number[];
	energyPeak: number;
	target: number;
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

	useLayoutEffect(() => {
		const currentVolume = store.get(lowFreqVolumeAtom);
		if (
			!Number.isFinite(currentVolume) ||
			currentVolume < 0 ||
			currentVolume > MAX_RHYTHM_VISUAL_VOLUME
		) {
			store.set(lowFreqVolumeAtom, SILENT_RHYTHM_VOLUME);
		}
	}, [store]);

	useEffect(() => {
		emitAudioThread("setFFTRange", {
			fromFreq: fftDataRange[0],
			toFreq: fftDataRange[1],
		});
	}, [fftDataRange]);

	useEffect(() => {
		if (!isLyricPageOpened) return;

		let animationFrame = 0;
		let lastFrameTime = performance.now();
		let lastPosition: number | null = null;
		let lastMusicId = "";
		let lastGeneration = -1;
		let lastResetSignal = store.get(rhythmVisualResetAtom);
		let analysisBlend = 0;
		let smoothedValue = store.get(lowFreqVolumeAtom);
		const spectralState: SpectralFluxState = {
			lastFrame: null,
			lastSource: null,
			fluxHistory: [],
			energyPeak: 0,
			target: 0,
		};

		const resetSampling = (spectrum: number[] | null) => {
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
			const playing = store.get(musicPlayingAtom);
			const generation = rhythmState?.generation ?? -1;
			const resetSignal = store.get(rhythmVisualResetAtom);

			if (musicId !== lastMusicId || generation !== lastGeneration) {
				lastMusicId = musicId;
				lastGeneration = generation;
				analysisBlend = 0;
				resetSampling(spectrum);
			}
			if (resetSignal !== lastResetSignal) {
				lastResetSignal = resetSignal;
				resetSampling(spectrum);
			}

			if (
				lastPosition !== null &&
				(position < lastPosition - 20 ||
					Math.abs(position - lastPosition) > Math.max(250, deltaMs * 3))
			) {
				resetSampling(spectrum);
			}
			lastPosition = position;

			const fallback = updateSpectralFlux(spectralState, spectrum);
			const analysis =
				rhythmState?.musicId === musicId ? rhythmState.analysis : null;
			let normalizedTarget = playing ? fallback : 0;
			if (playing && analysis) {
				analysisBlend = Math.min(
					1,
					analysisBlend + deltaMs / ANALYSIS_FADE_IN_MS,
				);
				const analyzed = sampleAnalysisTarget(analysis, position);
				const analyzedWithTexture = clamp01(
					analyzed * (1 - ANALYSIS_FALLBACK_WEIGHT) +
						fallback * ANALYSIS_FALLBACK_WEIGHT,
				);
				normalizedTarget =
					fallback +
					(analyzedWithTexture - fallback) * smootherStep01(analysisBlend);
			}

			const targetVolume = mapRhythmTargetToVolume(normalizedTarget);
			smoothedValue = advanceRhythmVisualVolume(
				smoothedValue,
				targetVolume,
				deltaMs,
			);
			store.set(
				lowFreqVolumeAtom,
				Math.max(SILENT_RHYTHM_VOLUME, smoothedValue),
			);

			animationFrame = requestAnimationFrame(update);
		};

		animationFrame = requestAnimationFrame(update);
		return () => {
			cancelAnimationFrame(animationFrame);
		};
	}, [isLyricPageOpened, store]);

	return null;
};
