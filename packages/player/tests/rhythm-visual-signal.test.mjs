import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	advanceRhythmVisualVolume,
	limitRhythmVisualDelta,
	mapRhythmTargetToVolume,
	normalizeBeatStrength,
	sampleAnalysisTarget,
	sampleSmoothPulse,
	sampleStrongBeatTarget,
} from "../src/components/LocalMusicContext/rhythm-visual-signal.ts";

globalThis.MouseEvent ??= class {};
const { MeshGradientRenderer } = await import(
	"../node_modules/@applemusic-like-lyrics/core/dist/amll-core.mjs"
);

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

test("可靠 beat grid 会屏蔽高密度 onset 的独立碎动", () => {
	const withoutOnsets = makeAnalysis();
	const withDenseOnsets = {
		...withoutOnsets,
		onsets: Array.from({ length: 18 }, (_, index) => ({
			timeMs: 650 + index * 70,
			strength: index % 2 === 0 ? 1 : 0.45,
			bands: [0.2, 0.4, 0.7, 0.9, 1],
		})),
	};

	for (let timeMs = 650; timeMs <= 1_850; timeMs += 5) {
		assert.equal(
			sampleAnalysisTarget(withDenseOnsets, timeMs),
			sampleAnalysisTarget(withoutOnsets, timeMs),
			`高密度 onset 在 ${timeMs}ms 改变了可靠拍点轨迹`,
		);
	}
});

