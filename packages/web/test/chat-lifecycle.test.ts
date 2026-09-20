import { describe, expect, it, vi } from "vitest";
import { toLiveToolViewModel } from "../src/adapters/live-tool-view-model.ts";
import {
	applyPromptAccepted,
	canSendPrompt,
	clearsThinking,
	committedToolCallIds,
	hasActiveSessionSnapshot,
	hasActiveSessionWork,
	hasActiveToolActivities,
	matchPendingUserPrompts,
	reconcileCommittedTurn,
	reconcilePendingUserPrompts,
	reconcileQueuedUserPromptCounts,
	removeQueuedUserPrompt,
	removeQueuedUserPromptByText,
	submitPromptWithFollowUpFallback,
} from "../src/state/chat-lifecycle.ts";
import { restoreRuntimeActivities, type WorkbenchState } from "../src/state/use-workbench.ts";
import type { WebOperation, WebTranscriptItem } from "../src/types.ts";

const assistant: WebTranscriptItem = {
	entryId: "assistant-1",
	parentId: "user-1",
	kind: "message",
	timestamp: "2026-09-07T00:00:00Z",
	view: { type: "assistant", text: "正文" },
};
const call: WebTranscriptItem = {
	...assistant,
	view: { type: "tool_call", calls: [{ id: "tool-1", name: "bash", summary: "pwd" }] },
};
const user: WebTranscriptItem = { ...assistant, entryId: "user-2", view: { type: "user", text: "新任务" } };

function liveState(): WorkbenchState {
	return {
		sessionId: "session-1",
		transcript: [],
		liveTurnId: 1,
		liveTurnStartRevision: 10,
		liveTurnActive: true,
		liveTools: {
			"tool-1": {
				id: "tool-1",
				name: "bash",
				summary: "pwd",
				batchId: "batch-1",
				state: "running",
				status: "running",
			},
		},
		liveTurnItems: [
			{ id: "text-1", kind: "text", parts: ["正文"], turnId: 1 },
			{ id: "tools-1", kind: "tools", toolIds: ["tool-1"], batchId: "batch-1", turnId: 1 },
		],
	} as WorkbenchState;
}

function operation(status: WebOperation["status"], updatedAt: number): WebOperation {
	return { operationId: "op-1", type: "prompt", status, updatedAt, sessionId: "session-1" } as WebOperation;
}

