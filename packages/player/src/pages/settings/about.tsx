import { branch, commit } from "virtual:git-metadata-plugin";
import {
	ArrowDownIcon,
	ArrowRightIcon,
	ChevronDownIcon,
	UpdateIcon,
} from "@radix-ui/react-icons";
import { Badge, Button, Heading, Spinner, Text } from "@radix-ui/themes";
import { getVersion } from "@tauri-apps/api/app";
import { atom, useAtomValue } from "jotai";
import { loadable } from "jotai/utils";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import appIcon from "../../../src-tauri/icons/128x128.png";
import { isCheckingUpdateAtom, updateInfoAtom } from "../../states/appAtoms.ts";
import { restartApp } from "../../utils/player.ts";
import styles from "./about.module.scss";

const appVersionAtom = loadable(atom(() => getVersion()));

export const AboutSettings = () => {
	const { t } = useTranslation();
	const updateInfo = useAtomValue(updateInfoAtom);
	const isChecking = useAtomValue(isCheckingUpdateAtom);
	const appVersion = useAtomValue(appVersionAtom);
	const [updating, setUpdating] = useState(false);
	const updatingRef = useRef(false);
	const version =
		appVersion.state === "hasData"
			? appVersion.data
			: updateInfo
				? updateInfo.currentVersion
				: undefined;

	const installUpdate = async () => {
		if (!updateInfo || updatingRef.current) return;
		updatingRef.current = true;
		setUpdating(true);
		const toastId = toast.loading(
			t("page.about.updating", "正在更新，完成后将会自动重启，请稍后……"),
		);
		let contentLength: number | undefined;
		let receivedLength = 0;
		const getProgressSizeText = () => {
			const received = `${(receivedLength / 1024 / 1024).toFixed(2)} MiB`;
			if (!contentLength) return `(${received})`;
			const total = `${(contentLength / 1024 / 1024).toFixed(2)} MiB`;
			return `(${received} / ${total}) (${Math.min(100, (receivedLength / contentLength) * 100).toFixed(1)}%)`;
		};
		const showDownloadProgress = () => {
			toast.update(toastId, {
				render: t("page.about.downloading", "正在下载更新…… {progressText}", {
					progressText: getProgressSizeText(),
				}),
				progress: contentLength
					? Math.min(1, receivedLength / contentLength)
					: null,
			});
		};
		try {
			await updateInfo.downloadAndInstall((event) => {
				switch (event.event) {
					case "Started":
						contentLength = event.data.contentLength;
						showDownloadProgress();
						break;
					case "Progress":
						receivedLength += event.data.chunkLength;
						showDownloadProgress();
						break;
					case "Finished":
						toast.update(toastId, {
							render: t(
								"page.about.installing",
								"正在安装更新，将会自动重启，请稍后……",
							),
							progress: null,
						});
						break;
				}
			});
			await restartApp();
		} catch (error) {
			toast.update(toastId, {
				render: t("page.about.updateFailed", "更新失败，请重试：{message}", {
					message: error instanceof Error ? error.message : String(error),
				}),
				type: "error",
				isLoading: false,
				autoClose: 8000,
				closeButton: true,
				progress: null,
			});
		} finally {
			updatingRef.current = false;
			setUpdating(false);
		}
	};

	return (
		<div className={styles.about}>
			<Heading as="h1" size="7" className={styles.pageTitle}>
				{t("page.about.subtitle", "关于")}
			</Heading>
			<section className={styles.identity} aria-label="AMLL Player">
				<img src={appIcon} alt="" className={styles.appIcon} />
				<div className={styles.identityText}>
					<Heading as="h2" size="7" className={styles.appName}>
						AMLL Player
					</Heading>
					<Text as="p" size="3" className={styles.tagline}>
						Apple Music-like Lyrics Player
					</Text>
					<div className={styles.buildInfo}>
						{version && (
							<Badge size="2" color="gray">
								v{version}
							</Badge>
						)}
						{branch && (
							<Badge size="2" variant="soft">
								{branch}
							</Badge>
						)}
						{commit && <code title={commit}>{commit.slice(0, 7)}</code>}
					</div>
				</div>
			</section>

			<section className={styles.updateCard} aria-labelledby="update-title">
				<div className={styles.updateHeader}>
					<div className={styles.updateIcon} aria-hidden="true">
						<UpdateIcon width={20} height={20} />
					</div>
					<div className={styles.updateSummary} aria-live="polite">
						<Heading as="h2" size="4" id="update-title">
							{t("page.about.softwareUpdate", "软件更新")}
						</Heading>
						<Text as="p" size="2" className={styles.updateDescription}>
							{isChecking
								? t("page.about.checkingUpdate", "正在检查更新……")
								: updateInfo
									? t(
											"page.about.updateAvailable",
											"发现新版本，更新后即可体验。",
										)
									: t("page.about.noUpdateInfo", "有可用更新时会显示在这里。")}
						</Text>
					</div>
					{isChecking ? (
						<Spinner />
					) : (
						updateInfo && (
							<Badge size="2" color="green">
								{t("page.about.availableBadge", "可用更新")}
							</Badge>
						)
					)}
				</div>
				{updateInfo && (
					<>
						<div className={styles.updateAction} id="updater">
							<div
								className={styles.versionChange}
								aria-label={t(
									"page.about.newVersion",
									"有可用更新从 {currentVersion} 升级至 {nextVersion}",
									{
										currentVersion: updateInfo.currentVersion,
										nextVersion: updateInfo.version,
									},
								)}
							>
								<span className={styles.currentVersion}>
									{updateInfo.currentVersion}
								</span>
								<ArrowRightIcon aria-hidden="true" />
								<strong>{updateInfo.version}</strong>
							</div>
							<Button
								size="3"
								disabled={updating}
								loading={updating}
								onClick={installUpdate}
							>
								<ArrowDownIcon />
								{t("page.about.installUpdate", "更新并安装")}
							</Button>
						</div>
						{updateInfo.body?.trim() && (
							<details className={styles.releaseNotes}>
								<summary>
									{t("page.about.releaseNotes", "更新说明")}
									<ChevronDownIcon aria-hidden="true" />
								</summary>
								<div className={styles.releaseBody}>{updateInfo.body}</div>
							</details>
						)}
					</>
				)}
			</section>
			<footer className={styles.credits}>
				{t("page.about.credits", "由 SteveXMH 及其所有 Github 协作者共同开发")}
			</footer>
		</div>
	);
};
