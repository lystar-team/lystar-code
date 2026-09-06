import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { ToolActivityTracker } from "../src/core/tool-activity.ts";

function event(value: unknown): AgentSessionEvent {
	return value as AgentSessionEvent;
}

function toolResult(text: string, details?: unknown) {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

describe("ToolActivityTracker", () => {
	it("收敛参数预览、排队、执行和真实终态", () => {
		const tracker = new ToolActivityTracker();
		const args = { path: "src/app.ts", content: "const answer = 42;\n" };
		const preparing = tracker.apply(
			event({
				type: "message_update",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "write", arguments: args }],
				},
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
			}),
		)[0];
		expect(preparing).toMatchObject({
			toolCallId: "call-1",
			name: "write",
			state: "preparing",
			inputPreview: true,
			diff: { files: [{ path: "src/app.ts", additions: 1 }] },
		});

		const queued = tracker.apply(
			event({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "write", arguments: args }],
				},
			}),
		)[0];
		expect(queued).toMatchObject({ state: "queued", inputPreview: true });

		const running = tracker.apply(
			event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "write", args }),
		)[0];
		expect(running).toMatchObject({ state: "running", inputPreview: true });

		const success = tracker.apply(
			event({
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "write",
				result: toolResult("已写入", {
					path: "src/app.ts",
					additions: 1,
					deletions: 0,
					diff: "+const answer = 42;",
				}),
				isError: false,
			}),
		)[0];
		expect(success).toMatchObject({
			state: "success",
			summary: "src/app.ts",
			output: "已写入",
			diff: { files: [{ path: "src/app.ts", additions: 1, deletions: 0 }] },
		});
		expect(success?.inputPreview).toBeUndefined();
		expect(success?.revision).toBeGreaterThan(preparing?.revision ?? 0);
	});

	it("终态后忽略迟到的进行时更新", () => {
		const tracker = new ToolActivityTracker();
		tracker.apply(
			event({ type: "tool_execution_start", toolCallId: "call-2", toolName: "read", args: { path: "a.ts" } }),
		);
		const success = tracker.apply(
			event({
				type: "tool_execution_end",
				toolCallId: "call-2",
				toolName: "read",
				result: toolResult("done"),
				isError: false,
			}),
		)[0];
		expect(
			tracker.apply(
				event({
					type: "tool_execution_update",
					toolCallId: "call-2",
					toolName: "read",
					args: { path: "a.ts" },
					partialResult: toolResult("late"),
				}),
			),
		).toEqual([]);
		expect(success).toMatchObject({ state: "success", summary: "a.ts", output: "done", revision: success?.revision });
	});

	it("终态保留实际执行的命令并单独记录输出", () => {
		const tracker = new ToolActivityTracker();
		tracker.apply(
			event({
				type: "tool_execution_start",
				toolCallId: "call-bash",
				toolName: "bash",
				args: { command: "git status --short" },
			}),
		);
		const finished = tracker.apply(
			event({
				type: "tool_execution_end",
				toolCallId: "call-bash",
				toolName: "bash",
				result: toolResult(" M packages/web/src/components/workbench.tsx"),
				isError: false,
			}),
		)[0];

		expect(finished).toMatchObject({
			state: "success",
			summary: "git status --short",
			output: " M packages/web/src/components/workbench.tsx",
		});
	});

	it("未返回工具结果时收敛为中断", () => {
		const tracker = new ToolActivityTracker();
		tracker.apply(
			event({ type: "tool_execution_start", toolCallId: "call-3", toolName: "bash", args: { command: "sleep 1" } }),
		);
		const interrupted = tracker.apply(event({ type: "agent_end", messages: [], willRetry: false }))[0];
		expect(interrupted).toMatchObject({ state: "interrupted", error: "工具调用未返回最终结果" });
	});
});
