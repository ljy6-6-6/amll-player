import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform, version } from "@tauri-apps/plugin-os";
import { useStore } from "jotai";
import { useEffect, useRef } from "react";
import semverGt from "semver/functions/gt";
import { hasBackgroundAtom } from "../states/appAtoms";

export const useInitializeWindow = () => {
	const store = useStore();
	const isInitializedRef = useRef(false);

	useEffect(() => {
		const initializeWindow = async () => {
			if (isInitializedRef.current) return;
			isInitializedRef.current = true;

			setTimeout(async () => {
				try {
					const appWindow = getCurrentWindow();

					if (platform() === "windows" && !semverGt(version(), "10.0.22000")) {
						store.set(hasBackgroundAtom, true);
						await appWindow.clearEffects();
					}

					if (platform() === "windows") {
						const enabled =
							localStorage.getItem("amll-player.enableAlwaysOnTop") === "true";
						invoke("set_window_always_on_top", { enabled }).catch((err) => {
							console.error("同步窗口置顶状态失败", err);
						});

						// window-state 会在 WebView 完成首帧前恢复最大化。保持窗口
						// 隐藏并重新套用一次最大化，让 WebView2 取得当前工作区的
						// 精确尺寸，避免自动隐藏任务栏边缘留下 1px 未覆盖区域。
						if (await appWindow.isMaximized()) {
							await appWindow.unmaximize();
							await appWindow.maximize();
						}
					}

					await appWindow.show();
					await appWindow.setFocus();
				} catch (err) {
					console.error("初始化窗口失败:", err);
				}
			}, 50);
		};

		initializeWindow();
	}, [store]);
};
