import { describe, expect, it } from "vitest";
import { buildConversationListModel } from "../src/components/workbench/conversation-list-model.ts";
import type { AgentStepRenderItem, MessageRenderItem } from "../src/components/workbench/conversation-render-model.ts";
import { ConversationScrollCache } from "../src/components/workbench/conversation-scroll-cache.ts";

const message: MessageRenderItem = { kind: "message", key: "answer", live: false, role: "assistant", text: "正文", attachments: [], sources: [], copyVisible: false, editable: false };
const step: AgentStepRenderItem = { kind: "agent-step", key: "step", live: false,
	step: { id: "step", title: "读取说明", status: "running", startedAt: 0, toolCallIds: [], messageEntryIds: [] }, items: [message] };
const options: Parameters<typeof buildConversationListModel>[1] = {
	expandedAgentSteps: new Map(), expandedWorkProcesses: new Map(), expandedThinking: new Map(), expandedToolBatches: new Map(), retainedGroups: new Set(),
	toolActivityPresentation: () => ({ repeatedFileReads: false }), toolPresentation: () => "group", gap: () => 12,
};

describe("conversation visible rows", () => {
	it("展开步骤的正文分别测量，收起后移除，动画期间保留", () => {
		const open = buildConversationListModel([step], options);
		expect(open.rows.map((row) => row.key)).toEqual(["step", "step:padding", "answer"]);
		expect(open.rows[2]).toMatchObject({ kind: "content", stepChild: true });
		const closed = { ...options, expandedAgentSteps: new Map([["step", false]]) };
		expect(buildConversationListModel([step], closed).rows.map((row) => row.key)).toEqual(["step"]);
		const retained = buildConversationListModel([step], { ...closed, retainedGroups: new Set(["step"]) });
		expect(retained.nodes[0]?.open).toBe(false);
		expect(retained.rows.map((row) => row.key)).toEqual(open.rows.map((row) => row.key));
	});

	it("工作过程与内部步骤分别使用各自的展开选择", () => {
		const items = [{ kind: "work-process" as const, key: "process", items: [step] }];
		expect(buildConversationListModel(items, options).rows.map((row) => row.key)).toEqual(["process"]);
		const open = buildConversationListModel(items, { ...options, expandedWorkProcesses: new Map([["process", true]]) });
		expect(open.rows.map((row) => row.key)).toEqual(["process", "process:padding", "step", "step:padding", "answer"]);
		expect(open.nodes[0]?.end).toBe(open.rows.length - 1);
	});

	it("展开 Thinking 会打开其所属的完成步骤与工作过程", () => {
		const completed: AgentStepRenderItem = { ...step, step: { ...step.step, status: "completed" },
			items: [{ kind: "thinking", key: "thinking", live: false, streaming: false, text: "检查说明" }] };
		const items = [{ kind: "work-process" as const, key: "process", items: [completed] }];
		const open = buildConversationListModel(items, { ...options, expandedThinking: new Map([["thinking", true]]) });
		expect(open.rows.at(-1)?.key).toBe("thinking");
		expect(open.nodes[0]?.open).toBe(true);
	});
});

describe("conversation position cache", () => {
	it("会话历史代次分别保存，更新后只淘汰最早保存的会话", () => {
		const cache = new ConversationScrollCache(2);
		const snapshot = { atBottom: false, offset: 30, measurements: [], anchor: { key: "answer", offset: -4 } };
		cache.set("session:generation-1", snapshot);
		cache.set("other:generation-1", snapshot);
		cache.set("session:generation-1", { ...snapshot, offset: 50 });
		cache.set("session:generation-2", { ...snapshot, atBottom: true });
		expect(cache.get("other:generation-1")).toBeUndefined();
		expect(cache.get("session:generation-1")?.offset).toBe(50);
		expect(cache.get("session:generation-2")?.atBottom).toBe(true);
	});
});
