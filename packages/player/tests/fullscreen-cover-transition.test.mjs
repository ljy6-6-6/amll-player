import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
	assert.match(
		transition,
		/querySelectorAll<HTMLElement>\("\[data-amll-cover\]"\)/,
	);
	assert.match(transition, /right\.width \* right\.height/);
});

test("封面以关闭态布局换算终点并与整页同速完成 FLIP", () => {
	assert.match(transition, /targetCandidate\.left - wrapperRect\.left/);
	assert.match(transition, /targetCandidate\.top - wrapperRect\.top/);
	assert.match(
		transition,
		/snapshot\.source\.width \/ snapshot\.target\.width/,
	);
	assert.match(transition, /duration: 500/);
	assert.match(transition, /cubic-bezier\(0\.25, 1, 0\.5, 1\)/);
	assert.match(transition, /window\.addEventListener\("resize", finish\)/);
	assert.match(transitionStyle, /transform-origin: top left/);
});

test("过渡期间只显示跨层封面并为视频和减少动态效果安全降级", () => {
	assert.match(nowPlayingBar, /musicCoverIsVideoAtom/);
	assert.match(nowPlayingBar, /!musicCoverIsVideo && !reduceMotion/);
	assert.match(nowPlayingBar, /coverTransitionSourceHidden/);
	assert.match(nowPlayingBarStyle, /\.coverTransitionSourceHidden/);
	assert.match(transition, /document\.body\.dataset\.amllCoverTransition/);
	assert.match(wrapperStyle, /body\[data-amll-cover-transition\]/);
	assert.match(wrapperStyle, /\[data-amll-cover\]/);
	assert.match(wrapperStyle, /opacity: 0/);
});
