import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	appendLiveRenderItems,
	buildConversationRenderItems,
	buildPersistedRenderItems,
	formatElapsedDuration,
	initialTranscriptDisplayState,
	LiveElapsedHeader,
	toolActivityGap,
} from "../src/components/workbench/conversation.tsx";
import { HookActivityGroup } from "../src/components/workbench/hook-activity-group.tsx";
import { activeThinkingText, THINKING_SHIMMER_HEIGHT, ThinkingBlock } from "../src/components/workbench/live-turn.tsx";
import { TranscriptItemView, TranscriptMessageView } from "../src/components/workbench/transcript.tsx";
import {
	CONVERSATION_EDGE_PADDING,
	resolveTranscriptFirstItemIndex,
} from "../src/components/workbench/virtualized-transcript.tsx";
import type { WorkbenchState } from "../src/state/use-workbench";

const thinking = { id: "thinking-1", kind: "thinking" as const, parts: ["先分析任务"], turnId: 1 };
const text = { id: "text-1", kind: "text" as const, parts: ["回复内容"], turnId: 1 };
const emptyToolIndex = {
	callIds: new Set<string>(),
	results: new Map(),
	statuses: new Map<string, "success" | "error">(),
};

describe("conversation render items", () => {
	it("按秒、分钟、小时和天展示 Agent 耗时", () => {
		expect(formatElapsedDuration(0)).toBe("0秒");
		expect(formatElapsedDuration(15_000)).toBe("15秒");
		expect(formatElapsedDuration(59_999)).toBe("59秒");
		expect(formatElapsedDuration(90_000)).toBe("1分钟30秒");
		expect(formatElapsedDuration(12 * 60_000)).toBe("12分钟");
		expect(formatElapsedDuration(2 * 60 * 60_000 + 8 * 60_000)).toBe("2小时08分钟");
		expect(formatElapsedDuration(2 * 60 * 60_000 + 8 * 60_000 + 5_000)).toBe("2小时08分钟05秒");
		expect(formatElapsedDuration(1 * 24 * 60 * 60_000 + 3 * 60 * 60_000 + 20 * 60_000)).toBe("1天03小时20分钟");
	});

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

	it("将实时 Thinking 放入固定底部槽而不是新增虚拟列表行", () => {
		const rendered = appendLiveRenderItems([], [thinking, text], {}, new Set(), undefined, 1);

		expect(rendered.map((item) => item.kind)).toEqual(["message"]);
		expect(activeThinkingText([thinking])).toBe("先分析任务");
		expect(activeThinkingText([thinking, text])).toBe("");
		expect(CONVERSATION_EDGE_PADDING).toBeGreaterThanOrEqual(THINKING_SHIMMER_HEIGHT);
	});

	it("把调整方向 Prompt 固定在发送时的实时输出位置", () => {
		const rendered = appendLiveRenderItems(
			[],
			[
				{ id: "text-before", kind: "text", parts: ["先执行检查"], turnId: 1 },
				{
					id: "optimistic-user:queue-1",
					kind: "user",
					turnId: 1,
					queueId: "queue-1",
					text: "先修接口",
					displayText: "先修接口",
					attachments: [],
					status: "queued",
				},
				{ id: "text-after", kind: "text", parts: ["已切换方向"], turnId: 1 },
			],
			{},
			new Set(),
			undefined,
			1,
		);

		expect(rendered.filter((item) => item.kind === "message").map((item) => [item.role, item.text])).toEqual([
			["assistant", "先执行检查"],
			["user", "先修接口"],
			["assistant", "已切换方向"],
		]);
		expect(rendered[1]).toMatchObject({ statusLabel: "已发出 · 等待当前步骤结束" });
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

	it("只呈现最新一行 Shimmer Thinking 内容并始终保留固定高度", () => {
		const html = renderToStaticMarkup(
			createElement(ThinkingBlock, { text: "旧过程\n**Implementing LRU session caching helper**" }),
		);
		const emptyHtml = renderToStaticMarkup(createElement(ThinkingBlock, { text: "" }));

		expect(html).toContain("Implementing LRU session caching helper");
		expect(html).not.toContain("旧过程");
		expect(html).not.toContain("思考过程");
		expect(html).not.toContain("<button");
		expect(html).toContain(`height:${THINKING_SHIMMER_HEIGHT}px`);
		expect(emptyHtml).toContain(`height:${THINKING_SHIMMER_HEIGHT}px`);
	});

	it("在最终 Agent 回复下显示本次耗时", () => {
		const html = renderToStaticMarkup(
			createElement(TranscriptMessageView, {
				role: "assistant",
				text: "检查完成。",
				durationLabel: "2小时08分钟",
				showCopy: true,
				onOpenPath: async () => {},
			}),
		);

		expect(html).toContain("本次耗时：2小时08分钟");
	});

	it("扩展记录使用标准工具调用行并默认折叠详情", () => {
		const item: WorkbenchState["transcript"][number] = {
			entryId: "extension-entry",
			parentId: "user-entry",
			timestamp: "2026-09-24T00:00:00Z",
			kind: "custom",
			renderId: "extension-entry:extension_activity:0",
			view: {
				type: "extension_entry",
				customType: "context-preheat-metrics",
				details: '{\n  "version": 1,\n  "decision": "context"\n}',
			},
		};
		const html = renderToStaticMarkup(
			createElement(TranscriptItemView, {
				item,
				toolStatuses: new Map(),
				onOpenPath: async () => {},
				showCopy: false,
			}),
		);

		expect(html).toContain('data-testid="extension-entry-card"');
		expect(html).toContain("已调用 context-preheat-metrics");
		expect(html).toContain('data-state="closed"');
		expect(html).toContain("flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5");
		expect(html).not.toContain("扩展记录");
		expect(html).not.toContain("rounded-md border");
		expect(html).not.toContain('"decision"');
	});

	it("displays a Hook activity status without exposing its details by default", () => {
		const item: WorkbenchState["transcript"][number] = {
			entryId: "activity-entry",
			parentId: "user-entry",
			timestamp: "2026-09-24T00:00:00Z",
			kind: "custom",
			renderId: "activity-entry:extension_activity:0",
			view: {
				type: "extension_activity",
				activityId: "activity-1",
				extensionPath: "extensions/context-preheat/index.ts",
				hook: "before_agent_start",
				status: "completed",
				durationMs: 140,
				details: '[{ "customType": "context-preheat-metrics" }]',
			},
		};
		const html = renderToStaticMarkup(
			createElement(TranscriptItemView, {
				item,
				toolStatuses: new Map(),
				onOpenPath: async () => {},
				showCopy: false,
			}),
		);

		expect(html).toContain('data-testid="extension-activity-card"');
		expect(html).toContain("已调用 before_agent_start");
		expect(html).toContain("index.ts");
		expect(html).toContain("140 毫秒");
		expect(html).toContain('data-state="closed"');
		expect(html).toContain("min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5");
		expect(html).not.toContain("rounded-md border");
		expect(html).not.toContain("context-preheat-metrics");
	});

	it("各类相邻工具记录在会话和工作过程中共用紧凑间隔", () => {
		const timestamp = "2026-09-24T00:00:00Z";
		const transcript: WorkbenchState["transcript"] = [
			{ entryId: "user", parentId: null, timestamp, kind: "message", view: { type: "user", text: "检查项目" } },
			{
				entryId: "extension",
				parentId: "user",
				timestamp,
				kind: "custom",
				view: { type: "extension_entry", customType: "context-preheat-metrics" },
			},
			{
				entryId: "hook",
				parentId: "extension",
				timestamp,
				kind: "custom",
				view: {
					type: "extension_activity",
					activityId: "hook-1",
					extensionPath: "extensions/context-preheat/index.ts",
					hook: "before_agent_start",
					status: "completed",
				},
			},
			{
				entryId: "progress",
				parentId: "hook",
				timestamp,
				kind: "message",
				view: { type: "assistant", text: "开始检查。" },
			},
			{
				entryId: "commands",
				parentId: "progress",
				timestamp,
				kind: "message",
				view: { type: "tool_call", calls: [{ id: "bash-1", name: "bash", summary: "pwd" }] },
			},
			{
				entryId: "skill",
				parentId: "commands",
				timestamp,
				kind: "message",
				view: {
					type: "tool_call",
					calls: [{ id: "skill-1", name: "read", summary: "/home/yean/.agents/skills/demo/SKILL.md" }],
				},
			},
			{
				entryId: "image",
				parentId: "skill",
				timestamp,
				kind: "message",
				view: { type: "tool_call", calls: [{ id: "image-1", name: "image_gen", summary: "生成图片" }] },
			},
			{
				entryId: "custom-tool",
				parentId: "image",
				timestamp,
				kind: "message",
				view: { type: "tool_call", calls: [{ id: "custom-1", name: "custom_tool", summary: "执行" }] },
			},
			{
				entryId: "search",
				parentId: "custom-tool",
				timestamp,
				kind: "message",
				view: { type: "web_search", id: "search-1", status: "completed", query: "项目说明", sources: [] },
			},
			{ entryId: "legacy-bash", parentId: "search", timestamp, kind: "custom", view: { type: "bash", text: "pwd" } },
			{
				entryId: "final",
				parentId: "legacy-bash",
				timestamp,
				kind: "message",
				view: { type: "assistant", text: "检查完成。" },
			},
		];
		const persisted = buildPersistedRenderItems(transcript, emptyToolIndex);
		const active = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, true);
		const completed = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, false);
		const process = completed.find((entry) => entry.kind === "work-process");
		if (!process || process.kind !== "work-process") throw new Error("缺少工作过程");

		expect(process.items.map((entry) => entry.kind)).toEqual([
			"item",
			"message",
			"tool-stack",
			"tool-stack",
			"tool-stack",
			"tool-stack",
			"tool-stack",
			"item",
		]);
		expect(toolActivityGap(active[2]!, active[3]!)).toBe(12);
		expect(toolActivityGap(process.items[0]!, process.items[1]!)).toBe(12);
		expect(toolActivityGap(process.items[1]!, process.items[2]!)).toBe(12);
		for (let index = 3; index < process.items.length; index++) {
			expect(toolActivityGap(process.items[index - 1]!, process.items[index]!)).toBe(0);
		}
		expect(toolActivityGap(active[0]!, active[2]!)).toBe(12);
	});

	it("成功 Hook 不进入对话，失败 Hook 在所属回合显示一条提示", () => {
		const timestamp = "2026-09-24T00:00:00Z";
		const step = {
			id: "check-step",
			title: "检查项目",
			status: "completed" as const,
			toolCallIds: ["read-1"],
			messageEntryIds: [],
			startedAt: 1,
			endedAt: 2,
		};
		const hook = (id: string, status: "completed" | "failed"): WorkbenchState["transcript"][number] => ({
			entryId: id,
			renderId: id,
			parentId: "user-1",
			timestamp,
			kind: "custom",
			view: {
				type: "extension_activity",
				activityId: id,
				extensionPath: `extensions/${id}.ts`,
				hook: "tool_call",
				status,
				...(status === "failed" ? { error: "Hook 执行失败" } : {}),
			},
		});
		const transcript: WorkbenchState["transcript"] = [
			{
				entryId: "user-1",
				renderId: "user-1",
				parentId: null,
				timestamp,
				kind: "message",
				view: { type: "user", text: "检查项目" },
			},
			hook("hook-before", "completed"),
			{
				entryId: "step",
				renderId: "step",
				parentId: "hook-before",
				timestamp,
				kind: "custom",
				view: { type: "agent_step", step },
			},
			{
				entryId: "read",
				renderId: "read",
				parentId: "step",
				timestamp,
				kind: "message",
				view: { type: "tool_call", calls: [{ id: "read-1", name: "read", summary: "README.md", stepId: step.id }] },
			},
			hook("hook-middle", "completed"),
			{
				entryId: "final-1",
				renderId: "final-1",
				parentId: "hook-middle",
				timestamp,
				kind: "message",
				view: { type: "assistant", text: "检查完成。" },
			},
			hook("hook-after", "failed"),
			{
				entryId: "user-2",
				renderId: "user-2",
				parentId: "hook-after",
				timestamp,
				kind: "message",
				view: { type: "user", text: "继续。" },
			},
			hook("hook-next", "completed"),
			{
				entryId: "final-2",
				renderId: "final-2",
				parentId: "hook-next",
				timestamp,
				kind: "message",
				view: { type: "assistant", text: "继续完成。" },
			},
		];
		const persisted = buildPersistedRenderItems(transcript, emptyToolIndex, [], {}, { [step.id]: step });
		const completed = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, false);
		const processes = completed.filter((entry) => entry.kind === "work-process");
		expect(completed.map((entry) => entry.kind)).toEqual([
			"message",
			"work-process",
			"hook-group",
			"result-boundary",
			"message",
			"message",
			"message",
		]);
		expect(processes).toHaveLength(1);
		expect(processes[0]).toMatchObject({
			items: [{ kind: "agent-step", items: [{ kind: "tool-stack", stepId: step.id }] }],
		});
		const group = completed[2];
		if (group?.kind !== "hook-group") throw new Error("缺少 Hook 异常提示");
		expect(group.items.map((entry) => entry.item.entryId)).toEqual(["hook-after"]);
		const html = renderToStaticMarkup(createElement(HookActivityGroup, { entry: group }));
		expect(html).toContain("Hook 出错或中断 · 1 条");
		expect(html).toContain("Hook 执行失败");
		expect(html).not.toContain("hook-before.ts");
		expect(html).not.toContain("hook-after.ts");
		expect(html).not.toContain("<button");
	});

	it("运行和完成的 Hook 不显示，失败与中断时保留单条异常提示", () => {
		const timestamp = "2026-09-24T00:00:00Z";
		const user = {
			entryId: "user",
			renderId: "user",
			parentId: null,
			timestamp,
			kind: "message" as const,
			view: { type: "user" as const, text: "检查" },
		};
		const step = {
			id: "step",
			title: "读取文件",
			status: "running" as const,
			toolCallIds: [],
			messageEntryIds: [],
			startedAt: 1,
		};
		const activity = (status: "running" | "completed" | "failed" | "interrupted") => ({
			entryId: "hook",
			renderId: "hook",
			parentId: "step",
			timestamp,
			kind: "custom" as const,
			view: {
				type: "extension_activity" as const,
				activityId: "hook-1",
				extensionPath: "extensions/check.ts",
				hook: "tool_call",
				status,
			},
		});
		const render = (status: "running" | "completed" | "failed" | "interrupted") =>
			buildConversationRenderItems(
				buildPersistedRenderItems([user, activity(status)], emptyToolIndex, [], {}, { [step.id]: step }),
				[],
				{},
				new Set(),
				undefined,
				1,
				true,
				false,
				{ [step.id]: step },
			);
		const running = render("running");
		const completed = render("completed");
		const failed = render("failed");
		const interrupted = render("interrupted");
		expect(running.map((entry) => entry.kind)).toEqual(["message", "live-elapsed", "agent-step"]);
		expect(completed.map((entry) => entry.kind)).toEqual(["message", "live-elapsed", "agent-step"]);
		expect(failed.at(-1)).toMatchObject({
			kind: "hook-group",
			items: [{ item: { view: { status: "failed" } } }],
		});
		expect(interrupted.at(-1)).toMatchObject({
			kind: "hook-group",
			key: failed.at(-1)?.key,
			items: [{ item: { view: { status: "interrupted" } } }],
		});
	});

	it("大量成功 Hook 不生成对话分组，异常提示不展开内部明细", () => {
		const timestamp = "2026-09-24T00:00:00Z";
		const transcript: WorkbenchState["transcript"] = [
			{ entryId: "user", parentId: null, timestamp, kind: "message", view: { type: "user", text: "检查" } },
			...Array.from({ length: 816 }, (_, index) => ({
				entryId: `hook-${index}`,
				parentId: "user",
				timestamp,
				kind: "custom" as const,
				view: {
					type: "extension_activity" as const,
					activityId: `hook-${index}`,
					extensionPath: "extensions/internal.ts",
					hook: "tool_call",
					status: "completed" as const,
				},
			})),
			{ entryId: "final", parentId: "user", timestamp, kind: "message", view: { type: "assistant", text: "完成" } },
		];
		const persisted = buildPersistedRenderItems(transcript, emptyToolIndex);
		const rendered = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, false);
		expect(rendered.map((entry) => entry.kind)).toEqual(["message", "message"]);
		expect(rendered.some((entry) => entry.kind === "hook-group")).toBe(false);
	});

	it("处理中在用户消息下方显示实时已处理耗时行", () => {
		const persisted = buildPersistedRenderItems([], emptyToolIndex, [
			{ id: "prompt-1", text: "部署后端", attachments: [], sentAt: Date.now() - 24_000 },
		]);
		const rendered = buildConversationRenderItems(persisted, [text], {}, new Set(), undefined, 1, true);

		expect(rendered.map((item) => item.kind)).toEqual(["message", "live-elapsed", "message"]);
		expect(rendered[1]).toMatchObject({ kind: "live-elapsed", startedAt: expect.any(Number) });
	});

	it("实时耗时行从已落盘的用户消息时间起算", () => {
		const persisted = buildPersistedRenderItems(
			[
				{
					entryId: "user-1",
					parentId: null,
					timestamp: "2026-09-16T00:00:00.000Z",
					kind: "message",
					view: { type: "user", text: "部署后端" },
				},
			],
			emptyToolIndex,
		);
		const rendered = buildConversationRenderItems(persisted, [text], {}, new Set(), undefined, 1, true);

		expect(rendered[1]).toMatchObject({ kind: "live-elapsed", startedAt: Date.parse("2026-09-16T00:00:00.000Z") });
	});

	it("回合结束后用最终回复下方的本次耗时替换实时行", () => {
		const persisted = buildPersistedRenderItems(
			[
				{
					entryId: "user-1",
					parentId: null,
					timestamp: "2026-09-08T00:00:00.000Z",
					kind: "message",
					view: { type: "user", text: "部署后端" },
				},
				{
					entryId: "assistant-1",
					parentId: "user-1",
					timestamp: "2026-09-08T00:02:08.000Z",
					kind: "message",
					view: { type: "assistant", text: "部署完成。" },
				},
			],
			emptyToolIndex,
		);
		const rendered = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, false);

		expect(rendered.some((item) => item.kind === "live-elapsed")).toBe(false);
		expect(rendered.filter((item) => item.kind === "message" && item.durationLabel)).toMatchObject([
			{ role: "assistant", durationLabel: "2分钟08秒" },
		]);
	});

	it("已落盘回合的耗时从客户端按下发送时刻起算", () => {
		const transcript = [
			{
				entryId: "user-1",
				parentId: null,
				timestamp: "2026-09-16T00:00:00.000Z",
				kind: "message" as const,
				view: { type: "user" as const, text: "部署后端" },
			},
			{
				entryId: "assistant-1",
				parentId: "user-1",
				timestamp: "2026-09-16T00:02:08.000Z",
				kind: "message" as const,
				view: { type: "assistant" as const, text: "部署完成。" },
			},
		];
		const sentAt = Date.parse("2026-09-16T00:00:20.000Z");
		const labels = (items: ReturnType<typeof buildPersistedRenderItems>) =>
			buildConversationRenderItems(items, [], {}, new Set(), undefined, 1, false).flatMap((item) =>
				item.kind === "message" && item.durationLabel ? [item.durationLabel] : [],
			);

		expect(labels(buildPersistedRenderItems(transcript, emptyToolIndex))).toEqual(["2分钟08秒"]);
		expect(labels(buildPersistedRenderItems(transcript, emptyToolIndex, [], { "user-1": sentAt }))).toEqual([
			"1分钟48秒",
		]);
	});

	it("客户端看到的实时数值优先作为本次耗时", () => {
		const transcript = [
			{
				entryId: "user-1",
				parentId: null,
				timestamp: "2026-09-16T00:00:00.000Z",
				kind: "message" as const,
				view: { type: "user" as const, text: "部署后端" },
			},
			{
				entryId: "assistant-1",
				parentId: "user-1",
				timestamp: "2026-09-16T00:02:08.000Z",
				kind: "message" as const,
				view: { type: "assistant" as const, text: "部署完成。" },
			},
		];
		const sentAt = Date.parse("2026-09-16T00:00:20.000Z");
		const persisted = buildPersistedRenderItems(transcript, emptyToolIndex, [], { "user-1": sentAt });
		const rendered = buildConversationRenderItems(
			persisted,
			[],
			{},
			new Set(),
			undefined,
			1,
			false,
			false,
			{},
			(value) => (value === sentAt ? 17_000 : undefined),
		);

		expect(rendered.filter((item) => item.kind === "message" && item.durationLabel)).toMatchObject([
			{ role: "assistant", durationLabel: "17秒" },
		]);
	});

	it("实时耗时行下方跟随分割线", () => {
		const html = renderToStaticMarkup(createElement(LiveElapsedHeader, { startedAt: Date.now() - 24_000 }));

		expect(html).toContain("已处理");
		expect(html).toContain("秒");
		expect(html).toContain('data-testid="live-elapsed"');
		expect(html).toContain('role="separator"');
	});

	it("在乐观用户卡片下显示调整方向排队状态", () => {
		const html = renderToStaticMarkup(
			createElement(TranscriptMessageView, {
				role: "user",
				text: "先修接口",
				statusLabel: "已发出 · 等待当前步骤结束",
				showCopy: false,
				onRemove: () => {},
				onOpenPath: async () => {},
			}),
		);

		expect(html).toContain("已发出 · 等待当前步骤结束");
		expect(html).toContain('data-testid="user-delivery-status"');
		expect(html).toContain("删除排队消息");
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
	it("按真实顺序把全部已关联执行活动和中途插话收进动态步骤", () => {
		const step = {
			id: "step-1",
			title: "读取项目说明",
			status: "completed" as const,
			toolCallIds: ["read-1", "orphan-1"],
			messageEntryIds: ["assistant-step-update", "user-steer", "assistant-step-error"],
			startedAt: Date.parse("2026-09-16T00:00:00.500Z"),
			endedAt: Date.parse("2026-09-16T00:00:04.500Z"),
		};
		const transcript = [
			{
				entryId: "user-step",
				parentId: null,
				timestamp: "2026-09-16T00:00:00.000Z",
				kind: "message",
				view: { type: "user" as const, text: "检查项目" },
			},
			{
				entryId: "assistant-step-tools",
				parentId: "user-step",
				timestamp: "2026-09-16T00:00:01.000Z",
				kind: "message",
				view: {
					type: "tool_call" as const,
					calls: [{ id: "read-1", name: "read", summary: "README.md" }],
				},
			},
			{
				entryId: "step-entry",
				parentId: "assistant-step-tools",
				timestamp: "2026-09-16T00:00:02.000Z",
				kind: "custom",
				view: { type: "agent_step" as const, step },
			},
			{
				entryId: "read-result",
				parentId: "step-entry",
				timestamp: "2026-09-16T00:00:03.000Z",
				kind: "message",
				view: {
					type: "tool_result" as const,
					callId: "read-1",
					name: "read",
					stepId: step.id,
					status: "success" as const,
					summary: "README.md",
					detail: "说明内容",
				},
			},
			{
				entryId: "compaction-step",
				renderId: "compaction-step",
				parentId: "read-result",
				timestamp: "2026-09-16T00:00:03.500Z",
				kind: "compaction",
				view: {
					type: "summary" as const,
					variant: "compaction" as const,
					title: "上下文压缩",
					text: "保留当前检查目标与已读取结果。",
					tokensBefore: 12_000,
				},
			},
			{
				entryId: "assistant-step-update",
				renderId: "web-search-step",
				parentId: "compaction-step",
				timestamp: "2026-09-16T00:00:03.750Z",
				kind: "message",
				view: {
					type: "web_search" as const,
					id: "web-search-1",
					status: "completed" as const,
					query: "项目配置说明",
					sources: [],
				},
			},
			{
				entryId: "assistant-step-update",
				renderId: "assistant-step-update",
				parentId: "compaction-step",
				timestamp: "2026-09-16T00:00:04.000Z",
				kind: "message",
				view: { type: "assistant" as const, text: "项目边界已确认，继续检查配置。" },
			},
			{
				entryId: "user-steer",
				renderId: "user-steer",
				parentId: "assistant-step-update",
				timestamp: "2026-09-16T00:00:04.100Z",
				kind: "message",
				view: { type: "user" as const, text: "先确认网页搜索结果。" },
			},
			{
				entryId: "orphan-result",
				renderId: "orphan-result",
				parentId: "user-steer",
				timestamp: "2026-09-16T00:00:04.200Z",
				kind: "message",
				view: {
					type: "tool_result" as const,
					callId: "orphan-1",
					name: "write",
					stepId: step.id,
					status: "success" as const,
					summary: "/tmp/result.txt",
					detail: "写入完成",
				},
			},
			{
				entryId: "assistant-step-error",
				renderId: "assistant-step-error",
				parentId: "orphan-result",
				timestamp: "2026-09-16T00:00:04.300Z",
				kind: "message",
				view: { type: "system" as const, text: "一次读取失败，继续使用已有结果。" },
			},
			{
				entryId: "assistant-step-final",
				parentId: "assistant-step-error",
				timestamp: "2026-09-16T00:00:05.000Z",
				kind: "message",
				view: { type: "assistant" as const, text: "检查完成。" },
			},
		];
		const toolIndex = {
			callIds: new Set(["read-1"]),
			results: new Map([
				[
					"read-1",
					{
						id: "read-1",
						name: "read",
						summary: "README.md",
						state: "output-available" as const,
						detail: "说明内容",
					},
				],
			]),
			statuses: new Map([["read-1", "success" as const]]),
		};

		const persisted = buildPersistedRenderItems(transcript, toolIndex);
		const completed = buildConversationRenderItems(persisted, [], {}, toolIndex.callIds, undefined, 1, false);
		const workProcess = completed.find((item) => item.kind === "work-process");
		if (!workProcess || workProcess.kind !== "work-process") throw new Error("缺少折叠的工作过程");
		const stepItem = workProcess.items.find((item) => item.kind === "agent-step");

		expect(stepItem).toMatchObject({
			kind: "agent-step",
			step: { id: step.id, title: "读取项目说明", status: "completed" },
			items: [
				{ kind: "tool-stack", stepId: step.id },
				{
					kind: "tool-stack",
					stepId: step.id,
					batches: [
						{
							entryId: "assistant-step-update",
							tools: [{ id: "web-search-1", name: "web_search", summary: "项目配置说明" }],
						},
					],
				},
				{ kind: "message", entryId: "assistant-step-update", text: "项目边界已确认，继续检查配置。" },
				{ kind: "message", role: "user", entryId: "user-steer", text: "先确认网页搜索结果。" },
				{
					kind: "tool-stack",
					stepId: step.id,
					batches: [{ tools: [{ id: "orphan-1", name: "write", summary: "/tmp/result.txt" }] }],
				},
				{
					kind: "message",
					role: "system",
					entryId: "assistant-step-error",
					text: "一次读取失败，继续使用已有结果。",
				},
			],
		});
		expect(workProcess.items).toContainEqual(
			expect.objectContaining({
				kind: "compaction",
				entryId: "compaction-step",
				text: "保留当前检查目标与已读取结果。",
			}),
		);
		expect(completed.map((item) => item.kind)).toEqual(["message", "work-process", "result-boundary", "message"]);
		expect(completed.some((item) => item.kind === "result-boundary")).toBe(true);
	});

	it("Task 条目不在当前分页时仍按步骤索引归组工具", () => {
		const step = {
			id: "step-page",
			title: "读取跨页文件",
			status: "completed" as const,
			toolCallIds: ["read-page"],
			messageEntryIds: [],
			startedAt: 1,
			endedAt: 2,
		};
		const persisted = buildPersistedRenderItems(
			[
				{
					entryId: "assistant-page",
					parentId: "older-step-entry",
					timestamp: "2026-09-20T00:00:00.000Z",
					kind: "message",
					view: {
						type: "tool_call" as const,
						calls: [{ id: "read-page", name: "read", summary: "README.md", stepId: step.id }],
					},
				},
			],
			emptyToolIndex,
			[],
			{},
			{ [step.id]: step },
		);

		expect(persisted).toMatchObject([
			{
				kind: "agent-step",
				step: { id: step.id, status: "completed" },
				items: [{ kind: "tool-stack", stepId: step.id }],
			},
		]);
	});

	it("缺少明确 stepId 的实时活动保持在会话时间线顶层", () => {
		const step = {
			id: "step-live",
			title: "检查实时状态",
			status: "running" as const,
			toolCallIds: [],
			messageEntryIds: [],
			startedAt: 1,
		};
		const rendered = appendLiveRenderItems(
			[],
			[
				{ id: "live-step-text", kind: "text", parts: ["正在核对运行状态。"], turnId: 1, stepId: step.id },
				{ id: "live-write", kind: "tools", turnId: 1, batchId: "write-batch", toolIds: ["write-1"] },
				{
					id: "optimistic-user:queue-1",
					kind: "user",
					turnId: 1,
					queueId: "queue-1",
					text: "Thinking 保持外部",
					displayText: "Thinking 保持外部",
					attachments: [],
					status: "processing",
				},
				{ id: "live-read", kind: "tools", turnId: 1, batchId: "read-batch", toolIds: ["read-2"] },
				{ id: "live-compaction:1", kind: "compaction", turnId: 1 },
			],
			{
				"write-1": {
					id: "write-1",
					name: "write",
					batchId: "write-batch",
					summary: "/tmp/analyze.ts",
					state: "running",
					status: "running",
				},
				"read-2": {
					id: "read-2",
					name: "read",
					batchId: "read-batch",
					summary: "分析结果",
					state: "running",
					status: "running",
				},
			},
			new Set(),
			{ status: "running", reason: "threshold", summaryCountAtStart: 0 },
			1,
			{ [step.id]: step },
		);

		expect(rendered).toMatchObject([
			{
				kind: "agent-step",
				step: { id: step.id },
				items: [{ kind: "message", key: "live-step-text", text: "正在核对运行状态。", live: true }],
			},
			{ kind: "tool-stack", stepId: undefined, batches: [{ tools: [{ id: "write-1", stepId: undefined }] }] },
			{ kind: "message", key: "optimistic-user:queue-1", role: "user", text: "Thinking 保持外部" },
			{ kind: "tool-stack", stepId: undefined, batches: [{ tools: [{ id: "read-2", stepId: undefined }] }] },
			{ kind: "compaction", key: "live-compaction:1", live: true, state: { status: "running" } },
		]);
	});

	it("按实时事件顺序把上下文压缩插入正在执行的 Agent Step", () => {
		const step = {
			id: "step-compaction",
			title: "整理上下文",
			status: "running" as const,
			toolCallIds: [],
			messageEntryIds: [],
			startedAt: 1,
		};
		const rendered = appendLiveRenderItems(
			[],
			[
				{ id: "before", kind: "text", parts: ["压缩前"], turnId: 1, stepId: step.id },
				{ id: "live-compaction:1", kind: "compaction", turnId: 1, stepId: step.id },
				{ id: "after", kind: "text", parts: ["压缩后"], turnId: 1, stepId: step.id },
			],
			{},
			new Set(),
			{ status: "running", reason: "threshold", summaryCountAtStart: 0 },
			1,
			{ [step.id]: step },
		);

		expect(rendered).toMatchObject([
			{
				kind: "agent-step",
				items: [
					{ kind: "message", key: "before", text: "压缩前" },
					{ kind: "compaction", key: "live-compaction:1" },
					{ kind: "message", key: "after", text: "压缩后" },
				],
			},
		]);
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
		expect(completed.at(-1)).toMatchObject({ durationLabel: "3秒" });
		const workProcess = completed.find((item) => item.kind === "work-process");
		if (!workProcess || workProcess.kind !== "work-process") throw new Error("缺少折叠的工作过程");
		expect(workProcess.items.map((item) => item.kind)).toEqual(["message", "tool-stack"]);
		expect(workProcess.items.find((item) => item.kind === "message")).toMatchObject({ text: "我先检查文件。" });
		expect(workProcess.items.find((item) => item.kind === "tool-stack")).toMatchObject({
			collapseForResult: true,
		});
	});

	it("分页补齐首轮用户消息时保留已有首项 key 和视口锚点", () => {
		const tool: ToolBatchTool = {
			id: "boundary-read",
			name: "read",
			summary: "README.md",
			state: "output-available",
			detail: "项目说明",
		};
		const leadingTurn = [
			{
				entryId: "boundary-tool",
				renderId: "boundary-tool",
				parentId: "boundary-user",
				timestamp: "2026-09-17T00:00:01.000Z",
				kind: "message",
				view: { type: "tool_call" as const, calls: [{ id: tool.id, name: tool.name, summary: tool.summary }] },
			},
			{
				entryId: "boundary-result",
				renderId: "boundary-result",
				parentId: "boundary-tool",
				timestamp: "2026-09-17T00:00:02.000Z",
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
				entryId: "boundary-final",
				renderId: "boundary-final",
				parentId: "boundary-result",
				timestamp: "2026-09-17T00:00:03.000Z",
				kind: "message",
				view: { type: "assistant" as const, text: "第一轮完成。" },
			},
			{
				entryId: "next-user",
				renderId: "next-user",
				parentId: "boundary-final",
				timestamp: "2026-09-17T00:00:04.000Z",
				kind: "message",
				view: { type: "user" as const, text: "继续。" },
			},
			{
				entryId: "next-final",
				renderId: "next-final",
				parentId: "next-user",
				timestamp: "2026-09-17T00:00:05.000Z",
				kind: "message",
				view: { type: "assistant" as const, text: "第二轮完成。" },
			},
		];
		const boundaryUser = {
			entryId: "boundary-user",
			renderId: "boundary-user",
			parentId: null,
			timestamp: "2026-09-17T00:00:00.000Z",
			kind: "message",
			view: { type: "user" as const, text: "检查项目。" },
		};
		const toolIndex = {
			callIds: new Set([tool.id]),
			results: new Map([[tool.id, tool]]),
			statuses: new Map([[tool.id, "success" as const]]),
		};
		const render = (transcript: typeof leadingTurn) =>
			buildConversationRenderItems(
				buildPersistedRenderItems(transcript, toolIndex),
				[],
				{},
				toolIndex.callIds,
				undefined,
				1,
				false,
			);
		const tailPage = render(leadingTurn);
		const prependedPage = render([boundaryUser, ...leadingTurn]);
		const previousFirstKey = tailPage[0]?.key;
		if (!previousFirstKey) throw new Error("缺少分页前首项");

		expect(previousFirstKey).toBe("work-process:boundary-final:0");
		expect(prependedPage.findIndex((item) => item.key === previousFirstKey)).toBe(1);
		expect(
			resolveTranscriptFirstItemIndex(
				{ sessionKey: "session-1", firstItemIndex: 1_000, firstKey: previousFirstKey },
				prependedPage.map((item) => item.key),
			),
		).toBe(999);
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
