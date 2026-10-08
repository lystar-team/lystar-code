import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runToolCall } from "../src/agent-loop.ts";
import type { ToolRecoveryController } from "../src/tool-recovery/controller.ts";
import { ToolExecutionError } from "../src/tool-recovery/types.ts";
import type { AgentTool } from "../src/types.ts";

describe("structured tool errors", () => {
	it.each(["off", "observe", "controller-failure"] as const)("preserves conflict details in %s mode", async (mode) => {
		const details = {
			path: "/target.ts",
			status: "conflict",
			writeState: "not_written",
			plan: "retained-plan",
			issues: [{ code: "SOURCE_CHANGED", editIndex: 2, startLine: 3, endLine: 4 }],
		};
		const tool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "test conflict",
			parameters: Type.Object({}),
			execute: async () => {
				throw new ToolExecutionError("SOURCE_CHANGED: read current lines", {
					code: "SOURCE_CHANGED", category: "stale_state", retryable: false, details,
				});
			},
		};
		const controller: ToolRecoveryController | undefined = mode === "off" ? undefined : {
			preflight: () => undefined,
			observe: () => {},
			...(mode === "controller-failure" ? { decideAttempt: () => { throw new Error("controller unavailable"); } } : {}),
		};
		const toolCall = fauxToolCall("edit", {});
		const outcome = await runToolCall(toolCall, {
			tools: [tool], assistantMessage: fauxAssistantMessage([toolCall], { stopReason: "toolUse" }),
			context: { messages: [], tools: [tool] }, toolRecoveryController: controller,
		});
		expect(outcome.isError).toBe(true);
		expect(outcome.result.content).toEqual([{ type: "text", text: "SOURCE_CHANGED: read current lines" }]);
		expect(outcome.result.details).toEqual({ ...details, code: "SOURCE_CHANGED", category: "stale_state", retryable: false });
	});

	it("preserves the terminal hint of a structured error without recovery", async () => {
		const tool: AgentTool = {
			name: "edit", label: "Edit", description: "test terminal error", parameters: Type.Object({}),
			execute: async () => { throw new ToolExecutionError("Recovery exhausted", {
				code: "SOURCE_CHANGED", category: "stale_state", retryable: false, terminate: true,
				details: { recoveryAllowed: false, attempt: 3 },
			}); },
		};
		const toolCall = fauxToolCall("edit", {});
		const outcome = await runToolCall(toolCall, {
			tools: [tool], assistantMessage: fauxAssistantMessage([toolCall], { stopReason: "toolUse" }),
			context: { messages: [], tools: [tool] },
		});
		expect(outcome.result.terminate).toBe(true);
		expect(outcome.result.details).toMatchObject({ recoveryAllowed: false, attempt: 3 });
	});
});
