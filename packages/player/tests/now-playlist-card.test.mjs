import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	getQueueAutoScrollSpeed,
	getQueueDragShift,
	getQueueDropIndex,
	QUEUE_DRAG_THRESHOLD_PX,
} from "../src/components/NowPlaylistCard/queue-drag.ts";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const queueCard = readProjectFile(
	"../src/components/NowPlaylistCard/index.tsx",
);
const queueCardStyle = readProjectFile(
	"../src/components/NowPlaylistCard/index.module.css",
);
const nowPlayingBar = readProjectFile(
	"../src/components/NowPlayingBar/index.tsx",
);

test("队列行单击即可播放且当前歌曲有明确状态", () => {
	assert.match(queueCard, /onClick=\{onPlay\}/);
	assert.match(queueCard, /queueManager\?\.playAt\(virtualItem\.index\)/);
	assert.doesNotMatch(queueCard, /onDoubleClick/);
	assert.match(queueCard, /aria-current=\{isCurrent \? "true" : undefined\}/);
	assert.match(queueCard, /data-current=\{isCurrent \? "true" : "false"\}/);
	assert.match(queueCard, /role="list"/);
	assert.match(queueCard, /role="listitem"/);
	assert.match(queueCard, /aria-posinset=\{virtualItem\.index \+ 1\}/);
	assert.match(queueCard, /aria-setsize=\{playlist\.length\}/);
	assert.match(queueCard, /playbar\.playlist\.current/);
	assert.match(queueCardStyle, /\.playlistSongItem\.current\s*\{/);
	assert.match(queueCardStyle, /border-left-color:\s*var\(--accent-9\)/);
});

test("队列弹层只保留逐项移除并通过整行拖动调整顺序", () => {
	assert.match(queueCard, /queueManager\?\.removeSong\(song\.id\)/);
	assert.match(
		queueCard,
		/beginQueueDrag\(event, song\.id, virtualItem\.index\)/,
	);
	assert.match(
		queueCard,
		/captureTarget\.setPointerCapture\(event\.pointerId\)/,
	);
	assert.match(queueCard, /viewport\.setPointerCapture\(event\.pointerId\)/);
	assert.match(queueCard, /QUEUE_DRAG_THRESHOLD_PX/);
	assert.match(queueCard, /getQueueDropIndex/);
	assert.match(queueCard, /getQueueDragShift/);
	assert.match(queueCard, /getQueueAutoScrollSpeed/);
	assert.match(queueCard, /queueManager\.moveSong\(fromIndex, toIndex\)/);
	assert.match(queueCard, /queueManager\?\.clearUpcoming\(\)/);
	assert.match(queueCard, /playbar\.playlist\.removeSong/);
	assert.match(queueCard, /data-queue-action/);
	assert.match(
		queueCard,
		/onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/,
	);
	assert.doesNotMatch(queueCard, /SpeakerLoudIcon/);
	assert.doesNotMatch(queueCard, /ChevronUpIcon/);
	assert.doesNotMatch(queueCard, /ChevronDownIcon/);
	assert.doesNotMatch(queueCard, /disabled=\{index === 0\}/);
});

test("拖动排序保留稳定身份、平滑反馈和安全取消", () => {
	assert.match(queueCard, /itemIds: playlistRef\.current\.map/);
	assert.match(queueCard, /playlist\[index\]\?\.id !== songId/);
	assert.match(queueCard, /suppressedClickSongIdRef/);
	assert.match(queueCard, /activeDragRef\.current/);
	assert.match(queueCard, /className=\{styles\.dragOverlay\}/);
	assert.match(queueCard, /className=\{classNames\([\s\S]*styles\.rowMotion/);
	assert.match(queueCard, /style=\{\{ y: overlayY \}\}/);
	assert.match(queueCard, /requestAnimationFrame\(scrollAtEdge\)/);
	assert.match(queueCard, /event\.key !== "Escape"/);
	assert.match(queueCard, /cancelQueueDrag/);
	assert.match(queueCard, /event\.altKey/);
	assert.match(queueCard, /"Alt\+ArrowUp Alt\+ArrowDown"/);
	assert.match(queueCard, /event\.target === event\.currentTarget/);
	assert.match(queueCard, /flushSync/);
	assert.match(queueCard, /rowMotionGeneration/);
	assert.match(queueCardStyle, /\.dragOverlay[\s\S]*pointer-events:\s*none/);
	assert.match(queueCardStyle, /\.dragSource\s*\{[\s\S]*opacity:\s*0/);
	assert.match(
		queueCardStyle,
		/\.playlistSongItem\.dragOverlayItem\s*\{[\s\S]*background-color:\s*var\(--gray-4\)/,
	);
	assert.match(
		queueCardStyle,
		/\.playlistSongItem\.dragOverlayItem\.current\s*\{[\s\S]*background-color:\s*var\(--accent-4\)/,
	);
	assert.match(queueCardStyle, /@media \(prefers-reduced-motion: reduce\)/);
});

test("拖动目标按固定行高计算并限制在队列范围内", () => {
	assert.equal(QUEUE_DRAG_THRESHOLD_PX, 6);
	assert.equal(getQueueDropIndex(0, -100, 0, 36, 72, 5), 0);
	assert.equal(getQueueDropIndex(0, 100, 0, 36, 72, 5), 1);
	assert.equal(getQueueDropIndex(144, 36, 0, 36, 72, 5), 2);
	assert.equal(getQueueDropIndex(0, 1_000, 0, 36, 72, 5), 4);
	assert.equal(getQueueDropIndex(0, 100, 0, 36, 72, 0), -1);
});

test("拖动跨行时只让被跨过的相邻歌曲让位", () => {
	assert.equal(getQueueDragShift(1, 1, 3, 72), 0);
	assert.equal(getQueueDragShift(2, 1, 3, 72), -72);
	assert.equal(getQueueDragShift(3, 1, 3, 72), -72);
	assert.equal(getQueueDragShift(4, 1, 3, 72), 0);
	assert.equal(getQueueDragShift(1, 3, 1, 72), 72);
	assert.equal(getQueueDragShift(2, 3, 1, 72), 72);
	assert.equal(getQueueDragShift(3, 3, 1, 72), 0);
});

test("队列重排只改变当前索引时不会强制滚回正在播放项", () => {
	assert.match(queueCard, /lastAutoScrolledSongIdRef/);
	assert.match(
		queueCard,
		/lastAutoScrolledSongIdRef\.current === currentSongId/,
	);
	assert.match(
		queueCard,
		/lastAutoScrolledSongIdRef\.current = currentSongId;[\s\S]*rowVirtualizer\.scrollToIndex/,
	);
});

test("拖到可视区边缘时按距离连续调节自动滚动速度", () => {
	assert.equal(getQueueAutoScrollSpeed(100, 100, 400), -16);
	assert.equal(getQueueAutoScrollSpeed(124, 100, 400), -8);
	assert.equal(getQueueAutoScrollSpeed(250, 100, 400), 0);
	assert.equal(getQueueAutoScrollSpeed(376, 100, 400), 8);
	assert.equal(getQueueAutoScrollSpeed(400, 100, 400), 16);
});

test("虚拟列表估算行高与实际行盒保持一致", () => {
	const rowHeight = queueCard.match(/NOW_PLAYLIST_ROW_HEIGHT = (\d+)/)?.[1];
	assert.equal(rowHeight, "72");
	assert.match(queueCard, /estimateSize:\s*\(\) => NOW_PLAYLIST_ROW_HEIGHT/);
	assert.match(
		queueCard,
		/getItemKey: \(index\) => playlist\[index\]\?\.id \?\? index/,
	);
	assert.doesNotMatch(queueCard, /measureElement/);
	assert.match(queueCard, /data-index=\{virtualItem\.index\}/);
	assert.match(queueCard, /height: `\$\{NOW_PLAYLIST_ROW_HEIGHT\}px`/);
	assert.match(queueCardStyle, /\.queueRowSlot[\s\S]*box-sizing:\s*border-box/);
	assert.match(queueCardStyle, /\.playlistSongItem[\s\S]*height:\s*100%/);
});

test("播放队列按歌曲数量延展并只在接近播放栏时滚动", () => {
	assert.match(queueCardStyle, /\.root\s*\{[\s\S]*height:\s*auto/);
	assert.match(
		queueCardStyle,
		/max-height:\s*calc\([\s\S]*100dvh[\s\S]*--amll-player-playbar-bottom/,
	);
	assert.match(queueCardStyle, /\.queueViewport\s*\{[\s\S]*flex:\s*0 1 auto/);
	assert.match(
		queueCard,
		/<ScrollArea[\s\S]*type="scroll"[\s\S]*scrollbars="vertical"[\s\S]*size="1"/,
	);
	assert.match(queueCardStyle, /\.rt-ScrollAreaScrollbar/);
	assert.match(queueCardStyle, /\.rt-ScrollAreaThumb/);
	assert.doesNotMatch(queueCardStyle, /scrollbar-gutter:\s*stable/);
	assert.doesNotMatch(queueCardStyle, /height:\s*min\(500px,\s*50vh\)/);
});

test("标题展示队列计数并覆盖空队列和待播数量", () => {
	assert.match(queueCard, /playbar\.playlist\.count/);
	assert.match(queueCard, /playlist\.length === 0/);
	assert.match(queueCard, /playbar\.playlist\.emptyTitle/);
	assert.match(queueCard, /playbar\.playlist\.clearUpcomingLabel/);
});

test("播放队列新增文案在所有内置语言中都有翻译", () => {
	const requiredKeys = [
		"clearUpcoming",
		"clearUpcomingLabel",
		"close",
		"count",
		"current",
		"emptyHint",
		"emptyTitle",
		"moveDown",
		"moveUp",
		"open",
		"playSong",
		"queueLabel",
		"removeSong",
		"replaySong",
		"title",
		"unknownArtist",
		"unknownSong",
	];
	for (const locale of ["en-US", "ja-JP", "vi-VN", "zh-CN", "zh-TW"]) {
		const messages = JSON.parse(
			readProjectFile(`../locales/${locale}/translation.json`),
		).playbar.playlist;
		for (const key of requiredKeys) {
			assert.equal(
				typeof messages[key],
				"string",
				`${locale} 缺少 playbar.playlist.${key}`,
			);
			assert.notEqual(messages[key].length, 0);
		}
	}
});

test("Esc 和外部指针关闭弹层且内部交互不会被当作外部点击", () => {
	assert.match(
		nowPlayingBar,
		/playlistPanelRef\.current\?\.contains\(target\)/,
	);
	assert.match(
		nowPlayingBar,
		/playlistDismissLayerRef\.current\?\.contains\(target\)/,
	);
	assert.match(
		nowPlayingBar,
		/playlistToggleButtonRef\.current\?\.contains\(target\)/,
	);
	assert.match(nowPlayingBar, /className=\{styles\.playlistDismissLayer\}/);
	assert.match(
		nowPlayingBar,
		/onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/,
	);
	assert.match(nowPlayingBar, /event\.stopPropagation\(\)/);
	assert.match(nowPlayingBar, /event\.key !== "Escape"/);
	assert.match(
		nowPlayingBar,
		/document\.addEventListener\("pointerdown", handlePointerDown, true\)/,
	);
	assert.match(
		nowPlayingBar,
		/document\.addEventListener\("keydown", handleKeyDown, true\)/,
	);
	assert.match(nowPlayingBar, /aria-expanded=\{playlistOpened\}/);
	assert.match(nowPlayingBar, /aria-controls="now-playlist-card"/);
	assert.match(nowPlayingBar, /aria-haspopup="dialog"/);
	assert.match(queueCard, /autoFocus/);
	assert.match(queueCard, /onRequestClose/);
});
