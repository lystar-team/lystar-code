import { describe, expect, it } from "vitest";
import { OutputSpeedTracker, visibleOutputTokens } from "../src/output-speed.ts";

describe("OutputSpeedTracker", () => {
	it("excludes hidden reasoning tokens from visible output speed", () => {
		expect(visibleOutputTokens(131, 31)).toBe(100);
		expect(visibleOutputTokens(12, 20)).toBe(0);
		expect(visibleOutputTokens(undefined, 20)).toBeUndefined();
	});
	it("measures model output from the first thinking or text delta to message completion", () => {
		const tracker = new OutputSpeedTracker();
		tracker.start();
		tracker.outputDelta(100);
		tracker.outputDelta(200);
		expect(tracker.finish(131, "stop", 1_100)).toEqual({ outputTokens: 131, elapsedMs: 1_000 });
		expect(tracker.finish(131, "stop", 1_200)).toBeUndefined();
	});

	it("does not reuse output time after an error or a new response", () => {
		const tracker = new OutputSpeedTracker();
		tracker.outputDelta(100);
		expect(tracker.finish(12, "error", 200)).toBeUndefined();
		tracker.outputDelta(300);
		tracker.start();
		expect(tracker.finish(12, "stop", 600)).toBeUndefined();
		tracker.outputDelta(700);
		expect(tracker.finish(0, "stop", 800)).toBeUndefined();
	});
});