test("单个有效拍点可驱动视觉，纯空拍网格则回退到 onset", () => {
	const singleBeat = {
		...makeAnalysis(),
		beats: [{ timeMs: 1_000, strength: 0.8, confidence: 0.8 }],
		onsets: [],
	};
	assert.ok(sampleAnalysisTarget(singleBeat, 1_000) > 0.5);

	const emptyGrid = {
		...makeAnalysis({ onsetTime: 1_000 }),
		beats: [
			{ timeMs: 500, strength: 0, confidence: 0.1 },
			{ timeMs: 1_500, strength: 0, confidence: 0.1 },
		],
	};
	assert.ok(sampleAnalysisTarget(emptyGrid, 1_000) > 0.2);
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

test("正常 beat 也会合并同拍 onset，修正被 novelty 低估的重拍", () => {
	const withoutOnset = makeAnalysis({ beatStrength: 0.43 });
	const withOnset = makeAnalysis({ beatStrength: 0.43, onsetTime: 1_000 });
	const baseline = sampleAnalysisTarget(withoutOnset, 1_000);
	const corrected = sampleAnalysisTarget(withOnset, 1_000);

	assert.ok(corrected >= 0.65, `同拍 onset 合并后仅达到 ${corrected}`);
	assert.ok(
		corrected > baseline + 0.25,
		`正常 beat 的 onset 校正幅度不足：${baseline} -> ${corrected}`,
	);
});

test("拍点附近的高能量会补强持续重低音，而不会依赖 novelty 抖动", () => {
	const beatStrengths = [0.33, 0.44, 0.56, 0.41];
	const analysis = {
		...makeAnalysis(),
		durationMs: 3_000,
		beats: beatStrengths.map((strength, index) => ({
			timeMs: 750 + index * 500,
			strength,
			confidence: 0.45,
		})),
		onsets: [],
		energyEnvelope: beatStrengths.flatMap((_, index) => {
			const beatTime = 750 + index * 500;
			return [
				{ timeMs: beatTime - 230, value: 0.44 },
				{ timeMs: beatTime - 46, value: 0.72 },
				{ timeMs: beatTime, value: 1 },
				{ timeMs: beatTime + 46, value: 0.68 },
				{ timeMs: beatTime + 230, value: 0.45 },
			];
		}),
	};
	const targets = analysis.beats.map((beat) =>
		sampleAnalysisTarget(analysis, beat.timeMs),
	);

	assert.ok(Math.min(...targets) >= 0.82, `重低音仍出现弱拍：${targets}`);
	assert.ok(
		Math.max(...targets) - Math.min(...targets) <= 0.04,
		`等能量重低音仍随 novelty 闪烁：${targets}`,
	);
});

test("持续高能量铺底不会把缺少局部冲击的拍点误判为重拍", () => {
	const strengths = [0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.58, 0.6, 0.61, 0.62];
	const analysis = {
		...makeAnalysis(),
		durationMs: 6_000,
		beats: strengths.map((strength, index) => ({
			timeMs: 500 + index * 500,
			strength,
			confidence: 0.8,
		})),
		onsets: [],
		energyEnvelope: Array.from({ length: 131 }, (_, index) => ({
			timeMs: index * 46,
			value: 0.9,
		})),
	};
	const weakBeatTarget = sampleAnalysisTarget(analysis, 1_000);
	assert.ok(weakBeatTarget < 0.4, `持续响亮铺底把弱拍推到 ${weakBeatTarget}`);
});

test("全曲分位映射会明确拉开弱拍与重拍", () => {
	const analysis = {
		...makeAnalysis(),
		beats: [0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.58, 0.6, 0.61, 0.62].map(
			(strength, index) => ({
				timeMs: 500 + index * 500,
				strength,
				confidence: 0.8,
			}),
		),
	};

	const weak = normalizeBeatStrength(analysis, 0.2);
	const heavy = normalizeBeatStrength(analysis, 0.61);
	assert.ok(weak > 0, "弱拍对比测试退化成除以零");
	assert.ok(weak <= 0.13, `弱拍被放大到 ${weak}`);
	assert.ok(heavy >= 0.95, `重拍只达到 ${heavy}`);
	assert.ok(heavy / weak >= 7, "重拍与弱拍的对比不足");
});

test("强度近乎一致的拍点不会全部退化成轻触", () => {
	for (const strength of [0.2, 0.9]) {
		const analysis = {
			...makeAnalysis(),
			beats: Array.from({ length: 8 }, (_, index) => ({
				timeMs: 500 + index * 400,
				strength,
				confidence: 0.8,
			})),
		};
		assert.ok(
			normalizeBeatStrength(analysis, strength) >= 0.95,
			`均匀 strength=${strength} 被错误压低`,
		);
	}
});

// 来自本机 Shots (Broiler Remix) 00:49–01:03 缓存的精简夹具：
// [beatTime, novelty, confidence, ±90ms RMS peak, local P20, onset peak]
const SHOTS_SEGMENT_ROWS = [
	[49_284, 0.561548, 0.469966, 1, 0.429668, 0.912],
	[49_784, 0.43605, 0.412823, 1, 0.421527, 0.708],
	[50_283, 0.551568, 0.465422, 1, 0.450381, 0.895],
	[50_782, 0.509389, 0.446216, 1, 0.461999, 0.827],
	[51_281, 0.534513, 0.457656, 1, 0.446995, 0.868],
	[51_780, 0.436754, 0.413143, 1, 0.444138, 0.725],
	[52_280, 0.500249, 0.442055, 1, 0.452376, 0.812],
	[52_779, 0.502283, 0.442981, 1, 0.425373, 0.815],
	[53_278, 0.508979, 0.44603, 1, 0.430158, 0.826],
	[53_789, 0.32801, 0.363628, 1, 0.460404, 0.623],
	[54_288, 0.522869, 0.452354, 1, 0.454134, 0.849],
	[54_776, 0.493918, 0.439172, 1, 0.427888, 0.802],
	[55_287, 0.528434, 0.454888, 1, 0.430728, 0.858],
	[55_774, 0.468666, 0.427674, 1, 0.466899, 0.761],
	[56_285, 0.486296, 0.435702, 1, 0.494909, 0.789],
	[56_773, 0.488216, 0.436576, 1, 0.460491, 0.793],
	[57_284, 0.565237, 0.471646, 1, 0.427071, 0.918],
	[57_794, 0.329207, 0.364173, 1, 0.437071, 0.72],
	[58_282, 0.552554, 0.465871, 1, 0.44411, 0.897],
	[58_781, 0.507527, 0.445369, 1, 0.446878, 0.824],
	[59_281, 0.528483, 0.45491, 1, 0.454853, 0.858],
	[59_780, 0.410327, 0.40111, 1, 0.45823, 0.71],
	[60_291, 0.510188, 0.44658, 1, 0.450585, 0.828],
	[60_778, 0.505621, 0.444501, 1, 0.454156, 0.821],
	[61_289, 0.522786, 0.452316, 1, 0.416029, 0.849],
	[61_788, 0.433563, 0.41169, 1, 0.430163, 0.704],
	[62_299, 0.323054, 0.361372, 0.403, 0.443471, 0.612],
	[62_775, 0.494181, 0.439291, 0.332, 0.269554, 0.802],
];

function makeShotsSegmentAnalysis() {
	return {
		analyzerVersion: 1,
		durationMs: 64_000,
		globalBpm: 120.0448,
		confidence: 0.6626,
		beats: SHOTS_SEGMENT_ROWS.map(([timeMs, strength, confidence]) => ({
			timeMs,
			strength,
			confidence,
		})),
		onsets: SHOTS_SEGMENT_ROWS.map((row) => ({
			timeMs: row[0],
			strength: row[5],
		})),
		tempoSegments: [],
		energyEnvelope: SHOTS_SEGMENT_ROWS.flatMap((row) => [
			{ timeMs: row[0] - 230, value: row[4] },
			{ timeMs: row[0], value: row[3] },
			{ timeMs: row[0] + 230, value: row[4] },
		]),
	};
}

test("Shots 真实片段的持续重低音不会随 novelty 忽强忽弱", () => {
	const analysis = makeShotsSegmentAnalysis();
	const heavyTargets = analysis.beats
		.slice(0, 26)
		.map((beat) => sampleAnalysisTarget(analysis, beat.timeMs));

	assert.ok(
		Math.min(...heavyTargets) >= 0.85,
		`持续重低音仍出现弱拍：${heavyTargets}`,
	);
	assert.ok(
		Math.max(...heavyTargets) - Math.min(...heavyTargets) <= 0.05,
		`持续重低音仍随 novelty 闪烁：${heavyTargets}`,
	);
});

test("Shots 真实片段只将前 26 个极重拍送入额外旋转通道", () => {
	const analysis = makeShotsSegmentAnalysis();
	const strongTargets = analysis.beats.map((beat) =>
		sampleStrongBeatTarget(analysis, beat.timeMs),
	);
	const heavyTargets = strongTargets.slice(0, 26);
	const endingTargets = strongTargets.slice(26);

	assert.ok(
		Math.min(...heavyTargets) >= 0.998,
		`前 26 个极重拍仍有漏判：${heavyTargets}`,
	);
	assert.deepEqual(
		endingTargets,
		[0, 0],
		`尾部普通拍被误触发：${endingTargets}`,
	);
});

test("普通拍可以驱动呼吸，但不会触发极重拍旋转", () => {
	const analysis = {
		...makeAnalysis({ beatStrength: 0.95, onsetTime: 1_000 }),
		energyEnvelope: [
			{ timeMs: 700, value: 0.45 },
			{ timeMs: 954, value: 0.45 },
			{ timeMs: 1_000, value: 0.9 },
			{ timeMs: 1_046, value: 0.45 },
			{ timeMs: 1_300, value: 0.45 },
		],
	};
	assert.ok(
		sampleAnalysisTarget(analysis, 1_000) >= 0.7,
		"测试拍点未能驱动普通呼吸通道",
	);
	assert.equal(sampleStrongBeatTarget(analysis, 1_000), 0);
	assert.equal(sampleStrongBeatTarget(analysis, Number.NaN), 0);
});

test("低动态分位与极弱拍阈值保持连续", () => {
	const makeLowDynamicAnalysis = (upperStrength) => ({
		...makeAnalysis(),
		beats: [0.5, upperStrength].map((strength, index) => ({
			timeMs: 500 + index * 500,
			strength,
			confidence: 0.8,
		})),
	});
	const below = normalizeBeatStrength(makeLowDynamicAnalysis(0.561538), 0.5);
	const above = normalizeBeatStrength(makeLowDynamicAnalysis(0.561539), 0.5);
	assert.ok(Math.abs(below - above) < 0.001, "分位动态范围边界仍存在跳变");

	const barelyVisible = normalizeBeatStrength(
		makeLowDynamicAnalysis(0.0010000001),
		0.0010000001,
	);
	assert.ok(barelyVisible < 0.001, `极弱拍被放大到 ${barelyVisible}`);
});

test("能量平滑会滤除约 46ms 的交替折点", () => {
	const analysis = {
		...makeAnalysis(),
		beats: [],
		onsets: [],
		energyEnvelope: Array.from({ length: 55 }, (_, index) => ({
			timeMs: index * 46,
			value: index % 2,
		})),
	};
	const samples = [];
	for (let timeMs = 600; timeMs <= 1_800; timeMs += 46) {
		samples.push(sampleAnalysisTarget(analysis, timeMs));
	}
	assert.ok(
		Math.max(...samples) - Math.min(...samples) < 0.015,
		"短周期能量折点仍造成明显呼吸抖动",
	);
	assert.ok(Math.max(...samples) > 0.1, "无拍点音乐的能量呼吸被静音");
});

test("能量呼吸不会提前数百毫秒预响", () => {
	const analysis = {
		...makeAnalysis(),
		beats: [],
		onsets: [],
		energyEnvelope: Array.from({ length: 50 }, (_, index) => ({
			timeMs: index * 46,
			value: index * 46 >= 1_000 ? 1 : 0,
		})),
	};
	assert.ok(
		sampleAnalysisTarget(analysis, 800) < 0.001,
		"响度阶跃前 200ms 已出现明显呼吸",
	);
});

test("能量平滑窗口边缘连续且非法时间不会触发视觉信号", () => {
	const analysis = {
		...makeAnalysis(),
		beats: [],
		onsets: [],
		energyEnvelope: [
			{ timeMs: 0, value: 1 },
			...Array.from({ length: 31 }, (_, index) => ({
				timeMs: 46 * (index + 1),
				value: 0,
			})),
		],
	};
	const beforeEdge = sampleAnalysisTarget(analysis, 719.999);
	const afterEdge = sampleAnalysisTarget(analysis, 720.001);
	assert.ok(
		Math.abs(beforeEdge - afterEdge) < 1e-5,
		"能量点进出平滑窗口时仍产生突跳",
	);
	for (const invalidTime of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
		assert.equal(sampleAnalysisTarget(analysis, invalidTime), 0);
		assert.equal(sampleSmoothPulse(invalidTime, 1_000, 100, 300), 0);
	}
});

function simulateAtFPS(fps) {
	const analysis = makeAnalysis();
	const deltaMs = 1_000 / fps;
	let current = 0;
	const checkpoints = new Map();
	for (let frame = 1; frame <= fps * 2; frame++) {
		const timeMs = frame * deltaMs;
		const target = mapRhythmTargetToVolume(
			sampleAnalysisTarget(analysis, timeMs),
		);
		current = advanceRhythmVisualVolume(current, target, deltaMs);
		if (frame % (fps / 60) === 0) {
			checkpoints.set(Math.round(timeMs * 1_000), current);
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
				Math.abs((candidate.get(timeMs) ?? 0) - expected) < 0.02,
				`${fps}Hz 在 ${timeMs / 1_000}ms 偏差过大`,
			);
		}
	}
});

