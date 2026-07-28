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
	persistedQueueStateAtom,
	queueCurrentIndexAtom,
	queueLoudnessUpdatePolicyAtom,
	queuePlaylistAtom,
	shouldSuppressAutomaticLoudnessUpdate,
} = await import("../src/utils/play-queue-manager.ts");

function createStore({
	loudnessEnabled = true,
	playing = true,
	position = 0,
} = {}) {
	const values = new Map([
		[testAtoms.enableLoudnessNormalization, loudnessEnabled],
		[testAtoms.musicPlaying, playing],
		[testAtoms.musicPlayingPosition, position],
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

function getAudioMessages(calls, type) {
	return calls
		.filter(({ command }) => command === "local_player_send_msg")
		.map(({ payload }) => payload.msg.data)
		.filter((message) => message.type === type);
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

test("解码器临时忙时等待阻塞分析并用响度结果起播", {
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
				if (payload.nonBlocking) throw new Error("DECODER_BUSY");
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
		manager.dispose();
		clearMocks();
	});

	manager.replaceQueueAndPlay(makeSong("busy"));
	await waitFor(
		() =>
			calls.filter(({ command }) => command === "get_or_analyze_song_rhythm")
				.length === 2,
		"解码器忙后未进入阻塞响度分析",
	);

	assert.equal(
		getPlayMessages(calls).length,
		0,
		"阻塞响度分析完成前不应按原始音量起播",
	);
	assert.deepEqual(
		calls
			.filter(({ command }) => command === "get_or_analyze_song_rhythm")
			.map(({ payload }) => payload.nonBlocking),
		[true, false],
	);

	analysis.resolve(makeAnalysis(makeLoudness(-12.4, 0.72)));
	await waitFor(
		() => getPlayMessages(calls).length === 1,
		"阻塞响度分析完成后未启动播放",
	);

	assert.deepEqual(getPlayMessages(calls)[0]?.loudnessNormalization, {
		enabled: true,
		integratedLoudnessLufs: -12.4,
		samplePeak: 0.72,
	});
	assert.equal(
		store.get(queueLoudnessUpdatePolicyAtom),
		null,
		"起播已携带响度时不应留下后台更新抑制策略",
	);
});

test("解码器忙后的阻塞分析返回时不会播放已快速切走的歌曲", {
	concurrency: false,
}, async (context) => {
	const firstBlockingAnalysis = deferred();
	const calls = [];
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		switch (command) {
			case "get_cached_song_loudness":
				if (payload.songId === "first") return null;
				return makeLoudness(-10.2, 0.74);
			case "get_or_analyze_song_rhythm":
				if (payload.songId !== "first") {
					throw new Error(`Unexpected analysis song: ${payload.songId}`);
				}
				if (payload.nonBlocking) throw new Error("DECODER_BUSY");
				return firstBlockingAnalysis.promise;
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
					payload.songId === "first" &&
					payload.nonBlocking === false,
			),
		"第一首歌曲未进入阻塞响度分析",
	);

	manager.playAt(1);
	await waitFor(
		() => getPlayMessages(calls).some(({ song }) => song.songId === "second"),
		"快速切换后的第二首歌曲未启动播放",
	);
	firstBlockingAnalysis.resolve(makeAnalysis(makeLoudness(-13.2, 0.66)));
	await drainAsyncWork();

	assert.deepEqual(
		getPlayMessages(calls).map(({ song }) => song.songId),
		["second"],
		"过期的阻塞分析结果不能启动已被切走的歌曲",
	);
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

test("指定索引设置队列只会为目标歌曲发送一次播放请求", {
	concurrency: false,
}, async (context) => {
	const calls = [];
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		if (command === "local_player_send_msg") return undefined;
		throw new Error(`Unexpected IPC command: ${command}`);
	});

	const manager = new PlayQueueManager(createStore({ loudnessEnabled: false }));
	context.after(() => {
		manager.dispose();
		clearMocks();
	});

	manager.setQueue(
		[makeSong("first"), makeSong("second"), makeSong("third")],
		42,
		2,
	);
	await waitFor(
		() => getPlayMessages(calls).length === 1,
		"指定索引歌曲未启动播放",
	);
	await drainAsyncWork();

	assert.deepEqual(
		getPlayMessages(calls).map(({ song }) => song.songId),
		["third"],
	);
	assert.equal(manager.getCurrentIndex(), 2);
	assert.equal(manager.getPlaylistId(), 42);
});

test("随机模式未指定起播索引时保留播放洗牌后首项的语义", {
	concurrency: false,
}, async (context) => {
	const calls = [];
	const originalRandom = Math.random;
	Math.random = () => 0;
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		if (command === "local_player_send_msg") return undefined;
		throw new Error(`Unexpected IPC command: ${command}`);
	});

	const manager = new PlayQueueManager(createStore({ loudnessEnabled: false }));
	context.after(() => {
		Math.random = originalRandom;
		manager.dispose();
		clearMocks();
	});

	manager.toggleShuffleOn();
	manager.setQueue([makeSong("a"), makeSong("b"), makeSong("c")]);
	await waitFor(
		() => getPlayMessages(calls).length === 1,
		"随机队列首项未启动播放",
	);
	await drainAsyncWork();

	assert.deepEqual(
		manager.getPlayList().map((song) => song.id),
		["b", "c", "a"],
	);
	assert.equal(manager.getCurrentIndex(), 0);
	assert.deepEqual(
		getPlayMessages(calls).map(({ song }) => song.songId),
		["b"],
	);
});

