import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { AGENT_STEP_CUSTOM_TYPE, AgentStepController } from "../src/agent-steps.ts";

describe("AgentStepController", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	it("持久化步骤快照、关联工具，并在新步骤开始时结束旧步骤", () => {
		const root = mkdtempSync(join(tmpdir(), "agent-steps-"));
		cleanupPaths.push(root);
		const cwd = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, sessionDir);
		const controller = new AgentStepController(manager);

		const first = controller.start("读取项目说明");
		controller.associateMessage("assistant-1");
		controller.associateMessage("user-steer-1");
		controller.associateTool("read-1");
		const second = controller.start("检查生成脚本");
		controller.associateMessage("assistant-2");
		controller.associateTool("grep-1");
		controller.finishActive("completed", "已确认入口");

		const snapshots = manager.getEntries().flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== AGENT_STEP_CUSTOM_TYPE) return [];
			return [
				entry.data as {
					step: { id: string; status: string; toolCallIds: string[]; messageEntryIds: string[]; summary?: string };
				},
			];
		});
		const firstSnapshots = snapshots.filter(({ step }) => step.id === first.id);
		const secondSnapshots = snapshots.filter(({ step }) => step.id === second.id);

		expect(firstSnapshots.at(-1)?.step).toMatchObject({
			status: "completed",
			toolCallIds: ["read-1"],
			messageEntryIds: ["assistant-1", "user-steer-1"],
			summary: "进入下一步骤",
		});
		expect(secondSnapshots.at(-1)?.step).toMatchObject({
			status: "completed",
			toolCallIds: ["grep-1"],
			messageEntryIds: ["assistant-2"],
			summary: "已确认入口",
		});
		expect(controller.activeStep).toBeUndefined();
	});

	it("只为增量提交返回与条目 ID 或工具 ID 相关的步骤快照", () => {
		const root = mkdtempSync(join(tmpdir(), "agent-steps-index-"));
		cleanupPaths.push(root);
		const cwd = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, sessionDir);
		const controller = new AgentStepController(manager);
		const step = controller.start("读取索引文件");
		const assistantEntryId = manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "read-indexed", name: "read", arguments: { path: "README.md" } }],
			api: "anthropic-messages",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		});
		controller.associateMessage(assistantEntryId);
		controller.associateTool("read-indexed");
		controller.finishActive("completed");
		const assistantEntry = manager.getEntries().find((entry) => entry.id === assistantEntryId);
		if (!assistantEntry) throw new Error("缺少 assistant 条目");

		expect(controller.stepsForEntries([assistantEntry])).toEqual([
			expect.objectContaining({ id: step.id, status: "completed", toolCallIds: ["read-indexed"] }),
		]);
	});

	it("压缩条目关联活动步骤后可从提交索引和历史快照找回", () => {
		const root = mkdtempSync(join(tmpdir(), "agent-steps-compaction-"));
		cleanupPaths.push(root);
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, join(root, "sessions"));
		const controller = new AgentStepController(manager);
		const step = controller.start("整理资料");
		const firstKeptEntryId = manager.getLeafId();
		if (!firstKeptEntryId) throw new Error("缺少步骤条目");
		const compactionId = manager.appendCompaction("保留已整理资料", firstKeptEntryId, 12_000);
		controller.associateMessage(compactionId);
		controller.finishActive("completed");
		const compaction = manager.getEntry(compactionId);
		if (!compaction) throw new Error("缺少压缩条目");

		expect(controller.stepsForEntries([compaction])).toEqual([
			expect.objectContaining({ id: step.id, messageEntryIds: [compactionId] }),
		]);
		expect(new AgentStepController(manager).stepsForEntries([compaction])).toEqual([
			expect.objectContaining({ id: step.id, messageEntryIds: [compactionId] }),
		]);
	});

	it("工具准备时确定归属，步骤切换后不把同一工具归入新步骤", () => {
		const root = mkdtempSync(join(tmpdir(), "agent-steps-preparing-"));
		cleanupPaths.push(root);
		const cwd = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, sessionDir);
		const controller = new AgentStepController(manager);
		const first = controller.start("修改页面");

		controller.associateTool("edit-1");
		expect(controller.stepIdForTool("edit-1")).toBe(first.id);
		const second = controller.start("检查结果");
		controller.associateTool("edit-1");
		controller.associateTool("read-1");

		expect(controller.stepIdForTool("edit-1")).toBe(first.id);
		expect(controller.activeStep?.toolCallIds).toEqual(["read-1"]);
		expect(controller.stepsForEntries(manager.getEntries())).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: first.id, toolCallIds: ["edit-1"] }),
				expect.objectContaining({ id: second.id, toolCallIds: ["read-1"] }),
			]),
		);
	});

	it("从已有自定义条目恢复活动步骤和工具归属", () => {
		const root = mkdtempSync(join(tmpdir(), "agent-steps-restore-"));
		cleanupPaths.push(root);
		const cwd = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, sessionDir);
		const original = new AgentStepController(manager);
		const step = original.start("恢复中的步骤");
		original.associateMessage("assistant-restore");
		original.associateTool("bash-1");

		const restored = new AgentStepController(manager);

		expect(restored.activeStep).toMatchObject({
			id: step.id,
			title: "恢复中的步骤",
			messageEntryIds: ["assistant-restore"],
		});
		expect(restored.stepIdForTool("bash-1")).toBe(step.id);
	});
});
