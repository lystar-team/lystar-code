import type { TranscriptItem } from "@lystar/code-web-protocol";
import { describe, expect, it } from "vitest";
import { projectTranscriptItems } from "../src/transcript-projection.ts";

function subagentResult(details: unknown): TranscriptItem {
	return {
		entryId: "subagent-result",
		parentId: null,
		timestamp: "2026-09-17T00:00:00Z",
		kind: "message",
		payload: {
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "subagent",
				content: [{ type: "text", text: "子任务已完成" }],
				isError: false,
				details,
			},
		},
	} as TranscriptItem;
}

describe("Subagent transcript projection", () => {
	it("preserves agent identifiers and tasks on historical tool results", () => {
		const projected = projectTranscriptItems(
			subagentResult({
				runId: "run-1",
				results: [
					{
						runId: "run-1",
						agentId: "run-1:1",
						agent: "reviewer",
						agentSource: "user",
						task: "检查实现",
						state: "succeeded",
					},
				],
			}),
		);

		expect(projected[0]?.view).toMatchObject({
			type: "tool_result",
			name: "subagent",
			subagents: [
				{
					runId: "run-1",
					agentId: "run-1:1",
					agent: "reviewer",
					task: "检查实现",
					state: "succeeded",
				},
			],
		});
	});
});
