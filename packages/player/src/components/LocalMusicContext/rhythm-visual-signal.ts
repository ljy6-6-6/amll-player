import type {
	RhythmAnalysis,
	RhythmBeatPoint,
	RhythmOnsetPoint,
	RhythmTimedValue,
} from "../../utils/db-client.ts";

const BEAT_PRE_ROLL_MS = 140;
const ONSET_PRE_ROLL_MS = 55;
const ONSET_RELEASE_MS = 240;
const ONSET_BEAT_MERGE_MS = 180;
const MIN_BEAT_RELEASE_MS = 300;
const MAX_BEAT_RELEASE_MS = 520;
const STRONG_BEAT_PRE_ROLL_MS = 65;
const STRONG_BEAT_RELEASE_MS = 130;
const STRONG_BEAT_IMPACT_START = 0.96;
const STRONG_BEAT_IMPACT_FULL = 0.995;
const PERCUSSIVE_ACCENT_PRE_ROLL_MS = 55;
const PERCUSSIVE_ACCENT_RELEASE_MS = 170;
const PERCUSSIVE_ACCENT_GRID_TOLERANCE_RATIO = 0.32;
const PERCUSSIVE_ACCENT_GRID_TOLERANCE_MIN_MS = 90;
const PERCUSSIVE_ACCENT_GRID_TOLERANCE_MAX_MS = 180;
const PERCUSSIVE_ACCENT_GRID_COVERAGE_FULL = 0.4;
const PERCUSSIVE_ACCENT_GRID_COVERAGE_LIMIT = 0.5;
const PERCUSSIVE_ACCENT_MIN_SALIENT_ONSETS = 6;
const PERCUSSIVE_ACCENT_NMS_MS = 125;
const PERCUSSIVE_ACCENT_RAW_FLOOR = 0.18;
const PERCUSSIVE_ACCENT_STANDALONE_FLOOR = 0.64;
const PERCUSSIVE_ACCENT_QUANTILE_BIN_COUNT = 1024;

const VISUAL_ATTACK_MS = 70;
const VISUAL_RELEASE_MS = 250;
const BEAT_DYNAMIC_RANGE_SCALE = 0.2;
export const MAX_RHYTHM_VISUAL_STEP_MS = 50;

const ENERGY_SMOOTH_PAST_RADIUS_MS = 720;
const ENERGY_SMOOTH_FUTURE_RADIUS_MS = 160;
const ENERGY_SMOOTH_PAST_SIGMA_MS = 240;
const ENERGY_SMOOTH_FUTURE_SIGMA_MS = 90;
const ENERGY_SMOOTH_PAST_EDGE_MS = 240;
const ENERGY_SMOOTH_FUTURE_EDGE_MS = 80;
const BEAT_ENERGY_PEAK_RADIUS_MS = 90;
const BEAT_ENERGY_BASELINE_INNER_MS = 120;
const BEAT_ENERGY_BASELINE_RADIUS_MS = 320;

interface BeatStrengthProfile {
	lower: number;
	upper: number;
}

interface PercussiveAccentPoint {
	timeMs: number;
	strength: number;
	structured: boolean;
}

interface PercussiveAccentCandidate extends PercussiveAccentPoint {
	coveredByGrid: boolean;
}

interface PercussiveAccentProfile {
	gridCoverage: number;
	points: PercussiveAccentPoint[];
	strongPoints: PercussiveAccentPoint[];
}

const beatStrengthProfiles = new WeakMap<RhythmAnalysis, BeatStrengthProfile>();
const beatEnergyImpacts = new WeakMap<
	RhythmAnalysis,
	Map<RhythmBeatPoint, number>
>();
const usableBeatGridCache = new WeakMap<RhythmAnalysis, boolean>();
const percussiveAccentProfiles = new WeakMap<
	RhythmAnalysis,
	PercussiveAccentProfile
>();

