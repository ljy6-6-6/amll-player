import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	findCurrentLyricIndex,
	findMetadataLyricIndex,
	reconcileMetadataTimeline,
	taskbarContentGroupKey,
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

	assert.deepEqual(reconcileMetadataTimeline(8, previous, 9, false, 12), {
		currentLyricIndex: 8,
		jumpState: previous,
	});
	assert.deepEqual(reconcileMetadataTimeline(8, previous, -1, true, 12), {
		currentLyricIndex: -1,
		jumpState: { lastIndex: -1, jumpId: 0 },
	});
	assert.deepEqual(reconcileMetadataTimeline(-1, previous, 1, false, 3), {
		currentLyricIndex: 1,
		jumpState: { lastIndex: 1, jumpId: 3 },
	});
	assert.deepEqual(reconcileMetadataTimeline(8, previous, 1, false, 3), {
		currentLyricIndex: 1,
		jumpState: { lastIndex: 1, jumpId: 3 },
	});
	assert.match(
		taskbarSource,
		/const trackChanged = previousMusicId !== evt\.payload\.musicId/,
	);
});

test("普通切句和副歌词有无变化不会重建外层歌词组", () => {
	const lyricKey = taskbarContentGroupKey("song-a", false, 4);
	assert.equal(taskbarContentGroupKey("song-a", false, 4), lyricKey);
	assert.notEqual(taskbarContentGroupKey("song-a", false, 5), lyricKey);
	assert.notEqual(taskbarContentGroupKey("song-b", false, 4), lyricKey);
	assert.notEqual(taskbarContentGroupKey("song-a", true, 4), lyricKey);
	assert.equal(
		taskbarContentGroupKey("song-a", true, 9),
		taskbarContentGroupKey("song-a", true, 0),
	);
	assert.match(
		taskbarSource,
		/const groupKey = taskbarContentGroupKey\(\s*musicId,\s*displayAsMetadata,\s*jumpState\.jumpId/,
	);
});

test("长句切换短句时容器延后收窄以保留退场上滑", () => {
	assert.match(taskbarSource, /const LYRIC_EXIT_EXTENT_HOLD_MS = 360/);
	assert.match(
		taskbarSource,
		/measured >= current[\s\S]*collapsedShrinkTimerRef\.current = window\.setTimeout/,
	);
	assert.match(
		taskbarSource,
		/if \(isHovered\) return;[\s\S]*\[isHovered, layoutExtents, musicId, orientation\]/,
	);
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
	assert.match(
		taskbarSource,
		/const isMetadataMode =\s*currentLyricIndex < 0 \|\| !hasLyrics \|\| !currentLine/,
	);
});
