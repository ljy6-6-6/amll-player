import {
	Button,
	Callout,
	Card,
	Flex,
	Heading,
	Select,
	Slider,
	Switch,
	Text,
	TextField,
} from "@radix-ui/themes";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
	type FC,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import {
	db,
	type ImportedSongVideoBackground,
	type SongBackgroundOverride,
	type SongBackgroundRendererMode,
	type SongVideoBackground,
	type SongVideoBackgroundFitMode,
	type SongVideoBaseRendererMode,
} from "../../utils/db-client.ts";
import { useDbQuery } from "../../utils/use-db-query.ts";
import { SongContext } from "./song-ctx.ts";
import styles from "./video-background.module.css";
import {
	formatVideoTime,
	VideoBackgroundRange,
	type VideoBackgroundRangeChangeSource,
} from "./video-background-range.tsx";

const MIN_VALID_RANGE_MS = 100;
const END_FRAME_OFFSET_MS = 16;
const DEFAULT_DUAL_LAYER = true;
const DEFAULT_VIDEO_OPACITY = 0.4;
const DEFAULT_VIDEO_BASE_RENDERER: SongVideoBaseRendererMode = "css-bg";
const DEFAULT_VIDEO_BASE_CSS_BACKGROUND = "#000000";

interface VideoMetadata {
	durationMs: number;
	width: number;
	height: number;
}

interface VideoBackgroundDraft extends VideoMetadata {
	assetId: string;
	filePath: string;
	mimeType: "video/mp4" | "video/webm";
	bytes?: number;
	fitMode: SongVideoBackgroundFitMode;
	inPointMs: number;
	outPointMs: number;
	loopEnabled: boolean;
	syncOnSeek: boolean;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getColorPickerValue(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(normalized)) return normalized;
	if (/^#[0-9a-f]{3}$/.test(normalized)) {
		return `#${normalized
			.slice(1)
			.split("")
			.map((part) => part.repeat(2))
			.join("")}`;
	}
	const rgb = normalized.match(
		/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/,
	);
	if (!rgb) return DEFAULT_VIDEO_BASE_CSS_BACKGROUND;
	return `#${rgb
		.slice(1)
		.map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0"))
		.join("")}`;
}

function probeVideoMetadata(source: string): Promise<VideoMetadata> {
	return new Promise((resolve, reject) => {
		const video = document.createElement("video");
		let settled = false;
		let timeout = 0;
		const cleanup = () => {
			window.clearTimeout(timeout);
			video.onloadeddata = null;
			video.onerror = null;
			video.pause();
			video.removeAttribute("src");
			video.load();
		};
		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(message));
		};
		timeout = window.setTimeout(
			() => fail("Timed out while decoding the selected video"),
			15_000,
		);
		video.preload = "auto";
		video.muted = true;
		video.playsInline = true;
		video.onloadeddata = () => {
			const durationMs = Math.round(video.duration * 1_000);
			if (
				!Number.isFinite(durationMs) ||
				durationMs < MIN_VALID_RANGE_MS ||
				video.videoWidth <= 0 ||
				video.videoHeight <= 0
			) {
				fail("The selected video has invalid metadata");
				return;
			}
			settled = true;
			const metadata = {
				durationMs,
				width: video.videoWidth,
				height: video.videoHeight,
			};
			cleanup();
			resolve(metadata);
		};
		video.onerror = () => fail("The selected video cannot be decoded");
		video.src = source;
		video.load();
	});
}

function recordToDraft(record: SongVideoBackground): VideoBackgroundDraft {
	return {
		assetId: record.assetId,
		filePath: record.filePath,
		mimeType: record.mimeType,
		durationMs: record.durationMs,
		width: record.width,
		height: record.height,
		fitMode: record.fitMode,
		inPointMs: record.inPointMs,
		outPointMs: record.outPointMs,
		loopEnabled: record.loopEnabled,
		syncOnSeek: record.syncOnSeek,
	};
}

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function getDefaultOutPointMs(
	videoDurationMs: number,
	songDurationMs: number,
): number {
	const preferred = Math.min(
		videoDurationMs,
		songDurationMs > 0 ? songDurationMs : videoDurationMs,
	);
	return Math.min(videoDurationMs, Math.max(MIN_VALID_RANGE_MS, preferred));
}

function ignorePreviewPlayAbort(error: unknown): void {
	if (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		error.name === "AbortError"
	) {
		return;
	}
	console.warn("Failed to resume the video background preview", error);
}