test("长帧恢复只推进一个有限视觉步长，不追赶未显示的动画", () => {
	assert.equal(limitRhythmVisualDelta(1_000), 50);
	assert.equal(limitRhythmVisualDelta(-10), 0);
	assert.equal(limitRhythmVisualDelta(Number.NaN), 0);

	const attacked = advanceRhythmVisualVolume(
		0,
		0.4,
		limitRhythmVisualDelta(1_000),
	);
	const released = advanceRhythmVisualVolume(
		0.4,
		0,
		limitRhythmVisualDelta(1_000),
	);
	assert.ok(attacked < 0.25, `长帧后 attack 瞬跳到 ${attacked}`);
	assert.ok(released > 0.3, `长帧后 release 瞬跳到 ${released}`);
});

function createMeshHarness() {
	const noop = () => {};
	const uniforms = new Map();
	MeshGradientRenderer.setRhythmVisualSignal(0, 0);
	const gl = {
		ARRAY_BUFFER: 0x8892,
		BLEND: 0x0be2,
		COLOR_BUFFER_BIT: 0x4000,
		FLOAT: 0x1406,
		FRAMEBUFFER: 0x8d40,
		ONE: 1,
		ONE_MINUS_SRC_ALPHA: 0x0303,
		SRC_ALPHA: 0x0302,
		TEXTURE0: 0x84c0,
		TEXTURE_2D: 0x0de1,
		TRIANGLES: 4,
		activeTexture: noop,
		bindBuffer: noop,
		bindFramebuffer: noop,
		bindTexture: noop,
		blendFuncSeparate: noop,
		clear: noop,
		clearColor: noop,
		disable: noop,
		disableVertexAttribArray: noop,
		drawArrays: noop,
		enable: noop,
		enableVertexAttribArray: noop,
		flush: noop,
		vertexAttribPointer: noop,
	};
	const mainProgram = {
		attrs: { a_pos: 0 },
		setUniform1f(name, value) {
			uniforms.set(name, value);
		},
		setUniform1i: noop,
		use: noop,
	};
	const renderer = Object.create(MeshGradientRenderer.prototype);
	Object.assign(renderer, {
		canvas: { height: 1_080, width: 1_920 },
		fbo: {},
		fboTexture: {},
		gl,
		isNoCover: false,
		mainProgram,
		manualControl: false,
		meshStates: [
			{
				alpha: 1.1,
				mesh: { bind: noop, dispose: noop, draw: noop },
				texture: { bind: noop, dispose: noop },
			},
		],
		quadBuffer: {},
		quadProgram: {
			attrs: { a_pos: 0 },
			setUniform1f: noop,
			setUniform1i: noop,
			use: noop,
		},
		rhythmBreath: 0,
		rhythmKick: 0,
		maxFPS: 240,
		smoothedVolume: 0,
		volume: 0,
	});
	renderer.checkIfResize = noop;

	return {
		renderer,
		step(timeMs, deltaMs, { breath = 0, strongBeat = 0, rawBass = 0 } = {}) {
			MeshGradientRenderer.setRhythmVisualSignal(breath, strongBeat);
			renderer.setLowFreqVolume(rawBass);
			renderer.onRedraw(timeMs, deltaMs);
			const renderedBreath = uniforms.get("u_volume") ?? 0;
			const alpha = uniforms.get("u_alpha") ?? 1;
			const kick = renderer.rhythmKick;
			const expectedAngle = (timeMs / 1e4 + renderer.volume) * 2 + kick;
			const sinAngle = uniforms.get("u_sinAngle");
			const cosAngle = uniforms.get("u_cosAngle");
			return {
				alpha,
				angleUniformError:
					typeof sinAngle === "number" && typeof cosAngle === "number"
						? Math.max(
								Math.abs(sinAngle - Math.sin(expectedAngle)),
								Math.abs(cosAngle - Math.cos(expectedAngle)),
							)
						: Number.POSITIVE_INFINITY,
				breath: renderedBreath,
				brightness: alpha * Math.max(0.5, 1 - renderedBreath * 0.5),
				cosAngle,
				kick,
				rawBassVolume: renderer.volume,
				sinAngle,
			};
		},
	};
}

