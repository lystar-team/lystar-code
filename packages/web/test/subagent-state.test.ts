import type { SessionProgress, SubagentSnapshot } from "@lystar/code-web-protocol";
import { describe, expect, it } from "vitest";
import {
	applySubagentProgress,
	createSubagentConversationState,
	mergeSubagentSnapshots,
} from "../src/state/use-workbench.ts";

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return {
		runId: "run-1",
		agentId: "run-1:1",
		agent: "reviewer",
		agentSource: "user",
		task: "检查实现",
		state: "running",
		startedAt: 1,
		updatedAt: 1,
		elapsedMs: 0,
		controllable: true,
		...overrides,
	};
}

describe("Subagent workbench state", () => {
	it("keeps the newest snapshot for each agent", () => {
		const first = snapshot({ updatedAt: 10 });
		const second = snapshot({ updatedAt: 20, currentAction: "正在读取" });
		const other = snapshot({ runId: "run-2", agentId: "run-2:1", updatedAt: 5 });

		expect(mergeSubagentSnapshots([first], [snapshot({ updatedAt: 9 }), second, other])).toEqual([second, other]);
	});

	it("projects live text, thinking, tool activity, and turn settlement", () => {
		let itemIndex = 0;
		let batchIndex = 0;
		let state = createSubagentConversationState(snapshot());
		const next = (progress: SessionProgress) => {
			state = applySubagentProgress(
				state,
				progress,
				() => `item-${++itemIndex}`,
				() => `batch-${++batchIndex}`,
			);
		};

		next({ type: "phase", phase: "turn" });
		next({ type: "thinking_delta", text: "先检查" });
		next({ type: "assistant_delta", text: "已开始" });
		next({ type: "tool_start", toolCallId: "tool-1", name: "read", summary: "README.md" });
		next({ type: "tool_end", toolCallId: "tool-1", name: "read", status: "success", summary: "读取完成" });
		next({ type: "phase", phase: "idle" });

		expect(state.liveTurnItems.map((item) => item.kind)).toEqual(["thinking", "text", "tools"]);
		expect(state.liveTools["tool-1"]).toMatchObject({
			name: "read",
			status: "success",
			state: "success",
			result: "读取完成",
		});
		expect(state.liveTurnActive).toBe(false);
	});

	it("moves the final assistant text outside a completed task", () => {
		let itemIndex = 0;
		let batchIndex = 0;
		let state = createSubagentConversationState(snapshot());
		const next = (progress: SessionProgress) => {
			state = applySubagentProgress(
				state,
				progress,
				() => `item-${++itemIndex}`,
				() => `batch-${++batchIndex}`,
			);
		};

		next({ type: "phase", phase: "turn" });
		next({
			type: "agent_step",
			step: { id: "step-1", title: "执行检查", status: "running", toolCallIds: [], startedAt: 1 },
		});
		next({ type: "assistant_delta", text: "正在检查。", stepId: "step-1" });
		next({ type: "tool_start", toolCallId: "tool-1", name: "read", summary: "README.md", stepId: "step-1" });
		next({ type: "tool_end", toolCallId: "tool-1", name: "read", status: "success", summary: "读取完成" });
		next({ type: "assistant_delta", text: "检查完成。", stepId: "step-1" });
		next({
			type: "agent_step",
			step: {
				id: "step-1",
				title: "执行检查",
				status: "completed",
				toolCallIds: ["tool-1"],
				messageEntryIds: [],
				startedAt: 1,
				endedAt: 2,
			},
		});
		next({ type: "phase", phase: "idle" });

		expect(state.liveTurnItems).toMatchObject([
			{ kind: "text", parts: ["正在检查。"], stepId: "step-1" },
			{ kind: "tools", toolIds: ["tool-1"] },
			{ kind: "text", parts: ["检查完成。"] },
		]);
		expect(state.liveTurnItems.at(-1)).not.toHaveProperty("stepId");
	});

	it("starts a new turn without inheriting stale tools, Task state, or compaction cards", () => {
		let itemIndex = 0;
		let batchIndex = 0;
		let state = createSubagentConversationState(snapshot());
		const next = (progress: SessionProgress) => {
			state = applySubagentProgress(
				state,
				progress,
				() => `item-${++itemIndex}`,
				() => `batch-${++batchIndex}`,
			);
		};

		next({
			type: "agent_step",
			step: { id: "step-1", title: "检查", status: "running", toolCallIds: [], startedAt: 1 },
		});
		next({ type: "tool_start", toolCallId: "tool-1", name: "read", summary: "README.md" });
		next({ type: "phase", phase: "compaction" });
		expect(state.liveTurnItems).toMatchObject([
			{ kind: "tools" },
			{ kind: "compaction", id: "live-compaction:0", stepId: "step-1" },
		]);
		next({ type: "compaction", status: "running", reason: "threshold" });
		next({ type: "phase", phase: "turn" });

		expect(state.liveSteps).toEqual({});
		expect(state.liveTools).toEqual({});
		expect(state.liveCompaction).toBeUndefined();
		expect(state.liveTurnItems).toEqual([]);
	});
});
