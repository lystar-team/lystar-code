import type { TranscriptItem } from "@lystar/code-gui-protocol";
import { describe, expect, it } from "vitest";
import { projectTranscriptBatch, projectTranscriptItems } from "../src/transcript-projection.ts";

function assistant(content: unknown): TranscriptItem {
	return {
		entryId: "assistant-entry",
		parentId: null,
		timestamp: "2026-08-22T00:00:00Z",
		kind: "message",
		payload: {
			type: "message",
			message: { role: "assistant", content },
		},
	} as TranscriptItem;
}

function toolResult(
	entryId: string,
	parentId: string | null,
	toolCallId: string,
	toolName: string,
	output: string,
): TranscriptItem {
	return {
		entryId,
		parentId,
		timestamp: "2026-08-22T00:00:00Z",
		kind: "message",
		payload: {
			type: "message",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text: output }],
				isError: false,
			},
		},
	} as TranscriptItem;
}

describe("assistant transcript projection", () => {
	it("keeps thinking, text, and tool call blocks in order", () => {
		const views = projectTranscriptItems(
			assistant([
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "call-1", name: "edit", arguments: { path: "src/a.ts" } },
			]),
		).map((item) => item.view);

		expect(views).toEqual([
			{ type: "thinking", text: "plan" },
			{ type: "assistant", text: "answer" },
			{
				type: "tool_call",
				calls: [{ id: "call-1", name: "edit", summary: "src/a.ts", href: "file://src/a.ts" }],
			},
		]);
	});

	it("does not let a tool call discard text after it", () => {
		const items = projectTranscriptItems(
			assistant([
				{ type: "text", text: "before" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
				{ type: "text", text: "after" },
			]),
		);

		expect(items.map((item) => item.view?.type)).toEqual(["assistant", "tool_call", "assistant"]);
		expect(items.map((item) => item.entryId)).toEqual(["assistant-entry", "assistant-entry", "assistant-entry"]);
		expect(items[2]?.view).toEqual({ type: "assistant", text: "after" });
	});

	it("projects a thinking-only assistant block as thinking text", () => {
		const items = projectTranscriptItems(assistant([{ type: "thinking", thinking: "private plan" }]));

		expect(items).toHaveLength(1);
		expect(items[0]?.view).toEqual({ type: "thinking", text: "private plan" });
	});

	it("uses tool input for the result title and keeps output in detail", () => {
		const items = projectTranscriptBatch([
			assistant([
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/app.ts" } },
				{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "git status --short" } },
			]),
			toolResult("read-result", "assistant-entry", "read-1", "read", "const answer = 42;"),
			toolResult("bash-result", "read-result", "bash-1", "bash", " M src/app.ts"),
		]);

		expect(items[1]?.view).toEqual({
			type: "tool_result",
			callId: "read-1",
			name: "read",
			status: "success",
			summary: "src/app.ts",
			detail: "const answer = 42;",
		});
		expect(items[2]?.view).toEqual({
			type: "tool_result",
			callId: "bash-1",
			name: "bash",
			status: "success",
			summary: "git status --short",
			detail: " M src/app.ts",
		});
	});

	it("does not use result content as the title when the call is unavailable", () => {
		const projected = projectTranscriptItems(toolResult("result", null, "read-1", "read", "file contents"));

		expect(projected[0]?.view).toMatchObject({
			type: "tool_result",
			name: "read",
			summary: "read",
			detail: "file contents",
		});
	});
});
