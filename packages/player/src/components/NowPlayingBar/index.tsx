import {
	isLyricPageOpenedAtom,
	MediaButton,
	musicArtistsAtom,
	musicCoverAtom,
	musicCoverIsVideoAtom,
	musicNameAtom,
	musicPlayingAtom,
	onPlayOrResumeAtom,
	onRequestNextSongAtom,
	onRequestPrevSongAtom,
	TextMarquee,
} from "@applemusic-like-lyrics/react-full";
import lyricIcon from "@iconify/icons-ic/round-lyrics";
import { Icon } from "@iconify/react";
import {
	ListBulletIcon,
	TrackNextIcon,
	TrackPreviousIcon,
} from "@radix-ui/react-icons";
import { Flex, IconButton } from "@radix-ui/themes";
import classNames from "classnames";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	type FC,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import IconForward from "../../assets/icon_forward.svg?react";
import IconRewind from "../../assets/icon_rewind.svg?react";
import {
	hideNowPlayingBarAtom,
	playlistCardOpenedAtom,
} from "../../states/appAtoms.ts";
import { AnimatedPlayPauseIcon } from "../AnimatedPlayPauseIcon/index.tsx";
import {
	captureFullscreenCoverTransition,
	FullscreenCoverTransition,
	type FullscreenCoverTransitionSnapshot,
} from "../FullscreenCoverTransition/index.tsx";
import { NowPlaylistCard } from "../NowPlaylistCard/index.tsx";
import styles from "./index.module.css";

