import type { LyricLine } from "@applemusic-like-lyrics/core";

export type LyricJumpState = {
	lastIndex: number;
	jumpId: number;
};

export function findCurrentLyricIndex(
	lines: LyricLine[],
	position: number,
): number {
	let low = 0;
	let high = lines.length - 1;
	let index = -1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const lineTime = lines[mid].startTime;
		if (lineTime <= position) {
			index = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return index;
}

export function findMetadataLyricIndex(
	previousMusicId: string | null,
	nextMusicId: string,
	lines: LyricLine[],
	position: number,
): number {
	if (previousMusicId !== null && previousMusicId !== nextMusicId) {
		return -1;
	}
	return findCurrentLyricIndex(lines, position);
}

export function reconcileMetadataTimeline(
	previousIndex: number,
	previousJumpState: LyricJumpState,
	currentLyricIndex: number,
	trackChanged: boolean,
	lyricLineCount: number,
): { currentLyricIndex: number; jumpState: LyricJumpState } {
	if (trackChanged) {
		return {
			currentLyricIndex,
			jumpState: { lastIndex: currentLyricIndex, jumpId: 0 },
		};
	}

	if (previousIndex >= 0 && previousIndex < lyricLineCount) {
		return {
			currentLyricIndex: previousIndex,
			jumpState: previousJumpState,
		};
	}

	return {
		currentLyricIndex,
		jumpState: {
			lastIndex: currentLyricIndex,
			jumpId: previousJumpState.jumpId,
		},
	};
}

export function taskbarContentGroupKey(
	musicId: string,
	displayAsMetadata: boolean,
	jumpId: number,
): string {
	const content = displayAsMetadata ? "metadata" : "lyrics";
	return `${content}-${musicId}-${displayAsMetadata ? 0 : jumpId}`;
}
