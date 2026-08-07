import {
	isLyricPageOpenedAtom,
	onPlayOrResumeAtom,
	PrebuiltLyricPlayer,
} from "@applemusic-like-lyrics/react-full";
import { ContextMenu } from "@radix-ui/themes";
import classnames from "classnames";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { type FC, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { playlistCardOpenedAtom } from "../../states/appAtoms.ts";
import { useCursorAutoHide } from "../../utils/useCursorAutoHide.ts";
import { useTitlebarAutoHide } from "../../utils/useTitlebarAutoHide.ts";
import { AMLLContextMenuContent } from "../AMLLContextMenu/index.tsx";
import { AudioQualityDialog } from "../AudioQualityDialog/index.tsx";
import { BottomLyricInfo } from "../BottomLyricInfo";
import { NowPlaylistCard } from "../NowPlaylistCard/index.tsx";
import { RecordPanel } from "../RecordPanel/index.tsx";
import { shouldPreservePointerFocusMode } from "./focus-modality.ts";
import { calculateFullscreenPlaylistPlacement } from "./fullscreen-playlist-position.ts";
import styles from "./index.module.css";
import "@applemusic-like-lyrics/core/style.css";
import "@applemusic-like-lyrics/react-full/style.css";

const FULLSCREEN_PLAYLIST_TOGGLE_SELECTOR =
	'button[data-amll-toggle-type="playlist"]';
const FULLSCREEN_ANIMATED_CONTROL_SELECTOR =
	"button[data-amll-toggle-type], button[data-amll-media-action]";

const animateFullscreenControl = (button: HTMLButtonElement) => {
	requestAnimationFrame(() => {
		if (!button.isConnected) return;
		const icon = button.querySelector<SVGElement>("svg");
		if (!icon) return;

		for (const animation of icon.getAnimations()) animation.cancel();
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

		const action = button.dataset.amllMediaAction;
		const keyframes: Keyframe[] =
			action === "repeat"
				? [
						{ transform: "rotate(0deg) scale(1)" },
						{ transform: "rotate(-32deg) scale(0.82)", offset: 0.35 },
						{ transform: "rotate(360deg) scale(1)" },
					]
				: action === "shuffle"
					? [
							{ transform: "translateX(0) rotate(0deg) scale(1)" },
							{
								transform: "translateX(-0.12em) rotate(-10deg) scale(0.82)",
								offset: 0.34,
							},
							{
								transform: "translateX(0.08em) rotate(5deg) scale(1.06)",
								offset: 0.68,
							},
							{ transform: "translateX(0) rotate(0deg) scale(1)" },
						]
					: [
							{ transform: "rotate(0deg) scale(1)" },
							{ transform: "rotate(-8deg) scale(0.78)", offset: 0.38 },
							{ transform: "rotate(3deg) scale(1.06)", offset: 0.7 },
							{ transform: "rotate(0deg) scale(1)" },
						];

		icon.animate(keyframes, {
			duration: action === "repeat" ? 520 : action === "shuffle" ? 460 : 420,
			easing: "cubic-bezier(0.22, 1, 0.36, 1)",
		});
	});
};

export const AMLLWrapper: FC = () => {
	const { t } = useTranslation();
	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const [playlistOpened, setPlaylistOpened] = useAtom(playlistCardOpenedAtom);
	const setLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);
	const lyricPageRef = useRef<HTMLDivElement>(null);
	const fullscreenPlaylistPanelRef = useRef<HTMLDivElement>(null);
	const fullscreenPlaylistToggleRef = useRef<HTMLButtonElement>(null);
	const previousLyricPageOpenedRef = useRef(isLyricPageOpened);

	const findVisibleFullscreenPlaylistToggle = () => {
		const remembered = fullscreenPlaylistToggleRef.current;
		if (remembered?.isConnected && remembered.getClientRects().length > 0) {
			return remembered;
		}
		const buttons = lyricPageRef.current?.querySelectorAll<HTMLButtonElement>(
			FULLSCREEN_PLAYLIST_TOGGLE_SELECTOR,
		);
		return Array.from(buttons ?? []).find((button) => {
			if (button.getClientRects().length === 0) return false;
			const style = getComputedStyle(button);
			return style.display !== "none" && style.visibility !== "hidden";
		});
	};

	const focusFullscreenPlaylistToggle = () => {
		requestAnimationFrame(() => {
			findVisibleFullscreenPlaylistToggle()?.focus();
		});
	};

	useTitlebarAutoHide(isLyricPageOpened);
	const cursorHidden = useCursorAutoHide(isLyricPageOpened);

	useLayoutEffect(() => {
		if (isLyricPageOpened) {
			document.body.dataset.amllLyricsOpen = "";
		} else {
			delete document.body.dataset.amllLyricsOpen;
			if (lyricPageRef.current) {
				delete lyricPageRef.current.dataset.pointerInput;
			}
		}
	}, [isLyricPageOpened]);

	useLayoutEffect(() => {
		if (!isLyricPageOpened || !lyricPageRef.current) return;

		const label = playlistOpened
			? t("playbar.playlist.close", "关闭当前播放列表")
			: t("playbar.playlist.open", "打开当前播放列表");
		const buttons = lyricPageRef.current.querySelectorAll<HTMLButtonElement>(
			FULLSCREEN_PLAYLIST_TOGGLE_SELECTOR,
		);
		for (const button of buttons) {
			button.dataset.amllPlaylistOpened = playlistOpened ? "true" : "false";
			button.setAttribute("aria-label", label);
			button.setAttribute("aria-expanded", String(playlistOpened));
			button.setAttribute("aria-controls", "fullscreen-now-playlist-card");
			button.setAttribute("aria-haspopup", "dialog");
		}

		return () => {
			for (const button of buttons) {
				delete button.dataset.amllPlaylistOpened;
				button.removeAttribute("aria-expanded");
				button.removeAttribute("aria-controls");
				button.removeAttribute("aria-haspopup");
			}
		};
	}, [isLyricPageOpened, playlistOpened, t]);

	useLayoutEffect(() => {
		if (!isLyricPageOpened || !playlistOpened) return;
		const lyricPage = lyricPageRef.current;
		const panel = fullscreenPlaylistPanelRef.current;
		if (!lyricPage || !panel) return;

		let animationFrame = 0;
		const updatePlacement = () => {
			animationFrame = 0;
			const trigger = findVisibleFullscreenPlaylistToggle();
			if (!trigger) return;
			fullscreenPlaylistToggleRef.current = trigger;

			const containerRect = lyricPage.getBoundingClientRect();
			const triggerRect = trigger.getBoundingClientRect();
			const panelRect = panel.getBoundingClientRect();
			const computedStyle = getComputedStyle(lyricPage);
			const gap =
				Number.parseFloat(computedStyle.getPropertyValue("--space-3")) || 12;
			const titlebarHeight =
				Number.parseFloat(
					computedStyle.getPropertyValue("--system-titlebar-height"),
				) || 0;
			const placement = calculateFullscreenPlaylistPlacement(
				containerRect,
				triggerRect,
				panelRect.width,
				gap,
				titlebarHeight + gap,
			);
			panel.style.setProperty(
				"--amll-fullscreen-playlist-left",
				`${placement.left}px`,
			);
			panel.style.setProperty(
				"--amll-fullscreen-playlist-bottom",
				`${placement.bottom}px`,
			);
			panel.style.setProperty(
				"--amll-fullscreen-playlist-max-height",
				`${placement.maxHeight}px`,
			);
		};
		const schedulePlacement = () => {
			if (animationFrame) cancelAnimationFrame(animationFrame);
			animationFrame = requestAnimationFrame(updatePlacement);
		};
		const observer = new ResizeObserver(schedulePlacement);
		observer.observe(lyricPage);
		observer.observe(panel);
		for (const button of lyricPage.querySelectorAll<HTMLButtonElement>(
			FULLSCREEN_PLAYLIST_TOGGLE_SELECTOR,
		)) {
			observer.observe(button);
		}
		window.addEventListener("resize", schedulePlacement);
		schedulePlacement();

		return () => {
			if (animationFrame) cancelAnimationFrame(animationFrame);
			observer.disconnect();
			window.removeEventListener("resize", schedulePlacement);
		};
	}, [isLyricPageOpened, playlistOpened]);

	useEffect(() => {
		if (previousLyricPageOpenedRef.current && !isLyricPageOpened) {
			setPlaylistOpened(false);
		}
		previousLyricPageOpenedRef.current = isLyricPageOpened;
	}, [isLyricPageOpened, setPlaylistOpened]);

	useEffect(() => {
		if (!isLyricPageOpened) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (!shouldPreservePointerFocusMode(e) && lyricPageRef.current) {
				delete lyricPageRef.current.dataset.pointerInput;
			}
			if (e.key === " ") {
				e.preventDefault();
				onPlayOrResume?.();
			} else if (e.key === "Escape") {
				if (playlistOpened) {
					e.preventDefault();
					e.stopPropagation();
					setPlaylistOpened(false);
					focusFullscreenPlaylistToggle();
				} else {
					setLyricPageOpened(false);
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [
		isLyricPageOpened,
		onPlayOrResume,
		playlistOpened,
		setLyricPageOpened,
		setPlaylistOpened,
	]);

	return (
		<>
			<ContextMenu.Root>
				<ContextMenu.Trigger>
					<div
						ref={lyricPageRef}
						className={classnames(
							styles.lyricPage,
							isLyricPageOpened && styles.opened,
						)}
						id="amll-lyric-player-wrapper"
						onPointerDownCapture={(event) => {
							if (event.pointerType === "mouse") {
								event.currentTarget.dataset.pointerInput = "";
							}
						}}
						onClick={(event) => {
							const target = event.target;
							const controlButton =
								target instanceof Element
									? target.closest<HTMLButtonElement>(
											FULLSCREEN_ANIMATED_CONTROL_SELECTOR,
										)
									: null;
							if (
								!controlButton ||
								!event.currentTarget.contains(controlButton)
							) {
								return;
							}
							animateFullscreenControl(controlButton);
							if (controlButton.dataset.amllToggleType === "playlist") {
								fullscreenPlaylistToggleRef.current = controlButton;
								setPlaylistOpened((opened) => !opened);
							}
						}}
					>
						<PrebuiltLyricPlayer
							id="amll-lyric-player"
							style={{ width: "100%", height: "100%" }}
							bottomLineSlot={<BottomLyricInfo />}
						/>
						{isLyricPageOpened && playlistOpened && (
							<>
								<button
									className={styles.fullscreenPlaylistDismissLayer}
									type="button"
									tabIndex={-1}
									aria-label={t("playbar.playlist.close", "关闭当前播放列表")}
									onClick={() => {
										setPlaylistOpened(false);
										focusFullscreenPlaylistToggle();
									}}
								/>
								<div
									ref={fullscreenPlaylistPanelRef}
									className={styles.fullscreenPlaylistPanel}
									data-amll-playlist-panel=""
									onPointerDown={(event) => event.stopPropagation()}
								>
									<NowPlaylistCard
										id="fullscreen-now-playlist-card"
										className={styles.fullscreenPlaylistCard}
										onRequestClose={() => {
											setPlaylistOpened(false);
											focusFullscreenPlaylistToggle();
										}}
									/>
								</div>
							</>
						)}
						{cursorHidden && <div className={styles.cursorHiddenOverlay} />}
					</div>
				</ContextMenu.Trigger>
				<AMLLContextMenuContent />
			</ContextMenu.Root>
			<AudioQualityDialog />
			<RecordPanel />
		</>
	);
};

export default AMLLWrapper;
