export interface CoverRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export const isUsableCoverRect = (rect: CoverRect) =>
	Number.isFinite(rect.left) &&
	Number.isFinite(rect.top) &&
	Number.isFinite(rect.width) &&
	Number.isFinite(rect.height) &&
	rect.width > 1 &&
	rect.height > 1;

export const toCoverRect = (rect: DOMRect | CoverRect): CoverRect => ({
	left: rect.left,
	top: rect.top,
	width: rect.width,
	height: rect.height,
});

export const mapCoverRectFromTransformedContainer = (
	target: CoverRect,
	transformedContainer: CoverRect,
	finalContainer: CoverRect,
): CoverRect => {
	const scaleX = transformedContainer.width / finalContainer.width;
	const scaleY = transformedContainer.height / finalContainer.height;
	if (
		!Number.isFinite(scaleX) ||
		!Number.isFinite(scaleY) ||
		Math.abs(scaleX) < 0.0001 ||
		Math.abs(scaleY) < 0.0001
	) {
		return target;
	}

	return {
		left:
			finalContainer.left + (target.left - transformedContainer.left) / scaleX,
		top: finalContainer.top + (target.top - transformedContainer.top) / scaleY,
		width: target.width / scaleX,
		height: target.height / scaleY,
	};
};

export const coverRectDistance = (left: CoverRect, right: CoverRect) =>
	Math.max(
		Math.abs(left.left - right.left),
		Math.abs(left.top - right.top),
		Math.abs(left.width - right.width),
		Math.abs(left.height - right.height),
	);
