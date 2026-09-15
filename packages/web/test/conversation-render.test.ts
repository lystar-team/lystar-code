import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	appendLiveRenderItems,
	buildConversationRenderItems,
	buildPersistedRenderItems,
	initialTranscriptDisplayState,
} from "../src/components/workbench/conversation.tsx";
import { ThinkingBlock } from "../src/components/workbench/live-turn.tsx";
import { TranscriptMessageView } from "../src/components/workbench/transcript.tsx";

const thinking = { id: "thinking-1", kind: "thinking" as const, parts: ["先分析任务"], turnId: 1 };
const text = { id: "text-1", kind: "text" as const, parts: ["回复内容"], turnId: 1 };
const emptyToolIndex = {
	callIds: new Set<string>(),
	results: new Map(),
	statuses: new Map<string, "success" | "error">(),
};

describe("conversation render items", () => {
	it("首个历史页完成前不把实时片段当成完整会话展示", () => {
		expect(
			initialTranscriptDisplayState({
				transcriptPageLoaded: false,
				transcriptLoading: true,
				transcriptError: undefined,
			}),
		).toBe("loading");
		expect(
			initialTranscriptDisplayState({
				transcriptPageLoaded: false,
				transcriptLoading: false,
				transcriptError: "读取失败",
			}),
		).toBe("error");
		expect(
			initialTranscriptDisplayState({
				transcriptPageLoaded: true,
				transcriptLoading: true,
				transcriptError: undefined,
			}),
		).toBe("ready");
		expect(
			initialTranscriptDisplayState({
				transcriptPageLoaded: false,
				transcriptLoading: false,
				transcriptError: undefined,
			}),
		).toBe("ready");
	});

	it("保留后续文本或工具到达前已经产生的 Thinking 项", () => {
		const rendered = appendLiveRenderItems([], [thinking, text], {}, new Set(), undefined, 1);

		expect(rendered.map((item) => item.kind)).toEqual(["thinking", "message"]);
		expect(rendered[0]).toMatchObject({ kind: "thinking", key: "thinking-1", text: "先分析任务" });
	});

	it("忽略工具之间没有可见内容的实时文本和 Thinking 项", () => {
		const toolId = "live-tool-1";
		const rendered = appendLiveRenderItems(
			[],
			[
				{ id: "blank-text", kind: "text", parts: ["\n", "  "], turnId: 1 },
				{ id: "blank-thinking", kind: "thinking", parts: ["已完成检查\n"], turnId: 1 },
				{ id: "live-tools", kind: "tools", turnId: 1, batchId: "batch-1", toolIds: [toolId] },
			],
			{
				[toolId]: {
					id: toolId,
					name: "edit",
					batchId: "batch-1",
					summary: "正在编辑",
					state: "running",
					status: "running",
				},
			},
			new Set(),
			undefined,
			1,
		);

		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toMatchObject({ kind: "tool-stack", live: true });
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

		expect(rendered[0]).toMatchObject({
			kind: "message",
			text: "请查看截图",
			attachments: [attachment],
			editable: false,
		});
	});

	it("以通用附件卡片展示非图片附件", () => {
		const html = renderToStaticMarkup(
			createElement(TranscriptMessageView, {
				role: "user",
				text: "请阅读报告",
				attachments: [
					{
						id: "upload-2",
						filename: "报告.md",
						mediaType: "text/markdown",
						url: "data:text/markdown;base64,IyByZXBvcnQ=",
					},
				],
				showCopy: false,
				onOpenPath: async () => {},
			}),
		);

		expect(html).toContain("报告.md");
		expect(html).not.toContain("<img");
	});

	it("把历史投影的非图片文件转换为附件卡片", () => {
		const persisted = buildPersistedRenderItems(
			[
				{
					entryId: "user-file-1",
					parentId: null,
					timestamp: "2026-09-14T00:00:00.000Z",
					kind: "message",
					view: {
						type: "user",
						text: "",
						files: [{ filename: "报告.md", mimeType: "text/markdown" }],
					},
				},
			],
			emptyToolIndex,
		);
		const rendered = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, false);

		expect(rendered[0]).toMatchObject({
			kind: "message",
			text: "",
			attachments: [{ filename: "报告.md", mediaType: "text/markdown" }],
		});
	});

	it("只允许空闲状态下编辑已落盘的用户 Prompt", () => {
		const persisted = buildPersistedRenderItems(
			[
				{
					entryId: "user-1",
					parentId: null,
					timestamp: "2026-09-08T00:00:00.000Z",
					kind: "message",
					view: { type: "user", text: "检查登录流程" },
				},
			],
			emptyToolIndex,
		);
		const idle = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, false, true);
		const running = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, true, false);

		expect(idle[0]).toMatchObject({ kind: "message", entryId: "user-1", editable: true });
		expect(running[0]).toMatchObject({ kind: "message", entryId: "user-1", editable: false });
	});

	it("在用户 Prompt 操作区显示编辑入口", () => {
		const html = renderToStaticMarkup(
			createElement(TranscriptMessageView, {
				role: "user",
				text: "检查登录流程",
				showCopy: false,
				onOpenPath: async () => {},
				onEdit: () => {},
			}),
		);

		expect(html).toContain("编辑 Prompt");
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

	it("把 Skill 读取保留为独立工具卡片", () => {
		const ordinaryRead = {
			id: "read-before",
			name: "read",
			summary: JSON.stringify({ path: "src/app.ts" }),
		};
		const skillRead = {
			id: "skill-read",
			name: "read",
			summary: JSON.stringify({ path: "/home/yean/.agents/skills/demo/SKILL.md" }),
		};
		const trailingRead = {
			id: "read-after",
			name: "read",
			summary: JSON.stringify({ path: "src/other.ts" }),
		};
		const persisted = buildPersistedRenderItems(
			[
				{
					entryId: "assistant-process",
					parentId: null,
					timestamp: "2026-09-08T00:00:00.000Z",
					kind: "message",
					view: {
						type: "tool_call",
						calls: [ordinaryRead, skillRead, trailingRead],
					},
				},
			],
			emptyToolIndex,
		);
		const stacks = persisted.filter((entry) => entry.kind === "tool-stack");

		expect(stacks).toHaveLength(3);
		expect(stacks.every((stack) => stack.batches.flatMap((batch) => batch.tools).length === 1)).toBe(true);
		expect(stacks[1]?.batches[0]?.tools[0]?.summary).toBe(skillRead.summary);
	});
	it("只在最终结果确认后折叠整轮工作过程并插入分界线", () => {
		const tool = {
			summary: "pwd",
			state: "output-available" as const,
			detail: "/workspace",
		};
		const transcript = [
			{
				entryId: "user-1",
				parentId: null,
				timestamp: "2026-09-08T00:00:00.000Z",
				kind: "message",
				view: { type: "user" as const, text: "检查项目" },
			},
			{
				entryId: "assistant-process",
				parentId: "user-1",
				timestamp: "2026-09-08T00:00:01.000Z",
				kind: "message",
				view: { type: "assistant" as const, text: "我先检查文件。" },
			},
			{
				entryId: "assistant-process",
				parentId: "user-1",
				timestamp: "2026-09-08T00:00:01.000Z",
				kind: "message",
				view: { type: "tool_call" as const, calls: [{ id: tool.id, name: tool.name, summary: tool.summary }] },
			},
			{
				entryId: "tool-result",
				parentId: "assistant-process",
				timestamp: "2026-09-08T00:00:02.000Z",
				kind: "message",
				view: {
					type: "tool_result" as const,
					callId: tool.id,
					name: tool.name,
					summary: tool.summary,
					status: "success" as const,
					detail: tool.detail,
				},
			},
			{
				entryId: "assistant-final",
				parentId: "tool-result",
				timestamp: "2026-09-08T00:00:03.000Z",
				kind: "message",
				view: { type: "assistant" as const, text: "检查完成。" },
			},
		];
		const toolIndex = {
			callIds: new Set([tool.id]),
			results: new Map([[tool.id, tool]]),
			statuses: new Map([[tool.id, "success" as const]]),
		};
		const persisted = buildPersistedRenderItems(transcript, toolIndex);
		const active = buildConversationRenderItems(persisted, [], {}, toolIndex.callIds, undefined, 1, true);
		const completed = buildConversationRenderItems(persisted, [], {}, toolIndex.callIds, undefined, 1, false);

		expect(active.some((item) => item.kind === "result-boundary" || item.kind === "work-process")).toBe(false);
		expect(active.find((item) => item.kind === "tool-stack")).toMatchObject({ collapseForResult: false });
		expect(completed.map((item) => item.kind)).toEqual(["message", "work-process", "result-boundary", "message"]);
		const workProcess = completed.find((item) => item.kind === "work-process");
		if (!workProcess || workProcess.kind !== "work-process") throw new Error("缺少折叠的工作过程");
		expect(workProcess.items.map((item) => item.kind)).toEqual(["message", "tool-stack"]);
		expect(workProcess.items.find((item) => item.kind === "message")).toMatchObject({ text: "我先检查文件。" });
		expect(workProcess.items.find((item) => item.kind === "tool-stack")).toMatchObject({
			collapseForResult: true,
		});
	});

	it("显示转录中的模型请求错误而不是空行", () => {
		const errorText = "请求失败：503 service unavailable";
		const persisted = buildPersistedRenderItems(
			[
				{
					entryId: "error-entry",
					parentId: null,
					timestamp: "2026-09-08T00:00:00.000Z",
					kind: "message",
					view: { type: "system", text: errorText },
				},
			],
			emptyToolIndex,
		);
		const rendered = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, false);

		expect(rendered).toEqual([expect.objectContaining({ kind: "message", role: "system", text: errorText })]);
	});
});