/**
 * 保持现有 0..0.4 接口范围；Mesh 内部会在拆分慢呼吸与重拍相位前将其
 * 重新归一化到 0..1，避免放大其他背景实现的输入。
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
 * energyEnvelope 约每 46ms 产生一个折点。非对称高斯平滑保留少量前视以
 * 平顺起势，但主要向过去取样，避免在响度变化前数百毫秒出现呼吸 pre-echo。
 * 窗口边缘平滑归零，采样点进出窗口时也不会突跳。
 */
function sampleSmoothedEnergy(
	values: readonly RhythmTimedValue[],
	timeMs: number,
): number {
	if (values.length === 0 || !Number.isFinite(timeMs)) return 0;
	let weightedValue = 0;
	let totalWeight = 0;
	let index = lowerBound(values, timeMs - ENERGY_SMOOTH_PAST_RADIUS_MS);
	while (index < values.length) {
		const point = values[index];
		if (!point || point.timeMs > timeMs + ENERGY_SMOOTH_FUTURE_RADIUS_MS) break;
		const offsetMs = point.timeMs - timeMs;
		const isFuture = offsetMs >= 0;
		const radiusMs = isFuture
			? ENERGY_SMOOTH_FUTURE_RADIUS_MS
			: ENERGY_SMOOTH_PAST_RADIUS_MS;
		const sigmaMs = isFuture
			? ENERGY_SMOOTH_FUTURE_SIGMA_MS
			: ENERGY_SMOOTH_PAST_SIGMA_MS;
		const edgeMs = isFuture
			? ENERGY_SMOOTH_FUTURE_EDGE_MS
			: ENERGY_SMOOTH_PAST_EDGE_MS;
		const edgeWeight = smootherStep01((radiusMs - Math.abs(offsetMs)) / edgeMs);
		const weight =
			edgeWeight * Math.exp(-(offsetMs * offsetMs) / (2 * sigmaMs * sigmaMs));
		weightedValue += clamp01(point.value) * weight;
		totalWeight += weight;
		index++;
	}
	return totalWeight > Number.EPSILON
		? clamp01(weightedValue / totalWeight)
		: sampleEnergy(values, timeMs);
}

function quantile(sortedValues: readonly number[], amount: number): number {
	if (sortedValues.length === 0) return 0;
	const position = clamp01(amount) * (sortedValues.length - 1);
	const lowerIndex = Math.floor(position);
	const upperIndex = Math.ceil(position);
	const lower = sortedValues[lowerIndex] ?? 0;
	const upper = sortedValues[upperIndex] ?? lower;
	return lower + (upper - lower) * (position - lowerIndex);
}

function beatStrengthProfile(analysis: RhythmAnalysis): BeatStrengthProfile {
	const cached = beatStrengthProfiles.get(analysis);
	if (cached) return cached;

	const strengths = analysis.beats
		.map((point) => clamp01(point.strength))
		.filter((strength) => strength > 0)
		.sort((left, right) => left - right);
	const lower = quantile(strengths, 0.25);
	const profile = { lower, upper: quantile(strengths, 0.9) };
	beatStrengthProfiles.set(analysis, profile);
	return profile;
}

/**
 * novelty 衡量的是频谱变化，不等同于听感冲击；持续且等强的重低音可能
 * 因频谱形态相似而得到忽高忽低的 strength。用拍点附近 RMS 峰值相对
 * 局部底噪的抬升作为正交证据，持续响亮的铺底不会把每一拍都推成重拍。
 */
