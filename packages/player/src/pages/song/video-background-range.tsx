import type { FC, KeyboardEvent, PointerEvent } from "react";
import { useRef } from "react";
import styles from "./video-background.module.css";

const RANGE_STEP_MS = 100;
const MIN_RANGE_MS = 100;

export type VideoBackgroundRangeChangeSource = "in" | "out" | "move";

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function snap(value: number, max: number): number {
	if (value <= 0) return 0;
	if (value >= max) return max;
	return clamp(Math.round(value / RANGE_STEP_MS) * RANGE_STEP_MS, 0, max);
}

export function formatVideoTime(milliseconds: number): string {
	const safeMilliseconds = Math.max(0, Math.round(milliseconds));
	const minutes = Math.floor(safeMilliseconds / 60_000);
	const seconds = Math.floor((safeMilliseconds % 60_000) / 1_000);
	const fraction = safeMilliseconds % 1_000;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
}

interface VideoBackgroundRangeProps {
	durationMs: number;
	inPointMs: number;
	outPointMs: number;
	onChange: (
		inPointMs: number,
		outPointMs: number,
		source: VideoBackgroundRangeChangeSource,
	) => void;
	inPointLabel: string;
	outPointLabel: string;
	moveRangeLabel: string;
	disabled?: boolean;
}

export const VideoBackgroundRange: FC<VideoBackgroundRangeProps> = ({
	durationMs,
	inPointMs,
	outPointMs,
	onChange,
	inPointLabel,
	outPointLabel,
	moveRangeLabel,
	disabled = false,
}) => {
	const dragRef = useRef<{
		pointerId: number;
		startX: number;
		trackWidth: number;
		inPointMs: number;
		outPointMs: number;
	} | null>(null);

	const safeDuration = Math.max(1, Math.round(durationMs));
	const minRangeMs = Math.min(MIN_RANGE_MS, safeDuration);
	const safeInPoint = clamp(inPointMs, 0, safeDuration - minRangeMs);
	const safeOutPoint = clamp(
		outPointMs,
		safeInPoint + minRangeMs,
		safeDuration,
	);
	const startPercent = (safeInPoint / safeDuration) * 100;
	const endPercent = (safeOutPoint / safeDuration) * 100;

	const moveSelection = (deltaMs: number) => {
		if (disabled) return;
		const width = safeOutPoint - safeInPoint;
		const nextIn = clamp(
			snap(safeInPoint + deltaMs, safeDuration),
			0,
			safeDuration - width,
		);
		onChange(nextIn, nextIn + width, "move");
	};

	const handleSelectionPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (disabled) return;
		const track = event.currentTarget.parentElement;
		if (!track) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			trackWidth: Math.max(1, track.getBoundingClientRect().width),
			inPointMs: safeInPoint,
			outPointMs: safeOutPoint,
		};
	};

	const handleSelectionPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		if (disabled) return;
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		const width = drag.outPointMs - drag.inPointMs;
		const rawDelta =
			((event.clientX - drag.startX) / drag.trackWidth) * safeDuration;
		const nextIn = clamp(
			snap(drag.inPointMs + rawDelta, safeDuration),
			0,
			safeDuration - width,
		);
		onChange(nextIn, nextIn + width, "move");
	};

	const handleSelectionPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		if (dragRef.current?.pointerId !== event.pointerId) return;
		dragRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	const handleSelectionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (disabled) return;
		if (
			event.key !== "ArrowLeft" &&
			event.key !== "ArrowRight" &&
			event.key !== "ArrowUp" &&
			event.key !== "ArrowDown" &&
			event.key !== "Home" &&
			event.key !== "End"
		)
			return;
		event.preventDefault();
		const selectionWidth = safeOutPoint - safeInPoint;
		if (event.key === "Home" || event.key === "End") {
			const nextIn = event.key === "Home" ? 0 : safeDuration - selectionWidth;
			onChange(nextIn, nextIn + selectionWidth, "move");
			return;
		}
		const multiplier = event.shiftKey ? 10 : 1;
		moveSelection(
			(event.key === "ArrowLeft" || event.key === "ArrowDown"
				? -RANGE_STEP_MS
				: RANGE_STEP_MS) * multiplier,
		);
	};

	return (
		<div className={styles.rangeEditor}>
			<div className={styles.rangeLabels}>
				<span>
					{inPointLabel}: {formatVideoTime(safeInPoint)}
				</span>
				<span>
					{outPointLabel}: {formatVideoTime(safeOutPoint)}
				</span>
			</div>
			<div className={styles.rangeTrack}>
				<div className={styles.rangeTrackBase} />
				<div
					className={styles.rangeSelection}
					style={{ left: `${startPercent}%`, right: `${100 - endPercent}%` }}
					tabIndex={disabled ? -1 : 0}
					role="slider"
					aria-disabled={disabled}
					aria-label={moveRangeLabel}
					aria-valuemin={0}
					aria-valuemax={safeDuration - (safeOutPoint - safeInPoint)}
					aria-valuenow={safeInPoint}
					aria-valuetext={`${formatVideoTime(safeInPoint)} – ${formatVideoTime(safeOutPoint)}`}
					onPointerDown={handleSelectionPointerDown}
					onPointerMove={handleSelectionPointerMove}
					onPointerUp={handleSelectionPointerUp}
					onPointerCancel={handleSelectionPointerUp}
					onLostPointerCapture={() => {
						dragRef.current = null;
					}}
					onKeyDown={handleSelectionKeyDown}
				/>
				<input
					className={styles.rangeInput}
					type="range"
					min={0}
					max={safeDuration}
					step={RANGE_STEP_MS}
					value={safeInPoint}
					aria-label={inPointLabel}
					aria-valuetext={formatVideoTime(safeInPoint)}
					disabled={disabled}
					onChange={(event) => {
						const next = Math.min(
							snap(Number(event.currentTarget.value), safeDuration),
							safeOutPoint - minRangeMs,
						);
						onChange(Math.max(0, next), safeOutPoint, "in");
					}}
				/>
				<input
					className={styles.rangeInput}
					type="range"
					min={0}
					max={safeDuration}
					step={RANGE_STEP_MS}
					value={safeOutPoint}
					aria-label={outPointLabel}
					aria-valuetext={formatVideoTime(safeOutPoint)}
					disabled={disabled}
					onChange={(event) => {
						const next = Math.max(
							snap(Number(event.currentTarget.value), safeDuration),
							safeInPoint + minRangeMs,
						);
						onChange(safeInPoint, Math.min(safeDuration, next), "out");
					}}
				/>
			</div>
		</div>
	);
};
