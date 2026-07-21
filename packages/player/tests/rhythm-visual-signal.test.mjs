import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	advanceRhythmVisualVolume,
	mapRhythmTargetToVolume,
	normalizeBeatStrength,
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

test("长帧间隔仍按真实时间推进视觉滤波", () => {
	const attacked = advanceRhythmVisualVolume(0, 0.4, 1_000);
	const released = advanceRhythmVisualVolume(0.4, 0, 1_000);
	assert.ok(attacked > 0.399, `1FPS attack 仅推进到 ${attacked}`);
	assert.ok(released < 0.002, `1FPS release 仍残留 ${released}`);
});

function simulateMeshPulse(fps, amplitude) {
	const deltaMs = 1_000 / fps;
	let smoothedVolume = 0;
	let rhythmBaseline = 0;
	let rhythmPhase = 0;
	let rhythmBreath = 0;
	let initialized = false;
	let maxRotationSpeed = 0;
	let maxBreath = 0;
	let maxBrightnessError = 0;
	for (let timeMs = deltaMs; timeMs <= 1_200; timeMs += deltaMs) {
		const externalVolume = amplitude * sampleSmoothPulse(timeMs, 350, 100, 420);
		const volume = externalVolume / 10;
		const lerpFactor = 1 - Math.exp(-deltaMs / 55);
		smoothedVolume += (volume - smoothedVolume) * lerpFactor;
		const signal = Math.min(1, Math.max(0, smoothedVolume * 25));
		if (!initialized) {
			rhythmBaseline = signal;
			initialized = true;
		}
		const accent = Math.max(0, signal - rhythmBaseline);
		const baselineFactor = 1 - Math.exp(-deltaMs / 900);
		rhythmBaseline += (signal - rhythmBaseline) * baselineFactor;
		const rotationSpeed = Math.min(2.6, accent * 3.2);
		rhythmPhase =
			(rhythmPhase + (rotationSpeed * deltaMs) / 1_000) % (Math.PI * 2);
		const targetBreath = Math.min(
			0.075,
			Math.max(0, rhythmBaseline * 0.09 + accent * 0.09),
		);
		const breathMs = targetBreath > rhythmBreath ? 90 : 360;
		const breathFactor = 1 - Math.exp(-deltaMs / breathMs);
		rhythmBreath += (targetBreath - rhythmBreath) * breathFactor;
		const compensatedAlpha = 1 / Math.max(0.5, 1 - rhythmBreath * 0.5);
		const brightness = compensatedAlpha * Math.max(0.5, 1 - rhythmBreath * 0.5);
		maxRotationSpeed = Math.max(maxRotationSpeed, rotationSpeed);
		maxBreath = Math.max(maxBreath, rhythmBreath);
		maxBrightnessError = Math.max(maxBrightnessError, Math.abs(1 - brightness));
	}
	return { rhythmPhase, maxRotationSpeed, maxBreath, maxBrightnessError };
}

test("Mesh 重拍以单向加速形成明显旋转并平滑呼吸", () => {
	const weak = simulateMeshPulse(240, 0.12);
	const heavy = simulateMeshPulse(240, 0.4);
	assert.ok(heavy.rhythmPhase >= 0.3, `重拍累计旋转仅 ${heavy.rhythmPhase}rad`);
	assert.ok(
		heavy.maxRotationSpeed >= weak.maxRotationSpeed * 2,
		"重拍旋转加速度与弱拍对比不足",
	);
	assert.ok(
		heavy.maxBreath >= 0.04,
		`重拍呼吸缩放仍不明显：${heavy.maxBreath}`,
	);
	assert.ok(heavy.maxBreath <= 0.075, "呼吸幅度越界");
	assert.ok(heavy.maxBrightnessError < 1e-12, "节拍仍在直接改变着色器乘法亮度");
});

test("Mesh 旋转与呼吸在 60/120/240Hz 下保持一致", () => {
	const expected = simulateMeshPulse(60, 0.4);
	for (const fps of [120, 240]) {
		const candidate = simulateMeshPulse(fps, 0.4);
		assert.ok(
			Math.abs(candidate.rhythmPhase - expected.rhythmPhase) < 0.02,
			`${fps}Hz 的累计旋转漂移过大`,
		);
		assert.ok(
			Math.abs(candidate.maxBreath - expected.maxBreath) < 0.003,
			`${fps}Hz 的呼吸峰值漂移过大`,
		);
	}
});

test("安装后的 Mesh 补丁使用独立呼吸、重拍旋转和亮度补偿", () => {
	for (const fileName of ["amll-core.mjs", "amll-core.cjs"]) {
		const source = readFileSync(
			new URL(
				`../node_modules/@applemusic-like-lyrics/core/dist/${fileName}`,
				import.meta.url,
			),
			"utf8",
		);
		assert.match(source, /const signal = .*smoothedVolume \* 25/);
		assert.match(source, /mesh_frag_default\.replace\(.*vec2\(0\.5\)/);
		assert.match(
			source,
			/const rotationSpeed = Math\.min\(2\.6, accent \* 3\.2\)/,
		);
		assert.ok(
			source.indexOf("var mesh_frag_default") <
				source.indexOf("mesh_frag_default = mesh_frag_default.replace"),
			`${fileName} 在 shader 声明前执行了替换`,
		);
		const setAlbumStart = source.indexOf(
			"async setAlbum(albumSource, isVideo)",
		);
		const volumeReset = source.indexOf("this.volume = 0", setAlbumStart);
		const baselineReset = source.indexOf(
			"this.rhythmBaseline = 0",
			setAlbumStart,
		);
		assert.ok(
			setAlbumStart >= 0 &&
				volumeReset > setAlbumStart &&
				volumeReset < setAlbumStart + 300 &&
				baselineReset > volumeReset &&
				baselineReset < setAlbumStart + 300,
			`${fileName} 没有在 Mesh setAlbum 入口重置节奏状态`,
		);
		assert.match(
			source,
			/const safeDelta = Number\.isFinite\(delta\) \? Math\.max\(0, delta\) : 0/,
		);
		assert.doesNotMatch(source, /safeDelta = Math\.min\(100/);
		assert.match(source, /"u_volume", breathVolume/);
		assert.match(source, /"u_alpha", compensatedAlpha/);
		assert.match(source, /const angle = uTime \* 2 \+ this\.rhythmPhase/);
		assert.doesNotMatch(source, /const angle = \(uTime \+ this\.volume\) \* 2/);
		assert.doesNotMatch(source, /this\.rhythmRotation/);
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
