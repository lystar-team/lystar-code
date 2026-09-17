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