function simulateMeshPulse(
	fps,
	{
		beatTimes = [500],
		breathAmplitude = 0.4,
		durationMs = 1_600,
		rawBass = 0,
		strongBeatAmplitude = 1,
	} = {},
) {
	const harness = createMeshHarness();
	const deltaMs = 1_000 / fps;
	const samples = [];
	for (let timeMs = deltaMs; timeMs <= durationMs; timeMs += deltaMs) {
		const breath =
			breathAmplitude *
			Math.max(
				...beatTimes.map((beatTime) =>
					sampleSmoothPulse(timeMs, beatTime, 140, 250),
				),
			);
		const strongBeat =
			strongBeatAmplitude *
			Math.max(
				...beatTimes.map((beatTime) =>
					sampleSmoothPulse(timeMs, beatTime, 65, 130),
				),
			);
		samples.push({
			...harness.step(timeMs, deltaMs, { breath, rawBass, strongBeat }),
			timeMs,
		});
	}
	const frameSteps = samples
		.slice(1)
		.map((sample, index) =>
			Math.abs(sample.kick - (samples[index]?.kick ?? sample.kick)),
		);
	const breathFrameSteps = samples
		.slice(1)
		.map((sample, index) =>
			Math.abs(sample.breath - (samples[index]?.breath ?? sample.breath)),
		);
	return {
		breathFrameSteps,
		frameSteps,
		maxAngleUniformError: Math.max(
			...samples.map((sample) => sample.angleUniformError),
		),
		maxBreath: Math.max(...samples.map((sample) => sample.breath)),
		maxBreathFrameStep: Math.max(0, ...breathFrameSteps),
		maxBrightnessError: Math.max(
			...samples.map((sample) => Math.abs(1 - sample.brightness)),
		),
		maxFrameStep: Math.max(0, ...frameSteps),
		maxKick: Math.max(...samples.map((sample) => sample.kick)),
		minKick: Math.min(...samples.map((sample) => sample.kick)),
		samples,
	};
}

