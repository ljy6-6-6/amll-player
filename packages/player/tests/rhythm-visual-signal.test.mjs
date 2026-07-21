import assert from "node:assert/strict";
import test from "node:test";
import {
	advanceRhythmVisualVolume,
	mapRhythmTargetToVolume,
	sampleAnalysisTarget,
	sampleSmoothPulse,
} from "../src/components/LocalMusicContext/rhythm-visual-signal.ts";

function makeAnalysis({
	beatTime = 1_000,
	beatStrength = 0.9,
	onsetTime = null,
} = {}) {
	return {
		analyzerVersion: 1,
		durationMs: 4_000,
		globalBpm: 120,
		confidence: 0.65,
		beats: [
			{ timeMs: beatTime, strength: beatStrength, confidence: 0.8 },
			{ timeMs: beatTime + 500, strength: 0.8, confidence: 0.75 },
		],
		onsets:
			onsetTime === null
				? []
				: [
						{
							timeMs: onsetTime,
							strength: 1,
							bands: [0.1, 0.3, 0.7, 0.9, 1],
						},
					],
		tempoSegments: [],
		energyEnvelope: [
			{ timeMs: 0, value: 0.35 },
			{ timeMs: 4_000, value: 0.35 },
		],
	};
}

test("拍点包络在事件边界连续且峰值两侧没有突跳", () => {
	const before = sampleSmoothPulse(999.999, 1_000, 120, 340);
	const at = sampleSmoothPulse(1_000, 1_000, 120, 340);
	const after = sampleSmoothPulse(1_000.001, 1_000, 120, 340);

	assert.ok(Math.abs(at - before) < 1e-9);
	assert.ok(Math.abs(at - after) < 1e-9);
	assert.equal(at, 1);
});

test("同一拍点窗口内的 onset 与弱 beat 也只产生一个视觉峰", () => {
	for (const onsetOffsetMs of [-180, -160, -20, 20, 160, 180]) {
		const analysis = makeAnalysis({
			beatStrength: 0.3,
			onsetTime: 1_000 + onsetOffsetMs,
		});
		const samples = [];
		for (let timeMs = 650; timeMs <= 1_350; timeMs += 2) {
			samples.push(sampleAnalysisTarget(analysis, timeMs));
		}

		let localPeaks = 0;
		for (let index = 1; index < samples.length - 1; index++) {
			if (
				(samples[index] ?? 0) > (samples[index - 1] ?? 0) &&
				(samples[index] ?? 0) >= (samples[index + 1] ?? 0)
			) {
				localPeaks++;
			}
		}
		assert.equal(localPeaks, 1, `onset 偏移 ${onsetOffsetMs}ms 时出现双峰`);
	}
});

test("空拍占位会吸收邻近 onset 的强度而不是把真实打击删掉", () => {
	for (const beatStrength of [0, 0.001]) {
		const withoutOnset = makeAnalysis({ beatStrength });
		const withOnset = makeAnalysis({ beatStrength, onsetTime: 1_000 });
		const baseline = sampleAnalysisTarget(withoutOnset, 1_000);
		const accented = sampleAnalysisTarget(withOnset, 1_000);
		assert.ok(
			accented > baseline + 0.15,
			`beatStrength=${beatStrength} 时邻近 onset 未并入拍点`,
		);
	}
});

function simulateAtFPS(fps) {
	const analysis = makeAnalysis();
	const deltaMs = 1_000 / fps;
	let current = 0;
	const checkpoints = new Map();
	for (let frame = 0; frame <= fps * 2; frame++) {
		const timeMs = frame * deltaMs;
		const target = mapRhythmTargetToVolume(
			sampleAnalysisTarget(analysis, timeMs),
		);
		current = advanceRhythmVisualVolume(current, target, deltaMs);
		if (Math.abs(timeMs % 250) < 1e-6) {
			checkpoints.set(Math.round(timeMs), current);
		}
	}
	return checkpoints;
}

test("60/120/240Hz 下的视觉轨迹保持一致", () => {
	const at60 = simulateAtFPS(60);
	for (const fps of [120, 240]) {
		const candidate = simulateAtFPS(fps);
		for (const [timeMs, expected] of at60) {
			assert.ok(
				Math.abs((candidate.get(timeMs) ?? 0) - expected) < 0.012,
				`${fps}Hz 在 ${timeMs}ms 偏差过大`,
			);
		}
	}
});

test("释放阶段不会让 Mesh 背景旋转相位倒退", () => {
	const deltaMs = 1_000 / 240;
	let current = mapRhythmTargetToVolume(1);
	let previousPhase = current / 10;
	for (let timeMs = deltaMs; timeMs <= 2_000; timeMs += deltaMs) {
		current = advanceRhythmVisualVolume(current, 0, deltaMs);
		const phase = timeMs / 10_000 + current / 10;
		assert.ok(phase >= previousPhase - 1e-12, `相位在 ${timeMs}ms 倒退`);
		previousPhase = phase;
	}
});

test("Mesh 二级平滑及歌词页关闭重开时相位仍单调", () => {
	const deltaMs = 1_000 / 240;
	let appVolume = 0;
	let meshVolume = 0;
	let previousPhase = 0;
	let renderTimeMs = 0;
	let wasClosed = false;
	for (let timeMs = 0; timeMs <= 2_000; timeMs += deltaMs) {
		const target = timeMs < 600 ? mapRhythmTargetToVolume(1) : 0;
		// 歌词页在 800ms 关闭、1,200ms 重开；关闭期间保留同一个输入值。
		const lyricPageClosed = timeMs >= 800 && timeMs < 1_200;
		if (!lyricPageClosed) {
			appVolume = advanceRhythmVisualVolume(appVolume, target, deltaMs);
		}
		const meshTarget = appVolume / 10;
		const shouldRender = !lyricPageClosed || !wasClosed;
		if (shouldRender) {
			renderTimeMs += deltaMs;
			meshVolume += (meshTarget - meshVolume) * Math.min(1, deltaMs / 100);
		}

		const phase = renderTimeMs / 10_000 + meshVolume;
		assert.ok(phase >= previousPhase - 1e-12, `相位在 ${timeMs}ms 倒退`);
		previousPhase = phase;
		wasClosed = lyricPageClosed;
	}
});
