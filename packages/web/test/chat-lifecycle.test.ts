import { describe, expect, it } from "vitest";
import { toLiveToolViewModel } from "../src/adapters/live-tool-view-model.ts";
import {
	applyPromptAccepted,
	clearsThinking,
	committedToolCallIds,
	reconcileCommittedTurn,
} from "../src/state/chat-lifecycle.ts";
import type { WorkbenchState } from "../src/state/use-workbench.ts";
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
	return { operationId: "op-1", type: "prompt", status, updatedAt } as WebOperation;
}

describe("chat lifecycle", () => {
	it("hands committed assistant text and calls to transcript without losing running tools", () => {
		const next = reconcileCommittedTurn(liveState(), [assistant, call], 11);
		expect(next.liveTurnStartRevision).toBe(11);
		expect(next.liveTurnItems).toEqual([]);
		expect(next.liveTools["tool-1"].state).toBe("running");
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

	it("does not regress websocket operation state with an older HTTP response", () => {
		const current = { ...liveState(), currentOperation: operation("completed", 3) };
		expect(applyPromptAccepted(current, "session-1", operation("accepted", 1))).toBe(current);
	});

	it("preserves cancelled and interrupted tool states at the call position", () => {
		const tool = liveState().liveTools["tool-1"];
		expect(toLiveToolViewModel({ ...tool, state: "cancelled" }).state).toBe("output-cancelled");
		expect(toLiveToolViewModel({ ...tool, state: "interrupted" }).state).toBe("output-interrupted");
		expect(toLiveToolViewModel({ ...tool, state: "running" }).state).toBe("input-available");
	});
});
