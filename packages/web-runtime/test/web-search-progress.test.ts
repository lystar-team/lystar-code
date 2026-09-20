import { describe, expect, it } from "vitest";
import {
	mergeWebSearchProgress,
	webSearchProgressFromCall,
	webSearchProgressSummary,
} from "../src/web-search-progress.ts";

describe("web search progress", () => {
	it("normalizes the query and keeps valid unique sources", () => {
		expect(
			webSearchProgressFromCall({
				status: "completed",
				action: {
					type: "search",
					queries: ["", "  uni-app Canvas touch event  "],
					sources: [
						{ url: "https://example.com/a", title: "Example" },
						{ url: "https://example.com/a", title: "Example updated" },
						{ url: "javascript:alert(1)", title: "Invalid" },
					],
				},
			}),
		).toEqual({
			status: "completed",
			action: "search",
			query: "uni-app Canvas touch event",
			sources: [{ url: "https://example.com/a", title: "Example updated" }],
		});
	});

	it("shows the opened page and adds it as a source when no source list is returned", () => {
		const progress = webSearchProgressFromCall({
			status: "in_progress",
			action: { type: "open_page", url: "https://example.com/docs" },
		});

		expect(progress).toEqual({
			status: "in_progress",
			action: "open_page",
			url: "https://example.com/docs",
			sources: [{ url: "https://example.com/docs" }],
		});
		expect(webSearchProgressSummary(progress)).toBe("打开 https://example.com/docs");
	});

	it("merges source updates without losing the original query", () => {
		expect(
			mergeWebSearchProgress(
				{
					status: "searching",
					action: "search",
					query: "uni-app Canvas",
					sources: [],
				},
				{
					status: "completed",
					action: "search",
					sources: [{ url: "https://example.com/docs", title: "Docs" }],
				},
			),
		).toEqual({
			status: "completed",
			action: "search",
			query: "uni-app Canvas",
			sources: [{ url: "https://example.com/docs", title: "Docs" }],
		});
	});

	it("keeps the in-page search pattern separate from the page URL", () => {
		const progress = webSearchProgressFromCall({
			status: "completed",
			action: { type: "find_in_page", url: "https://example.com/docs", pattern: "Canvas touch" },
		});

		expect(progress).toEqual({
			status: "completed",
			action: "find_in_page",
			pattern: "Canvas touch",
			url: "https://example.com/docs",
			sources: [{ url: "https://example.com/docs" }],
		});
		expect(webSearchProgressSummary(progress)).toBe("查找 Canvas touch");
	});
});