function enforcePreviewRange(
	video: HTMLVideoElement,
	draft: VideoBackgroundDraft,
): void {
	const currentMs = video.currentTime * 1_000;
	if (currentMs < draft.inPointMs) {
		video.currentTime = draft.inPointMs / 1_000;
		return;
	}
	if (currentMs < draft.outPointMs) return;
	if (draft.loopEnabled) {
		video.currentTime = draft.inPointMs / 1_000;
		void video.play().catch(ignorePreviewPlayAbort);
		return;
	}
	video.currentTime =
		Math.max(draft.inPointMs, draft.outPointMs - END_FRAME_OFFSET_MS) / 1_000;
	video.pause();
}

const VideoBackgroundEditor: FC = () => {
	const song = useContext(SongContext);
	const { t } = useTranslation();
	const previewRef = useRef<HTMLVideoElement>(null);
	const mountedRef = useRef(false);
	const operationRef = useRef(0);
	const busyRef = useRef(false);
	const candidateAssetsRef = useRef(new Set<string>());
	const activeCandidateRef = useRef<string | null>(null);
	const [activeCandidateId, setActiveCandidateId] = useState<string | null>(
		null,
	);
	const [draft, setDraft] = useState<VideoBackgroundDraft | null>(null);
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const {
		data: saved,
		loading,
		error: loadError,
		refetch,
	} = useDbQuery<SongVideoBackground | null>(
		() => (song ? db.videoBackgrounds.get(song.id) : Promise.resolve(null)),
		[song?.id],
		null,
		["song_video_backgrounds"],
	);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			operationRef.current += 1;
			for (const assetId of candidateAssetsRef.current) {
				void db.videoBackgrounds.discard(assetId).catch((error) => {
					console.warn("Failed to discard a pending video background", error);
				});
			}
			candidateAssetsRef.current.clear();
			activeCandidateRef.current = null;
		};
	}, []);

	useLayoutEffect(() => {
		if (loading || dirty || activeCandidateRef.current) return;
		if (saved && saved.songId !== song?.id) return;
		setDraft(saved ? recordToDraft(saved) : null);
	}, [dirty, loading, saved, song?.id]);

	useEffect(() => {
		const video = previewRef.current;
		if (!video || !draft) return;
		const currentMs = video.currentTime * 1_000;
		if (currentMs < draft.inPointMs || currentMs >= draft.outPointMs) {
			video.currentTime = draft.inPointMs / 1_000;
		}
	}, [draft]);

	useEffect(() => {
		const video = previewRef.current;
		if (!video || !draft) return;
		let disposed = false;
		let frameCallback = 0;
		let animationFrame = 0;
		const cancelFrame = () => {
			if (
				frameCallback &&
				typeof video.cancelVideoFrameCallback === "function"
			) {
				video.cancelVideoFrameCallback(frameCallback);
				frameCallback = 0;
			}
			if (animationFrame) {
				cancelAnimationFrame(animationFrame);
				animationFrame = 0;
			}
		};
		const schedule = () => {
			if (disposed || video.paused) return;
			if (typeof video.requestVideoFrameCallback === "function") {
				frameCallback = video.requestVideoFrameCallback(tick);
			} else {
				animationFrame = requestAnimationFrame(tick);
			}
		};
		const tick = () => {
			frameCallback = 0;
			animationFrame = 0;
			if (disposed) return;
			enforcePreviewRange(video, draft);
			schedule();
		};
		const handlePlay = () => {
			cancelFrame();
			enforcePreviewRange(video, draft);
			schedule();
		};
		video.addEventListener("play", handlePlay);
		if (!video.paused) schedule();
		return () => {
			disposed = true;
			video.removeEventListener("play", handlePlay);
			cancelFrame();
		};
	}, [draft]);

	const discardCandidate = useCallback(async (assetId: string) => {
		try {
			await db.videoBackgrounds.discard(assetId);
			candidateAssetsRef.current.delete(assetId);
			return true;
		} catch (error) {
			console.warn("Failed to discard a pending video background", error);
			return false;
		}
	}, []);

	const updateDraft = useCallback(
		(update: (current: VideoBackgroundDraft) => VideoBackgroundDraft) => {
			setDraft((current) => (current ? update(current) : current));
			setDirty(true);
		},
		[],
	);

	const chooseVideo = useCallback(async () => {
		if (!song || busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		const operation = ++operationRef.current;
		let imported: ImportedSongVideoBackground | null = null;
		try {
			imported = await db.videoBackgrounds.pickAndImport(
				t("page.song.videoBackground.choose", "选择视频"),
			);
			if (!imported) return;
			if (!mountedRef.current || operationRef.current !== operation) {
				await discardCandidate(imported.assetId);
				return;
			}

			candidateAssetsRef.current.add(imported.assetId);
			if (!mountedRef.current || operationRef.current !== operation) {
				await discardCandidate(imported.assetId);
				return;
			}
			const metadata = await probeVideoMetadata(
				convertFileSrc(imported.filePath),
			);
			if (!mountedRef.current || operationRef.current !== operation) {
				await discardCandidate(imported.assetId);
				return;
			}

			const songDurationMs = Math.max(0, Math.round(song.duration * 1_000));
			const outPointMs = getDefaultOutPointMs(
				metadata.durationMs,
				songDurationMs,
			);
			const previousCandidate = activeCandidateRef.current;
			activeCandidateRef.current = imported.assetId;
			setActiveCandidateId(imported.assetId);
			setDraft({
				...imported,
				...metadata,
				fitMode: "cover",
				inPointMs: 0,
				outPointMs,
				loopEnabled: songDurationMs > outPointMs,
				syncOnSeek: true,
			});
			setDirty(true);
			if (previousCandidate && previousCandidate !== imported.assetId) {
				void discardCandidate(previousCandidate);
			}
		} catch (error) {
			if (imported) await discardCandidate(imported.assetId);
			if (mountedRef.current && operationRef.current === operation) {
				toast.error(
					t("page.song.videoBackground.error.import", {
						defaultValue: "无法导入视频背景：{message}",
						message: getErrorMessage(error),
					}),
				);
			}
		} finally {
			if (operationRef.current === operation) {
				busyRef.current = false;
				if (mountedRef.current) setBusy(false);
			}
		}
	}, [discardCandidate, song, t]);

	const persistVideoBackground = useCallback(
		async (snapshot: VideoBackgroundDraft, announce: boolean) => {
			if (!song || busyRef.current || loadError) return;
			busyRef.current = true;
			setBusy(true);
			const operation = ++operationRef.current;
			const candidateWasApplying = candidateAssetsRef.current.delete(
				snapshot.assetId,
			);
			try {
				const result = await db.videoBackgrounds.save({
					songId: song.id,
					assetId: snapshot.assetId,
					durationMs: snapshot.durationMs,
					width: snapshot.width,
					height: snapshot.height,
					fitMode: snapshot.fitMode,
					inPointMs: snapshot.inPointMs,
					outPointMs: snapshot.outPointMs,
					loopEnabled: snapshot.loopEnabled,
					syncOnSeek: snapshot.syncOnSeek,
				});
				if (activeCandidateRef.current === snapshot.assetId) {
					activeCandidateRef.current = null;
				}
				if (!mountedRef.current || operationRef.current !== operation) return;
				setActiveCandidateId(null);
				setDraft(recordToDraft(result));
				setDirty(false);
				refetch();
				if (announce) {
					toast.success(t("page.song.videoBackground.saved", "视频背景已保存"));
				}
			} catch (error) {
				if (candidateWasApplying) {
					if (mountedRef.current && operationRef.current === operation) {
						candidateAssetsRef.current.add(snapshot.assetId);
					} else {
						void db.videoBackgrounds
							.discard(snapshot.assetId)
							.catch((discardError) => {
								console.warn(
									"Failed to discard a video candidate after save failure",
									discardError,
								);
							});
					}
				}
				if (mountedRef.current && operationRef.current === operation) {
					toast.error(
						t("page.song.videoBackground.error.save", {
							defaultValue: "无法保存视频背景：{message}",
							message: getErrorMessage(error),
						}),
					);
				}
			} finally {
				if (operationRef.current === operation) {
					busyRef.current = false;
					if (mountedRef.current) setBusy(false);
				}
			}
		},
		[loadError, refetch, song, t],
	);

	const saveVideoBackground = useCallback(() => {
		if (!draft) return;
		void persistVideoBackground(draft, true);
	}, [draft, persistVideoBackground]);

	const updateBehaviorSetting = useCallback(
		(
			update: Partial<
				Pick<VideoBackgroundDraft, "fitMode" | "loopEnabled" | "syncOnSeek">
			>,
		) => {
			if (!draft) return;
			const nextDraft = { ...draft, ...update };
			setDraft(nextDraft);
			setDirty(true);
			if (!activeCandidateRef.current) {
				void persistVideoBackground(nextDraft, false);
			}
		},
		[draft, persistVideoBackground],
	);

	const removeVideoBackground = useCallback(async () => {
		if (!song || busyRef.current || loadError) return;
		busyRef.current = true;
		setBusy(true);
		const operation = ++operationRef.current;
		try {
			const candidate = activeCandidateRef.current;
			if (candidate) {
				if (!(await discardCandidate(candidate))) {
					throw new Error("Failed to discard the selected video");
				}
				activeCandidateRef.current = null;
				if (!mountedRef.current || operationRef.current !== operation) return;
				setActiveCandidateId(null);
				setDraft(saved ? recordToDraft(saved) : null);
				setDirty(false);
			} else {
				await db.videoBackgrounds.delete(song.id);
				if (!mountedRef.current || operationRef.current !== operation) return;
				setDraft(null);
				setDirty(false);
				refetch();
			}
			toast.success(
				candidate
					? t("page.song.videoBackground.discarded", "已放弃候选视频")
					: t("page.song.videoBackground.removed", "视频背景已移除"),
			);
		} catch (error) {
			if (mountedRef.current && operationRef.current === operation) {
				toast.error(
					t("page.song.videoBackground.error.remove", {
						defaultValue: "无法移除视频背景：{message}",
						message: getErrorMessage(error),
					}),
				);
			}
		} finally {
			if (operationRef.current === operation) {
				busyRef.current = false;
				if (mountedRef.current) setBusy(false);
			}
		}
	}, [discardCandidate, loadError, refetch, saved, song, t]);

	const resetRange = useCallback(() => {
		if (!draft || !song || busy) return;
		const songDurationMs = Math.max(0, Math.round(song.duration * 1_000));
		const outPointMs = getDefaultOutPointMs(draft.durationMs, songDurationMs);
		updateDraft((current) => ({
			...current,
			inPointMs: 0,
			outPointMs,
		}));
	}, [busy, draft, song, updateDraft]);

	const seekPreviewForRangeChange = useCallback(
		(
			inPointMs: number,
			outPointMs: number,
			source: VideoBackgroundRangeChangeSource,
		) => {
			const video = previewRef.current;
			if (!video) return;
			const targetMs =
				source === "out"
					? Math.max(inPointMs, outPointMs - END_FRAME_OFFSET_MS)
					: inPointMs;
			video.currentTime = targetMs / 1_000;
		},
		[],
	);

	const previewSource = draft ? convertFileSrc(draft.filePath) : null;
	const controlsDisabled = busy || loading || Boolean(loadError);

	return (
		<Card aria-busy={busy || loading}>
			<Flex direction="column" gap="4">
				<div>
					<Heading size="4">
						{t("page.song.videoBackground.title", "歌词视频背景")}
					</Heading>
					<Text size="2" color="gray">
						{t(
							"page.song.videoBackground.description",
							"仅覆盖这首歌曲的全屏歌词背景，不会修改歌曲封面。",
						)}
					</Text>
				</div>

				{loadError && (
					<Callout.Root color="red" size="1">
						<Callout.Text>
							{t(
								"page.song.videoBackground.error.load",
								"无法读取这首歌曲的视频背景设置。",
							)}
						</Callout.Text>
						<Button size="1" variant="soft" onClick={refetch}>
							{t("page.song.videoBackground.retry", "重试")}
						</Button>
					</Callout.Root>
				)}

				<div className={styles.preview}>
					{draft && previewSource ? (
						<video
							ref={previewRef}
							src={previewSource}
							controls
							muted
							playsInline
							preload="auto"
							aria-label={t(
								"page.song.videoBackground.preview",
								"视频背景预览",
							)}
							style={{ objectFit: draft.fitMode }}
							onTimeUpdate={(event) =>
								enforcePreviewRange(event.currentTarget, draft)
							}
							onEnded={(event) =>
								enforcePreviewRange(event.currentTarget, draft)
							}
						/>
					) : (
						<div className={styles.emptyPreview}>
							{t("page.song.videoBackground.empty", "尚未设置视频背景")}
						</div>
					)}
				</div>

				<Flex gap="2" wrap="wrap">
					<Button
						variant="soft"
						disabled={!song || controlsDisabled}
						onClick={chooseVideo}
					>
						{draft
							? t("page.song.videoBackground.change", "更换视频")
							: t("page.song.videoBackground.choose", "选择视频")}
					</Button>
					{draft && (
						<Button
							variant="soft"
							color="red"
							disabled={controlsDisabled}
							onClick={removeVideoBackground}
						>
							{activeCandidateId
								? t("page.song.videoBackground.discard", "放弃候选视频")
								: t("page.song.videoBackground.remove", "移除背景")}
						</Button>
					)}
				</Flex>

				{draft && (
					<>
						<Text size="2" color="gray" className={styles.detailText}>
							{draft.width} × {draft.height} ·{" "}
							{formatVideoTime(draft.durationMs)}
							{draft.bytes !== undefined
								? ` · ${formatBytes(draft.bytes)}`
								: ""}
						</Text>
						<label>
							<Flex direction="column" gap="2">
								<Text>
									{t("page.song.videoBackground.fit.label", "适应方式")}
								</Text>
								<Text size="2" color="gray">
									{t(
										"page.song.videoBackground.fit.description",
										"填充会裁切，适应会完整显示并留出空白，拉伸会铺满；视频与预览比例相同时三者看起来相同。",
									)}
								</Text>
								<Select.Root
									value={draft.fitMode}
									disabled={controlsDisabled}
									onValueChange={(value) =>
										updateBehaviorSetting({
											fitMode: value as SongVideoBackgroundFitMode,
										})
									}
								>
									<Select.Trigger />
									<Select.Content>
										<Select.Item value="cover">
											{t("page.song.videoBackground.fit.cover", "填充（裁切）")}
										</Select.Item>
										<Select.Item value="contain">
											{t(
												"page.song.videoBackground.fit.contain",
												"适应（完整）",
											)}
										</Select.Item>
										<Select.Item value="fill">
											{t("page.song.videoBackground.fit.fill", "拉伸")}
										</Select.Item>
									</Select.Content>
								</Select.Root>
							</Flex>
						</label>

						<div>
							<Flex justify="between" align="center" mb="2" gap="2">
								<Text>
									{t("page.song.videoBackground.range.label", "播放范围")}
								</Text>
								<Button
									size="1"
									variant="ghost"
									disabled={controlsDisabled}
									onClick={resetRange}
								>
									{t("page.song.videoBackground.range.reset", "重置为歌曲长度")}
								</Button>
							</Flex>
							<VideoBackgroundRange
								durationMs={draft.durationMs}
								inPointMs={draft.inPointMs}
								outPointMs={draft.outPointMs}
								disabled={controlsDisabled}
								onChange={(inPointMs, outPointMs, source) => {
									updateDraft((current) => ({
										...current,
										inPointMs,
										outPointMs,
									}));
									seekPreviewForRangeChange(inPointMs, outPointMs, source);
								}}
								inPointLabel={t("page.song.videoBackground.range.in", "入点")}
								outPointLabel={t("page.song.videoBackground.range.out", "出点")}
								moveRangeLabel={t(
									"page.song.videoBackground.range.move",
									"移动所选视频片段",
								)}
							/>
						</div>

						<label>
							<Flex align="center" justify="between" gap="4">
								<div>
									<Text as="div">
										{t("page.song.videoBackground.loop.label", "循环播放")}
									</Text>
									<Text as="div" size="2" color="gray">
										{t(
											"page.song.videoBackground.loop.description",
											"到达出点后返回入点；关闭时停留在最后一帧。",
										)}
									</Text>
								</div>
								<Switch
									checked={draft.loopEnabled}
									disabled={controlsDisabled}
									onCheckedChange={(loopEnabled) =>
										updateBehaviorSetting({ loopEnabled })
									}
								/>
							</Flex>
						</label>

						<label>
							<Flex align="center" justify="between" gap="4">
								<div>
									<Text as="div">
										{t(
											"page.song.videoBackground.syncOnSeek.label",
											"调整音乐进度时同步视频",
										)}
									</Text>
									<Text as="div" size="2" color="gray">
										{t(
											"page.song.videoBackground.syncOnSeek.description",
											"关闭后，拖动音乐进度不会改变视频当时的位置。",
										)}
									</Text>
								</div>
								<Switch
									checked={draft.syncOnSeek}
									disabled={controlsDisabled}
									onCheckedChange={(syncOnSeek) =>
										updateBehaviorSetting({ syncOnSeek })
									}
								/>
							</Flex>
						</label>

						{activeCandidateId && (
							<Callout.Root color="amber" size="1">
								<Callout.Text>
									{t(
										"page.song.videoBackground.pending",
										"这是尚未应用的候选视频，离开页面时会自动清理。",
									)}
								</Callout.Text>
							</Callout.Root>
						)}

						<Button
							disabled={controlsDisabled || Boolean(loadError)}
							onClick={saveVideoBackground}
						>
							{t("page.song.videoBackground.apply", "应用视频背景")}
						</Button>
					</>
				)}
			</Flex>
		</Card>
	);
};