export const NowPlayingBar: FC = () => {
	const { t } = useTranslation();
	const hideNowPlayingBar = useAtomValue(hideNowPlayingBarAtom);
	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const musicName = useAtomValue(musicNameAtom);
	const musicArtists = useAtomValue(musicArtistsAtom);
	const musicPlaying = useAtomValue(musicPlayingAtom);
	const musicCover = useAtomValue(musicCoverAtom);
	const musicCoverIsVideo = useAtomValue(musicCoverIsVideoAtom);
	const [playlistOpened, setPlaylistOpened] = useAtom(playlistCardOpenedAtom);
	const setLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);
	const [coverTransition, setCoverTransition] =
		useState<FullscreenCoverTransitionSnapshot | null>(null);

	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const onRequestPrevSong = useAtomValue(onRequestPrevSongAtom).onEmit;
	const onRequestNextSong = useAtomValue(onRequestNextSongAtom).onEmit;

	const playbarRef = useRef<HTMLDivElement>(null);
	const coverButtonRef = useRef<HTMLButtonElement>(null);
	const playlistPanelRef = useRef<HTMLDivElement>(null);
	const playlistDismissLayerRef = useRef<HTMLButtonElement>(null);
	const playlistToggleButtonRef = useRef<HTMLButtonElement>(null);
	const finishCoverTransition = useCallback(() => {
		setCoverTransition(null);
	}, []);
	const openLyricPage = () => {
		const source = coverButtonRef.current;
		const reduceMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		const snapshot =
			source && musicCover && !musicCoverIsVideo && !reduceMotion
				? captureFullscreenCoverTransition(source, musicCover)
				: null;
		setCoverTransition(snapshot);
		setLyricPageOpened(true);
	};

	useEffect(() => {
		if (coverTransition && coverTransition.coverUrl !== musicCover) {
			setCoverTransition(null);
		}
	}, [coverTransition, musicCover]);

	useLayoutEffect(() => {
		const playbarEl = playbarRef.current;
		if (!playbarEl) return;
		const updateSafeBound = () => {
			const { top } = playbarEl.getBoundingClientRect();
			document.body.style.setProperty(
				"--amll-player-playbar-bottom",
				`${window.innerHeight - top}px`,
			);
		};
		const observer = new ResizeObserver(updateSafeBound);
		window.addEventListener("resize", updateSafeBound);
		observer.observe(playbarEl);
		updateSafeBound();
		return () => {
			window.removeEventListener("resize", updateSafeBound);
			observer.disconnect();
		};
	}, []);

	useEffect(() => {
		if (!playlistOpened || isLyricPageOpened) return;

		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			const targetElement = target instanceof Element ? target : null;
			if (
				playlistPanelRef.current?.contains(target) ||
				playlistDismissLayerRef.current?.contains(target) ||
				playlistToggleButtonRef.current?.contains(target) ||
				targetElement?.closest(
					'[data-amll-playlist-panel], [data-amll-toggle-type="playlist"]',
				)
			) {
				return;
			}
			setPlaylistOpened(false);
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			setPlaylistOpened(false);
			playlistToggleButtonRef.current?.focus();
		};

		document.addEventListener("pointerdown", handlePointerDown, true);
		document.addEventListener("keydown", handleKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown, true);
			document.removeEventListener("keydown", handleKeyDown, true);
		};
	}, [isLyricPageOpened, playlistOpened, setPlaylistOpened]);

	return (
		<>
			{coverTransition && (
				<FullscreenCoverTransition
					snapshot={coverTransition}
					onFinish={finishCoverTransition}
				/>
			)}
			{/* <Container
		 	className={classNames(
		 		styles.nowPlayingBar,
		 		hideNowPlayingBar && styles.hide,
		 	)}
		 	position="fixed"
		 	bottom="0"
		 	left="0"
		 	right="0"
			> */}
			{playlistOpened && !isLyricPageOpened && (
				<>
					<button
						ref={playlistDismissLayerRef}
						className={styles.playlistDismissLayer}
						type="button"
						tabIndex={-1}
						aria-label={t("playbar.playlist.close", "关闭当前播放列表")}
						onPointerDown={(event) => event.preventDefault()}
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							setPlaylistOpened(false);
							playlistToggleButtonRef.current?.focus();
						}}
					/>
					<Flex
						className={styles.playlistPanel}
						direction="row-reverse"
						mx="3"
						position="absolute"
						right="0"
						bottom="calc(var(--amll-player-playbar-bottom) + var(--space-3))"
						ref={playlistPanelRef}
					>
						<NowPlaylistCard
							id="now-playlist-card"
							className={classNames(styles.playlistCard)}
							onRequestClose={() => {
								setPlaylistOpened(false);
								playlistToggleButtonRef.current?.focus();
							}}
						/>
					</Flex>
				</>
			)}
			<Flex
				className={classNames(styles.playBar, hideNowPlayingBar && styles.hide)}
				overflow="hidden"
				ref={playbarRef}
			>
				<Flex
					direction="row"
					justify="center"
					align="center"
					flexGrow="1"
					flexBasis="33.3%"
				>
					<button
						ref={coverButtonRef}
						className={classNames(
							styles.coverButton,
							coverTransition && styles.coverTransitionSourceHidden,
						)}
						type="button"
						aria-label={t("playbar.openLyricPage", "打开全屏歌词")}
						style={{
							backgroundImage: `url(${musicCover})`,
						}}
						onClick={openLyricPage}
					>
						<div className={styles.lyricIconButton}>
							<Icon width={34} icon={lyricIcon} className="icon" />
						</div>
					</button>
					<Flex
						direction="column"
						justify="center"
						ml="4"
						flexGrow="1"
						minWidth="0"
						overflow="hidden"
						style={{
							textWrap: "nowrap",
						}}
					>
						<TextMarquee>{musicName}</TextMarquee>
						<TextMarquee>
							{musicArtists.map((v) => v.name).join(", ")}
						</TextMarquee>
					</Flex>
				</Flex>
				<Flex
					direction="row"
					justify="center"
					align="center"
					flexGrow="1"
					flexBasis="33.3%"
					gap="5"
					display={{
						initial: "none",
						sm: "flex",
					}}
				>
					<MediaButton
						style={{
							scale: "1.5",
						}}
						onClick={onRequestPrevSong}
					>
						<IconRewind
							style={{
								scale: "1.25",
							}}
						/>
					</MediaButton>
					<MediaButton
						style={{
							scale: "1.5",
						}}
						onClick={onPlayOrResume}
					>
						<AnimatedPlayPauseIcon
							playing={musicPlaying}
							style={{
								scale: "0.75",
							}}
						/>
					</MediaButton>
					<MediaButton
						style={{
							scale: "1.5",
						}}
						onClick={onRequestNextSong}
					>
						<IconForward
							style={{
								scale: "1.25",
							}}
						/>
					</MediaButton>
				</Flex>
				<Flex
					direction="row"
					justify="end"
					align="center"
					flexGrow={{
						initial: "0",
						sm: "1",
					}}
					flexBasis={{
						initial: "",
						sm: "33.3%",
					}}
					gap="1"
				>
					<Flex
						direction="row"
						justify="end"
						align="center"
						gap="1"
						display={{
							initial: "flex",
							sm: "none",
						}}
					>
						<IconButton onClick={onRequestPrevSong} variant="soft">
							<TrackPreviousIcon />
						</IconButton>
						<IconButton onClick={onPlayOrResume} variant="soft">
							<AnimatedPlayPauseIcon playing={musicPlaying} />
						</IconButton>
						<IconButton onClick={onRequestNextSong} variant="soft">
							<TrackNextIcon />
						</IconButton>
					</Flex>
					<IconButton
						ref={playlistToggleButtonRef}
						variant="soft"
						onClick={() => setPlaylistOpened((v) => !v)}
						aria-label={
							playlistOpened
								? t("playbar.playlist.close", "关闭当前播放列表")
								: t("playbar.playlist.open", "打开当前播放列表")
						}
						aria-expanded={playlistOpened}
						aria-controls="now-playlist-card"
						aria-haspopup="dialog"
					>
						<ListBulletIcon />
					</IconButton>
				</Flex>
			</Flex>
			{/* </Container> */}
		</>
	);
};
