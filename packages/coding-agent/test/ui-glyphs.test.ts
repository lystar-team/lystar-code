import { describe, expect, it } from "vitest";
import { getUiGlyphs, toUiGlyph } from "../src/modes/interactive/ui-glyphs.ts";

describe("UI glyphs", () => {
	it("uses ASCII-safe built-in symbols in attached Windows terminals", () => {
		const glyphs = getUiGlyphs("win32");

		expect(glyphs).toEqual({
			prompt: ">",
			success: "+",
			failure: "x",
			tool: "*",
			expanded: "v",
			collapsed: ">",
			branch: ">",
			delta: "+/-",
			search: "?",
			list: "=",
			edit: "E",
			file: "F",
			write: "W",
			patch: "P",
			image: "I",
			running: ">",
			open: ">",
		});
		expect(Object.values(glyphs).every((glyph) => /^[\x20-\x7e]+$/.test(glyph))).toBe(true);
		expect(toUiGlyph("🔍", "win32")).toBe("?");
		expect(toUiGlyph("custom", "win32")).toBe("custom");
	});

	it("uses the shared rich glyph profile in the LYStar Windows host", () => {
		expect(getUiGlyphs("win32", { LYSTAR_TERMINAL_HOST: "1" })).toEqual(getUiGlyphs("linux"));
		expect(toUiGlyph("🔍", "win32", { LYSTAR_TERMINAL_HOST: "1" })).toBe("🔍");
	});

	it("keeps the existing compact symbols on Unix terminals", () => {
		expect(getUiGlyphs("linux")).toMatchObject({
			prompt: "❯",
			success: "🟢",
			expanded: "▼",
			file: "📁",
			write: "📝",
			edit: "✏️",
			patch: "📝",
		});
	});
});