test("随机模式显式指定原始索引时只播放对应目标歌曲", {
	concurrency: false,
}, async (context) => {
	const calls = [];
	const originalRandom = Math.random;
	Math.random = () => 0;
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		if (command === "local_player_send_msg") return undefined;
		throw new Error(`Unexpected IPC command: ${command}`);
	});

	const manager = new PlayQueueManager(createStore({ loudnessEnabled: false }));
	context.after(() => {
		Math.random = originalRandom;
		manager.dispose();
		clearMocks();
	});

	manager.toggleShuffleOn();
	manager.setQueue([makeSong("a"), makeSong("b"), makeSong("c")], undefined, 2);
	await waitFor(
		() => getPlayMessages(calls).length === 1,
		"显式指定的随机队列歌曲未启动播放",
	);
	await drainAsyncWork();

	assert.deepEqual(
		manager.getPlayList().map((song) => song.id),
		["c", "a", "b"],
	);
	assert.equal(manager.getCurrentSong()?.id, "c");
	assert.equal(manager.getCurrentIndex(), 0);
	assert.deepEqual(
		getPlayMessages(calls).map(({ song }) => song.songId),
		["c"],
	);

	const firstPlayback = getPlayMessages(calls)[0];
	manager.advanceForAutoEnd("c", firstPlayback.playbackId);
	await waitFor(
		() => getPlayMessages(calls).length === 2,
		"随机队列没有自然播放目标歌曲后的下一项",
	);
	const secondPlayback = getPlayMessages(calls)[1];
	manager.advanceForAutoEnd("a", secondPlayback.playbackId);
	await waitFor(
		() => getPlayMessages(calls).length === 3,
		"随机队列没有自然播放完整轮次",
	);
	assert.deepEqual(
		getPlayMessages(calls).map(({ song }) => song.songId),
		["c", "a", "b"],
	);
});

test("下一首、队尾和拖动排序保持当前歌曲身份且不重新起播", {
	concurrency: false,
}, async (context) => {
	const calls = [];
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		if (command === "local_player_send_msg") return undefined;
		throw new Error(`Unexpected IPC command: ${command}`);
	});

	const manager = new PlayQueueManager(createStore({ loudnessEnabled: false }));
	context.after(() => {
		manager.dispose();
		clearMocks();
	});

	manager.setQueue([makeSong("a"), makeSong("b"), makeSong("c")], undefined, 1);
	await waitFor(() => getPlayMessages(calls).length === 1, "队列未启动播放");

	manager.enqueueNext(makeSong("d"));
	manager.enqueueTail(makeSong("e"));
	manager.enqueueNext(makeSong("a"));
	manager.moveSong(4, 0);

	assert.deepEqual(
		manager.getPlayList().map((song) => song.id),
		["e", "b", "a", "d", "c"],
	);
	assert.equal(manager.getCurrentSong()?.id, "b");
	assert.equal(manager.getCurrentIndex(), 1);
	manager.toggleShuffleOn();
	manager.enqueueTail(makeSong("f"));
	assert.equal(manager.getPlayList().at(-1)?.id, "f");
	assert.equal(manager.getCurrentSong()?.id, "b");
	await drainAsyncWork();
	assert.equal(getPlayMessages(calls).length, 1);
});

