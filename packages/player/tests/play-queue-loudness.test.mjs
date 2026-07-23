import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

globalThis.window = globalThis;

const testAtoms = {
	enableLoudnessNormalization: {},
	isShuffleActive: {},
	musicPlaying: {},
	musicPlayingPosition: {},
	repeatMode: {},
};
globalThis.__playQueueTestAtoms = testAtoms;

const reactFullStub = `
const atoms = globalThis.__playQueueTestAtoms;
export const isShuffleActiveAtom = atoms.isShuffleActive;
export const musicPlayingAtom = atoms.musicPlaying;
export const musicPlayingPositionAtom = atoms.musicPlayingPosition;
export const repeatModeAtom = atoms.repeatMode;
export const RepeatMode = { Off: 0, All: 1, One: 2 };
`;
const appAtomsStub = `
export const enableLoudnessNormalizationAtom =
	globalThis.__playQueueTestAtoms.enableLoudnessNormalization;
`;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@applemusic-like-lyrics/react-full") {
			return {
				url: `data:text/javascript,${encodeURIComponent(reactFullStub)}`,
				shortCircuit: true,
			};
		}
		if (
			specifier === "../states/appAtoms.ts" &&
			context.parentURL?.endsWith("/utils/play-queue-manager.ts")
		) {
			return {
				url: `data:text/javascript,${encodeURIComponent(appAtomsStub)}`,
				shortCircuit: true,
			};
		}
		return nextResolve(specifier, context);
	},
});

const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const {
	PlayQueueManager,
	queueLoudnessUpdatePolicyAtom,
	shouldSuppressAutomaticLoudnessUpdate,
} = await import("../src/utils/play-queue-manager.ts");

function createStore() {
	const values = new Map([
		[testAtoms.enableLoudnessNormalization, true],
		[testAtoms.musicPlaying, true],
		[testAtoms.musicPlayingPosition, 0],
	]);
	return {
		get(atom) {
			return values.has(atom) ? values.get(atom) : atom?.init;
		},
		set(atom, value) {
			values.set(
				atom,
				typeof value === "function" ? value(this.get(atom)) : value,
			);
		},
	};
}

function makeSong(id) {
	return {
		id,
		filePath: `${id}.flac`,
		songName: id,
		songArtists: "",
		songAlbum: "",
		duration: 180,
		lyricFormat: "",
		lyric: "",
	};
}

function makeLoudness(integratedLoudnessLufs, samplePeak) {
	return {
		analyzerVersion: 1,
		integratedLoudnessLufs,
		samplePeak,
	};
}

function makeAnalysis(loudness) {
	return {
		analyzerVersion: 2,
		durationMs: 180_000,
		globalBpm: null,
		confidence: 0,
		beats: [],
		onsets: [],
		tempoSegments: [],
		energyEnvelope: [],
		energyScale: 0,
		loudness,
	};
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, reject, resolve };
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await new Promise((resolve) => setImmediate(resolve));
	}
}

async function drainAsyncWork() {
	for (let index = 0; index < 4; index++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function getPlayMessages(calls) {
	return calls
		.filter(({ command }) => command === "local_player_send_msg")
		.map(({ payload }) => payload.msg.data)
		.filter(({ type }) => type === "playAudio");
}

test("冷缓存歌曲会在整轨响度分析完成后才发送首个播放请求", {
	concurrency: false,
}, async (context) => {
	const analysis = deferred();
	const calls = [];
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		switch (command) {
			case "get_cached_song_loudness":
				return null;
			case "get_or_analyze_song_rhythm":
				return analysis.promise;
			case "local_player_send_msg":
				return undefined;
			default:
				throw new Error(`Unexpected IPC command: ${command}`);
		}
	});

	const manager = new PlayQueueManager(createStore());
	context.after(() => {
		manager.dispose();
		clearMocks();
	});

	manager.replaceQueueAndPlay(makeSong("cold"));
	await waitFor(
		() => calls.some(({ command }) => command === "get_or_analyze_song_rhythm"),
		"冷缓存未启动整轨响度分析",
	);
	assert.equal(
		getPlayMessages(calls).length,
		0,
		"响度分析完成前不应按原始音量起播",
	);

	analysis.resolve(makeAnalysis(makeLoudness(-11.5, 0.8)));
	await waitFor(
		() => getPlayMessages(calls).length === 1,
		"响度分析完成后未启动播放",
	);

	assert.deepEqual(
		calls.map(({ command }) => command),
		[
			"get_cached_song_loudness",
			"get_or_analyze_song_rhythm",
			"local_player_send_msg",
		],
	);
	assert.deepEqual(getPlayMessages(calls)[0]?.loudnessNormalization, {
		enabled: true,
		integratedLoudnessLufs: -11.5,
		samplePeak: 0.8,
	});
});

