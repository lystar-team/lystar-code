import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { appendLiveRenderItems, buildConversationRenderItems } from "../src/components/workbench/conversation.tsx";
import { ThinkingBlock } from "../src/components/workbench/live-turn.tsx";

const thinking = { id: "thinking-1", kind: "thinking" as const, parts: ["先分析任务"], turnId: 1 };
const text = { id: "text-1", kind: "text" as const, parts: ["回复内容"], turnId: 1 };

describe("conversation render items", () => {
	it("保留后续文本或工具到达前已经产生的 Thinking 项", () => {
		const rendered = appendLiveRenderItems([], [thinking, text], {}, new Set(), undefined, 1);

		expect(rendered.map((item) => item.kind)).toEqual(["thinking", "message"]);
		expect(rendered[0]).toMatchObject({ kind: "thinking", key: "thinking-1", text: "先分析任务" });
	});

	it("只呈现最新一行 Shimmer Thinking 内容", () => {
		const html = renderToStaticMarkup(
			createElement(ThinkingBlock, { text: "旧过程\n**Implementing LRU session caching helper**" }),
		);

		expect(html).toContain("Implementing LRU session caching helper");
		expect(html).not.toContain("旧过程");
		expect(html).not.toContain("思考过程");
		expect(html).not.toContain("<button");
	});

	it("把实时渲染结果合并进最终会话列表", () => {
		const rendered = buildConversationRenderItems([], [], [thinking, text], {}, new Set(), undefined, 1, true);

		expect(rendered.map((item) => item.kind)).toEqual(["thinking", "message"]);
	});
});
