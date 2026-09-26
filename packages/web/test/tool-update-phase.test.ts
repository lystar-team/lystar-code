import type { SessionProgress, ToolActivity } from "@lystar/code-web-protocol";
import { describe, expect, it } from "vitest";
import { toLiveToolViewModel } from "../src/adapters/live-tool-view-model.ts";
import { toolRowTitle } from "../src/components/ai-elements/tool-batch.tsx";
import { liveToolFromActivity, liveToolFromUpdate } from "../src/state/workbench-live-state.ts";

describe("streamed tool phase", () => {
	it("keeps the displayed write label steady while arguments arrive and changes it once execution starts", () => {
		const update: Extract<SessionProgress, { type: "tool_update" }> = {
			type: "tool_update",
			toolCallId: "write-1",
			name: "write",
			summary: "src/app.ts",
		};
		let tool = liveToolFromUpdate(update, undefined, "batch-1", "src/app.ts");
		const titles = [toolRowTitle(toLiveToolViewModel(tool))];
		for (let revision = 1; revision <= 4; revision++) {
			const activity: ToolActivity = {
				activityEpoch: "write-stream",
				revision,
				toolCallId: "write-1",
				name: "write",
				state: "preparing",
				summary: "src/app.ts",
				inputPreview: true,
				updatedAt: revision,
			};
			tool = liveToolFromActivity(activity, tool, "batch-1");
			titles.push(toolRowTitle(toLiveToolViewModel(tool)));
			tool = liveToolFromUpdate(update, tool, "batch-1", "src/app.ts");
			expect(tool.inputPreview).toBe(true);
			titles.push(toolRowTitle(toLiveToolViewModel(tool)));
		}
		expect(new Set(titles)).toEqual(new Set(["准备写入 src/app.ts"]));

		const queued: ToolActivity = {
			activityEpoch: "write-stream",
			revision: 5,
			toolCallId: "write-1",
			name: "write",
			state: "queued",
			summary: "src/app.ts",
			inputPreview: true,
			updatedAt: 5,
		};
		tool = liveToolFromUpdate(update, liveToolFromActivity(queued, tool, "batch-1"), "batch-1", "src/app.ts");
		expect(tool.state).toBe("queued");

		const started = { ...tool, state: "running" as const };
		tool = liveToolFromUpdate(update, started, "batch-1", "src/app.ts");
		expect(toolRowTitle(toLiveToolViewModel(tool))).toBe("正在写入 src/app.ts");
	});

	it("retains the image prompt when progress events report only a status", () => {
		const input = JSON.stringify({ prompt: "保留导航的三栏结构并调整项目入口", model: "auto" });
		const activity: ToolActivity = {
			activityEpoch: "image-stream",
			revision: 1,
			toolCallId: "image-1",
			name: "image_gen",
			state: "running",
			summary: input,
			updatedAt: 1,
		};
		const update: Extract<SessionProgress, { type: "tool_update" }> = {
			type: "tool_update",
			toolCallId: "image-1",
			name: "image_gen",
			summary: "正在使用模型生成图片",
		};
		const running = liveToolFromActivity(activity, undefined, "image-batch");
		const updated = liveToolFromUpdate(update, running, "image-batch", update.summary);

		expect(toLiveToolViewModel(updated).summary).toBe(input);
		expect(updated.result).toBe(update.summary);
	});
});
