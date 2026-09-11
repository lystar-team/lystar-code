import { describe, expect, it } from "vitest";
import { selectedVisibleThinkingLevel, visibleThinkingLevels } from "../src/components/workbench/constants.ts";

describe("visible thinking levels", () => {
	it("shows one low option when minimal and low are both supported", () => {
		const levels = visibleThinkingLevels(["off", "minimal", "low", "medium", "high"]);

		expect(levels).toEqual(["off", "low", "medium", "high"]);
		expect(selectedVisibleThinkingLevel("minimal", levels)).toBe("low");
	});

	it("keeps the real minimal value when low is unsupported", () => {
		const levels = visibleThinkingLevels(["minimal", "high"]);

		expect(levels).toEqual(["minimal", "high"]);
		expect(selectedVisibleThinkingLevel("minimal", levels)).toBe("minimal");
	});
});
