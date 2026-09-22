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

function system(content: unknown): TranscriptItem {
	return {
		entryId: "system-entry",
		parentId: null,
		timestamp: "2026-08-22T00:00:00Z",
		kind: "message",
		payload: {
			type: "message",
			message: { role: "system", content },
		},
	} as TranscriptItem;
}

function toolResult(
	entryId: string,
	parentId: string | null,
	toolCallId: string,
	toolName: string,
	output: string,
	details?: unknown,
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
				...(details === undefined ? {} : { details }),
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

	it("does not render model system messages as chat content", () => {
		const technical = system([
			{ type: "text", text: "You are an internal coding agent." },
			{ type: "text", text: "Project instructions and tools" },
		]);

		expect(projectTranscriptItems(technical)).toEqual([]);
		expect(
			projectTranscriptBatch([technical, assistant([{ type: "text", text: "visible" }])]).map((item) => item.view),
		).toEqual([{ type: "assistant", text: "visible" }]);
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

	it("隐藏步骤控制工具，并把真实工具投影到步骤", () => {
		const stepId = "step-1";
		const projected = projectTranscriptBatch([
			assistant([
				{ type: "toolCall", id: "step-start-1", name: "step_start", arguments: { title: "读取项目说明" } },
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
			]),
			toolResult("step-result", "assistant-entry", "step-start-1", "step_start", "已开始步骤"),
			{
				entryId: "step-snapshot",
				parentId: "step-result",
				timestamp: "2026-09-16T00:00:01Z",
				kind: "custom",
				payload: {
					type: "custom",
					customType: "lystar.web.agent-step",
					data: {
						version: 1,
						step: {
							id: stepId,
							title: "读取项目说明",
							status: "running",
							toolCallIds: ["read-1"],
							messageEntryIds: ["assistant-entry"],
							startedAt: 1,
						},
					},
				},
			} as TranscriptItem,
			toolResult("read-result", "step-snapshot", "read-1", "read", "项目说明"),
		]);

		expect(projected.map((item) => item.view?.type)).toEqual(["tool_call", "agent_step", "tool_result"]);
		expect(projected[0]?.view).toEqual({
			type: "tool_call",
			calls: [{ id: "read-1", name: "read", stepId, summary: "README.md", href: "file://README.md" }],
		});
		expect(projected[1]?.view).toMatchObject({
			type: "agent_step",
			step: { id: stepId, title: "读取项目说明", messageEntryIds: ["assistant-entry"] },
		});
		expect(projected[2]?.view).toMatchObject({ type: "tool_result", callId: "read-1", stepId });
	});

	it("projects stepId from the session Task index when the Task entry is outside the batch", () => {
		const step = {
			id: "step-indexed",
			title: "读取分页文件",
			status: "completed" as const,
			toolCallIds: ["read-indexed"],
			messageEntryIds: [],
			startedAt: 1,
			endedAt: 2,
		};
		const items = projectTranscriptBatch(
			[
				assistant([{ type: "toolCall", id: "read-indexed", name: "read", arguments: { path: "README.md" } }]),
				toolResult("read-result", "assistant-entry", "read-indexed", "read", "项目说明"),
			],
			[step],
		);

		expect(items[0]?.view).toMatchObject({
			type: "tool_call",
			calls: [{ id: "read-indexed", stepId: step.id }],
		});
		expect(items[1]?.view).toMatchObject({ type: "tool_result", callId: "read-indexed", stepId: step.id });
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

	it("keeps completed write contents from the tool call when result details only contain stats", () => {
		const items = projectTranscriptBatch([
			assistant([
				{
					type: "toolCall",
					id: "write-1",
					name: "write",
					arguments: { path: "src/app.ts", content: "const one = 1;\nconst two = 2;\n" },
				},
			]),
			toolResult("write-result", "assistant-entry", "write-1", "write", "Successfully wrote to src/app.ts", {
				operation: "updated",
				additions: 1,
				deletions: 1,
			}),
		]);

		expect(items[1]?.view).toMatchObject({
			type: "tool_result",
			callId: "write-1",
			name: "write",
			status: "success",
			summary: "src/app.ts",
			diff: {
				files: [
					{
						path: "src/app.ts",
						operation: "updated",
						additions: 1,
						deletions: 1,
						diff: "+const one = 1;\n+const two = 2;",
					},
				],
			},
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
						details: {
							model: "gpt-image-2.5-flare",
							savedPath: "/tmp/image.png",
						},
					},
				},
			} as TranscriptItem,
		]);

		expect(projected[1]?.view).toEqual({
			type: "tool_result",
			callId: "image-1",
			name: "image_gen",
			status: "success",
			summary:
				'{"prompt":"蓝色圆形","model":"gpt-image-2.5-flare","requestedModel":"auto","profile":"standard","filename":"image.png"}',
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

	it("hides image filenames added for attachment previews from projected user text", () => {
		const projected = projectTranscriptItems({
			entryId: "user-image-file-entry",
			parentId: null,
			timestamp: "2026-09-07T00:00:00Z",
			kind: "message",
			payload: {
				type: "message",
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: '请处理截图\n\n<file name="/tmp/upload-123" filename="internal-name.png" mimeType="image/png"></file>',
						},
						{
							type: "image",
							alt: "internal-name.png",
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
			text: "请处理截图",
			images: [{ contentRef: "image-ref", mimeType: "image/png", byteLength: 4, alt: "internal-name.png" }],
		});
	});

	it("hides internal file references from projected user text", () => {
		const projected = projectTranscriptItems({
			entryId: "user-file-entry",
			parentId: null,
			timestamp: "2026-09-07T00:00:00Z",
			kind: "message",
			payload: {
				type: "message",
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: '说明\n\n<file name="/tmp/upload-123" filename="report.md" mimeType="text/markdown"></file>\n\n后续说明',
						},
					],
				},
			},
		} as TranscriptItem);

		expect(projected[0]?.view).toEqual({
			type: "user",
			text: "说明\n\n后续说明",
			files: [{ filename: "report.md", mimeType: "text/markdown" }],
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
