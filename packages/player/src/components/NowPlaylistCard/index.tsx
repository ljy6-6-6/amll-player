import { Cross2Icon, TrashIcon } from "@radix-ui/react-icons";
import { Avatar, Flex, type FlexProps } from "@radix-ui/themes";
import { useVirtualizer } from "@tanstack/react-virtual";
import { convertFileSrc } from "@tauri-apps/api/core";
import classNames from "classnames";
import {
	animate,
	motion,
	useMotionValue,
	useReducedMotion,
} from "framer-motion";
import { useAtomValue } from "jotai";
import {
	type FC,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { Trans, useTranslation } from "react-i18next";
import { queueManagerAtom } from "../../states/appAtoms.ts";
import type { Song } from "../../utils/db-client.ts";
import {
	queueCurrentIndexAtom,
	queuePlaylistAtom,
} from "../../utils/play-queue-manager.ts";
import styles from "./index.module.css";
import {
	getQueueAutoScrollSpeed,
	getQueueDragShift,
	getQueueDropIndex,
	QUEUE_DRAG_THRESHOLD_PX,
} from "./queue-drag.ts";

export const NOW_PLAYLIST_ROW_HEIGHT = 72;
const QUEUE_DROP_DURATION_SECONDS = 0.16;
const QUEUE_SHIFT_SPRING = {
	type: "spring" as const,
	stiffness: 520,
	damping: 42,
	mass: 0.75,
};

interface QueueDragCandidate {
	pointerId: number;
	captureTarget: Element;
	songId: string;
	originIndex: number;
	startClientY: number;
	pointerClientY: number;
	grabOffset: number;
	itemCount: number;
	itemIds: string[];
}

interface ActiveQueueDrag extends QueueDragCandidate {
	targetIndex: number;
	dropping: boolean;
}

interface PlaylistSongItemProps {
	song: Song;
	isCurrent: boolean;
	isDragOverlay?: boolean;
	onPlay: () => void;
	onMoveBy: (offset: number) => void;
	onRemove: () => void;
}

const PlaylistSongItem: FC<PlaylistSongItemProps> = ({
	song,
	isCurrent,
	isDragOverlay = false,
	onPlay,
	onMoveBy,
	onRemove,
}) => {
	const { t } = useTranslation();
	const cover = song.coverPath
		? song.coverPath.startsWith("http://") ||
			song.coverPath.startsWith("https://")
			? song.coverPath
			: convertFileSrc(song.coverPath)
		: "";
	const name = song.songName || t("playbar.playlist.unknownSong", "未知歌曲");
	const artists =
		song.songArtists || t("playbar.playlist.unknownArtist", "未知艺术家");

	return (
		<div
			className={classNames(
				styles.playlistSongItem,
				isCurrent && styles.current,
				isDragOverlay && styles.dragOverlayItem,
			)}
			data-current={isCurrent ? "true" : "false"}
		>
			<button
				type="button"
				className={styles.songMain}
				onClick={onPlay}
				onKeyDown={(event) => {
					if (!event.altKey || isDragOverlay) return;
					if (event.key === "ArrowUp") {
						event.preventDefault();
						onMoveBy(-1);
					} else if (event.key === "ArrowDown") {
						event.preventDefault();
						onMoveBy(1);
					}
				}}
				aria-current={isCurrent ? "true" : undefined}
				aria-keyshortcuts={
					isDragOverlay ? undefined : "Alt+ArrowUp Alt+ArrowDown"
				}
				tabIndex={isDragOverlay ? -1 : undefined}
				aria-label={t(
					isCurrent
						? "playbar.playlist.replaySong"
						: "playbar.playlist.playSong",
					isCurrent ? "重新播放 {name} - {artists}" : "播放 {name} - {artists}",
					{ name, artists },
				)}
			>
				<Avatar size="4" fallback={<div />} src={cover} />
				<span className={styles.musicInfo}>
					<span className={styles.titleLine}>
						<span className={styles.name}>{name}</span>
						{isCurrent && (
							<span className={styles.currentLabel}>
								{t("playbar.playlist.current", "正在播放")}
							</span>
						)}
					</span>
					<span className={styles.artists}>{artists}</span>
				</span>
			</button>
			{!isDragOverlay && (
				<div className={styles.itemActions} data-queue-action>
					<button
						type="button"
						className={classNames(styles.itemAction, styles.removeAction)}
						data-queue-action
						onPointerDown={(event) => event.stopPropagation()}
						onClick={(event) => {
							event.stopPropagation();
							onRemove();
						}}
						aria-label={t(
							"playbar.playlist.removeSong",
							"从播放队列移除 {name}",
							{ name },
						)}
						title={t("playbar.playlist.removeShort", "移除")}
					>
						<TrashIcon />
					</button>
				</div>
			)}
		</div>
	);
};

type NowPlaylistCardProps = FlexProps & {
	onRequestClose?: () => void;
};

export const NowPlaylistCard: FC<NowPlaylistCardProps> = ({
	className,
	onRequestClose,
	...props
}) => {
	const { t } = useTranslation();
	const playlist = useAtomValue(queuePlaylistAtom);
	const playlistIndex = useAtomValue(queueCurrentIndexAtom);
	const queueManager = useAtomValue(queueManagerAtom);
	const playlistContainerRef = useRef<HTMLDivElement>(null);
	const dragCandidateRef = useRef<QueueDragCandidate | null>(null);
	const activeDragRef = useRef<ActiveQueueDrag | null>(null);
	const playlistRef = useRef(playlist);
	const suppressedClickSongIdRef = useRef<string | null>(null);
	const dropAnimationRef = useRef<{ stop: () => void } | null>(null);
	const dropGenerationRef = useRef(0);
	const overlayY = useMotionValue(0);
	const prefersReducedMotion = useReducedMotion();
	const [activeDrag, setActiveDrag] = useState<ActiveQueueDrag | null>(null);
	const [rowMotionGeneration, setRowMotionGeneration] = useState(0);
	const upcomingCount =
		playlistIndex >= 0 ? Math.max(0, playlist.length - playlistIndex - 1) : 0;

	const releasePointerCapture = useCallback(
		(pointerId: number, captureTarget?: Element) => {
			const viewport = playlistContainerRef.current;
			for (const target of new Set([captureTarget, viewport])) {
				try {
					if (target?.hasPointerCapture(pointerId)) {
						target.releasePointerCapture(pointerId);
					}
				} catch {
					// 捕获可能已经被系统撤销，清理拖动状态仍应继续。
				}
			}
		},
		[],
	);

	const cancelQueueDrag = useCallback(
		(pointerId?: number) => {
			dropGenerationRef.current += 1;
			dropAnimationRef.current?.stop();
			dropAnimationRef.current = null;
			const candidate = dragCandidateRef.current;
			const capturedPointerId = pointerId ?? candidate?.pointerId;
			dragCandidateRef.current = null;
			activeDragRef.current = null;
			setActiveDrag(null);
			if (suppressedClickSongIdRef.current) {
				const suppressedSongId = suppressedClickSongIdRef.current;
				window.setTimeout(() => {
					if (suppressedClickSongIdRef.current === suppressedSongId) {
						suppressedClickSongIdRef.current = null;
					}
				}, 0);
			}
			if (capturedPointerId !== undefined) {
				releasePointerCapture(capturedPointerId, candidate?.captureTarget);
			}
		},
		[releasePointerCapture],
	);

	const updateDragPosition = useCallback(
		(pointerClientY: number) => {
			const viewport = playlistContainerRef.current;
			const drag = activeDragRef.current;
			if (!viewport || !drag || drag.dropping) return;

			drag.pointerClientY = pointerClientY;
			const viewportRect = viewport.getBoundingClientRect();
			const requestedOverlayTop =
				viewport.scrollTop +
				pointerClientY -
				viewportRect.top -
				drag.grabOffset;
			overlayY.set(
				Math.min(
					(drag.itemCount - 1) * NOW_PLAYLIST_ROW_HEIGHT,
					Math.max(0, requestedOverlayTop),
				),
			);
			const targetIndex = getQueueDropIndex(
				viewport.scrollTop,
				pointerClientY,
				viewportRect.top,
				drag.grabOffset,
				NOW_PLAYLIST_ROW_HEIGHT,
				drag.itemCount,
			);
			if (targetIndex !== drag.targetIndex) {
				const nextDrag = { ...drag, targetIndex };
				activeDragRef.current = nextDrag;
				setActiveDrag(nextDrag);
			}
		},
		[overlayY],
	);

	const beginQueueDrag = useCallback(
		(
			event: ReactPointerEvent<HTMLDivElement>,
			songId: string,
			originIndex: number,
		) => {
			if (
				event.button !== 0 ||
				!event.isPrimary ||
				event.pointerType === "touch" ||
				dragCandidateRef.current ||
				activeDragRef.current
			) {
				return;
			}
			const target = event.target;
			if (target instanceof Element && target.closest("[data-queue-action]")) {
				return;
			}
			const viewport = playlistContainerRef.current;
			if (!viewport) return;

			const rowRect = event.currentTarget.getBoundingClientRect();
			const captureTarget =
				target instanceof Element
					? (target.closest("button") ?? event.currentTarget)
					: event.currentTarget;
			dragCandidateRef.current = {
				pointerId: event.pointerId,
				captureTarget,
				songId,
				originIndex,
				startClientY: event.clientY,
				pointerClientY: event.clientY,
				grabOffset: event.clientY - rowRect.top,
				itemCount: playlistRef.current.length,
				itemIds: playlistRef.current.map((song) => song.id),
			};
			try {
				captureTarget.setPointerCapture(event.pointerId);
			} catch {
				dragCandidateRef.current = null;
			}
		},
		[],
	);

	const handleQueuePointerMove = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			const candidate = dragCandidateRef.current;
			if (!candidate || candidate.pointerId !== event.pointerId) return;
			candidate.pointerClientY = event.clientY;

			let drag = activeDragRef.current;
			if (!drag) {
				if (
					Math.abs(event.clientY - candidate.startClientY) <
					QUEUE_DRAG_THRESHOLD_PX
				) {
					return;
				}
				drag = {
					...candidate,
					targetIndex: candidate.originIndex,
					dropping: false,
				};
				const viewport = playlistContainerRef.current;
				if (!viewport) {
					cancelQueueDrag(event.pointerId);
					return;
				}
				try {
					viewport.setPointerCapture(event.pointerId);
				} catch {
					cancelQueueDrag(event.pointerId);
					return;
				}
				activeDragRef.current = drag;
				suppressedClickSongIdRef.current = candidate.songId;
				setActiveDrag(drag);
			}

			event.preventDefault();
			updateDragPosition(event.clientY);
		},
		[cancelQueueDrag, updateDragPosition],
	);

	const finishQueueDrag = useCallback(
		(eventPointerId: number, cancelled: boolean) => {
			const candidate = dragCandidateRef.current;
			if (!candidate || candidate.pointerId !== eventPointerId) return;
			dragCandidateRef.current = null;
			releasePointerCapture(eventPointerId, candidate.captureTarget);

			const drag = activeDragRef.current;
			if (!drag) return;
			const suppressedSongId = drag.songId;
			window.setTimeout(() => {
				if (suppressedClickSongIdRef.current === suppressedSongId) {
					suppressedClickSongIdRef.current = null;
				}
			}, 0);

			if (cancelled) {
				cancelQueueDrag();
				return;
			}

			const droppingDrag = { ...drag, dropping: true };
			activeDragRef.current = droppingDrag;
			setActiveDrag(droppingDrag);
			const dropGeneration = ++dropGenerationRef.current;
			const commitDrop = () => {
				if (
					dropGenerationRef.current !== dropGeneration ||
					activeDragRef.current?.songId !== droppingDrag.songId
				) {
					return;
				}
				dropAnimationRef.current = null;
				const currentPlaylist = playlistRef.current;
				const fromIndex = currentPlaylist.findIndex(
					(song) => song.id === droppingDrag.songId,
				);
				const toIndex = Math.min(
					droppingDrag.targetIndex,
					currentPlaylist.length - 1,
				);
				activeDragRef.current = null;
				const shouldMove =
					fromIndex >= 0 &&
					toIndex >= 0 &&
					fromIndex !== toIndex &&
					queueManager !== null;
				flushSync(() => {
					if (shouldMove) {
						queueManager.moveSong(fromIndex, toIndex);
						setRowMotionGeneration((generation) => generation + 1);
					}
					setActiveDrag(null);
				});
			};

			if (prefersReducedMotion) {
				overlayY.set(droppingDrag.targetIndex * NOW_PLAYLIST_ROW_HEIGHT);
				commitDrop();
				return;
			}
			const controls = animate(
				overlayY,
				droppingDrag.targetIndex * NOW_PLAYLIST_ROW_HEIGHT,
				{
					duration: QUEUE_DROP_DURATION_SECONDS,
					ease: [0.22, 1, 0.36, 1],
				},
			);
			dropAnimationRef.current = controls;
			void controls.then(commitDrop);
		},
		[
			cancelQueueDrag,
			overlayY,
			prefersReducedMotion,
			queueManager,
			releasePointerCapture,
		],
	);

	useEffect(() => {
		playlistRef.current = playlist;
		const pendingDrag = dragCandidateRef.current ?? activeDragRef.current;
		if (
			pendingDrag &&
			(pendingDrag.itemCount !== playlist.length ||
				pendingDrag.itemIds.some(
					(songId, index) => playlist[index]?.id !== songId,
				))
		) {
			cancelQueueDrag(dragCandidateRef.current?.pointerId);
		}
	}, [cancelQueueDrag, playlist]);

	useEffect(() => {
		if (!activeDrag) return;
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			cancelQueueDrag(dragCandidateRef.current?.pointerId);
		};
		window.addEventListener("keydown", handleEscape, true);
		return () => window.removeEventListener("keydown", handleEscape, true);
	}, [activeDrag, cancelQueueDrag]);

	useEffect(() => {
		if (!activeDrag || activeDrag.dropping) return;
		let frameId = 0;
		let previousTime = performance.now();
		const scrollAtEdge = (time: number) => {
			const viewport = playlistContainerRef.current;
			const drag = activeDragRef.current;
			if (!viewport || !drag || drag.dropping) return;

			const viewportRect = viewport.getBoundingClientRect();
			const speed = getQueueAutoScrollSpeed(
				drag.pointerClientY,
				viewportRect.top,
				viewportRect.bottom,
			);
			const elapsed = Math.min(32, Math.max(0, time - previousTime));
			previousTime = time;
			if (speed !== 0) {
				const previousScrollTop = viewport.scrollTop;
				viewport.scrollTop += speed * (elapsed / (1_000 / 60));
				if (viewport.scrollTop !== previousScrollTop) {
					updateDragPosition(drag.pointerClientY);
				}
			}
			frameId = requestAnimationFrame(scrollAtEdge);
		};
		frameId = requestAnimationFrame(scrollAtEdge);
		return () => cancelAnimationFrame(frameId);
	}, [activeDrag, updateDragPosition]);

	useEffect(
		() => () => {
			dropGenerationRef.current += 1;
			dropAnimationRef.current?.stop();
		},
		[],
	);

	const rowVirtualizer = useVirtualizer({
		count: playlist.length,
		getScrollElement: () => playlistContainerRef.current,
		estimateSize: () => NOW_PLAYLIST_ROW_HEIGHT,
		getItemKey: (index) => playlist[index]?.id ?? index,
		overscan: 5,
	});

	useEffect(() => {
		if (
			!activeDragRef.current &&
			playlistIndex >= 0 &&
			playlistIndex < playlist.length
		) {
			rowVirtualizer.scrollToIndex(playlistIndex, { align: "center" });
		}
	}, [playlistIndex, rowVirtualizer, playlist.length]);

	const draggedSong = activeDrag
		? playlist.find((song) => song.id === activeDrag.songId)
		: undefined;
	const currentSongId = playlist[playlistIndex]?.id;

	return (
		<Flex
			{...props}
			direction="column"
			className={classNames(styles.root, className)}
			role="dialog"
			aria-modal="false"
			aria-label={t("playbar.playlist.title", "当前播放列表")}
		>
			<header className={styles.header}>
				<div className={styles.heading}>
					<strong>
						<Trans i18nKey="playbar.playlist.title">当前播放列表</Trans>
					</strong>
					<span className={styles.count}>
						{t("playbar.playlist.count", "{count, plural, other {#}} 首", {
							count: playlist.length,
						})}
					</span>
				</div>
				<div className={styles.headerActions}>
					{upcomingCount > 0 && (
						<button
							type="button"
							className={styles.clearUpcoming}
							onClick={(event) => {
								event.stopPropagation();
								queueManager?.clearUpcoming();
							}}
							aria-label={t(
								"playbar.playlist.clearUpcomingLabel",
								"清空 {count, plural, other {#}} 首待播歌曲",
								{ count: upcomingCount },
							)}
						>
							{t("playbar.playlist.clearUpcoming", "清空待播")}
						</button>
					)}
					{onRequestClose && (
						<button
							type="button"
							className={styles.closeButton}
							onClick={(event) => {
								event.stopPropagation();
								onRequestClose();
							}}
							autoFocus
							aria-label={t("playbar.playlist.close", "关闭当前播放列表")}
							title={t("playbar.playlist.closeShort", "关闭")}
						>
							<Cross2Icon />
						</button>
					)}
				</div>
			</header>

			{playlist.length === 0 ? (
				<div className={styles.emptyState} role="status">
					<div>{t("playbar.playlist.emptyTitle", "播放队列为空")}</div>
					<small>
						{t(
							"playbar.playlist.emptyHint",
							"播放歌曲或将歌曲添加到队列后会显示在这里",
						)}
					</small>
				</div>
			) : (
				<div
					className={classNames(
						styles.queueViewport,
						activeDrag && styles.dragging,
					)}
					ref={playlistContainerRef}
					role="list"
					aria-label={t("playbar.playlist.queueLabel", "播放队列")}
					onPointerMove={handleQueuePointerMove}
					onScroll={() => {
						const drag = activeDragRef.current;
						if (drag && !drag.dropping) {
							updateDragPosition(drag.pointerClientY);
						}
					}}
					onPointerUp={(event) => finishQueueDrag(event.pointerId, false)}
					onPointerCancel={(event) => finishQueueDrag(event.pointerId, true)}
					onLostPointerCapture={(event) =>
						event.target === event.currentTarget &&
						finishQueueDrag(event.pointerId, true)
					}
				>
					<div
						className={styles.virtualCanvas}
						style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
					>
						{rowVirtualizer.getVirtualItems().map((virtualItem) => {
							const song = playlist[virtualItem.index];
							if (!song) return null;
							const isDragSource = activeDrag?.songId === song.id;
							const dragShift = activeDrag
								? getQueueDragShift(
										virtualItem.index,
										activeDrag.originIndex,
										activeDrag.targetIndex,
										NOW_PLAYLIST_ROW_HEIGHT,
									)
								: 0;
							return (
								<div
									key={virtualItem.key}
									data-index={virtualItem.index}
									className={styles.queueRowSlot}
									role="listitem"
									aria-posinset={virtualItem.index + 1}
									aria-setsize={playlist.length}
									onPointerDown={(event) =>
										beginQueueDrag(event, song.id, virtualItem.index)
									}
									onDragStart={(event) => event.preventDefault()}
									style={{
										height: `${NOW_PLAYLIST_ROW_HEIGHT}px`,
										transform: `translateY(${virtualItem.start}px)`,
									}}
								>
									<motion.div
										key={`${song.id}:${rowMotionGeneration}`}
										initial={false}
										className={classNames(
											styles.rowMotion,
											isDragSource && styles.dragSource,
										)}
										data-drag-source={isDragSource ? "true" : "false"}
										animate={{ y: dragShift }}
										transition={
											prefersReducedMotion
												? { duration: 0 }
												: QUEUE_SHIFT_SPRING
										}
									>
										<PlaylistSongItem
											song={song}
											isCurrent={playlistIndex === virtualItem.index}
											onPlay={() => {
												if (suppressedClickSongIdRef.current === song.id) {
													suppressedClickSongIdRef.current = null;
													return;
												}
												queueManager?.playAt(virtualItem.index);
											}}
											onMoveBy={(offset) =>
												queueManager?.moveSong(
													virtualItem.index,
													virtualItem.index + offset,
												)
											}
											onRemove={() => queueManager?.removeSong(song.id)}
										/>
									</motion.div>
								</div>
							);
						})}
						{activeDrag && draggedSong && (
							<motion.div
								className={styles.dragOverlay}
								style={{ y: overlayY }}
								initial={
									prefersReducedMotion ? false : { opacity: 0.72, scale: 0.985 }
								}
								animate={{ opacity: 1, scale: 1.015 }}
								transition={{ duration: 0.12, ease: "easeOut" }}
								aria-hidden="true"
								inert
							>
								<PlaylistSongItem
									song={draggedSong}
									isCurrent={currentSongId === draggedSong.id}
									isDragOverlay
									onPlay={() => {}}
									onMoveBy={() => {}}
									onRemove={() => {}}
								/>
							</motion.div>
						)}
					</div>
				</div>
			)}
		</Flex>
	);
};