describe("chat lifecycle", () => {
	it("把乐观用户消息匹配到已落盘条目并带回发送时刻", () => {
		const pending = [{ id: "optimistic-user:1", text: "新任务", attachments: [], sentAt: 1_789_628_000_000 }];

		expect(matchPendingUserPrompts(pending, [user])).toEqual([{ prompt: pending[0], entryId: "user-2" }]);
		expect(matchPendingUserPrompts(pending, [assistant])).toEqual([]);
	});

	it("blocks prompt submission before the session subscription is ready", () => {
		const current = { ...liveState(), connected: true, readOnly: false, sessionReady: false };
		expect(canSendPrompt(current)).toBe(false);
		expect(canSendPrompt({ ...current, sessionReady: true })).toBe(true);
	});

	it("工具仍在运行时保持活跃任务状态", () => {
		const activity = {
			activityEpoch: "epoch",
			revision: 1,
			toolCallId: "tool-1",
			name: "bash",
			state: "running" as const,
			summary: "sleep 10",
			updatedAt: 1,
		};

		expect(hasActiveToolActivities([activity])).toBe(true);
		expect(hasActiveToolActivities([{ ...activity, state: "success" }])).toBe(false);
	});
	it("流式回复仍在展示时，即使快照暂时为空闲也按活跃任务处理", () => {
		const staleSnapshot = {
			...liveState(),
			session: { activity: "idle" },
			currentOperation: undefined,
		} as WorkbenchState;
		expect(hasActiveSessionWork(staleSnapshot)).toBe(true);
	});

	it("终态信号会压过缓存中的运行工具和整理状态", () => {
		const settled = {
			...liveState(),
			session: { activity: "idle", phase: "idle" },
			currentOperation: undefined,
			liveTurnActive: false,
			liveCompaction: { status: "running", summaryCountAtStart: 0 },
		} as WorkbenchState;

		expect(hasActiveSessionWork(settled)).toBe(false);
		expect(hasActiveSessionWork({ ...settled, currentOperation: operation("running", 1) })).toBe(true);
	});

	it("空闲快照会结束缓存中的旧 Live Turn 和运行步骤", () => {
		const snapshot = {
			id: "session-1",
			activity: "idle",
			phase: "idle",
			queuedFollowUpCount: 0,
		} as WorkbenchState["session"];
		const current = {
			...liveState(),
			liveSteps: {
				"step-old": {
					id: "step-old",
					title: "旧步骤",
					status: "running" as const,
					toolCallIds: ["tool-1"],
					startedAt: 1,
				},
			},
		};
		const restored = restoreRuntimeActivities(current, snapshot!);

		expect(hasActiveSessionSnapshot(snapshot!)).toBe(false);
		expect(restored.liveTurnActive).toBe(false);
		expect(restored.liveSteps).toEqual({});
		expect(restored.liveTools).toEqual({});
		expect(restored.liveTurnItems.some((item) => item.kind === "tools")).toBe(false);
		expect(hasActiveSessionWork({ ...restored, session: snapshot, currentOperation: undefined })).toBe(false);
	});

	it("相同工具 revision 的空闲快照会清掉会话缓存中的运行工具", () => {
		const current = {
			...liveState(),
			toolActivityEpoch: "epoch-1",
			toolActivityRevision: 3,
		};
		const snapshot = {
			id: "session-1",
			activity: "idle",
			phase: "idle",
			queuedFollowUpCount: 0,
			toolActivityEpoch: "epoch-1",
			toolActivityRevision: 3,
			toolActivities: [],
		} as WorkbenchState["session"];

		const restored = restoreRuntimeActivities(current, snapshot!);

		expect(restored.liveTools).toEqual({});
		expect(restored.liveTurnItems.some((item) => item.kind === "tools")).toBe(false);
	});

	it("活动快照用当前步骤替换缓存中的旧步骤", () => {
		const current = {
			...liveState(),
			liveSteps: {
				"step-old": {
					id: "step-old",
					title: "旧步骤",
					status: "running" as const,
					toolCallIds: [],
					startedAt: 1,
				},
			},
		};
		const activeStep = {
			id: "step-current",
			title: "当前步骤",
			status: "running" as const,
			toolCallIds: ["tool-1"],
			startedAt: 2,
		};
		const snapshot = {
			id: "session-1",
			activity: "running",
			phase: "turn",
			queuedFollowUpCount: 0,
			activeStep,
		} as WorkbenchState["session"];

		const restored = restoreRuntimeActivities(current, snapshot!);

		expect(restored.liveSteps).toEqual({ [activeStep.id]: activeStep });
	});

	it("owner queue snapshot replaces the matching optimistic prompt", () => {
		const current = {
			...liveState(),
			pendingUserPrompts: [{ id: "optimistic-1", text: "排队任务", attachments: [], queueId: "queue-1" }],
			queuedUserPrompts: [],
		};
		const snapshot = {
			id: "session-1",
			activity: "running",
			phase: "turn",
			queuedFollowUpCount: 1,
			queuedFollowUpMessages: [{ id: "queue-1", text: "排队任务" }],
		} as WorkbenchState["session"];
		const restored = restoreRuntimeActivities(current, snapshot!);

		expect(restored.pendingUserPrompts).toEqual([]);
		expect(restored.queuedUserPrompts).toEqual([
			{
				id: "queue-1",
				text: "排队任务",
				displayText: "排队任务",
				delivery: "follow-up",
				attachments: [],
			},
		]);
	});

	it("refreshing the queue snapshot hides internal file references", () => {
		const current = { ...liveState(), queuedUserPrompts: [] };
		const snapshot = {
			id: "session-1",
			activity: "running",
			phase: "turn",
			queuedFollowUpCount: 1,
			queuedFollowUpMessages: [{ id: "queue-file-1", text: '<file name="/tmp/report.md"></file>' }],
		} as WorkbenchState["session"];

		const restored = restoreRuntimeActivities(current, snapshot!);

		expect(restored.queuedUserPrompts).toEqual([
			{
				id: "queue-file-1",
				text: '<file name="/tmp/report.md"></file>',
				displayText: "附件：report.md",
				delivery: "follow-up",
				attachments: [],
			},
		]);
	});
	it("falls back from prompt to follow-up only for an active owner operation", async () => {
		const active = Object.assign(new Error("busy"), { code: "session_operation_active" });
		const submit = vi
			.fn<(mode: "prompt" | "steer" | "follow-up") => Promise<string>>()
			.mockRejectedValueOnce(active)
			.mockResolvedValueOnce("queued");

		await expect(submitPromptWithFollowUpFallback("prompt", submit)).resolves.toEqual({
			result: "queued",
			submittedMode: "follow-up",
		});
		expect(submit.mock.calls).toEqual([["prompt"], ["follow-up"]]);
	});

	it("preserves non-active errors without retrying", async () => {
		const failure = Object.assign(new Error("offline"), { code: "runtime_unavailable" });
		const submit = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

		await expect(submitPromptWithFollowUpFallback("prompt", submit)).rejects.toBe(failure);
		expect(submit).toHaveBeenCalledOnce();
	});

	it("reconciles attachment-only optimistic prompts with empty committed text", () => {
		const attachment = {
			id: "file-1",
			filename: "report.md",
			mediaType: "text/markdown",
			url: "",
		};
		const pending = [
			{
				id: "prompt-file-1",
				text: "附件：report.md",
				attachments: [attachment],
			},
		];
		const committed: WebTranscriptItem[] = [
			{
				...user,
				view: { type: "user", text: "", files: [{ filename: "report.md", mimeType: "text/markdown" }] },
			},
		];

		expect(reconcilePendingUserPrompts(pending, committed)).toEqual([]);
	});

	it("认领内部 file 引用被 Transcript 投影剥离的乐观 Prompt", () => {
		const pending = [
			{
				id: "prompt-file-projected-1",
				text: '请阅读这份报告\n\n<file name="/tmp/report.md" filename="report.md" mimeType="text/markdown"></file>',
				attachments: [{ id: "file-1", filename: "report.md", mediaType: "text/markdown", url: "" }],
			},
		];
		const committed: WebTranscriptItem[] = [
			{
				...user,
				view: {
					type: "user",
					text: "请阅读这份报告",
					files: [{ filename: "report.md", mimeType: "text/markdown" }],
				},
			},
		];

		expect(reconcilePendingUserPrompts(pending, committed)).toEqual([]);
	});

	it("认领带两个图片附件且投影文本包含图片标签的乐观 Prompt", () => {
		const pending = [
			{
				id: "prompt-images-1",
				text: "请比较这两张截图",
				attachments: [
					{ id: "image-1", filename: "before.png", mediaType: "image/png", url: "" },
					{ id: "image-2", filename: "after.png", mediaType: "image/png", url: "" },
				],
			},
		];
		const committed: WebTranscriptItem[] = [
			{
				...user,
				view: {
					type: "user",
					text: "请比较这两张截图 before.png after.png",
					images: [
						{ contentRef: "image-1", mimeType: "image/png", byteLength: 1, alt: "before.png" },
						{ contentRef: "image-2", mimeType: "image/png", byteLength: 1, alt: "after.png" },
					],
				},
			},
		];

		expect(reconcilePendingUserPrompts(pending, committed)).toEqual([]);
	});

	it("从合并后的 Transcript 认领发送位置之后的图片 Prompt", () => {
		const pending = [
			{
				id: "prompt-image-merged",
				text: "请处理截图",
				attachments: [{ id: "image-1", filename: "image.png", mediaType: "image/png", url: "" }],
				afterEntryId: "assistant-anchor",
			},
		];
		const committed: WebTranscriptItem[] = [
			{ ...user, entryId: "older-user", view: { type: "user", text: "请处理截图" } },
			{ ...assistant, entryId: "assistant-anchor" },
			{
				...user,
				entryId: "committed-image-prompt",
				view: {
					type: "user",
					text: "请处理截图",
					images: [{ contentRef: "image-1", mimeType: "image/png", byteLength: 1, alt: "image.png" }],
				},
			},
		];

		expect(reconcilePendingUserPrompts(pending, committed)).toEqual([]);
	});

	it("不让发送位置之前的同文 Prompt 误认领新乐观消息", () => {
		const pending = [
			{
				id: "prompt-repeated",
				text: "重复任务",
				attachments: [],
				afterEntryId: "assistant-anchor",
			},
		];
		const committed: WebTranscriptItem[] = [
			{ ...user, entryId: "older-user", view: { type: "user", text: "重复任务" } },
			{ ...assistant, entryId: "assistant-anchor" },
		];

		expect(reconcilePendingUserPrompts(pending, committed)).toEqual(pending);
	});

	it("removes one optimistic prompt for each matching committed user message", () => {
		const pending = [
			{ id: "prompt-1", text: "新任务", attachments: [] },
			{ id: "prompt-2", text: "新任务", attachments: [] },
		];
		expect(reconcilePendingUserPrompts(pending, [user])).toEqual([pending[1]]);
	});

	it("按运行时数量保留调整方向和完成后发送队列", () => {
		const pending = [
			{ id: "steer-1", text: "先修接口", displayText: "先修接口", delivery: "steer" as const, attachments: [] },
			{ id: "follow-1", text: "补测试", displayText: "补测试", delivery: "follow-up" as const, attachments: [] },
			{ id: "steer-2", text: "再看样式", displayText: "再看样式", delivery: "steer" as const, attachments: [] },
		];

		expect(reconcileQueuedUserPromptCounts(pending, 1, 1)).toEqual([pending[0], pending[1]]);
		expect(reconcileQueuedUserPromptCounts(pending, 1, 0)).toEqual([pending[0]]);
	});

	it("会话快照保留本地调整方向队列并刷新完成后发送内容", () => {
		const current = {
			...liveState(),
			pendingUserPrompts: [],
			queuedUserPrompts: [
				{ id: "steer-1", text: "调整实现", displayText: "调整实现", delivery: "steer" as const, attachments: [] },
				{ id: "follow-1", text: "旧内容", displayText: "旧内容", delivery: "follow-up" as const, attachments: [] },
			],
		};
		const snapshot = {
			id: "session-1",
			activity: "running",
			phase: "turn",
			queuedSteerCount: 1,
			queuedFollowUpCount: 1,
			queuedFollowUpMessages: [{ id: "follow-1", text: "补充测试" }],
		} as WorkbenchState["session"];

		const restored = restoreRuntimeActivities(current, snapshot!);

		expect(restored.queuedUserPrompts).toEqual([
			current.queuedUserPrompts[0],
			{ id: "follow-1", text: "补充测试", displayText: "旧内容", delivery: "follow-up", attachments: [] },
		]);
	});

	it("removes a queued prompt by ID without touching duplicate text", () => {
		const pending = [
			{ id: "queue-1", text: "重复任务", displayText: "重复任务", delivery: "follow-up" as const, attachments: [] },
			{ id: "queue-2", text: "重复任务", displayText: "重复任务", delivery: "follow-up" as const, attachments: [] },
		];
		expect(removeQueuedUserPrompt(pending, "queue-2")).toEqual([pending[0]]);
		expect(removeQueuedUserPromptByText(pending, "重复任务")).toEqual([pending[1]]);
	});

	it("hands committed assistant text and calls to transcript without losing running tools", () => {
		const next = reconcileCommittedTurn(liveState(), [assistant, call], 11);
		expect(next.liveTurnStartRevision).toBe(11);
		expect(next.liveTurnItems).toEqual([]);
		expect(next.liveTools["tool-1"].state).toBe("running");
	});

	it("Assistant 输出落盘时保留尚未落盘的调整方向 Prompt", () => {
		const current = liveState();
		const steer = {
			id: "optimistic-user:queue-1",
			kind: "user" as const,
			turnId: 1,
			queueId: "queue-1",
			text: "先修接口",
			displayText: "先修接口",
			attachments: [],
			status: "queued" as const,
		};
		current.liveTurnItems = [...current.liveTurnItems, steer];

		const next = reconcileCommittedTurn(current, [assistant], 11);

		expect(next.liveTurnItems.map((item) => item.kind)).toEqual(["tools", "user"]);
		expect(next.liveTurnItems.at(-1)).toEqual(steer);
	});

	it("does not clear a new assistant turn for an older duplicate commit", () => {
		const current = liveState();
		const next = reconcileCommittedTurn(current, [assistant], 10);
		expect(next.liveTurnItems).toEqual(current.liveTurnItems);
	});

	it("does not mistake a user commit or tool result for an assistant commit", () => {
		const result: WebTranscriptItem = {
			...assistant,
			entryId: "result-1",
			view: { type: "tool_result", callId: "tool-1", name: "bash", summary: "pwd", status: "success" },
		};
		const next = reconcileCommittedTurn(liveState(), [user, result], 12);
		expect(next.liveTurnItems.map((item) => item.kind)).toEqual(["text"]);
		expect([...committedToolCallIds([call, result])]).toEqual(["tool-1"]);
	});

	it("keeps uncommitted tools while acknowledging other tools", () => {
		const current = liveState();
		current.liveTurnItems = [
			{ id: "tools", kind: "tools", batchId: "batch", toolIds: ["tool-1", "tool-2"], turnId: 1 },
		];
		const next = reconcileCommittedTurn(current, [call], 11);
		expect(next.liveTurnItems).toEqual([
			{ id: "tools", kind: "tools", batchId: "batch", toolIds: ["tool-2"], turnId: 1 },
		]);
	});

	it("clears thinking on text, tool input and lifecycle transitions, not usage", () => {
		expect(clearsThinking({ type: "assistant_delta", text: "正文" })).toBe(true);
		expect(clearsThinking({ type: "tool_update", toolCallId: "tool-1", name: "bash", summary: "pwd" })).toBe(true);
		for (const phase of ["turn", "idle", "interrupted", "compaction", "retry"] as const)
			expect(clearsThinking({ type: "phase", phase })).toBe(true);
		expect(clearsThinking({ type: "thinking_delta", text: "继续思考" })).toBe(false);
		expect(clearsThinking({ type: "usage", usage: { outputTokens: 1 } })).toBe(false);
	});

	it("does not reset active output when a follow-up HTTP response arrives", () => {
		const current = liveState();
		const next = applyPromptAccepted(current, "session-1", operation("accepted", 1));
		expect(next.liveTurnItems).toBe(current.liveTurnItems);
		expect(next.liveTools).toBe(current.liveTools);
	});

	it("ignores prompt responses for a session that is no longer selected", () => {
		const current = liveState();
		expect(applyPromptAccepted(current, "other-session", operation("accepted", 1))).toBe(current);
	});

	it("ignores prompt responses without the selected session", () => {
		const current = liveState();
		expect(applyPromptAccepted(current, "session-1", { ...operation("accepted", 1), sessionId: undefined })).toBe(
			current,
		);
	});

	it("does not regress websocket operation state with an older HTTP response", () => {
		const current = { ...liveState(), currentOperation: operation("completed", 3) };
		expect(applyPromptAccepted(current, "session-1", operation("accepted", 1))).toBe(current);
	});

	it("preserves cancelled and interrupted tool states at the call position", () => {
		const tool = liveState().liveTools["tool-1"];
		expect(toLiveToolViewModel({ ...tool, state: "cancelled" }).state).toBe("output-cancelled");
		expect(toLiveToolViewModel({ ...tool, state: "interrupted" }).state).toBe("output-interrupted");
		expect(toLiveToolViewModel({ ...tool, state: "preparing" }).state).toBe("input-available");
		expect(toLiveToolViewModel({ ...tool, state: "queued" }).state).toBe("input-queued");
		expect(toLiveToolViewModel({ ...tool, state: "running" }).state).toBe("input-available");
	});
});
