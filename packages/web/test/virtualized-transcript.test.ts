import { describe, expect, it } from "vitest";
import {
	selectTranscriptContentAnchors,
	shouldCancelPrependAnchorForKey,
	shouldCancelPrependAnchorForWheel,
	transcriptAnchorScrollDelta,
} from "../src/components/workbench/prepend-anchored-transcript.tsx";
import {
	buildTranscriptHeightEstimates,
	resolveTranscriptFirstItemIndex,
	safeTranscriptItemKey,
	selectTranscriptScrollAnchor,
	shouldCaptureTranscriptScrollState,
	transcriptDataIndex,
} from "../src/components/workbench/virtualized-transcript.tsx";

type Item = { key: string; height: number; kind: "message" | "tool" };

function items(...entries: Array<[number, Item["kind"]]>): Item[] {
	return entries.map(([height, kind], index) => ({ key: `item-${index}`, height, kind }));
}

describe("transcript virtualization", () => {
	it("builds per-item height estimates and leaves no gap after the final row", () => {
		const result = buildTranscriptHeightEstimates(
			items([40, "message"], [50, "message"], [60, "message"]),
			(item) => item.height,
			12,
		);

		expect(result).toEqual([52, 62, 60]);
	});

	it("preserves the zero gap between adjacent tool rows", () => {
		const result = buildTranscriptHeightEstimates(
			items([32, "tool"], [32, "tool"], [80, "message"]),
			(item) => item.height,
			(previous, current) => (previous.kind === "tool" && current.kind === "tool" ? 0 : 12),
		);

		expect(result).toEqual([32, 44, 80]);
	});

	it("normalizes invalid estimates without producing an unusable scroll size", () => {
		const result = buildTranscriptHeightEstimates(
			items([0, "message"], [Number.NaN, "message"]),
			(item) => item.height,
			Number.NaN,
		);

		expect(result).toEqual([1, 1]);
	});

	it("decreases the first item index only when stable keys are prepended", () => {
		const previous = { firstItemIndex: 1_000, firstKey: "current-0" };

		expect(resolveTranscriptFirstItemIndex(previous, ["older-0", "older-1", "current-0", "current-1"])).toBe(998);
		expect(resolveTranscriptFirstItemIndex(previous, ["current-0", "current-1", "newer-0"])).toBe(1_000);
	});

	it("uses a stable placeholder key while Virtuoso replaces session data", () => {
		expect(safeTranscriptItemKey(3, undefined, (item: Item) => item.key)).toBe("virtual-placeholder:3");
		expect(safeTranscriptItemKey(3, { key: "message-3", height: 20, kind: "message" }, (item) => item.key)).toBe(
			"message-3",
		);
	});

	it("selects the first visible transcript row as the message anchor", () => {
		const transcriptItems = items([80, "message"], [120, "message"], [60, "tool"]);

		expect(
			selectTranscriptScrollAnchor(
				transcriptItems,
				[
					{ bottom: 100.5, index: 0, top: 20 },
					{ bottom: 180, index: 1, top: 80 },
					{ bottom: 240, index: 2, top: 180 },
				],
				100,
				(item) => item.key,
			),
		).toEqual({ anchorKey: "item-1", anchorOffset: -20, atBottom: false });
	});

	it("converts Virtuoso absolute indexes back to transcript array indexes", () => {
		expect(transcriptDataIndex(998, 998)).toBe(0);
		expect(transcriptDataIndex(1_005, 998)).toBe(7);
	});

	it("anchors the first visible content item instead of its containing virtual row", () => {
		expect(
			selectTranscriptContentAnchors(
				[
					{ key: "hidden-child", top: 10, bottom: 90 },
					{ key: "visible-message", top: 80, bottom: 160 },
					{ key: "below-viewport", top: 220, bottom: 300 },
				],
				100,
				200,
			),
		).toEqual([{ anchorKey: "visible-message", anchorOffset: -20 }]);
	});

	it("restores the captured content pixel after nested history changes its containing row", () => {
		expect(transcriptAnchorScrollDelta(71, 49)).toBe(22);
		expect(transcriptAnchorScrollDelta(48.7, 49)).toBe(0);
		expect(transcriptAnchorScrollDelta(Number.NaN, 49)).toBe(0);
	});

	it("keeps the anchor during the loading gesture and releases it when the user leaves", () => {
		expect(shouldCancelPrependAnchorForWheel(-120, true)).toBe(false);
		expect(shouldCancelPrependAnchorForWheel(120, true)).toBe(true);
		expect(shouldCancelPrependAnchorForWheel(-120, false)).toBe(true);
		expect(shouldCancelPrependAnchorForKey("PageUp", true)).toBe(false);
		expect(shouldCancelPrependAnchorForKey("ArrowDown", true)).toBe(true);
		expect(shouldCancelPrependAnchorForKey("PageUp", false)).toBe(true);
	});

	it("does not let programmatic off-bottom corrections overwrite user scroll state", () => {
		expect(shouldCaptureTranscriptScrollState(false, false, false)).toBe(false);
		expect(shouldCaptureTranscriptScrollState(false, true, false)).toBe(false);
		expect(shouldCaptureTranscriptScrollState(false, true, true)).toBe(true);
		expect(shouldCaptureTranscriptScrollState(true, false, false)).toBe(true);
	});
});
