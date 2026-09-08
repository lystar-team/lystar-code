import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolBatch, toolRowTitle, type ToolBatchTool } from "../src/components/ai-elements/tool-batch.tsx";

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

	it("renders clickable sources with site favicons", () => {
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool] }));

		expect(markup).toContain("已搜索网页 uni-app Canvas touch event");
		expect(markup).toContain("uni-app Canvas 文档");
		expect(markup).toContain("MDN TouchEvent");
		expect(markup).toContain('href="https://uniapp.dcloud.net.cn/api/canvas"');
		expect(markup).toContain('target="_blank"');
		expect(markup).toContain("https://www.google.com/s2/favicons?domain=uniapp.dcloud.net.cn&amp;sz=32");
		expect(markup).toContain("lucide-search");
	});
});
