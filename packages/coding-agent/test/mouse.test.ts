import { describe, expect, it } from "vitest";
import { parseMouseEvent } from "../src/modes/interactive/mouse.ts";

describe("SGR mouse input", () => {
	it("parses wheel events and converts coordinates to zero-based values", () => {
		expect(parseMouseEvent("\x1b[<64;20;5M")).toEqual({
			button: "wheel-up",
			column: 19,
			row: 4,
			shift: false,
			motion: false,
			released: false,
		});
		expect(parseMouseEvent("\x1b[<65;3;9M")?.button).toBe("wheel-down");
		expect(parseMouseEvent("\x1b[<66;3;9M")?.button).toBe("other");
		expect(parseMouseEvent("\x1b[<67;3;9M")?.button).toBe("other");
	});

	it("parses shifted click and release events", () => {
		expect(parseMouseEvent("\x1b[<4;1;1M")).toMatchObject({ button: "left", shift: true, released: false });
		expect(parseMouseEvent("\x1b[<0;1;1m")).toMatchObject({ button: "left", released: true });
		expect(parseMouseEvent("\x1b[<32;2;3M")).toMatchObject({ button: "left", motion: true });
	});

	it("ignores malformed input", () => {
		expect(parseMouseEvent("hello")).toBeUndefined();
		expect(parseMouseEvent("\x1b[<0;0;1M")).toBeUndefined();
	});
});
