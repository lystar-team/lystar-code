import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	appendLiveRenderItems,
	buildConversationRenderItems,
	buildPersistedRenderItems,
} from "../src/components/workbench/conversation.tsx";
import { ThinkingBlock } from "../src/components/workbench/live-turn.tsx";

const thinking = { id: "thinking-1", kind: "thinking" as const, parts: ["先分析任务"], turnId: 1 };
const text = { id: "text-1", kind: "text" as const, parts: ["回复内容"], turnId: 1 };
const emptyToolIndex = {
	callIds: new Set<string>(),
	results: new Map(),
	statuses: new Map<string, "success" | "error">(),
};

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

	it("保留乐观用户消息的图片附件", () => {
		const attachment = {
			id: "upload-1",
			filename: "截图.png",
			mediaType: "image/png",
			url: "data:image/png;base64,AAAA",
		};
		const persisted = buildPersistedRenderItems([], emptyToolIndex, [
			{ id: "prompt-1", text: "请查看截图", attachments: [attachment] },
		]);
		const rendered = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, true);

		expect(rendered[0]).toMatchObject({ kind: "message", text: "请查看截图", attachments: [attachment] });
	});

	it("把乐观 Prompt 放在已提交输出之前", () => {
		const persisted = buildPersistedRenderItems(
			[
				{
					entryId: "before",
					parentId: null,
					timestamp: "2026-09-08T00:00:00.000Z",
					kind: "message",
					view: { type: "assistant", text: "之前的回复" },
				},
				{
					entryId: "after",
					parentId: "before",
					timestamp: "2026-09-08T00:00:01.000Z",
					kind: "message",
					view: { type: "assistant", text: "本轮输出" },
				},
			],
			emptyToolIndex,
			[{ id: "prompt-1", text: "首条 Prompt", attachments: [], afterEntryId: "before" }],
		);
		const rendered = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, true);

		expect(rendered.filter((item) => item.kind === "message").map((item) => item.text)).toEqual([
			"之前的回复",
			"首条 Prompt",
			"本轮输出",
		]);
	});

	it("把实时渲染结果合并进最终会话列表", () => {
		const rendered = buildConversationRenderItems([], [thinking, text], {}, new Set(), undefined, 1, true);

		expect(rendered.map((item) => item.kind)).toEqual(["thinking", "message"]);
	});
});