test("起播前分析失败会继续播放但禁止后台结果中途改变增益", {
	concurrency: false,
}, async (context) => {
	const analysis = deferred();
	const calls = [];
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...args) => warnings.push(args);
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		switch (command) {
			case "get_cached_song_loudness":
				return null;
			case "get_or_analyze_song_rhythm":
				return analysis.promise;
			case "local_player_send_msg":
				return undefined;
			default:
				throw new Error(`Unexpected IPC command: ${command}`);
		}
	});

	const store = createStore();
	const manager = new PlayQueueManager(store);
	context.after(() => {
		console.warn = originalWarn;
		manager.dispose();
		clearMocks();
	});

	manager.replaceQueueAndPlay(makeSong("failed"));
	await waitFor(
		() => calls.some(({ command }) => command === "get_or_analyze_song_rhythm"),
		"冷缓存未启动整轨响度分析",
	);
	analysis.reject(new Error("decode failed"));
	await waitFor(
		() => getPlayMessages(calls).length === 1,
		"响度分析失败后歌曲未回退播放",
	);

	assert.deepEqual(getPlayMessages(calls)[0]?.loudnessNormalization, {
		enabled: true,
		integratedLoudnessLufs: null,
		samplePeak: null,
	});
	const policy = store.get(queueLoudnessUpdatePolicyAtom);
	assert.deepEqual(policy, {
		musicId: "failed",
		suppressAutomaticUpdate: true,
	});
	assert.equal(
		shouldSuppressAutomaticLoudnessUpdate(policy, "failed", true),
		true,
	);
	assert.equal(
		shouldSuppressAutomaticLoudnessUpdate(policy, "failed", false),
		false,
		"用户主动关闭开关时不应继续抑制设置更新",
	);
	assert.equal(warnings.length, 1);
});

test("等待响度缓存期间快速切歌不会为过期歌曲启动整轨分析", {
	concurrency: false,
}, async (context) => {
	const firstCache = deferred();
	const calls = [];
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		switch (command) {
			case "get_cached_song_loudness":
				if (payload.songId === "first") return firstCache.promise;
				return makeLoudness(-10, 0.7);
			case "get_or_analyze_song_rhythm":
				return makeAnalysis(makeLoudness(-12, 0.8));
			case "local_player_send_msg":
				return undefined;
			default:
				throw new Error(`Unexpected IPC command: ${command}`);
		}
	});

	const manager = new PlayQueueManager(createStore());
	context.after(() => {
		manager.dispose();
		clearMocks();
	});

	manager.setQueue([makeSong("first"), makeSong("second")]);
	await waitFor(
		() =>
			calls.some(
				({ command, payload }) =>
					command === "get_cached_song_loudness" && payload.songId === "first",
			),
		"第一首歌曲未进入响度缓存查询",
	);

	manager.playAt(1);
	await waitFor(
		() => getPlayMessages(calls).some(({ song }) => song.songId === "second"),
		"快速切换后的第二首歌曲未启动播放",
	);
	firstCache.resolve(null);
	await drainAsyncWork();

	assert.equal(
		calls.some(
			({ command, payload }) =>
				command === "get_or_analyze_song_rhythm" && payload.songId === "first",
		),
		false,
		"过期请求不应继续占用整轨分析资源",
	);
	assert.deepEqual(
		getPlayMessages(calls).map(({ song }) => song.songId),
		["second"],
	);
});

test("整轨响度分析期间快速切歌不会在分析返回后播放过期歌曲", {
	concurrency: false,
}, async (context) => {
	const firstAnalysis = deferred();
	const calls = [];
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		switch (command) {
			case "get_cached_song_loudness":
				if (payload.songId === "first") return null;
				return makeLoudness(-9.5, 0.75);
			case "get_or_analyze_song_rhythm":
				if (payload.songId === "first") return firstAnalysis.promise;
				return makeAnalysis(makeLoudness(-12, 0.8));
			case "local_player_send_msg":
				return undefined;
			default:
				throw new Error(`Unexpected IPC command: ${command}`);
		}
	});

	const manager = new PlayQueueManager(createStore());
	context.after(() => {
		manager.dispose();
		clearMocks();
	});

	manager.setQueue([makeSong("first"), makeSong("second")]);
	await waitFor(
		() =>
			calls.some(
				({ command, payload }) =>
					command === "get_or_analyze_song_rhythm" &&
					payload.songId === "first",
			),
		"第一首歌曲未进入整轨响度分析",
	);

	manager.playAt(1);
	await waitFor(
		() => getPlayMessages(calls).some(({ song }) => song.songId === "second"),
		"快速切换后的第二首歌曲未启动播放",
	);
	firstAnalysis.resolve(makeAnalysis(makeLoudness(-13, 0.65)));
	await drainAsyncWork();

	assert.deepEqual(
		getPlayMessages(calls).map(({ song }) => song.songId),
		["second"],
		"过期分析结果不能启动已被切走的歌曲",
	);
});
