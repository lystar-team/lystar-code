import assert from "node:assert";
import { describe, it } from "node:test";
import { WheelScrollNormalizer } from "../src/wheel-scroll.ts";

describe("WheelScrollNormalizer", () => {
	it("keeps discrete wheel notches useful and normalizes sustained precision input", () => {
		const wheel = new WheelScrollNormalizer();

		assert.strictEqual(wheel.getDelta(1, 100), 3);
		assert.strictEqual(wheel.getDelta(1, 120), 1);
		assert.strictEqual(wheel.getDelta(1, 140), 1);
		assert.strictEqual(wheel.getDelta(1, 160), 1);
		assert.strictEqual(wheel.getDelta(1, 220), 3);
	});

	it("resets accumulated speed when direction changes", () => {
		const wheel = new WheelScrollNormalizer();

		wheel.getDelta(1, 100);
		wheel.getDelta(1, 116);
		wheel.getDelta(1, 132);
		assert.strictEqual(wheel.getDelta(-1, 140), -1);
		assert.strictEqual(wheel.getDelta(-1, 156), -1);
	});

	it("accumulates duplicate terminal ticks without multiplying their distance", () => {
		const wheel = new WheelScrollNormalizer();

		assert.strictEqual(wheel.getDelta(1, 100), 3);
		assert.strictEqual(wheel.getDelta(1, 104), 0);
		assert.strictEqual(wheel.getDelta(1, 108), 0);
		assert.strictEqual(wheel.getDelta(1, 112), 0);
		assert.strictEqual(wheel.getDelta(1, 116), 1);
	});
});