test("安装后的 Mesh 会分离呼吸与非负的极重拍冲量", () => {
	const ordinary = simulateMeshPulse(240, { strongBeatAmplitude: 0 });
	const heavy = simulateMeshPulse(240);

	assert.equal(ordinary.maxKick, 0, "普通呼吸信号泄漏到额外旋转通道");
	assert.ok(heavy.maxKick >= 0.12, `极重拍前冲仅 ${heavy.maxKick}rad`);
	assert.ok(heavy.maxKick <= 0.18, `极重拍前冲越界到 ${heavy.maxKick}rad`);
	assert.ok(heavy.minKick >= 0, `极重拍冲量反向越界：${heavy.minKick}rad`);
	assert.ok(
		heavy.maxBreath >= 0.09,
		`重拍呼吸缩放仍不明显：${heavy.maxBreath}`,
	);
	assert.ok(heavy.maxBreath <= 0.12, "呼吸幅度越界");
	assert.ok(
		heavy.maxAngleUniformError < 1e-12,
		"极重拍冲量没有写入旋转 uniform",
	);
	assert.ok(heavy.maxBrightnessError < 1e-12, "节拍仍在直接改变着色器乘法亮度");
	assert.ok(
		heavy.maxBreathFrameStep < 0.006,
		`呼吸单帧跳变 ${heavy.maxBreathFrameStep}`,
	);
});

function nearestSample(samples, timeMs) {
	return samples.reduce((nearest, sample) =>
		Math.abs(sample.timeMs - timeMs) < Math.abs(nearest.timeMs - timeMs)
			? sample
			: nearest,
	);
}

test("极重拍会快速单向推开、慢速部分回落，下一拍在未回零时再推", () => {
	const beatTimes = [500, 1_000, 1_500, 2_000];
	const result = simulateMeshPulse(240, {
		beatTimes,
		breathAmplitude: 0,
		durationMs: 2_200,
	});
	const beatTime = 1_500;
	const before = nearestSample(result.samples, beatTime - 65).kick;
	const peakSamples = result.samples.filter(
		(sample) => sample.timeMs >= beatTime && sample.timeMs <= beatTime + 100,
	);
	const peak = peakSamples.reduce((best, sample) =>
		sample.kick > best.kick ? sample : best,
	);
	const beforeNextBeat = nearestSample(result.samples, beatTime + 430).kick;
	const attackRate = (peak.kick - before) / (peak.timeMs - (beatTime - 65));
	const releaseRate =
		(peak.kick - beforeNextBeat) / (beatTime + 430 - peak.timeMs);
	const nextPeak = Math.max(
		...result.samples
			.filter(
				(sample) =>
					sample.timeMs >= beatTime + 500 && sample.timeMs <= beatTime + 600,
			)
			.map((sample) => sample.kick),
	);

	assert.ok(
		peak.timeMs - beatTime <= 90,
		`前冲峰值延迟 ${peak.timeMs - beatTime}ms`,
	);
	assert.ok(peak.kick - before >= 0.06, `前冲增量仅 ${peak.kick - before}rad`);
	assert.ok(
		beforeNextBeat >= peak.kick * 0.4 && beforeNextBeat <= peak.kick * 0.6,
		`下一拍前回落比例为 ${beforeNextBeat / peak.kick}`,
	);
	assert.ok(
		attackRate >= releaseRate * 3,
		`前冲与回落速度过于对称：${attackRate} / ${releaseRate}`,
	);
	assert.ok(beforeNextBeat > 0, "反作用力把旋转强制拉回了原点");
	assert.ok(
		nextPeak - beforeNextBeat >= 0.06,
		"下一拍未能在残留角度上再次推进",
	);
	assert.ok(result.minKick >= 0, "慢速回落期间出现了反向角度");
});

