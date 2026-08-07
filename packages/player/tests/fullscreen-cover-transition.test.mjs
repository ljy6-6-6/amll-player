import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	coverRectDistance,
	mapCoverRectFromTransformedContainer,
} from "../src/components/FullscreenCoverTransition/geometry.ts";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const transition = readProjectFile(
	"../src/components/FullscreenCoverTransition/index.tsx",
);
const transitionStyle = readProjectFile(
	"../src/components/FullscreenCoverTransition/index.module.css",
);
const wrapperStyle = readProjectFile(
	"../src/components/AMLLWrapper/index.module.css",
);
const nowPlayingBar = readProjectFile(
	"../src/components/NowPlayingBar/index.tsx",
);
const nowPlayingBarStyle = readProjectFile(
	"../src/components/NowPlayingBar/index.module.css",
);
const reactFullPatch = readProjectFile(
	"../../../patches/@applemusic-like-lyrics__react-full@0.4.2.patch",
);
const installedReactFull = readProjectFile(
	"../node_modules/@applemusic-like-lyrics/react-full/dist/amll-react-framework.mjs",
);

test("依赖封面暴露稳定标记供共享过渡定位", () => {
	for (const source of [reactFullPatch, installedReactFull]) {
		assert.match(source, /data-amll-cover/);
	}
	assert.match(transition, /querySelectorAll<HTMLElement>\(TARGET_SELECTOR\)/);
	assert.match(transition, /right\.rect\.width \* right\.rect\.height/);
});

test("封面终点会消除容器平移和缩放并使用精确视口几何", () => {
	const mapped = mapCoverRectFromTransformedContainer(
		{ left: 220, top: 960, width: 300, height: 240 },
		{ left: 100, top: 800, width: 1600, height: 1200 },
		{ left: 0, top: 0, width: 800, height: 600 },
	);
	assert.deepEqual(mapped, {
		left: 60,
		top: 80,
		width: 150,
		height: 120,
	});
	assert.equal(
		coverRectDistance(mapped, { ...mapped, left: mapped.left + 0.5 }),
		0.5,
	);
	assert.match(transition, /mapCoverRectFromTransformedContainer/);
	assert.match(transition, /TRANSITION_DURATION = 480/);
	assert.match(transition, /CORRECTION_DURATION = 120/);
	assert.match(transition, /cubic-bezier\(0\.25, 1, 0\.5, 1\)/);
	assert.match(
		transition,
		/coverRectDistance\(currentRect, actualEndpoint\.rect\)/,
	);
	assert.match(
		transition,
		/window\.addEventListener\("resize", handleResize\)/,
	);
	assert.match(transitionStyle, /\.transitionViewport/);
	assert.match(transitionStyle, /overflow: hidden/);
	assert.match(transitionStyle, /will-change: left, top, width, height/);
});

test("封面进入和退出共用单层动画并为特殊媒体安全降级", () => {
	assert.match(nowPlayingBar, /musicCoverIsVideoAtom/);
	assert.match(nowPlayingBar, /musicIdAtom/);
	assert.match(nowPlayingBar, /!musicCoverIsVideo && !reduceMotion/);
	assert.match(nowPlayingBar, /"enter"/);
	assert.match(nowPlayingBar, /"exit"/);
	assert.match(nowPlayingBar, /previousLyricPageOpenedRef/);
	assert.match(nowPlayingBar, /coverTransition\.musicId !== musicId/);
	assert.match(nowPlayingBar, /disabled=\{isLyricPageOpened/);
	assert.match(nowPlayingBar, /coverTransitionSourceHidden/);
	assert.match(nowPlayingBarStyle, /\.coverTransitionSourceHidden/);
	assert.match(transition, /document\.body\.dataset\.amllCoverTransition/);
	assert.match(transition, /data-amll-cover-transition-cover/);
	assert.match(transition, /TRANSITION_COVER_SELECTOR/);
	assert.match(wrapperStyle, /body\[data-amll-cover-transition\]/);
	assert.match(wrapperStyle, /\[data-amll-cover\]/);
	assert.match(wrapperStyle, /opacity: 0/);
	assert.match(wrapperStyle, /prefers-reduced-motion: reduce/);
	assert.match(wrapperStyle, /transition-duration: 1ms/);
});
