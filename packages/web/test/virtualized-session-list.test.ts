import { describe, expect, it } from "vitest";
import { getVirtualSessionRange } from "../src/components/workbench/virtualized-session-list.tsx";

describe("virtualized session range", () => {
	it("returns only rows near the current viewport", () => {
		expect(getVirtualSessionRange(300, 1000, 400, 960, 40, 80)).toEqual({ start: 0, end: 12 });
		expect(getVirtualSessionRange(300, 5200, 400, 4800, 40, 80)).toEqual({ start: 8, end: 21 });
	});

	it("does not mount rows outside the list viewport", () => {
		expect(getVirtualSessionRange(300, 0, 400, 3000, 40, 80)).toEqual({ start: 0, end: -1 });
		expect(getVirtualSessionRange(300, 20000, 400, 0, 40, 80)).toEqual({ start: 0, end: -1 });
	});
});
