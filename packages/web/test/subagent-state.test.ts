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
});
