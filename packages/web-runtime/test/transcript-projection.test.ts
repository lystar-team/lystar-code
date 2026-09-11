import type { TranscriptItem } from "@lystar/code-web-protocol";
import { describe, expect, it } from "vitest";
import { projectTranscriptBatch, projectTranscriptItems } from "../src/transcript-projection.ts";

function assistant(content: unknown, options: { stopReason?: string; errorMessage?: string } = {}): TranscriptItem {
	return {
		entryId: "assistant-entry",
		parentId: null,
		timestamp: "2026-08-22T00:00:00Z",
		kind: "message",
		payload: {
			type: "message",
			message: { role: "assistant", content, ...options },
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

	it("把失败的空 assistant 响应投影为可见错误", () => {
		const projected = projectTranscriptItems(
			assistant([{ type: "text", text: "" }], { stopReason: "error", errorMessage: "503 service unavailable" }),
		);

		expect(projected.map((item) => item.view)).toEqual([
			{ type: "system", text: "请求失败：503 service unavailable" },
		]);
	});

	it("保留部分 assistant 响应并追加失败原因", () => {
		const projected = projectTranscriptItems(
			assistant([{ type: "text", text: "partial answer" }], { stopReason: "error", errorMessage: "连接中断" }),
		);

		expect(projected.map((item) => item.view)).toEqual([
			{ type: "assistant", text: "partial answer" },
			{ type: "system", text: "请求失败：连接中断" },
		]);
	});

	it("does not render session control entries as chat content", () => {
		const technical: TranscriptItem = {
			entryId: "thinking-level-entry",
			parentId: "assistant-entry",
			timestamp: "2026-09-08T00:00:00Z",
			kind: "thinking_level_change",
			payload: {
				type: "thinking_level_change",
				id: "thinking-level-entry",
				parentId: "assistant-entry",
				timestamp: "2026-09-08T00:00:00Z",
				thinkingLevel: "xhigh",
			},
		};

		expect(projectTranscriptItems(technical)).toEqual([]);
		expect(
			projectTranscriptBatch([technical, assistant([{ type: "text", text: "visible" }])]).map((item) => item.view),
		).toEqual([{ type: "assistant", text: "visible" }]);
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

	it("projects generated-image metadata on the original tool result", () => {
		const projected = projectTranscriptBatch([
			assistant([
				{
					type: "toolCall",
					id: "image-1",
					name: "image_gen",
					arguments: { prompt: "蓝色圆形", model: "auto", profile: "standard" },
				},
			]),
			{
				entryId: "image-result",
				parentId: "assistant-entry",
				timestamp: "2026-09-11T00:00:00Z",
				kind: "message",
				payload: {
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "image-1",
						toolName: "image_gen",
						content: [
							{ type: "text", text: "Generated image saved to /tmp/image.png." },
							{
								type: "image",
								data: {
									type: "content_ref",
									contentRef: "generated-ref",
									mimeType: "image/png",
									byteLength: 4,
									previewHead: "",
									previewTail: "",
									lineCount: 0,
								},
								mimeType: "image/png",
							},
						],
						isError: false,
					},
				},
			} as TranscriptItem,
		]);

		expect(projected[1]?.view).toEqual({
			type: "tool_result",
			callId: "image-1",
			name: "image_gen",
			status: "success",
			summary: '{"prompt":"蓝色圆形","model":"auto","profile":"standard"}',
			detail: "Generated image saved to /tmp/image.png.",
			contentRef: "generated-ref",
			images: [{ contentRef: "generated-ref", mimeType: "image/png", byteLength: 4 }],
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