function beatEnergyImpact(
	analysis: RhythmAnalysis,
	beat: RhythmBeatPoint,
): number {
	let cached = beatEnergyImpacts.get(analysis);
	if (!cached) {
		cached = new Map<RhythmBeatPoint, number>();
		const energy = analysis.energyEnvelope;
		for (const point of analysis.beats) {
			let energyIndex = lowerBound(
				energy,
				point.timeMs - BEAT_ENERGY_BASELINE_RADIUS_MS,
			);
			let peak = 0;
			const localBaselineValues: number[] = [];
			while (energyIndex < energy.length) {
				const energyPoint = energy[energyIndex];
				if (
					!energyPoint ||
					energyPoint.timeMs > point.timeMs + BEAT_ENERGY_BASELINE_RADIUS_MS
				) {
					break;
				}
				const offsetMs = Math.abs(energyPoint.timeMs - point.timeMs);
				const value = clamp01(energyPoint.value);
				if (offsetMs <= BEAT_ENERGY_PEAK_RADIUS_MS) {
					peak = Math.max(peak, value);
				} else if (offsetMs >= BEAT_ENERGY_BASELINE_INNER_MS) {
					localBaselineValues.push(value);
				}
				energyIndex++;
			}
			localBaselineValues.sort((left, right) => left - right);
			const baseline = quantile(localBaselineValues, 0.2);
			const absoluteImpact = smootherStep01((peak - 0.35) / 0.55);
			const transientImpact = smootherStep01((peak - baseline - 0.1) / 0.45);
			cached.set(point, absoluteImpact * (0.2 + transientImpact * 0.8));
		}
		beatEnergyImpacts.set(analysis, cached);
	}
	return cached.get(beat) ?? 0;
}

function approximatePercussiveSalientThreshold(
	onsets: readonly RhythmOnsetPoint[],
): number {
	const bins = new Uint32Array(PERCUSSIVE_ACCENT_QUANTILE_BIN_COUNT);
	for (const onset of onsets) {
		const bin = Math.min(
			PERCUSSIVE_ACCENT_QUANTILE_BIN_COUNT - 1,
			Math.floor(
				clamp01(onset.strength) * PERCUSSIVE_ACCENT_QUANTILE_BIN_COUNT,
			),
		);
		bins[bin]++;
	}
	const position = 0.8 * (onsets.length - 1);
	const lowerRank = Math.floor(position);
	const upperRank = Math.ceil(position);
	let lowerValue: number | undefined;
	let upperValue = 0;
	let seen = 0;
	for (let bin = 0; bin < bins.length; bin++) {
		seen += bins[bin] ?? 0;
		const value = bin / PERCUSSIVE_ACCENT_QUANTILE_BIN_COUNT;
		if (seen > lowerRank && lowerValue === undefined) lowerValue = value;
		if (seen <= upperRank) continue;
		upperValue = value;
		break;
	}
	const amount = position - lowerRank;
	const lower = lowerValue ?? upperValue;
	return Math.max(0.65, lower + (upperValue - lower) * amount);
}

function onsetGridCoverageFlags(
	onsets: readonly RhythmOnsetPoint[],
	beats: readonly RhythmBeatPoint[],
	toleranceMs: number,
): Uint8Array {
	const covered = new Uint8Array(onsets.length);
	if (beats.length === 0) return covered;

	let beatIndex = 0;
	for (let onsetIndex = 0; onsetIndex < onsets.length; onsetIndex++) {
		const onset = onsets[onsetIndex];
		if (!onset) continue;
		while (beatIndex + 1 < beats.length) {
			const current = beats[beatIndex];
			const next = beats[beatIndex + 1];
			if (!(current && next)) break;
			const currentDistance = Math.abs(current.timeMs - onset.timeMs);
			const nextDistance = Math.abs(next.timeMs - onset.timeMs);
			if (nextDistance < currentDistance || next.timeMs === current.timeMs) {
				beatIndex++;
			} else {
				break;
			}
		}
		const nearest = beats[beatIndex];
		if (nearest && Math.abs(nearest.timeMs - onset.timeMs) <= toleranceMs) {
			covered[onsetIndex] = 1;
		}
	}
	return covered;
}

function peakEnergyAroundOnsets(
	onsets: readonly RhythmOnsetPoint[],
	energy: readonly RhythmTimedValue[],
	radiusMs: number,
): Float64Array {
	const peaks = new Float64Array(onsets.length);
	const deque = new Int32Array(energy.length);
	let head = 0;
	let tail = 0;
	let nextEnergy = 0;

	for (let onsetIndex = 0; onsetIndex < onsets.length; onsetIndex++) {
		const onset = onsets[onsetIndex];
		if (!onset) continue;
		const upper = onset.timeMs + radiusMs;
		const lower = onset.timeMs - radiusMs;
		while (
			nextEnergy < energy.length &&
			(energy[nextEnergy]?.timeMs ?? Number.POSITIVE_INFINITY) <= upper
		) {
			const value = clamp01(energy[nextEnergy]?.value ?? 0);
			while (
				tail > head &&
				clamp01(energy[deque[tail - 1] ?? 0]?.value ?? 0) <= value
			) {
				tail--;
			}
			deque[tail++] = nextEnergy++;
		}
		while (
			head < tail &&
			(energy[deque[head] ?? 0]?.timeMs ?? Number.NEGATIVE_INFINITY) < lower
		) {
			head++;
		}
		peaks[onsetIndex] =
			head < tail ? clamp01(energy[deque[head] ?? 0]?.value ?? 0) : 0;
	}
	return peaks;
}

