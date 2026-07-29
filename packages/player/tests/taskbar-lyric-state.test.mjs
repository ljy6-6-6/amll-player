import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	findCurrentLyricIndex,
	findMetadataLyricIndex,
	metadataJumpState,
} from "../src/pages/taskbar-lyric/lyric-timeline.ts";

const taskbarSource = readFileSync(
	fileURLToPath(
		new URL("../src/pages/taskbar-lyric/index.tsx", import.meta.url),
	),
	"utf8",
);
const bridgeSource = readFileSync(
	fileURLToPath(
		new URL("../src/components/TaskbarLyricBridge/index.tsx", import.meta.url),
	),
	"utf8",
);

const lines = [{ startTime: 500 }, { startTime: 2_000 }, { startTime: 4_000 }];

test("暂停时再次同步元数据仍按缓存进度恢复当前歌词", () => {
	assert.equal(findMetadataLyricIndex("song-a", "song-a", lines, 3_000), 1);
	assert.match(
		taskbarSource,
		/const previousMusicId = musicIdRef\.current[\s\S]*musicIdRef\.current = evt\.payload\.musicId[\s\S]*currentLyricIndex: findMetadataLyricIndex\([\s\S]*positionRef\.current \+ LYRIC_OFFSET/,
	);
});

test("新歌元数据不会复用上一首的播放位置", () => {
	assert.equal(findMetadataLyricIndex("song-a", "song-b", lines, 3_000), -1);
	assert.equal(findMetadataLyricIndex(null, "song-b", lines, 3_000), 1);
});

test("同曲封面等元数据更新不会重置歌词动画代次", () => {
	const previous = { lastIndex: 8, jumpId: 3 };

	assert.deepEqual(metadataJumpState(previous, 8, false), {
		lastIndex: 8,
		jumpId: 3,
	});
	assert.deepEqual(metadataJumpState(previous, -1, true), {
		lastIndex: -1,
		jumpId: 0,
	});
});

test("进度事件即使被节流也会先更新请求快照并在暂停时立即发送", () => {
	const positionEffect = bridgeSource.match(
		/useEffect\(\(\) => \{([\s\S]*?)\}, \[musicPlaying, musicPlayingPosition\]\);/,
	)?.[1];

	assert.ok(positionEffect, "应能找到任务栏歌词进度同步逻辑");
	assert.ok(
		positionEffect.indexOf("stateCache.current.position = payload") <
			positionEffect.indexOf(
				"if (musicPlaying && now - lastEmitTime.current < 200) return",
			),
		"最新进度必须在节流返回前写入请求快照",
	);
	assert.match(
		positionEffect,
		/if \(musicPlaying && now - lastEmitTime\.current < 200\) return/,
	);
});

test("歌词尚未开始或列表为空时保持曲目信息态", () => {
	assert.equal(findCurrentLyricIndex(lines, 100), -1);
	assert.equal(findCurrentLyricIndex([], 3_000), -1);
});
