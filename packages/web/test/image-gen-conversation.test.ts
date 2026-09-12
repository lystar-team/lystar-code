import { describe, expect, it } from "vitest";
import { buildConversationRenderItems, buildPersistedRenderItems } from "../src/components/workbench/conversation.tsx";

describe("image generation conversation grouping", () => {
	it("keeps generated-image tools separate from ordinary action batches", () => {
		const transcript = [
			{
				entryId: "assistant-edit",
				parentId: null,
				timestamp: "2026-09-11T00:00:00.000Z",
				kind: "message",
				view: { type: "tool_call" as const, calls: [{ id: "edit-1", name: "edit", summary: "src/app.ts" }] },
			},
			{
				entryId: "assistant-image",
				parentId: "assistant-edit",
				timestamp: "2026-09-11T00:00:01.000Z",
				kind: "message",
				view: {
					type: "tool_call" as const,
					calls: [{ id: "image-1", name: "image_gen", summary: '{"prompt":"蓝色圆形"}' }],
				},
			},
		];
		const toolIndex = {
			callIds: new Set(["edit-1", "image-1"]),
			results: new Map([
				["edit-1", { id: "edit-1", name: "edit", summary: "src/app.ts", state: "output-available" as const }],
				[
					"image-1",
					{
						id: "image-1",
						name: "image_gen",
						summary: '{"prompt":"蓝色圆形"}',
						state: "output-available" as const,
						images: [{ contentRef: "image-ref", mimeType: "image/png", byteLength: 3 }],
					},
				],
			]),
			statuses: new Map([
				["edit-1", "success" as const],
				["image-1", "success" as const],
			]),
		};

		const rendered = buildPersistedRenderItems(transcript, toolIndex);
		const stacks = rendered.filter((item) => item.kind === "tool-stack");

		expect(stacks).toHaveLength(2);
		expect(stacks.map((stack) => stack.kind === "tool-stack" && stack.batches[0]?.tools[0]?.name)).toEqual([
			"edit",
			"image_gen",
		]);
	});

	it("keeps generated images inside a single collapsed work process", () => {
		const imageTool = {
			id: "image-1",
			name: "image_gen",
			summary: '{"prompt":"蓝色圆形"}',
			state: "output-available" as const,
			images: [{ contentRef: "image-ref", mimeType: "image/png", byteLength: 3 }],
		};
		const transcript = [
			{
				entryId: "user-1",
				parentId: null,
				timestamp: "2026-09-11T00:00:00.000Z",
				kind: "message",
				view: { type: "user" as const, text: "生成图片" },
			},
			{
				entryId: "assistant-process",
				parentId: "user-1",
				timestamp: "2026-09-11T00:00:01.000Z",
				kind: "message",
				view: { type: "assistant" as const, text: "我先整理画面要求。" },
			},
			{
				entryId: "assistant-image",
				parentId: "assistant-process",
				timestamp: "2026-09-11T00:00:02.000Z",
				kind: "message",
				view: {
					type: "tool_call" as const,
					calls: [{ id: imageTool.id, name: imageTool.name, summary: imageTool.summary }],
				},
			},
			{
				entryId: "assistant-process-after",
				parentId: "assistant-image",
				timestamp: "2026-09-11T00:00:03.000Z",
				kind: "message",
				view: { type: "assistant" as const, text: "我再确认图片结果。" },
			},
			{
				entryId: "assistant-final",
				parentId: "assistant-process-after",
				timestamp: "2026-09-11T00:00:04.000Z",
				kind: "message",
				view: { type: "assistant" as const, text: "图片已生成。" },
			},
		];
		const toolIndex = {
			callIds: new Set([imageTool.id]),
			results: new Map([[imageTool.id, imageTool]]),
			statuses: new Map([[imageTool.id, "success" as const]]),
		};

		const persisted = buildPersistedRenderItems(transcript, toolIndex);
		const rendered = buildConversationRenderItems(persisted, [], {}, toolIndex.callIds, undefined, 1, false);

		expect(rendered.map((item) => item.kind)).toEqual(["message", "work-process", "result-boundary", "message"]);
		const workProcess = rendered[1];
		if (!workProcess || workProcess.kind !== "work-process") throw new Error("缺少工作过程");
		expect(workProcess.items.map((item) => item.kind)).toEqual(["message", "tool-stack", "message"]);
		expect(workProcess.items[1]).toMatchObject({ kind: "tool-stack", collapseForResult: true });
	});
});