function percussiveGridToleranceMs(analysis: RhythmAnalysis): number {
	const periodMs = analysis.globalBpm
		? 60_000 / Math.max(1, analysis.globalBpm)
		: PERCUSSIVE_ACCENT_GRID_TOLERANCE_MAX_MS /
			PERCUSSIVE_ACCENT_GRID_TOLERANCE_RATIO;
	return clamp(
		periodMs * PERCUSSIVE_ACCENT_GRID_TOLERANCE_RATIO,
		PERCUSSIVE_ACCENT_GRID_TOLERANCE_MIN_MS,
		PERCUSSIVE_ACCENT_GRID_TOLERANCE_MAX_MS,
	);
}

/**
 * 有些歌曲能建立全曲拍点网格，但局部敲击采用切分、三连击或完全不同的
 * 拍速。先用全曲 P80 强 onset 检查网格覆盖率；只有覆盖率确实偏低时，
 * 才从 onset 中提取稀疏的可听敲击，避免改变目前已经稳定的多数歌曲。
 *
 * 声学门控同时要求频谱变化、至少三个频带的展开以及局部可听能量。
 * “三声—停—三声”结构允许较弱的第二、第三声被同组强声补足，但结构
 * 本身不能让没有声学冲击的普通密集 onset 变成重拍。
 */