test("原作者低频旋转保持原公式，并与呼吸、极重拍冲量独立叠加", () => {
	const baseHarness = createMeshHarness();
	const base = baseHarness.step(1_000, 16, { breath: 0.4 });
	const bassHarness = createMeshHarness();
	const bass = bassHarness.step(1_000, 16, { breath: 0.4, rawBass: 0.8 });
	const combinedHarness = createMeshHarness();
	const combined = combinedHarness.step(1_000, 16, {
		breath: 0.4,
		rawBass: 0.8,
		strongBeat: 1,
	});
	const baseAngle = Math.atan2(base.sinAngle, base.cosAngle);
	const bassAngle = Math.atan2(bass.sinAngle, bass.cosAngle);

	assert.ok(
		Math.abs(bass.rawBassVolume - 0.08) < 1e-12,
		"原低频 volume / 10 被改变",
	);
	assert.ok(
		Math.abs(bassAngle - baseAngle - 0.16) < 1e-12,
		`原低频 (uTime + volume) * 2 增量为 ${bassAngle - baseAngle}`,
	);
	assert.ok(combined.kick > 0, "极重拍冲量未叠加到原低频角度");
	assert.ok(
		combined.angleUniformError < 1e-12,
		"三通道合成后旋转 uniform 错误",
	);
	assert.ok(bass.breath > base.breath, "原低频没有保留原作者的缩放呼吸反馈");
});

test("持续强呼吸与原作者低频使用软膝叠加，不会在 0.16 处截平", () => {
	const harness = createMeshHarness();
	let sample;
	for (let timeMs = 16; timeMs <= 1_600; timeMs += 16) {
		sample = harness.step(timeMs, 16, { breath: 0.4, rawBass: 1 });
	}
	assert.ok(sample, "未生成 Mesh 样本");
	assert.ok(sample.breath > 0.19, `低频与呼吸合成仍被压平到 ${sample.breath}`);
	assert.ok(sample.breath <= 0.2, `软膝合成越过安全上限 ${sample.breath}`);
	assert.ok(Math.abs(1 - sample.brightness) < 1e-12, "软膝合成破坏亮度补偿");
});

function simulateShotsEndToEnd(fps = 240) {
	const analysis = makeShotsSegmentAnalysis();
	const harness = createMeshHarness();
	const deltaMs = 1_000 / fps;
	const startMs = 48_500;
	const endMs = 63_000;
	let smoothedVolume = 0;
	const samples = [];

	for (
		let musicTimeMs = startMs;
		musicTimeMs <= endMs;
		musicTimeMs += deltaMs
	) {
		const elapsedMs = musicTimeMs - startMs;
		const targetVolume = mapRhythmTargetToVolume(
			sampleAnalysisTarget(analysis, musicTimeMs),
		);
		smoothedVolume = advanceRhythmVisualVolume(
			smoothedVolume,
			targetVolume,
			deltaMs,
		);
		const strongBeat = sampleStrongBeatTarget(analysis, musicTimeMs);
		samples.push({
			...harness.step(elapsedMs, deltaMs, {
				breath: smoothedVolume,
				strongBeat,
			}),
			musicTimeMs,
			smoothedVolume,
			strongBeat,
		});
	}

	const firstDifferences = samples
		.slice(1)
		.map((sample, index) =>
			Math.abs(sample.kick - (samples[index]?.kick ?? sample.kick)),
		);
	const secondDifferences = samples
		.slice(2)
		.map((sample, index) =>
			Math.abs(
				sample.kick -
					2 * (samples[index + 1]?.kick ?? sample.kick) +
					(samples[index]?.kick ?? sample.kick),
			),
		);

	return {
		maxAngleUniformError: Math.max(
			...samples.map((sample) => sample.angleUniformError),
		),
		maxBreath: Math.max(...samples.map((sample) => sample.breath)),
		maxFrameStep: Math.max(...firstDifferences),
		maxKick: Math.max(...samples.map((sample) => sample.kick)),
		maxSmoothedVolume: Math.max(
			...samples.map((sample) => sample.smoothedVolume),
		),
		maxSecondDifference: Math.max(...secondDifferences),
		minKick: Math.min(...samples.map((sample) => sample.kick)),
		strongRotationFraction:
			samples.filter((sample) => sample.kick >= (5 * Math.PI) / 180).length /
			samples.length,
	};
}

