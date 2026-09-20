import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolBatch, toolRowTitle, type ToolBatchTool } from "../src/components/ai-elements/tool-batch.tsx";
import { mergeWebSearchSummary } from "../src/state/tool-batching.ts";

describe("Web search tool card", () => {
	const tool: ToolBatchTool = {
		id: "ws-1",
		name: "web_search",
		summary: "uni-app Canvas touch event",
		state: "output-available",
		sources: [
			{ title: "uni-app Canvas 文档", url: "https://uniapp.dcloud.net.cn/api/canvas" },
			{ title: "MDN TouchEvent", url: "https://developer.mozilla.org/en-US/docs/Web/API/TouchEvent" },
		],
	};

	it("uses the search-specific tool label", () => {
		expect(toolRowTitle(tool)).toBe("已搜索网页 uni-app Canvas touch event");
		expect(toolRowTitle({ ...tool, summary: "网页搜索" })).toBe("已搜索网页");
	});

	it("hides legacy webSearchCall JSON in the tool title", () => {
		const summary = JSON.stringify({
			type: "webSearchCall",
			status: "completed",
			action: { type: "search", query: "uni-app H5 Canvas touch event" },
		});

		expect(toolRowTitle({ ...tool, summary })).toBe("已搜索网页 uni-app H5 Canvas touch event");
	});

	it("keeps the final query when the search starts with a generic summary", () => {
		expect(mergeWebSearchSummary("网页搜索", "uni-app Canvas touch event")).toBe("uni-app Canvas touch event");
		expect(mergeWebSearchSummary("uni-app Canvas touch event", "网页搜索")).toBe("uni-app Canvas touch event");
	});

	it("keeps a search row expandable before sources return", () => {
		const markup = renderToStaticMarkup(
			createElement(ToolBatch, {
				tools: [{ ...tool, state: "input-available", sources: undefined, inputPreview: true }],
			}),
		);

		expect(markup).toContain("正在搜索网页 uni-app Canvas touch event");
		expect(markup).toContain("展开详情");
	});

	it("explains missing search data instead of disabling the row", () => {
		const markup = renderToStaticMarkup(
			createElement(ToolBatch, {
				initialOpen: true,
				tools: [{ ...tool, summary: "网页搜索", state: "output-available", sources: undefined }],
			}),
		);

		expect(markup).toContain("已搜索网页");
		expect(markup).toContain("本次搜索未返回搜索词");
		expect(markup).toContain("本次搜索未返回网页来源");
	});

	it("renders clickable sources with site favicons", () => {
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool] }));

		expect(markup).toContain("已搜索网页 uni-app Canvas touch event");
		expect(markup).toContain("uni-app Canvas 文档");
		expect(markup).toContain("MDN TouchEvent");
		expect(markup.match(/来源 · 2/gu)).toHaveLength(1);
		expect(markup.indexOf("来源 · 2")).toBeGreaterThan(markup.indexOf("已搜索网页 uni-app Canvas touch event"));
		expect(markup).toContain('href="https://uniapp.dcloud.net.cn/api/canvas"');
		expect(markup).toContain('target="_blank"');
		expect(markup).toContain("https://www.google.com/s2/favicons?domain=uniapp.dcloud.net.cn&amp;sz=32");
		expect(markup).toContain("lucide-search");
	});
});
