import { describe, expect, it } from "vitest";
import { buildVirtualLayout, getVirtualRange } from "../src/components/workbench/virtualized-transcript.tsx";

type Item = { key: string; height: number };

const getKey = (item: Item) => item.key;
const estimateHeight = (item: Item) => item.height;

function items(...heights: number[]): Item[] {
	return heights.map((height, index) => ({ key: `item-${index}`, height }));
}

describe("transcript virtual layout", () => {
	it("uses measured heights and preserves the configured row gap", () => {
		const layout = buildVirtualLayout(items(40, 50, 60), getKey, new Map([["item-1", 90]]), estimateHeight, 12);

		expect(layout.offsets).toEqual([0, 52, 154]);
		expect(layout.heights).toEqual([40, 90, 60]);
		expect(layout.totalHeight).toBe(214);
	});

	it("returns only the viewport range with overscan", () => {
		const layout = buildVirtualLayout(items(40, 40, 40, 40, 40), getKey, new Map(), estimateHeight, 12);

		expect(getVirtualRange(layout, 104, 40, 0)).toEqual({ start: 2, end: 2 });
		expect(getVirtualRange(layout, 104, 40, 45)).toEqual({ start: 1, end: 3 });
	});

	it("keeps a row mounted while the viewport is inside a row gap", () => {
		const layout = buildVirtualLayout(items(40, 40), getKey, new Map(), estimateHeight, 12);

		expect(getVirtualRange(layout, 44, 1, 0)).toEqual({ start: 0, end: 1 });
	});
});
