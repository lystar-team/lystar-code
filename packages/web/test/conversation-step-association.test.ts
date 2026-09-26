import { describe, expect, it } from "vitest";
import {
	appendLiveRenderItems,
	buildPersistedRenderItems,
} from "../src/components/workbench/conversation-render-model.ts";
import type { WorkbenchState } from "../src/state/use-workbench.ts";

const toolIndex = { callIds: new Set<string>(), results: new Map(), statuses: new Map() };
const timestamp = "2026-09-25T15:50:46.770Z";

describe("conversation step association", () => {
	it("keeps an edit inside its step when the assistant message is linked but the tool call never started", () => {
		const step = {
			id: "edit-step",
			title: "修改页面",
			status: "completed" as const,
			toolCallIds: [],
			messageEntryIds: ["edit-message"],
			startedAt: 1,
			endedAt: 2,
		};
		const transcript: WorkbenchState["transcript"] = [
			{
				entryId: "step-entry",
				renderId: "step-entry",
				parentId: null,
				timestamp,
				kind: "custom",
				view: { type: "agent_step", step },
			},
			{
				entryId: "edit-message",
				renderId: "edit-message",
				parentId: "step-entry",
				timestamp,
				kind: "message",
				view: { type: "tool_call", calls: [{ id: "edit-1", name: "edit", summary: "conversation.tsx" }] },
			},
			{
				entryId: "unlinked-message",
				renderId: "unlinked-message",
				parentId: "edit-message",
				timestamp,
				kind: "message",
				view: { type: "tool_call", calls: [{ id: "read-1", name: "read", summary: "README.md" }] },
			},
		];

		const rendered = buildPersistedRenderItems(transcript, toolIndex);
		expect(rendered).toMatchObject([
			{
				kind: "agent-step",
				step: { id: step.id },
				items: [
					{
						kind: "tool-stack",
						stepId: step.id,
						batches: [{ entryId: "edit-message", tools: [{ id: "edit-1" }] }],
					},
				],
			},
			{
				kind: "tool-stack",
				stepId: undefined,
				batches: [{ entryId: "unlinked-message", tools: [{ id: "read-1" }] }],
			},
		]);
	});

	it("在实时工具转为 Transcript 工具时保留当前步骤归属和卡片身份", () => {
		const step = {
			id: "edit-step",
			title: "修改页面",
			status: "running" as const,
			toolCallIds: [],
			messageEntryIds: [],
			startedAt: 1,
		};
		const liveTools: WorkbenchState["liveTools"] = {
			"edit-1": {
				id: "edit-1",
				name: "edit",
				batchId: "edit-batch",
				summary: "conversation.tsx",
				state: "running",
				status: "running",
				stepId: step.id,
			},
		};
		const liveItems: WorkbenchState["liveTurnItems"] = [
			{ id: "live-edit", kind: "tools", turnId: 1, batchId: "edit-batch", toolIds: ["edit-1"] },
		];
		const live = appendLiveRenderItems([], liveItems, liveTools, new Set(), undefined, 1, { [step.id]: step });
		const transcript: WorkbenchState["transcript"] = [
			{
				entryId: "edit-message",
				renderId: "live-edit",
				parentId: null,
				timestamp,
				kind: "message",
				view: { type: "tool_call", calls: [{ id: "edit-1", name: "edit", summary: "conversation.tsx" }] },
			},
		];
		const committedIds = new Set(["edit-1"]);
		const committed = appendLiveRenderItems(
			buildPersistedRenderItems(
				transcript,
				{ ...toolIndex, callIds: committedIds },
				[],
				{},
				{},
				{ [step.id]: step },
				liveTools,
			),
			liveItems,
			liveTools,
			committedIds,
			undefined,
			1,
			{ [step.id]: step },
		);
		const completed = buildPersistedRenderItems(
			transcript,
			{ ...toolIndex, callIds: committedIds },
			[],
			{},
			{ [step.id]: { ...step, status: "completed", toolCallIds: ["edit-1"], endedAt: 2 } },
		);

		for (const items of [live, committed, completed]) {
			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({
				kind: "agent-step",
				key: `agent-step:${step.id}`,
				items: [{ kind: "tool-stack", key: "tool-stack:tool-batch:live-edit:edit-1", stepId: step.id }],
			});
		}
	});

	it("压缩记录留在所属步骤的两条工具之间，实时转历史时不跳到 Task 下方", () => {
		const step = {
			id: "compaction-step",
			title: "整理上下文",
			status: "completed" as const,
			toolCallIds: ["read-before", "read-after"],
			messageEntryIds: ["compaction-entry"],
			startedAt: 1,
			endedAt: 2,
		};
		const transcript: WorkbenchState["transcript"] = [
			{
				entryId: "step-entry",
				renderId: "step-entry",
				parentId: null,
				timestamp,
				kind: "custom",
				view: { type: "agent_step", step },
			},
			{
				entryId: "before",
				renderId: "before",
				parentId: "step-entry",
				timestamp,
				kind: "message",
				view: { type: "tool_call", calls: [{ id: "read-before", name: "read", summary: "before.md" }] },
			},
			{
				entryId: "compaction-entry",
				renderId: "live-compaction:1",
				parentId: "before",
				timestamp,
				kind: "compaction",
				view: { type: "summary", variant: "compaction", title: "上下文压缩", text: "已整理。" },
			},
			{
				entryId: "after",
				renderId: "after",
				parentId: "compaction-entry",
				timestamp,
				kind: "message",
				view: { type: "tool_call", calls: [{ id: "read-after", name: "read", summary: "after.md" }] },
			},
		];
		const persisted = buildPersistedRenderItems(transcript, toolIndex, [], {}, { [step.id]: step });
		expect(persisted).toMatchObject([
			{
				kind: "agent-step",
				items: [
					{ kind: "tool-stack", stepId: step.id },
					{ kind: "compaction", key: "live-compaction:1", entryId: "compaction-entry" },
					{ kind: "tool-stack", stepId: step.id },
				],
			},
		]);
		const rendered = appendLiveRenderItems(
			persisted,
			[{ id: "live-compaction:1", kind: "compaction", turnId: 1, stepId: step.id }],
			{},
			new Set(),
			{ status: "completed", reason: "threshold", summaryCountAtStart: 0 },
			1,
		);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toMatchObject({
			kind: "agent-step",
			items: [{ kind: "tool-stack" }, { kind: "compaction", live: true }, { kind: "tool-stack" }],
		});
	});

	it("已有会话用唯一的步骤时间区间找回压缩归属，步骤外的压缩保持独立", () => {
		const time = Date.parse(timestamp);
		const step = {
			id: "older-step",
			title: "处理文件",
			status: "completed" as const,
			toolCallIds: [],
			messageEntryIds: [],
			startedAt: time - 1000,
			endedAt: time + 1000,
		};
		const transcript: WorkbenchState["transcript"] = [
			{
				entryId: "step-entry",
				renderId: "step-entry",
				parentId: null,
				timestamp,
				kind: "custom",
				view: { type: "agent_step", step },
			},
			{
				entryId: "older-compaction",
				renderId: "older-compaction",
				parentId: "step-entry",
				timestamp,
				kind: "compaction",
				view: { type: "summary", variant: "compaction", title: "上下文压缩", text: "已整理。" },
			},
			{
				entryId: "outside-compaction",
				renderId: "outside-compaction",
				parentId: "older-compaction",
				timestamp: new Date(time + 2000).toISOString(),
				kind: "compaction",
				view: { type: "summary", variant: "compaction", title: "上下文压缩", text: "下一次压缩。" },
			},
		];
		expect(buildPersistedRenderItems(transcript, toolIndex)).toMatchObject([
			{ kind: "agent-step", items: [{ kind: "compaction", entryId: "older-compaction" }] },
			{ kind: "compaction", entryId: "outside-compaction" },
		]);
	});

	it("实时工具可加入已有的历史步骤，但无归属工具不借用当前步骤", () => {
		const step = {
			id: "older-step",
			title: "检查项目",
			status: "completed" as const,
			toolCallIds: [],
			messageEntryIds: [],
			startedAt: 1,
			endedAt: 2,
		};
		const transcript: WorkbenchState["transcript"] = [
			{
				entryId: "step-entry",
				renderId: "step-entry",
				parentId: null,
				timestamp,
				kind: "custom",
				view: { type: "agent_step", step },
			},
		];
		const rendered = appendLiveRenderItems(
			buildPersistedRenderItems(transcript, toolIndex),
			[
				{ id: "linked", kind: "tools", turnId: 1, batchId: "linked", toolIds: ["read-1"] },
				{ id: "unlinked", kind: "tools", turnId: 1, batchId: "unlinked", toolIds: ["read-2"] },
			],
			{
				"read-1": {
					id: "read-1",
					name: "read",
					batchId: "linked",
					summary: "README.md",
					state: "running",
					status: "running",
					stepId: step.id,
				},
				"read-2": {
					id: "read-2",
					name: "read",
					batchId: "unlinked",
					summary: "other.md",
					state: "running",
					status: "running",
				},
			},
			new Set(),
			undefined,
			1,
		);

		expect(rendered).toMatchObject([
			{ kind: "agent-step", step: { id: step.id }, items: [{ kind: "tool-stack", stepId: step.id }] },
			{ kind: "tool-stack", stepId: undefined },
		]);
	});
});
