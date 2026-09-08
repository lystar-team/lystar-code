import { describe, expect, it } from "vitest";
import {
	buildTranscriptHeightEstimates,
	resolveTranscriptFirstItemIndex,
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

	it("converts Virtuoso absolute indexes back to transcript array indexes", () => {
		expect(transcriptDataIndex(998, 998)).toBe(0);
		expect(transcriptDataIndex(1_005, 998)).toBe(7);
	});
});
