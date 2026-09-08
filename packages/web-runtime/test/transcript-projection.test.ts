import type { TranscriptItem } from "@lystar/code-web-protocol";
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

	it("projects user image content as attachments for the Prompt card", () => {
		const projected = projectTranscriptItems({
			entryId: "user-entry",
			parentId: null,
			timestamp: "2026-09-07T00:00:00Z",
			kind: "message",
			payload: {
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "请读取 /tmp/upload.png" },
						{
							type: "image",
							data: {
								type: "content_ref",
								contentRef: "image-ref",
								mimeType: "image/png",
								byteLength: 4,
								previewHead: "",
								previewTail: "",
								lineCount: 0,
							},
							mimeType: "image/png",
						},
					],
				},
			},
		} as TranscriptItem);

		expect(projected[0]?.view).toEqual({
			type: "user",
			text: "请读取 /tmp/upload.png",
			images: [{ contentRef: "image-ref", mimeType: "image/png", byteLength: 4 }],
		});
	});

	it("projects compaction entries from the real summary field", () => {
		const projected = projectTranscriptItems({
			entryId: "compaction-entry",
			parentId: "assistant-entry",
			timestamp: "2026-09-07T00:00:00Z",
			kind: "compaction",
			payload: {
				type: "compaction",
				summary: "保留用户目标、工具结果和最后一轮回复。",
				tokensBefore: 12000,
				firstKeptEntryId: "kept-entry",
			},
		});

		expect(projected[0]?.view).toEqual({
			type: "summary",
			variant: "compaction",
			title: "上下文压缩",
			text: "保留用户目标、工具结果和最后一轮回复。",
			tokensBefore: 12000,
		});
	});

	it("does not serialize the whole compaction entry when summary is missing", () => {
		const projected = projectTranscriptItems({
			entryId: "compaction-without-summary",
			parentId: null,
			timestamp: "2026-09-07T00:00:00Z",
			kind: "compaction",
			payload: { type: "compaction", tokensBefore: 12000, firstKeptEntryId: "kept-entry" },
		});

		expect(projected[0]?.view).toEqual({
			type: "summary",
			variant: "compaction",
			title: "上下文压缩",
			text: "",
			tokensBefore: 12000,
		});
	});
});