test("Shots 真实片段的呼吸与极重拍冲量都能进入 Mesh", () => {
	const result = simulateShotsEndToEnd();
	assert.ok(
		result.maxSmoothedVolume >= 0.3,
		`完整呼吸链路输出仅 ${result.maxSmoothedVolume}`,
	);
	assert.ok(
		result.maxKick >= 0.13 && result.maxKick <= 0.15,
		`完整极重拍链路峰值为 ${result.maxKick}rad`,
	);
	assert.ok(result.minKick >= 0, `完整链路出现反向冲量 ${result.minKick}rad`);
	assert.ok(
		result.strongRotationFraction >= 0.5,
		`Shots 重低音段高于 5° 的时长仅 ${result.strongRotationFraction}`,
	);
	assert.ok(result.maxBreath >= 0.09, `完整链路呼吸仅 ${result.maxBreath}`);
	assert.ok(
		result.maxFrameStep < 0.012,
		`单帧旋转跳变 ${result.maxFrameStep}rad`,
	);
	assert.ok(
		result.maxSecondDifference < 0.004,
		`旋转二阶跳变 ${result.maxSecondDifference}rad`,
	);
	assert.ok(
		result.maxAngleUniformError < 1e-12,
		"完整链路冲量没有进入 Mesh 旋转 uniform",
	);
});

test("真实 Mesh 极重拍冲量在 60/120/240Hz 下峰值一致且无单帧闪跳", () => {
	const options = {
		beatTimes: [500, 1_000, 1_500, 2_000],
		breathAmplitude: 0,
		durationMs: 2_200,
	};
	const expected = simulateMeshPulse(60, options);
	assert.ok(
		expected.maxFrameStep < 0.04,
		`60Hz 单帧跳变 ${expected.maxFrameStep}rad`,
	);
	for (const [fps, maxStep] of [
		[120, 0.02],
		[240, 0.012],
	]) {
		const candidate = simulateMeshPulse(fps, options);
		assert.ok(
			Math.abs(candidate.maxKick - expected.maxKick) < 0.002,
			`${fps}Hz 的正向摆幅漂移过大`,
		);
		assert.ok(candidate.minKick >= 0, `${fps}Hz 出现反向角度`);
		assert.ok(
			candidate.maxFrameStep < maxStep,
			`${fps}Hz 单帧跳变 ${candidate.maxFrameStep}rad`,
		);
	}
});

test("真实 Mesh 遇到长帧时不会积分未显示的一整段旋转", () => {
	const harness = createMeshHarness();
	harness.renderer.meshStates[0].alpha = 0;
	harness.step(0, 16);
	const before = harness.renderer.rhythmKick;
	const after = harness.step(1_000, 1_000, { strongBeat: 1 }).kick;
	assert.ok(
		Math.abs(after - before) < 0.12,
		`长帧单步旋转 ${after - before}rad`,
	);
	assert.ok(
		harness.renderer.meshStates[0].alpha <= 0.21,
		`长帧让封面淡入瞬跳到 ${harness.renderer.meshStates[0].alpha}`,
	);
});

test("真实 Mesh 的基础旋转也不会追赶未显示的长帧", () => {
	const renderer = Object.create(MeshGradientRenderer.prototype);
	let redrawDelta = -1;
	Object.assign(renderer, {
		_disposed: false,
		flowSpeed: 1,
		frameTime: 0,
		lastFrameTime: 0,
		lastTickTime: 0,
		maxFPS: 240,
		paused: false,
		requestTick() {},
		staticMode: false,
		tickHandle: 1,
		updatePerformanceStats() {},
	});
	renderer.onRedraw = (_timeMs, deltaMs) => {
		redrawDelta = deltaMs;
		return false;
	};
	renderer.onTick(1_000);
	assert.equal(renderer.frameTime, 50);
	assert.equal(redrawDelta, 50);
});

test("真实 Mesh 会尊重合法低帧率，而不是固定截断到 50ms", () => {
	const renderer = Object.create(MeshGradientRenderer.prototype);
	let redrawDelta = -1;
	Object.assign(renderer, {
		_disposed: false,
		flowSpeed: 1,
		frameTime: 0,
		lastFrameTime: 0,
		lastTickTime: 0,
		maxFPS: 10,
		paused: false,
		requestTick() {},
		staticMode: false,
		tickHandle: 1,
		updatePerformanceStats() {},
	});
	renderer.onRedraw = (_timeMs, deltaMs) => {
		redrawDelta = deltaMs;
		return false;
	};
	renderer.onTick(100);
	assert.equal(renderer.frameTime, 100);
	assert.equal(redrawDelta, 100);
});

