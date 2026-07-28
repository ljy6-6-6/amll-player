import {
	ChevronDownIcon,
	ChevronUpIcon,
	Cross2Icon,
	SpeakerLoudIcon,
	TrashIcon,
} from "@radix-ui/react-icons";
import { Avatar, Flex, type FlexProps } from "@radix-ui/themes";
import { useVirtualizer } from "@tanstack/react-virtual";
import { convertFileSrc } from "@tauri-apps/api/core";
import classNames from "classnames";
import { useAtomValue } from "jotai";
import { type FC, useEffect, useRef } from "react";
import { Trans, useTranslation } from "react-i18next";
import { queueManagerAtom } from "../../states/appAtoms.ts";
import type { Song } from "../../utils/db-client.ts";
import {
	queueCurrentIndexAtom,
	queuePlaylistAtom,
} from "../../utils/play-queue-manager.ts";
import styles from "./index.module.css";

export const NOW_PLAYLIST_ROW_HEIGHT = 72;

interface PlaylistSongItemProps {
	song: Song;
	index: number;
	isCurrent: boolean;
	queueLength: number;
}

const PlaylistSongItem: FC<PlaylistSongItemProps> = ({
	song,
	index,
	isCurrent,
	queueLength,
}) => {
	const queueManager = useAtomValue(queueManagerAtom);
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
			)}
			data-current={isCurrent ? "true" : "false"}
		>
			<button
				type="button"
				className={styles.songMain}
				onClick={() => queueManager?.playAt(index)}
				aria-current={isCurrent ? "true" : undefined}
				aria-label={t(
					isCurrent
						? "playbar.playlist.replaySong"
						: "playbar.playlist.playSong",
					isCurrent ? "重新播放 {name} - {artists}" : "播放 {name} - {artists}",
					{ name, artists },
				)}
			>
				<span
					className={classNames(
						styles.currentIndicator,
						isCurrent && styles.currentIndicatorVisible,
					)}
					aria-hidden="true"
				>
					<SpeakerLoudIcon />
				</span>
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
			<div className={styles.itemActions}>
				<button
					type="button"
					className={styles.itemAction}
					disabled={index === 0}
					onClick={(event) => {
						event.stopPropagation();
						queueManager?.moveSong(index, index - 1);
					}}
					aria-label={t("playbar.playlist.moveUp", "上移 {name}", { name })}
					title={t("playbar.playlist.moveUpShort", "上移")}
				>
					<ChevronUpIcon />
				</button>
				<button
					type="button"
					className={styles.itemAction}
					disabled={index === queueLength - 1}
					onClick={(event) => {
						event.stopPropagation();
						queueManager?.moveSong(index, index + 1);
					}}
					aria-label={t("playbar.playlist.moveDown", "下移 {name}", {
						name,
					})}
					title={t("playbar.playlist.moveDownShort", "下移")}
				>
					<ChevronDownIcon />
				</button>
				<button
					type="button"
					className={classNames(styles.itemAction, styles.removeAction)}
					onClick={(event) => {
						event.stopPropagation();
						queueManager?.removeSong(song.id);
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
	const upcomingCount =
		playlistIndex >= 0 ? Math.max(0, playlist.length - playlistIndex - 1) : 0;

	const rowVirtualizer = useVirtualizer({
		count: playlist.length,
		getScrollElement: () => playlistContainerRef.current,
		estimateSize: () => NOW_PLAYLIST_ROW_HEIGHT,
		getItemKey: (index) => playlist[index]?.id ?? index,
		overscan: 5,
	});

	useEffect(() => {
		if (playlistIndex >= 0 && playlistIndex < playlist.length) {
			rowVirtualizer.scrollToIndex(playlistIndex, { align: "center" });
		}
	}, [playlistIndex, rowVirtualizer, playlist.length]);

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
					className={styles.queueViewport}
					ref={playlistContainerRef}
					role="list"
					aria-label={t("playbar.playlist.queueLabel", "播放队列")}
				>
					<div
						className={styles.virtualCanvas}
						style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
					>
						{rowVirtualizer.getVirtualItems().map((virtualItem) => {
							const song = playlist[virtualItem.index];
							if (!song) return null;
							return (
								<div
									key={virtualItem.key}
									data-index={virtualItem.index}
									className={styles.queueRowSlot}
									role="listitem"
									aria-posinset={virtualItem.index + 1}
									aria-setsize={playlist.length}
									style={{
										height: `${NOW_PLAYLIST_ROW_HEIGHT}px`,
										transform: `translateY(${virtualItem.start}px)`,
									}}
								>
									<PlaylistSongItem
										song={song}
										index={virtualItem.index}
										isCurrent={playlistIndex === virtualItem.index}
										queueLength={playlist.length}
									/>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</Flex>
	);
};
