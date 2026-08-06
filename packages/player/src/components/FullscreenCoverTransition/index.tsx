import { type CSSProperties, type FC, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import styles from "./index.module.css";

interface CoverRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface FullscreenCoverTransitionSnapshot {
	coverUrl: string;
	source: CoverRect;
	target: CoverRect;
	sourceCornerRadius: number;
	targetCornerRadius: number;
}

const isUsableRect = (rect: CoverRect) =>
	Number.isFinite(rect.left) &&
	Number.isFinite(rect.top) &&
	rect.width > 1 &&
	rect.height > 1;

const toCoverRect = (rect: DOMRect): CoverRect => ({
	left: rect.left,
	top: rect.top,
	width: rect.width,
	height: rect.height,
});

export const captureFullscreenCoverTransition = (
	sourceElement: HTMLElement,
	coverUrl: string,
): FullscreenCoverTransitionSnapshot | null => {
	const wrapper = document.getElementById("amll-lyric-player-wrapper");
	if (!wrapper) return null;

	const wrapperRect = wrapper.getBoundingClientRect();
	const targetCandidate = Array.from(
		wrapper.querySelectorAll<HTMLElement>("[data-amll-cover]"),
	)
		.map((element) => element.getBoundingClientRect())
		.filter((rect) => rect.width > 1 && rect.height > 1)
		.sort(
			(left, right) => right.width * right.height - left.width * left.height,
		)[0];
	if (!targetCandidate) return null;

	const source = toCoverRect(sourceElement.getBoundingClientRect());
	const target = {
		left: targetCandidate.left - wrapperRect.left,
		top: targetCandidate.top - wrapperRect.top,
		width: targetCandidate.width,
		height: targetCandidate.height,
	};
	if (!isUsableRect(source) || !isUsableRect(target)) return null;

	const sourceCornerRadius = Number.parseFloat(
		getComputedStyle(sourceElement).borderTopLeftRadius,
	);
	const targetCornerRadius = Math.max(
		Math.min(target.width, target.height) * 0.02,
		window.innerHeight * 0.007,
	);

	return {
		coverUrl,
		source,
		target,
		sourceCornerRadius: Number.isFinite(sourceCornerRadius)
			? sourceCornerRadius
			: 6,
		targetCornerRadius,
	};
};

export const FullscreenCoverTransition: FC<{
	snapshot: FullscreenCoverTransitionSnapshot;
	onFinish: () => void;
}> = ({ snapshot, onFinish }) => {
	const coverRef = useRef<HTMLDivElement>(null);
	const scaleX = snapshot.source.width / snapshot.target.width;
	const scaleY = snapshot.source.height / snapshot.target.height;
	const translateX = snapshot.source.left - snapshot.target.left;
	const translateY = snapshot.source.top - snapshot.target.top;
	const invertedTransform = `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`;
	const initialCornerRadius =
		snapshot.sourceCornerRadius / Math.max(scaleX, 0.001);
	const style: CSSProperties = {
		left: snapshot.target.left,
		top: snapshot.target.top,
		width: snapshot.target.width,
		height: snapshot.target.height,
		backgroundImage: `url(${snapshot.coverUrl})`,
		borderRadius: initialCornerRadius,
		transform: invertedTransform,
	};

	useLayoutEffect(() => {
		const cover = coverRef.current;
		if (!cover) return;

		document.body.dataset.amllCoverTransition = "";
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			delete document.body.dataset.amllCoverTransition;
			onFinish();
		};
		const animation = cover.animate(
			[
				{
					transform: invertedTransform,
					borderRadius: `${initialCornerRadius}px`,
					boxShadow: "0 2px 10px rgb(0 0 0 / 0.12)",
				},
				{
					transform: "translate(0, 0) scale(1, 1)",
					borderRadius: `${snapshot.targetCornerRadius}px`,
					boxShadow: "0 22px 60px rgb(0 0 0 / 0.32)",
				},
			],
			{
				duration: 500,
				easing: "cubic-bezier(0.25, 1, 0.5, 1)",
				fill: "both",
			},
		);
		animation.addEventListener("finish", finish, { once: true });
		window.addEventListener("resize", finish);

		return () => {
			settled = true;
			animation.cancel();
			window.removeEventListener("resize", finish);
			delete document.body.dataset.amllCoverTransition;
		};
	}, [
		initialCornerRadius,
		invertedTransform,
		onFinish,
		snapshot.targetCornerRadius,
	]);

	return createPortal(
		<div
			ref={coverRef}
			className={styles.transitionCover}
			style={style}
			aria-hidden="true"
		/>,
		document.body,
	);
};
