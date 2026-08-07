import { type CSSProperties, type FC, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
	type CoverRect,
	coverRectDistance,
	isUsableCoverRect,
	mapCoverRectFromTransformedContainer,
	toCoverRect,
} from "./geometry.ts";
import styles from "./index.module.css";

export type FullscreenCoverTransitionDirection = "enter" | "exit";

export interface FullscreenCoverTransitionSnapshot {
	direction: FullscreenCoverTransitionDirection;
	musicId: string;
	coverUrl: string;
	source: CoverRect;
	target: CoverRect;
	sourceCornerRadius: number;
	targetCornerRadius: number;
	sourceFilter: string;
	targetFilter: string;
}

const TRANSITION_DURATION = 480;
const CORRECTION_DURATION = 120;
const HANDOFF_DURATION = 100;
const TRANSPARENT_DROP_SHADOW = "drop-shadow(rgba(0, 0, 0, 0) 0px 0px 0px)";
const SOURCE_SELECTOR = "[data-amll-cover-transition-source]";
const TARGET_SELECTOR = "[data-amll-cover]";
const TRANSITION_COVER_SELECTOR = "[data-amll-cover-transition-cover]";

const getLargestFullscreenCover = () => {
	const wrapper = document.getElementById("amll-lyric-player-wrapper");
	if (!wrapper) return null;
	const element = Array.from(
		wrapper.querySelectorAll<HTMLElement>(TARGET_SELECTOR),
	)
		.map((candidate) => ({
			candidate,
			rect: candidate.getBoundingClientRect(),
		}))
		.filter(({ rect }) => rect.width > 1 && rect.height > 1)
		.sort(
			(left, right) =>
				right.rect.width * right.rect.height -
				left.rect.width * left.rect.height,
		)[0];
	return element
		? { wrapper, element: element.candidate, rect: element.rect }
		: null;
};

const getCornerRadius = (element: HTMLElement, fallback: number) => {
	const radius = Number.parseFloat(
		getComputedStyle(element).borderTopLeftRadius,
	);
	return Number.isFinite(radius) && radius > 0 ? radius : fallback;
};

const getVisualFilter = (element: HTMLElement) => {
	const filter = getComputedStyle(element).filter;
	return filter === "none" ? TRANSPARENT_DROP_SHADOW : filter;
};

const measureFullscreenTarget = (
	direction: FullscreenCoverTransitionDirection,
) => {
	const target = getLargestFullscreenCover();
	if (!target) return null;
	const wrapperRect = toCoverRect(target.wrapper.getBoundingClientRect());
	const candidateRect = toCoverRect(target.rect);
	const finalWrapperRect = {
		left: target.wrapper.offsetLeft,
		top: target.wrapper.offsetTop,
		width: target.wrapper.offsetWidth || window.innerWidth,
		height: target.wrapper.offsetHeight || window.innerHeight,
	};
	const rect =
		direction === "enter"
			? mapCoverRectFromTransformedContainer(
					candidateRect,
					wrapperRect,
					finalWrapperRect,
				)
			: candidateRect;
	if (!isUsableCoverRect(rect)) return null;
	return {
		rect,
		filter: getVisualFilter(target.element),
		cornerRadius: getCornerRadius(
			target.element,
			Math.max(
				Math.min(rect.width, rect.height) * 0.02,
				window.innerHeight * 0.007,
			),
		),
	};
};

export const captureFullscreenCoverTransition = (
	sourceElement: HTMLElement,
	coverUrl: string,
	musicId: string,
	direction: FullscreenCoverTransitionDirection = "enter",
): FullscreenCoverTransitionSnapshot | null => {
	const source = toCoverRect(sourceElement.getBoundingClientRect());
	const measuredTarget = measureFullscreenTarget(direction);
	if (!measuredTarget || !isUsableCoverRect(source)) return null;

	const activeTransitionCover = document.querySelector<HTMLElement>(
		TRANSITION_COVER_SELECTOR,
	);
	const activeTransitionRect = activeTransitionCover
		? toCoverRect(activeTransitionCover.getBoundingClientRect())
		: null;
	const target =
		direction === "exit" &&
		activeTransitionRect &&
		isUsableCoverRect(activeTransitionRect)
			? activeTransitionRect
			: measuredTarget.rect;
	const targetCornerRadius = activeTransitionCover
		? getCornerRadius(activeTransitionCover, measuredTarget.cornerRadius)
		: measuredTarget.cornerRadius;
	const targetFilter = activeTransitionCover
		? getVisualFilter(activeTransitionCover)
		: measuredTarget.filter;

	return {
		direction,
		musicId,
		coverUrl,
		source,
		target,
		sourceCornerRadius: getCornerRadius(sourceElement, 6),
		targetCornerRadius,
		sourceFilter: getVisualFilter(sourceElement),
		targetFilter,
	};
};

const rectToKeyframe = (
	rect: CoverRect,
	cornerRadius: number,
	shadow: string,
): Keyframe => ({
	left: `${rect.left}px`,
	top: `${rect.top}px`,
	width: `${rect.width}px`,
	height: `${rect.height}px`,
	borderRadius: `${cornerRadius}px`,
	filter: shadow,
});

