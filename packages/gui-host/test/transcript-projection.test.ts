import type { TranscriptItem } from "@lystar/code-gui-protocol";
import { describe, expect, it } from "vitest";
import { projectTranscriptItems } from "../src/transcript-projection.ts";

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
});
