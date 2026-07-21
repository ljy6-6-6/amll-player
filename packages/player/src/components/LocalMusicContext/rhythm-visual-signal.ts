import type {
	RhythmAnalysis,
	RhythmBeatPoint,
	RhythmOnsetPoint,
	RhythmTimedValue,
} from "../../utils/db-client.ts";

const BEAT_PRE_ROLL_MS = 120;
const ONSET_PRE_ROLL_MS = 55;
const ONSET_RELEASE_MS = 200;
const ONSET_BEAT_MERGE_MS = 180;
const MIN_BEAT_RELEASE_MS = 260;
const MAX_BEAT_RELEASE_MS = 500;

const VISUAL_ATTACK_MS = 90;
const VISUAL_RELEASE_MS = 380;
const MAX_RISE_PER_MS = 0.0025;
const MAX_FALL_PER_MS = 0.00075;

/**
 * Mesh 背景会把该值同时用于纹理缩放和旋转相位。限制满幅可以保留
 * 节拍感，同时避免相位发生肉眼可见的前跳。
 */
export const MAX_RHYTHM_VISUAL_VOLUME = 0.4;

export function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

/** 两端一阶、二阶导数均为零，适合直接驱动视觉相位。 */
export function smootherStep01(value: number): number {
	const x = clamp01(value);
	return x * x * x * (x * (x * 6 - 15) + 10);
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

function nearestPoint<T extends { timeMs: number }>(
	values: readonly T[],
	timeMs: number,
	toleranceMs: number,
): T | undefined {
	const nextIndex = lowerBound(values, timeMs);
	const previous = values[nextIndex - 1];
	const next = values[nextIndex];
	const previousDistance = previous
		? Math.abs(previous.timeMs - timeMs)
		: Number.POSITIVE_INFINITY;
	const nextDistance = next
		? Math.abs(next.timeMs - timeMs)
		: Number.POSITIVE_INFINITY;
	const nearest = nextDistance < previousDistance ? next : previous;
	return Math.min(previousDistance, nextDistance) <= toleranceMs
		? nearest
		: undefined;
}

function strongestOnsetAssignedToBeat(
	onsets: readonly RhythmOnsetPoint[],
	beats: readonly RhythmBeatPoint[],
	beat: RhythmBeatPoint,
): number {
	let onsetIndex = lowerBound(onsets, beat.timeMs - ONSET_BEAT_MERGE_MS);
	let result = 0;
	while (onsetIndex < onsets.length) {
		const onset = onsets[onsetIndex];
		if (!onset || onset.timeMs > beat.timeMs + ONSET_BEAT_MERGE_MS) break;
		if (nearestPoint(beats, onset.timeMs, ONSET_BEAT_MERGE_MS) === beat) {
			result = Math.max(result, clamp01(onset.strength));
		}
		onsetIndex++;
	}
	return result;
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

/**
 * 完整本地文件允许预知下一拍，因此在事件前平滑预起，在事件后平滑回落。
 * 该包络在事件点两侧都连续且导数为零，不会像指数脉冲一样突然换相位。
 */
export function sampleSmoothPulse(
	timeMs: number,
	pointTimeMs: number,
	preRollMs: number,
	releaseMs: number,
): number {
	const offset = timeMs - pointTimeMs;
	if (offset < -preRollMs || offset > releaseMs) return 0;
	if (offset <= 0) {
		return smootherStep01(1 + offset / Math.max(1, preRollMs));
	}
	return 1 - smootherStep01(offset / Math.max(1, releaseMs));
}

function sampleTimedPulses<T extends RhythmBeatPoint | RhythmOnsetPoint>(
	values: readonly T[],
	timeMs: number,
	preRollMs: number,
	releaseMs: number,
	getValue: (point: T) => number,
): number {
	if (values.length === 0) return 0;
	const nextIndex = lowerBound(values, timeMs);
	let result = 0;

	const next = values[nextIndex];
	if (next && next.timeMs - timeMs <= preRollMs) {
		result = Math.max(
			result,
			clamp01(getValue(next)) *
				sampleSmoothPulse(timeMs, next.timeMs, preRollMs, releaseMs),
		);
	}

	for (let index = nextIndex - 1; index >= 0; index--) {
		const point = values[index];
		if (!point) break;
		if (timeMs - point.timeMs > releaseMs) break;
		result = Math.max(
			result,
			clamp01(getValue(point)) *
				sampleSmoothPulse(timeMs, point.timeMs, preRollMs, releaseMs),
		);
	}
	return clamp01(result);
}

function beatReleaseMs(analysis: RhythmAnalysis): number {
	const periodMs = analysis.globalBpm
		? 60_000 / Math.max(1, analysis.globalBpm)
		: 500;
	return clamp(periodMs * 0.68, MIN_BEAT_RELEASE_MS, MAX_BEAT_RELEASE_MS);
}

/**
 * 将分析结果变成连续的 0..1 视觉目标。
 *
 * beat 是主驱动；高密度 onset 只在 beat 较弱或缺失时作为辅助纹理，且两者
 * 使用 max 合并，避免同一个打击先触发 onset、随后又触发 beat 的双闪。
 */
export function sampleAnalysisTarget(
	analysis: RhythmAnalysis,
	timeMs: number,
): number {
	const energy = sampleEnergy(analysis.energyEnvelope, timeMs);
	const reliability = smootherStep01(
		(clamp01(analysis.confidence) - 0.12) / 0.55,
	);
	const beat = sampleTimedPulses(
		analysis.beats,
		timeMs,
		BEAT_PRE_ROLL_MS,
		beatReleaseMs(analysis),
		(point) => {
			const beatValue = Math.sqrt(
				clamp01(point.strength) * (0.5 + clamp01(point.confidence) * 0.5),
			);
			const mergedOnsetValue =
				Math.sqrt(
					strongestOnsetAssignedToBeat(analysis.onsets, analysis.beats, point),
				) *
				(0.68 - reliability * 0.06);
			return Math.max(beatValue, mergedOnsetValue);
		},
	);
	const onset = sampleTimedPulses(
		analysis.onsets,
		timeMs,
		ONSET_PRE_ROLL_MS,
		ONSET_RELEASE_MS,
		(point) =>
			nearestPoint(analysis.beats, point.timeMs, ONSET_BEAT_MERGE_MS)
				? 0
				: Math.sqrt(clamp01(point.strength)),
	);

	const beatAccent = beat * (0.36 + reliability * 0.16);
	const onsetAccent = onset * (0.13 - reliability * 0.07);
	return clamp01(energy * 0.38 + Math.max(beatAccent, onsetAccent));
}

export function mapRhythmTargetToVolume(target: number): number {
	return clamp01(target) * MAX_RHYTHM_VISUAL_VOLUME;
}

/**
 * 帧率无关的一阶滤波，再增加绝对斜率限制。下降最多 0.75/s，低于 Mesh
 * 背景相位发生反向运动的 1.0/s 临界值。
 */
export function advanceRhythmVisualVolume(
	current: number,
	target: number,
	deltaMs: number,
): number {
	const safeCurrent = clamp(current, 0, MAX_RHYTHM_VISUAL_VOLUME);
	const safeTarget = clamp(target, 0, MAX_RHYTHM_VISUAL_VOLUME);
	const safeDeltaMs = clamp(deltaMs, 0, 100);
	if (safeDeltaMs === 0) return safeCurrent;

	const smoothingMs =
		safeTarget > safeCurrent ? VISUAL_ATTACK_MS : VISUAL_RELEASE_MS;
	const smoothing = 1 - Math.exp(-safeDeltaMs / smoothingMs);
	const candidate = safeCurrent + (safeTarget - safeCurrent) * smoothing;
	const limitedDelta = clamp(
		candidate - safeCurrent,
		-MAX_FALL_PER_MS * safeDeltaMs,
		MAX_RISE_PER_MS * safeDeltaMs,
	);
	return clamp(safeCurrent + limitedDelta, 0, MAX_RHYTHM_VISUAL_VOLUME);
}
