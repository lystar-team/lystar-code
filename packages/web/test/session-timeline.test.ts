import { describe, expect, it } from "vitest";
import { agentStepIndexChanged, agentStepsFromIndex, mergeAgentStepIndex } from "../src/state/session-timeline.ts";

const running = {
	id: "step-1",
	title: "读取项目",
	status: "running" as const,
	toolCallIds: ["read-1"],
	messageEntryIds: ["assistant-1"],
	startedAt: 1,
};

describe("session Task timeline", () => {
	it("merges identifiers while allowing the terminal snapshot to take ownership", () => {
		const completed = {
			...running,
			status: "completed" as const,
			toolCallIds: ["read-1", "bash-1"],
			messageEntryIds: ["assistant-1", "assistant-2"],
			endedAt: 3,
			summary: "检查完成",
		};
		const index = mergeAgentStepIndex(mergeAgentStepIndex({}, [running]), [completed]);

		expect(index[completed.id]).toEqual(completed);
		expect(agentStepsFromIndex(index)).toEqual([completed]);
	});

	it("does not let a replayed running snapshot reopen a completed Task", () => {
		const completed = { ...running, status: "completed" as const, endedAt: 3 };
		const index = mergeAgentStepIndex({ [completed.id]: completed }, [
			{ ...running, toolCallIds: ["read-1", "write-1"] },
		]);

		expect(index[completed.id]).toMatchObject({
			status: "completed",
			endedAt: 3,
			toolCallIds: ["read-1", "write-1"],
		});
	});

	it("detects status and association changes at the same transcript revision", () => {
		expect(agentStepIndexChanged({ [running.id]: running }, [{ ...running, status: "completed", endedAt: 2 }])).toBe(
			true,
		);
		expect(agentStepIndexChanged({ [running.id]: running }, [running])).toBe(false);
		expect(
			agentStepIndexChanged({ [running.id]: { ...running, messageEntryIds: undefined } }, [
				{ ...running, messageEntryIds: [] },
			]),
		).toBe(false);
	});
});