function getCurrentGlobalRendererMode(): SongVideoBaseRendererMode {
	const stored = localStorage.getItem(
		"amll-react-full.lyricBackgroundRenderer",
	);
	return stored === "pixi" || stored === "css-bg" ? stored : "mesh";
}

export const SongVideoBackgroundEditor: FC = () => {
	const song = useContext(SongContext);
	const { t } = useTranslation();
	const mutatingRef = useRef(false);
	const [mutating, setMutating] = useState(false);
	const [opacityPercent, setOpacityPercent] = useState(
		DEFAULT_VIDEO_OPACITY * 100,
	);
	const [videoBaseCssBackground, setVideoBaseCssBackground] = useState(
		DEFAULT_VIDEO_BASE_CSS_BACKGROUND,
	);
	const {
		data: backgroundOverride,
		loading,
		error,
		refetch,
	} = useDbQuery<SongBackgroundOverride | null>(
		() =>
			song ? db.songBackgroundOverrides.get(song.id) : Promise.resolve(null),
		[song?.id],
		null,
		["song_background_overrides"],
	);

	useEffect(() => {
		setOpacityPercent(
			Math.round(
				Math.min(
					1,
					Math.max(
						0,
						backgroundOverride?.videoOpacity ?? DEFAULT_VIDEO_OPACITY,
					),
				) * 100,
			),
		);
	}, [backgroundOverride?.videoOpacity]);

	useEffect(() => {
		setVideoBaseCssBackground(
			backgroundOverride?.videoBaseCssBackground ??
				DEFAULT_VIDEO_BASE_CSS_BACKGROUND,
		);
	}, [backgroundOverride?.videoBaseCssBackground]);

	const reportMutationError = useCallback(
		(error: unknown) => {
			toast.error(
				t("page.song.backgroundOverride.error", {
					defaultValue: "无法保存这首歌曲的背景覆盖设置：{message}",
					message: getErrorMessage(error),
				}),
			);
		},
		[t],
	);

	const saveOverride = useCallback(
		async (
			rendererMode: SongBackgroundRendererMode,
			dualLayer: boolean,
			videoOpacity: number,
			videoBaseRendererMode: SongVideoBaseRendererMode,
			videoBaseCssBackground: string,
		) => {
			if (!song || mutatingRef.current) return;
			mutatingRef.current = true;
			setMutating(true);
			try {
				await db.songBackgroundOverrides.save({
					songId: song.id,
					rendererMode,
					dualLayer,
					videoOpacity: Math.min(1, Math.max(0, videoOpacity)),
					videoBaseRendererMode,
					videoBaseCssBackground:
						videoBaseCssBackground.trim() || DEFAULT_VIDEO_BASE_CSS_BACKGROUND,
				});
				refetch();
			} catch (error) {
				setOpacityPercent(
					Math.round(
						Math.min(
							1,
							Math.max(
								0,
								backgroundOverride?.videoOpacity ?? DEFAULT_VIDEO_OPACITY,
							),
						) * 100,
					),
				);
				reportMutationError(error);
			} finally {
				mutatingRef.current = false;
				setMutating(false);
			}
		},
		[backgroundOverride?.videoOpacity, refetch, reportMutationError, song],
	);

	const handleOverrideEnabledChange = useCallback(
		async (enabled: boolean) => {
			if (!song || mutatingRef.current) return;
			if (enabled) {
				await saveOverride(
					backgroundOverride?.rendererMode ?? getCurrentGlobalRendererMode(),
					backgroundOverride?.dualLayer ?? DEFAULT_DUAL_LAYER,
					backgroundOverride?.videoOpacity ?? DEFAULT_VIDEO_OPACITY,
					backgroundOverride?.videoBaseRendererMode ??
						DEFAULT_VIDEO_BASE_RENDERER,
					backgroundOverride?.videoBaseCssBackground ??
						DEFAULT_VIDEO_BASE_CSS_BACKGROUND,
				);
				return;
			}
			mutatingRef.current = true;
			setMutating(true);
			try {
				await db.songBackgroundOverrides.delete(song.id);
				refetch();
			} catch (error) {
				reportMutationError(error);
			} finally {
				mutatingRef.current = false;
				setMutating(false);
			}
		},
		[backgroundOverride, refetch, reportMutationError, saveOverride, song],
	);

	const controlsDisabled = !song || loading || mutating || Boolean(error);
	const overrideEnabled = backgroundOverride?.overrideEnabled === true;
	const rendererMode =
		backgroundOverride?.rendererMode ?? getCurrentGlobalRendererMode();
	const videoBaseRendererMode =
		backgroundOverride?.videoBaseRendererMode ?? DEFAULT_VIDEO_BASE_RENDERER;
	const persistedVideoBaseCssBackground =
		backgroundOverride?.videoBaseCssBackground ??
		DEFAULT_VIDEO_BASE_CSS_BACKGROUND;

	return (
		<Flex direction="column" gap="4">
			<Card aria-busy={loading || mutating}>
				<Flex direction="column" gap="4">
					<label>
						<Flex align="center" justify="between" gap="4">
							<div>
								<Text as="div" weight="medium">
									{t(
										"page.song.backgroundOverride.enabled.label",
										"覆盖全局设置",
									)}
								</Text>
								<Text as="div" size="2" color="gray">
									{t(
										"page.song.backgroundOverride.enabled.description",
										"仅为这首歌曲选择不同的歌词背景；关闭时继续使用全局设置。",
									)}
								</Text>
							</div>
							<Switch
								checked={overrideEnabled}
								disabled={controlsDisabled}
								onCheckedChange={handleOverrideEnabledChange}
							/>
						</Flex>
					</label>

					{error && (
						<Callout.Root color="red" size="1">
							<Callout.Text>
								{t(
									"page.song.backgroundOverride.loadError",
									"无法读取这首歌曲的背景覆盖设置。",
								)}
							</Callout.Text>
							<Button size="1" variant="soft" onClick={refetch}>
								{t("page.song.videoBackground.retry", "重试")}
							</Button>
						</Callout.Root>
					)}

					{overrideEnabled && backgroundOverride && (
						<label>
							<Flex direction="column" gap="2">
								<Text>
									{t(
										"page.song.backgroundOverride.renderer.label",
										"背景渲染器",
									)}
								</Text>
								<Select.Root
									value={rendererMode}
									disabled={controlsDisabled}
									onValueChange={(value) =>
										void saveOverride(
											value as SongBackgroundRendererMode,
											backgroundOverride.dualLayer,
											backgroundOverride.videoOpacity,
											videoBaseRendererMode,
											persistedVideoBaseCssBackground,
										)
									}
								>
									<Select.Trigger />
									<Select.Content>
										<Select.Item value="mesh">
											{t(
												"page.song.backgroundOverride.renderer.mesh",
												"网格渐变渲染器",
											)}
										</Select.Item>
										<Select.Item value="pixi">
											{t(
												"page.song.backgroundOverride.renderer.pixi",
												"PixiJS 渲染器",
											)}
										</Select.Item>
										<Select.Item value="css-bg">
											{t(
												"page.song.backgroundOverride.renderer.css",
												"CSS 背景",
											)}
										</Select.Item>
										<Select.Item value="video">
											{t(
												"page.song.backgroundOverride.renderer.video",
												"歌曲视频背景",
											)}
										</Select.Item>
									</Select.Content>
								</Select.Root>
							</Flex>
						</label>
					)}
				</Flex>
			</Card>

			{overrideEnabled && backgroundOverride?.rendererMode === "video" && (
				<>
					<VideoBackgroundEditor />
					<Card>
						<Flex direction="column" gap="4">
							<label>
								<Flex align="center" justify="between" gap="4">
									<div>
										<Text as="div" weight="medium">
											{t(
												"page.song.backgroundOverride.dualLayer.label",
												"叠加双重背景",
											)}
										</Text>
										<Text as="div" size="2" color="gray">
											{t(
												"page.song.backgroundOverride.dualLayer.description",
												"在视频下方保留独立的基础背景，并用透明度控制视频显现程度。",
											)}
										</Text>
									</div>
									<Switch
										checked={backgroundOverride.dualLayer}
										disabled={controlsDisabled}
										onCheckedChange={(dualLayer) =>
											void saveOverride(
												"video",
												dualLayer,
												backgroundOverride.videoOpacity,
												videoBaseRendererMode,
												persistedVideoBaseCssBackground,
											)
										}
									/>
								</Flex>
							</label>

							{backgroundOverride.dualLayer && (
								<Flex direction="column" gap="4">
									<label>
										<Flex direction="column" gap="2">
											<Text>
												{t(
													"page.song.backgroundOverride.baseRenderer.label",
													"双重背景渲染器",
												)}
											</Text>
											<Text size="2" color="gray">
												{t(
													"page.song.backgroundOverride.baseRenderer.description",
													"选择视频下方的基础背景；该设置只影响这首歌曲。",
												)}
											</Text>
											<Select.Root
												value={videoBaseRendererMode}
												disabled={controlsDisabled}
												onValueChange={(value) =>
													void saveOverride(
														"video",
														true,
														backgroundOverride.videoOpacity,
														value as SongVideoBaseRendererMode,
														persistedVideoBaseCssBackground,
													)
												}
											>
												<Select.Trigger />
												<Select.Content>
													<Select.Item value="mesh">
														{t(
															"page.song.backgroundOverride.renderer.mesh",
															"网格渐变渲染器",
														)}
													</Select.Item>
													<Select.Item value="pixi">
														{t(
															"page.song.backgroundOverride.renderer.pixi",
															"PixiJS 渲染器",
														)}
													</Select.Item>
													<Select.Item value="css-bg">
														{t(
															"page.song.backgroundOverride.renderer.css",
															"CSS 背景",
														)}
													</Select.Item>
												</Select.Content>
											</Select.Root>
										</Flex>
									</label>

									{videoBaseRendererMode === "css-bg" && (
										<div>
											<Text as="div">
												{t(
													"page.song.backgroundOverride.baseCssBackground.label",
													"双重背景 CSS 属性值",
												)}
											</Text>
											<Text as="div" size="2" color="gray" mb="2">
												{t(
													"page.song.backgroundOverride.baseCssBackground.description",
													"等同于 background 样式的字符串值，默认为黑色 #000000。",
												)}
											</Text>
											<Flex gap="2" align="center" wrap="wrap">
												<input
													type="color"
													value={getColorPickerValue(videoBaseCssBackground)}
													disabled={controlsDisabled}
													aria-label={t(
														"page.song.backgroundOverride.baseCssBackground.picker",
														"选择双重背景纯色",
													)}
													onInput={(event) =>
														setVideoBaseCssBackground(event.currentTarget.value)
													}
													onChange={(event) =>
														void saveOverride(
															"video",
															true,
															backgroundOverride.videoOpacity,
															"css-bg",
															event.currentTarget.value,
														)
													}
													style={{
														width: 42,
														height: 34,
														padding: 0,
														border: 0,
													}}
												/>
												<TextField.Root
													value={videoBaseCssBackground}
													disabled={controlsDisabled}
													onChange={(event) =>
														setVideoBaseCssBackground(event.currentTarget.value)
													}
													onBlur={(event) =>
														void saveOverride(
															"video",
															true,
															backgroundOverride.videoOpacity,
															"css-bg",
															event.currentTarget.value,
														)
													}
												/>
											</Flex>
										</div>
									)}

									<div>
										<Flex justify="between" align="center" mb="2">
											<Text>
												{t(
													"page.song.backgroundOverride.opacity.label",
													"视频不透明度",
												)}
											</Text>
											<Text size="2" color="gray">
												{opacityPercent}%
											</Text>
										</Flex>
										<Slider
											min={0}
											max={100}
											step={1}
											value={[opacityPercent]}
											disabled={controlsDisabled}
											onValueChange={([value]) =>
												setOpacityPercent(value ?? DEFAULT_VIDEO_OPACITY * 100)
											}
											onValueCommit={([value]) =>
												void saveOverride(
													"video",
													true,
													(value ?? DEFAULT_VIDEO_OPACITY * 100) / 100,
													videoBaseRendererMode,
													persistedVideoBaseCssBackground,
												)
											}
										/>
									</div>
								</Flex>
							)}
						</Flex>
					</Card>
				</>
			)}
		</Flex>
	);
};