function percussiveAccentProfile(
	analysis: RhythmAnalysis,
): PercussiveAccentProfile {
	const cached = percussiveAccentProfiles.get(analysis);
	if (cached) return cached;

	const emptyProfile = { gridCoverage: 1, points: [], strongPoints: [] };
	if (!hasUsableBeatGrid(analysis) || analysis.onsets.length === 0) {
		percussiveAccentProfiles.set(analysis, emptyProfile);
		return emptyProfile;
	}

	const salientThreshold = approximatePercussiveSalientThreshold(
		analysis.onsets,
	);
	// 后端会在网格中保留 strength=0 的占位点；它们不能证明附近的
	// onset 已被正确解释，否则快歌或错相位网格会天然得到虚假的高覆盖率。
	const usableBeats = analysis.beats.filter(
		(point) => clamp01(point.strength) >= 0.06,
	);
	const gridToleranceMs = percussiveGridToleranceMs(analysis);
	const coveredByGrid = onsetGridCoverageFlags(
		analysis.onsets,
		usableBeats,
		gridToleranceMs,
	);
	let salientOnsetCount = 0;
	let coveredSalientOnsetCount = 0;
	for (let index = 0; index < analysis.onsets.length; index++) {
		if (clamp01(analysis.onsets[index]?.strength ?? 0) < salientThreshold) {
			continue;
		}
		salientOnsetCount++;
		coveredSalientOnsetCount += coveredByGrid[index] ?? 0;
	}
	const gridCoverage =
		coveredSalientOnsetCount / Math.max(1, salientOnsetCount);
	const coverageCorrection =
		1 -
		smootherStep01(
			(gridCoverage - PERCUSSIVE_ACCENT_GRID_COVERAGE_FULL) /
				(PERCUSSIVE_ACCENT_GRID_COVERAGE_LIMIT -
					PERCUSSIVE_ACCENT_GRID_COVERAGE_FULL),
		);
	if (
		salientOnsetCount < PERCUSSIVE_ACCENT_MIN_SALIENT_ONSETS ||
		coverageCorrection <= 0
	) {
		const profile = { gridCoverage, points: [], strongPoints: [] };
		percussiveAccentProfiles.set(analysis, profile);
		return profile;
	}

	const peakEnergies = peakEnergyAroundOnsets(
		analysis.onsets,
		analysis.energyEnvelope,
		90,
	);
	const candidates: PercussiveAccentCandidate[] = [];
	for (let onsetIndex = 0; onsetIndex < analysis.onsets.length; onsetIndex++) {
		const onset = analysis.onsets[onsetIndex];
		if (!onset) continue;
		const sortedBands = [...(onset.bands ?? [])].sort(
			(left, right) => right - left,
		);
		const bandBreadth =
			((sortedBands[0] ?? 0) + (sortedBands[1] ?? 0) + (sortedBands[2] ?? 0)) /
			3;
		const spectralStrength = smootherStep01(
			(clamp01(onset.strength) - 0.68) / 0.22,
		);
		const breadthStrength = smootherStep01((bandBreadth - 0.62) / 0.25);
		const audibleStrength = smootherStep01(
			((peakEnergies[onsetIndex] ?? 0) - 0.42) / 0.43,
		);
		const strength = Math.cbrt(
			spectralStrength * breadthStrength * audibleStrength,
		);
		if (strength < PERCUSSIVE_ACCENT_RAW_FLOOR) continue;

		const candidate = {
			timeMs: onset.timeMs,
			strength,
			structured: false,
			coveredByGrid: coveredByGrid[onsetIndex] === 1,
		};
		const previous = candidates[candidates.length - 1];
		if (
			previous &&
			candidate.timeMs - previous.timeMs < PERCUSSIVE_ACCENT_NMS_MS
		) {
			if (candidate.strength > previous.strength) {
				candidates[candidates.length - 1] = candidate;
			}
			continue;
		}
		candidates.push(candidate);
	}

	const structuredTimes = new Set<number>();
	for (let index = 0; index + 5 < candidates.length; index++) {
		const window = candidates.slice(index, index + 6);
		const [first, second, third, fourth, fifth, sixth] = window;
		if (!(first && second && third && fourth && fifth && sixth)) continue;
		const shortGaps = [
			second.timeMs - first.timeMs,
			third.timeMs - second.timeMs,
			fifth.timeMs - fourth.timeMs,
			sixth.timeMs - fifth.timeMs,
		].sort((left, right) => left - right);
		const referenceGap = quantile(shortGaps, 0.5);
		const pauseGap = fourth.timeMs - third.timeMs;
		const regularTriplets =
			referenceGap >= 150 &&
			referenceGap <= 360 &&
			shortGaps.every(
				(gap) => Math.abs(gap - referenceGap) <= referenceGap * 0.22,
			);
		const separatedGroups =
			pauseGap >= referenceGap * 1.55 && pauseGap <= referenceGap * 3.2;
		if (regularTriplets && separatedGroups) {
			for (const point of window) structuredTimes.add(point.timeMs);
		}
	}

	const points = candidates.flatMap((candidate) => {
		const structured = structuredTimes.has(candidate.timeMs);
		const rawStrength = structured
			? Math.max(candidate.strength, 0.52 + candidate.strength * 0.18)
			: candidate.strength;
		const strength = rawStrength * coverageCorrection;
		// 普通 onset 只补拍格没有解释到的动态；结构化三连击需要保留六声，
		// 即使其中一两声碰巧落在错误的慢速网格附近。
		return (structured ||
			(!candidate.coveredByGrid &&
				rawStrength >= PERCUSSIVE_ACCENT_STANDALONE_FLOOR)) &&
			strength >= PERCUSSIVE_ACCENT_RAW_FLOOR
			? [{ timeMs: candidate.timeMs, strength, structured }]
			: [];
	});
	// 普通漏拍会增强色块呼吸和跳动，但不会持续推动旋转。只有具备明确
	// “三声—停—三声”时序结构的敲击才进入中等旋转通道。
	const profile = {
		gridCoverage,
		points,
		strongPoints: points.filter((point) => point.structured),
	};
	percussiveAccentProfiles.set(analysis, profile);
	return profile;
}

