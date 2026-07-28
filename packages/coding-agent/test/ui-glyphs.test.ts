import { describe, expect, it } from "vitest";
import { getUiGlyphs, toUiGlyph } from "../src/modes/interactive/ui-glyphs.ts";

describe("UI glyphs", () => {
	it("uses ASCII-safe built-in symbols on Windows", () => {
		const glyphs = getUiGlyphs("win32");

		expect(glyphs).toEqual({
			prompt: ">",
			success: "+",
			failure: "x",
			tool: "*",
			expanded: "-",
			collapsed: "+",
			branch: ">",
			delta: "+/-",
			search: "?",
			list: "=",
			edit: "E",
		});
		expect(Object.values(glyphs).every((glyph) => /^[\x20-\x7e]+$/.test(glyph))).toBe(true);
		expect(toUiGlyph("⌕", "win32")).toBe("?");
		expect(toUiGlyph("custom", "win32")).toBe("custom");
	});

	it("keeps the existing compact symbols on Unix terminals", () => {
		expect(getUiGlyphs("linux")).toMatchObject({ prompt: "❯", success: "✓", expanded: "▾" });
	});
});
