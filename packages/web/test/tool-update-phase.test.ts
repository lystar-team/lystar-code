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
		expect(new Set(titles)).toEqual(new Set(["写入 src/app.ts"]));

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
		expect(toolRowTitle(toLiveToolViewModel(tool))).toBe("写入 src/app.ts");
	});

	it("retains a file path when a later edit update only reports the tool name", () => {
		const started: Extract<SessionProgress, { type: "tool_update" }> = {
			type: "tool_update",
			toolCallId: "edit-1",
			name: "edit",
			summary: "src/app.ts",
			diff: { files: [{ path: "src/app.ts", additions: 12, deletions: 14 }] },
		};
		const degraded: Extract<SessionProgress, { type: "tool_update" }> = {
			...started,
			summary: "edit",
			diff: { files: [{ additions: 12, deletions: 14, diff: "+new\n-old" }] },
		};
		const initial = liveToolFromUpdate(started, undefined, "batch-1", started.summary);
		const updated = liveToolFromUpdate(degraded, initial, "batch-1", degraded.summary);
		const activityUpdated = liveToolFromActivity(
			{
				activityEpoch: "edit-stream",
				revision: 1,
				toolCallId: "edit-1",
				name: "edit",
				state: "running",
				summary: "edit",
				updatedAt: 1,
				diff: degraded.diff,
			},
			initial,
			"batch-1",
		);
		const view = toLiveToolViewModel(updated);
		const activityView = toLiveToolViewModel(activityUpdated);

		expect(view.summary).toBe("src/app.ts");
		expect(toolRowTitle(view)).toBe("编辑 src/app.ts");
		expect(view.diff).toEqual({ files: [{ path: "src/app.ts", additions: 12, deletions: 14, diff: "+new\n-old" }] });
		expect(activityView.summary).toBe("src/app.ts");
		expect(toolRowTitle(activityView)).toBe("编辑 src/app.ts");
	});

	it("shows the path as soon as edit execution reports it after an unnamed preview", () => {
		const pending = liveToolFromUpdate(
			{ type: "tool_update", toolCallId: "edit-late-path", name: "edit", summary: "edit" },
			undefined,
			"batch-1",
			"edit",
		);
		expect(toolRowTitle(toLiveToolViewModel(pending))).toBe("编辑文件");
		const running = liveToolFromActivity(
			{
				activityEpoch: "edit-stream",
				revision: 1,
				toolCallId: "edit-late-path",
				name: "edit",
				state: "running",
				summary: "src/app.ts",
				updatedAt: 1,
			},
			pending,
			"batch-1",
		);
		expect(toolRowTitle(toLiveToolViewModel(running))).toBe("编辑 src/app.ts");
	});

	it("retains the command input when execution updates contain output instead of arguments", () => {
		const command = "rg -n 'bootstrap|subscribeSession' packages/web\nnpm run check";
		const running = liveToolFromActivity(
			{
				activityEpoch: "command-stream",
				revision: 1,
				toolCallId: "bash-1",
				name: "bash",
				state: "running",
				summary: command,
				updatedAt: 1,
			},
			undefined,
			"batch-1",
		);
		const output = "Checked 312 files. No fixes applied.";
		const updated = liveToolFromUpdate(
			{ type: "tool_update", toolCallId: "bash-1", name: "bash", summary: output },
			running,
			"batch-1",
			output,
		);
		expect(updated.summary).toBe(command);
		expect(updated.result).toBe(output);
		expect(toolRowTitle(toLiveToolViewModel(updated))).toContain("bootstrap|subscribeSession");
		expect(toolRowTitle(toLiveToolViewModel(updated))).not.toContain("Checked");
	});

	it("accepts revised command arguments while the tool is still preparing", () => {
		const first = liveToolFromUpdate(
			{ type: "tool_update", toolCallId: "bash-1", name: "bash", summary: "git status" },
			undefined,
			"batch-1",
			"git status",
		);
		const command = "git status --short\nnpm run check";
		const revised = liveToolFromUpdate(
			{ type: "tool_update", toolCallId: "bash-1", name: "bash", summary: command },
			first,
			"batch-1",
			command,
		);
		expect(revised.summary).toBe(command);
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