function hasUsableBeatGrid(analysis: RhythmAnalysis): boolean {
	const cached = usableBeatGridCache.get(analysis);
	if (cached !== undefined) return cached;
	const result = analysis.beats.some(
		(point) => clamp01(point.strength) >= 0.06,
	);
	usableBeatGridCache.set(analysis, result);
	return result;
}

/** 将全曲中等以下拍点映射为轻触，把 P90 重拍明确拉到满幅。 */
export function normalizeBeatStrength(
	analysis: RhythmAnalysis,
	strength: number,
): number {
	const safeStrength = clamp01(strength);
	if (safeStrength <= 0) return 0;
	const profile = beatStrengthProfile(analysis);
	const spread = Math.max(0, profile.upper - profile.lower);
	const relativeContrast = smootherStep01(
		(safeStrength - profile.lower) / Math.max(0.001, spread),
	);
	const uniformContrast = smootherStep01(
		safeStrength / Math.max(0.001, profile.upper),
	);
	// 对窄动态曲目少用分位对比，避免听感一致的重拍仅因很小的
	// novelty 差异就在 0.12 与 1.0 之间交替。动态真正足够宽时，
	// 仍保留原有的强弱分层。
	const rangeBlend = smootherStep01(spread / BEAT_DYNAMIC_RANGE_SCALE);
	const contrast =
		uniformContrast + (relativeContrast - uniformContrast) * rangeBlend;
	// 后端以 0.06 作为可定位真实拍点的门槛；在同一范围内连续淡入，
	// 避免极弱拍的一点浮点变化让视觉信号从静止直接跳到满幅。
	const visibility = smootherStep01(safeStrength / 0.06);
	return visibility * (0.12 + contrast * 0.88);
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
	if (!(Number.isFinite(timeMs) && Number.isFinite(pointTimeMs))) return 0;
	const offset = timeMs - pointTimeMs;
	if (offset < -preRollMs || offset > releaseMs) return 0;
	if (offset <= 0) {
		return smootherStep01(1 + offset / Math.max(1, preRollMs));
	}
	return 1 - smootherStep01(offset / Math.max(1, releaseMs));
}

function sampleTimedPulses<T extends { timeMs: number }>(
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
	return clamp(periodMs * 0.55, MIN_BEAT_RELEASE_MS, MAX_BEAT_RELEASE_MS);
}

/**
 * 将分析结果变成连续的 0..1 视觉目标。
 *
 * beat 是主驱动；邻近 onset 只校正对应 beat 的强度，或在完全没有 beat
 * grid 时降级使用。这样既不会漏掉 novelty 低估的真实重拍，也不会让
 * 每秒数次的高密度 onset 独立制造视觉碎动。
 */
export function sampleAnalysisTarget(
	analysis: RhythmAnalysis,
	timeMs: number,
): number {
	if (!Number.isFinite(timeMs)) return 0;
	const energy = sampleSmoothedEnergy(analysis.energyEnvelope, timeMs);
	const hasBeatGrid = hasUsableBeatGrid(analysis);
	const beat = hasBeatGrid
		? sampleTimedPulses(
				analysis.beats,
				timeMs,
				BEAT_PRE_ROLL_MS,
				beatReleaseMs(analysis),
				(point) => {
					const normalizedStrength = normalizeBeatStrength(
						analysis,
						point.strength,
					);
					const impact = Math.max(
						normalizedStrength,
						beatEnergyImpact(analysis, point),
					);
					const beatValue = impact * (0.82 + clamp01(point.confidence) * 0.18);
					const placeholderBlend =
						1 - smootherStep01(clamp01(point.strength) / 0.06);
					const onsetValue =
						Math.sqrt(
							strongestOnsetAssignedToBeat(
								analysis.onsets,
								analysis.beats,
								point,
							),
						) *
						(0.76 + placeholderBlend * 0.12);
					// onset 只合并到最近的 beat，不独立制造高密度峰。正常拍也需要
					// 它校正 novelty 强度，否则窄动态的重低音会被误判成弱拍。
					return Math.max(beatValue, onsetValue);
				},
			)
		: 0;
	const onset = hasBeatGrid
		? 0
		: sampleTimedPulses(
				analysis.onsets,
				timeMs,
				ONSET_PRE_ROLL_MS,
				ONSET_RELEASE_MS,
				(point) => Math.sqrt(clamp01(point.strength)),
			);
	const percussiveAccent = sampleTimedPulses(
		percussiveAccentProfile(analysis).points,
		timeMs,
		PERCUSSIVE_ACCENT_PRE_ROLL_MS,
		PERCUSSIVE_ACCENT_RELEASE_MS,
		(point) => point.strength,
	);

	const breath = Math.sqrt(energy) * 0.2;
	const beatAccent = hasBeatGrid ? beat * 0.8 : 0;
	const onsetFallback = hasBeatGrid ? 0 : onset * 0.3;
	const residualAccent = percussiveAccent * 0.72;
	return clamp01(breath + Math.max(beatAccent, onsetFallback, residualAccent));
}

