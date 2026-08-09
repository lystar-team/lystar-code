import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML web search rendering", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	it("renders structured web search calls and citations", () => {
		expect(templateJs).toContain("renderWebSearchCall(block)");
		expect(templateJs).toContain("renderCitations(block)");
		expect(templateJs).toContain("搜索记录");
		expect(templateJs).toContain("引用");
	});

	it("sanitizes and escapes provider URLs and titles", () => {
		expect(templateJs).toContain("sanitizeMarkdownUrl(link.url)");
		expect(templateJs).toContain('href="$' + '{escapeHtml(url)}"');
		expect(templateJs).toContain("$" + "{escapeHtml(title)}</a>");
	});
});
