import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const initialization = readProjectFile("../src/utils/useInitializeWindow.ts");
const nativeWindow = readProjectFile("../src-tauri/src/window.rs");
const nativeEntry = readProjectFile("../src-tauri/src/lib.rs");

test("Windows 主窗口只在前端首帧后执行一次原生呈现", () => {
	assert.match(initialization, /waitForCommittedFrames/);
	assert.match(
		initialization,
		/requestAnimationFrame\(\(\) => \{[\s\S]*requestAnimationFrame\(finish\)/,
	);
	assert.match(initialization, /invoke\("present_main_window"\)/);
	assert.doesNotMatch(initialization, /appWindow\.(?:unmaximize|maximize)\(/);
});

test("隐藏阶段恢复窗口时明确排除最大化和可见状态", () => {
	assert.match(nativeEntry, /skip_initial_state\("main"\)/);
	assert.match(
		nativeWindow,
		/StateFlags::SIZE\s*\|\s*StateFlags::POSITION\s*\|\s*StateFlags::DECORATIONS/,
	);
	assert.match(nativeWindow, /!flags\.contains\(StateFlags::MAXIMIZED\)/);
	assert.match(nativeWindow, /!flags\.contains\(StateFlags::VISIBLE\)/);
	assert.match(nativeWindow, /!flags\.contains\(StateFlags::FULLSCREEN\)/);
});

test("最终呈现按最大化意图原子显示并校准 WebView 客户区", () => {
	assert.match(nativeWindow, /set_dwm_cloaked\(hwnd, true\)/);
	assert.match(nativeWindow, /DwmCloakGuard/);
	assert.match(nativeWindow, /uncloak_dwm_with_retry/);
	assert.match(nativeWindow, /restore_state\(StateFlags::MAXIMIZED\)/);
	assert.match(nativeWindow, /ShowWindow\(hwnd, SW_SHOWMAXIMIZED\)/);
	assert.match(
		nativeWindow,
		/window\.show\(\)[\s\S]*window\.inner_size\(\)[\s\S]*\.set_bounds\(Rect[\s\S]*guard[\s\S]*\.release\(\)/,
	);
	assert.match(
		nativeWindow,
		/should_fullscreen[\s\S]*restore_state\(StateFlags::FULLSCREEN\)/,
	);
	assert.match(nativeWindow, /revealed\.swap\(true, Ordering::AcqRel\)/);
});

test("退出时在窗口状态插件保存后归一化主窗口还原坐标", () => {
	assert.match(nativeEntry, /\.build\(context\)/);
	assert.match(
		nativeEntry,
		/RunEvent::Exit[\s\S]*sanitize_persisted_main_window_state/,
	);
	assert.match(nativeWindow, /restore_bounds_generation/);
	assert.match(nativeWindow, /RESTORE_BOUNDS_SETTLE_DELAY/);
	assert.match(
		nativeWindow,
		/normalize_persisted_main_window_state[\s\S]*"prev_x"[\s\S]*"prev_y"/,
	);
});