/**
 * 额外旋转只响应有明确能量冲击的极强拍点。它与连续呼吸信号分离，
 * 短脉冲结束后由 Mesh 内的物理包络慢慢卸力，使下一拍能在尚未回零时
 * 再次把画面推开，而不是生成等速、对称的正反摆动。
 */
export function sampleStrongBeatTarget(
	analysis: RhythmAnalysis,
	timeMs: number,
): number {
	if (!Number.isFinite(timeMs) || !hasUsableBeatGrid(analysis)) return 0;
	const lowFrequencyImpact = sampleTimedPulses(
		analysis.beats,
		timeMs,
		STRONG_BEAT_PRE_ROLL_MS,
		STRONG_BEAT_RELEASE_MS,
		(point) =>
			smootherStep01(
				(beatEnergyImpact(analysis, point) - STRONG_BEAT_IMPACT_START) /
					(STRONG_BEAT_IMPACT_FULL - STRONG_BEAT_IMPACT_START),
			),
	);
	const percussiveImpact = sampleTimedPulses(
		percussiveAccentProfile(analysis).strongPoints,
		timeMs,
		STRONG_BEAT_PRE_ROLL_MS,
		STRONG_BEAT_RELEASE_MS,
		(point) => {
			const continuousStrength =
				smootherStep01((point.strength - 0.45) / 0.45) * 0.35;
			return Math.max(0.22, continuousStrength);
		},
	);
	return Math.max(lowFrequencyImpact, percussiveImpact);
}

export function mapRhythmTargetToVolume(target: number): number {
	return clamp01(target) * MAX_RHYTHM_VISUAL_VOLUME;
}

/**
 * 丢帧后不追赶没有真正显示过的动画。音乐时间仍按真实进度采样，只有
 * 当前可见帧的视觉状态推进量受限，避免恢复渲染时一步跳到新姿态。
 */
export function limitRhythmVisualDelta(deltaMs: number): number {
	if (!Number.isFinite(deltaMs)) return 0;
	return Math.min(MAX_RHYTHM_VISUAL_STEP_MS, Math.max(0, deltaMs));
}

/**
 * 帧率无关的一阶滤波。Mesh 已将呼吸和旋转拆开，释放阶段可以恢复明确
 * 的收缩；不再为了旧的“音量直接叠加相位”公式牺牲重拍幅度。
 */
export function advanceRhythmVisualVolume(
	current: number,
	target: number,
	deltaMs: number,
): number {
	const safeCurrent = clamp(current, 0, MAX_RHYTHM_VISUAL_VOLUME);
	const safeTarget = clamp(target, 0, MAX_RHYTHM_VISUAL_VOLUME);
	const safeDeltaMs = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
	if (safeDeltaMs === 0) return safeCurrent;

	const smoothingMs =
		safeTarget > safeCurrent ? VISUAL_ATTACK_MS : VISUAL_RELEASE_MS;
	const smoothing = 1 - Math.exp(-safeDeltaMs / smoothingMs);
	return clamp(
		safeCurrent + (safeTarget - safeCurrent) * smoothing,
		0,
		MAX_RHYTHM_VISUAL_VOLUME,
	);
}