test("暂停时删除当前歌曲会加载相邻歌曲但保持暂停", {
	concurrency: false,
}, async (context) => {
	const calls = [];
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		if (command === "local_player_send_msg") return undefined;
		throw new Error(`Unexpected IPC command: ${command}`);
	});

	const manager = new PlayQueueManager(createStore({ loudnessEnabled: false }));
	context.after(() => {
		manager.dispose();
		clearMocks();
	});

	manager.setQueue([makeSong("a"), makeSong("b"), makeSong("c")], undefined, 1);
	await waitFor(() => getPlayMessages(calls).length === 1, "队列未启动播放");
	manager.setPlaybackState(false);
	await waitFor(
		() => getAudioMessages(calls, "pauseAudio").length === 1,
		"暂停请求未发送",
	);

	manager.removeSong("b");
	await waitFor(
		() => getPlayMessages(calls).length === 2,
		"删除当前歌曲后未加载相邻歌曲",
	);

	const replacement = getPlayMessages(calls)[1];
	assert.equal(replacement.song.songId, "c");
	assert.equal(replacement.startPaused, true);
	assert.equal(manager.getCurrentSong()?.id, "c");
});

test("删除队列最后一首歌曲会清空状态并停止音频", {
	concurrency: false,
}, async (context) => {
	const calls = [];
	const store = createStore({ loudnessEnabled: false });
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		if (command === "local_player_send_msg") return undefined;
		throw new Error(`Unexpected IPC command: ${command}`);
	});

	const manager = new PlayQueueManager(store);
	context.after(() => {
		manager.dispose();
		clearMocks();
	});

	manager.replaceQueueAndPlay(makeSong("only"));
	await waitFor(() => getPlayMessages(calls).length === 1, "歌曲未启动播放");
	manager.removeSong("only");
	await waitFor(
		() => getAudioMessages(calls, "stopAudio").length === 1,
		"空队列未停止音频",
	);

	assert.deepEqual(manager.getPlayList(), []);
	assert.equal(manager.getCurrentIndex(), -1);
	assert.equal(store.get(queueCurrentIndexAtom), -1);
	assert.deepEqual(store.get(queuePlaylistAtom), []);
	assert.equal(store.get(persistedQueueStateAtom).currentSongId, null);
});

test("清空待播只保留播放历史和当前歌曲", {
	concurrency: false,
}, async (context) => {
	const calls = [];
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		if (command === "local_player_send_msg") return undefined;
		throw new Error(`Unexpected IPC command: ${command}`);
	});

	const manager = new PlayQueueManager(createStore({ loudnessEnabled: false }));
	context.after(() => {
		manager.dispose();
		clearMocks();
	});

	manager.setQueue(
		[makeSong("a"), makeSong("b"), makeSong("c"), makeSong("d")],
		undefined,
		1,
	);
	await waitFor(() => getPlayMessages(calls).length === 1, "队列未启动播放");
	manager.clearUpcoming();

	assert.deepEqual(
		manager.getPlayList().map((song) => song.id),
		["a", "b"],
	);
	assert.equal(manager.getCurrentSong()?.id, "b");
	assert.equal(getPlayMessages(calls).length, 1);
});

test("恢复队列时按当前歌曲 ID 抵消缺失歌曲造成的索引偏移", {
	concurrency: false,
}, async (context) => {
	const store = createStore({ loudnessEnabled: false });
	store.set(persistedQueueStateAtom, {
		songIds: ["missing", "b", "c"],
		originalSongIds: ["missing", "b", "c"],
		currentSongId: "b",
		currentIndex: 1,
		repeatMode: 0,
		shuffleActive: false,
		playlistId: 7,
		position: 12,
	});

	mockIPC((command) => {
		if (command === "get_songs_by_ids") {
			return [makeSong("b"), makeSong("c")];
		}
		throw new Error(`Unexpected IPC command: ${command}`);
	});

	const manager = new PlayQueueManager(store);
	context.after(() => {
		manager.dispose();
		clearMocks();
	});

	const restored = await manager.restore();

	assert.deepEqual(restored, { restored: true, position: 12 });
	assert.deepEqual(
		manager.getPlayList().map((song) => song.id),
		["b", "c"],
	);
	assert.equal(manager.getCurrentSong()?.id, "b");
	assert.equal(manager.getCurrentIndex(), 0);
	assert.equal(store.get(persistedQueueStateAtom).currentSongId, "b");
});