export const FullscreenCoverTransition: FC<{
	snapshot: FullscreenCoverTransitionSnapshot;
	onFinish: () => void;
}> = ({ snapshot, onFinish }) => {
	const coverRef = useRef<HTMLDivElement>(null);
	const from =
		snapshot.direction === "enter" ? snapshot.source : snapshot.target;
	const fromCornerRadius =
		snapshot.direction === "enter"
			? snapshot.sourceCornerRadius
			: snapshot.targetCornerRadius;
	const style: CSSProperties = {
		left: from.left,
		top: from.top,
		width: from.width,
		height: from.height,
		backgroundImage: `url(${snapshot.coverUrl})`,
		borderRadius: fromCornerRadius,
		filter:
			snapshot.direction === "enter"
				? snapshot.sourceFilter
				: snapshot.targetFilter,
	};

	useLayoutEffect(() => {
		const cover = coverRef.current;
		if (!cover) return;

		document.body.dataset.amllCoverTransition = snapshot.direction;
		let settled = false;
		let animationFrame = 0;
		let correctionCount = 0;
		let animation: Animation | null = null;
		let handoffAnimation: Animation | null = null;
		let nativeHandoffAnimation: Animation | null = null;
		let handoffStarted = false;

		const resolveEndpoint = () => {
			if (snapshot.direction === "enter") {
				return (
					measureFullscreenTarget("enter") ?? {
						rect: snapshot.target,
						cornerRadius: snapshot.targetCornerRadius,
						filter: snapshot.targetFilter,
					}
				);
			}
			const sourceElement =
				document.querySelector<HTMLElement>(SOURCE_SELECTOR);
			const rect = sourceElement
				? toCoverRect(sourceElement.getBoundingClientRect())
				: snapshot.source;
			return {
				rect: isUsableCoverRect(rect) ? rect : snapshot.source,
				cornerRadius: sourceElement
					? getCornerRadius(sourceElement, snapshot.sourceCornerRadius)
					: snapshot.sourceCornerRadius,
				filter: sourceElement
					? getVisualFilter(sourceElement)
					: snapshot.sourceFilter,
			};
		};

		const finish = () => {
			if (settled) return;
			settled = true;
			delete document.body.dataset.amllCoverTransition;
			onFinish();
		};
		const beginHandoff = () => {
			if (settled || handoffStarted) return;
			handoffStarted = true;
			const nativeEndpoint =
				snapshot.direction === "enter"
					? getLargestFullscreenCover()?.element
					: document.querySelector<HTMLElement>(SOURCE_SELECTOR);
			const currentOpacity = Number.parseFloat(getComputedStyle(cover).opacity);
			const handoffOptions: KeyframeAnimationOptions = {
				duration: HANDOFF_DURATION,
				easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
				fill: "both",
			};
			handoffAnimation = cover.animate(
				[
					{ opacity: Number.isFinite(currentOpacity) ? currentOpacity : 1 },
					{ opacity: 0 },
				],
				handoffOptions,
			);
			nativeHandoffAnimation =
				nativeEndpoint?.animate(
					[{ opacity: 0 }, { opacity: 1 }],
					handoffOptions,
				) ?? null;
			document.body.dataset.amllCoverTransition = `${snapshot.direction}-handoff`;
			handoffAnimation.addEventListener("finish", finish, { once: true });
		};
		const animateToEndpoint = (duration: number) => {
			const current = toCoverRect(cover.getBoundingClientRect());
			const endpoint = resolveEndpoint();
			const currentRadius =
				Number.parseFloat(getComputedStyle(cover).borderTopLeftRadius) ||
				fromCornerRadius;
			const currentShadow = getComputedStyle(cover).filter;
			animation?.cancel();
			animation = cover.animate(
				[
					rectToKeyframe(
						current,
						currentRadius,
						currentShadow === "none" ? TRANSPARENT_DROP_SHADOW : currentShadow,
					),
					rectToKeyframe(endpoint.rect, endpoint.cornerRadius, endpoint.filter),
				],
				{
					duration,
					easing: "cubic-bezier(0.25, 1, 0.5, 1)",
					fill: "both",
				},
			);
			animation.addEventListener(
				"finish",
				() => {
					const actualEndpoint = resolveEndpoint();
					const currentRect = toCoverRect(cover.getBoundingClientRect());
					if (
						correctionCount < 2 &&
						coverRectDistance(currentRect, actualEndpoint.rect) > 0.75
					) {
						correctionCount += 1;
						animateToEndpoint(CORRECTION_DURATION);
						return;
					}
					beginHandoff();
				},
				{ once: true },
			);
		};

		animationFrame = requestAnimationFrame(() => {
			animationFrame = 0;
			animateToEndpoint(TRANSITION_DURATION);
		});
		const handleResize = () => {
			if (settled) return;
			if (handoffStarted) {
				finish();
				return;
			}
			if (animationFrame) cancelAnimationFrame(animationFrame);
			animationFrame = requestAnimationFrame(() => {
				animationFrame = 0;
				correctionCount = 0;
				animateToEndpoint(CORRECTION_DURATION * 2);
			});
		};
		window.addEventListener("resize", handleResize);

		return () => {
			settled = true;
			if (animationFrame) cancelAnimationFrame(animationFrame);
			animation?.cancel();
			handoffAnimation?.cancel();
			nativeHandoffAnimation?.cancel();
			window.removeEventListener("resize", handleResize);
			delete document.body.dataset.amllCoverTransition;
		};
	}, [fromCornerRadius, onFinish, snapshot]);

	return createPortal(
		<div className={styles.transitionViewport} aria-hidden="true">
			<div
				ref={coverRef}
				className={styles.transitionCover}
				style={style}
				data-amll-cover-transition-cover=""
			/>
		</div>,
		document.body,
	);
};
