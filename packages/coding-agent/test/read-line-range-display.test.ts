import { describe, expect, it } from "vitest";
import { formatReadLineRange } from "../src/core/tools/render-utils.ts";

// #9887
describe("read line range display", () => {
	const cases: [unknown, unknown, string][] = [
		[25, 13, ":25-37"],
		["25", "13", ":25-37"],
		[null, "13", ":1-13"],
		["25", null, ":25"],
		[undefined, undefined, ""],
		["abc", 13, ""],
		[25, "", ""],
		[25, "Infinity", ""],
	];

	it("formats raw read arguments", () => {
		for (const [offset, limit, range] of cases) {
			expect(formatReadLineRange(offset, limit), `${offset}, ${limit}`).toBe(range);
		}
	});
});