test("重新打开歌词页会沿用当前节奏状态而不是先硬切静音", () => {
	const source = readFileSync(
		new URL(
			"../src/components/LocalMusicContext/rhythm-visual.tsx",
			import.meta.url,
		),
		"utf8",
	);
	assert.match(source, /const initialMusicId = store\.get\(musicIdAtom\)/);
	assert.match(source, /let lastMusicId = initialMusicId/);
	assert.doesNotMatch(source, /let lastMusicId = ["']{2}/);
});

test("播放器实际挂载原低频桥，并把呼吸与极重拍接入 Mesh", () => {
	const visualSource = readFileSync(
		new URL(
			"../src/components/LocalMusicContext/rhythm-visual.tsx",
			import.meta.url,
		),
		"utf8",
	);
	const contextSource = readFileSync(
		new URL("../src/components/LocalMusicContext/index.tsx", import.meta.url),
		"utf8",
	);
	assert.match(
		visualSource,
		/MeshGradientRenderer\.setRhythmVisualSignal\(\s*Math\.max\(SILENT_RHYTHM_VOLUME, smoothedValue\),\s*strongBeatTarget,?\s*\)/,
	);
	assert.match(
		visualSource,
		/MeshGradientRenderer\.setRhythmVisualSignal\(0, 0\)/,
	);
	assert.match(contextSource, /<FFTToLowPassContext\s*\/>/);
});

test("安装后的 Mesh 补丁使用低频、呼吸、极重拍三通道和亮度补偿", () => {
	for (const fileName of ["amll-core.mjs", "amll-core.cjs"]) {
		const source = readFileSync(
			new URL(
				`../node_modules/@applemusic-like-lyrics/core/dist/${fileName}`,
				import.meta.url,
			),
			"utf8",
		);
		assert.match(
			source,
			/static setRhythmVisualSignal\(breath, heavyBeat\) \{/,
		);
		assert.match(
			source,
			/const signal = Math\.min\(1, Math\.max\(0, MeshGradientRenderer\.rhythmVisualVolume \* 2\.5\)\)/,
		);
		assert.match(
			source,
			/const targetKick = MeshGradientRenderer\.strongBeat \* \.18/,
		);
		assert.match(
			source,
			/const kickMs = targetKick > this\.rhythmKick \? 55 : 540/,
		);
		assert.match(
			source,
			/this\.rhythmKick \+= \(targetKick - this\.rhythmKick\) \* kickFactor/,
		);
		assert.match(source, /mesh_frag_default\.replace\(.*vec2\(0\.5\)/);
		assert.ok(
			source.indexOf("var mesh_frag_default") <
				source.indexOf("mesh_frag_default = mesh_frag_default.replace"),
			`${fileName} 在 shader 声明前执行了替换`,
		);
		assert.match(source, /const maxFrameDelta = Math\.max\(50,/);
		assert.match(
			source,
			/const safeDelta = Number\.isFinite\(delta\) \? Math\.min\(maxFrameDelta, Math\.max\(0, delta\)\) : 0/,
		);
		assert.match(
			source,
			/const safeFrameDelta = Number\.isFinite\(frameDelta\) \? Math\.min\(maxFrameDelta, Math\.max\(0, frameDelta\)\) : 0/,
		);
		assert.match(
			source,
			/this\.frameTime \+= safeFrameDelta \* this\.flowSpeed/,
		);
		assert.match(source, /this\.onRedraw\(this\.frameTime, safeFrameDelta\)/);
		assert.match(source, /const deltaFactor = safeDelta \/ 500/);
		assert.match(source, /u_cosAngle \* centeredUV\.x/);
		assert.match(source, /"u_volume", breathVolume/);
		assert.match(source, /"u_alpha", compensatedAlpha/);
		assert.match(
			source,
			/const combinedBreath = Math\.max\(0, this\.volume\) \+ this\.rhythmBreath/,
		);
		assert.match(source, /const breathKnee = Math\.min\(1,/);
		assert.match(source, /const breathVolume = combinedBreath <= \.16/);
		assert.match(
			source,
			/const angle = \(uTime \+ this\.volume\) \* 2 \+ this\.rhythmKick/,
		);
		assert.match(
			source,
			/this\.volume = Number\.isFinite\(volume\) \? volume \/ 10 : 0/,
		);
		assert.doesNotMatch(
			source,
			/this\.(?:rhythmSwing|rhythmBaseline|rhythmPhase)/,
		);
		assert.match(
			source,
			/resume\(\) \{[\s\S]*?this\.lastFrameTime = now;[\s\S]*?this\.lastTickTime = now;/,
		);
	}

	for (const fileName of ["amll-core.d.mts", "amll-core.d.cts"]) {
		const source = readFileSync(
			new URL(
				`../node_modules/@applemusic-like-lyrics/core/dist/${fileName}`,
				import.meta.url,
			),
			"utf8",
		);
		assert.match(
			source,
			/static setRhythmVisualSignal\(breath: number, heavyBeat: number\): void;/,
			`${fileName} 缺少三通道静态 API 类型`,
		);
	}
});

test("安装后的 ESM 与 CJS core 包可以真实加载", () => {
	const mjsUrl = new URL(
		"../node_modules/@applemusic-like-lyrics/core/dist/amll-core.mjs",
		import.meta.url,
	).href;
	const cjsPath = fileURLToPath(
		new URL(
			"../node_modules/@applemusic-like-lyrics/core/dist/amll-core.cjs",
			import.meta.url,
		),
	);
	execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`globalThis.MouseEvent = class {}; await import(${JSON.stringify(mjsUrl)});`,
		],
		{ stdio: "pipe" },
	);
	execFileSync(
		process.execPath,
		[
			"--eval",
			`globalThis.MouseEvent = class {}; require(${JSON.stringify(cjsPath)});`,
		],
		{ stdio: "pipe" },
	);
});
