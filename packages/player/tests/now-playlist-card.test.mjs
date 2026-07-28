import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
	assert.match(
		queueCard,
		/onClick=\{\(\) => queueManager\?\.playAt\(index\)\}/,
	);
	assert.doesNotMatch(queueCard, /onDoubleClick/);
	assert.match(queueCard, /aria-current=\{isCurrent \? "true" : undefined\}/);
	assert.match(queueCard, /data-current=\{isCurrent \? "true" : "false"\}/);
	assert.match(queueCard, /role="list"/);
	assert.match(queueCard, /role="listitem"/);
	assert.match(queueCard, /aria-posinset=\{virtualItem\.index \+ 1\}/);
	assert.match(queueCard, /aria-setsize=\{playlist\.length\}/);
	assert.match(queueCard, /正在播放/);
	assert.match(queueCardStyle, /\.playlistSongItem\.current\s*\{/);
	assert.match(queueCardStyle, /border-left-color:\s*var\(--accent-9\)/);
});

test("队列弹层提供逐项移除、上下移动和清空待播操作", () => {
	assert.match(queueCard, /queueManager\?\.removeSong\(song\.id\)/);
	assert.match(queueCard, /queueManager\?\.moveSong\(index, index - 1\)/);
	assert.match(queueCard, /queueManager\?\.moveSong\(index, index \+ 1\)/);
	assert.match(queueCard, /queueManager\?\.clearUpcoming\(\)/);
	assert.match(queueCard, /disabled=\{index === 0\}/);
	assert.match(queueCard, /disabled=\{index === queueLength - 1\}/);
	assert.match(queueCard, /aria-label=\{`上移 \$\{name\}`\}/);
	assert.match(queueCard, /aria-label=\{`下移 \$\{name\}`\}/);
	assert.match(queueCard, /aria-label=\{`从播放队列移除 \$\{name\}`\}/);
	assert.ok(
		(queueCard.match(/event\.stopPropagation\(\)/g) ?? []).length >= 5,
		"队列操作按钮应拦截点击，避免误触歌曲播放",
	);
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

test("标题展示队列计数并覆盖空队列和待播数量", () => {
	assert.match(queueCard, /aria-label=\{`共 \$\{playlist\.length\} 首`\}/);
	assert.match(queueCard, /\{playlist\.length\} 首/);
	assert.match(queueCard, /playlist\.length === 0/);
	assert.match(queueCard, /播放队列为空/);
	assert.match(queueCard, /清空 \$\{upcomingCount\} 首待播歌曲/);
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
