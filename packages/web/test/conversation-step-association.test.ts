import { describe, expect, it } from "vitest";
import { buildPersistedRenderItems } from "../src/components/workbench/conversation-render-model.ts";
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
});
