import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session collaboration metadata", () => {
	it("persists parent, relation, and profile metadata in a normal session header", async () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-session-metadata-"));
		tempDirs.push(root);
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const parentSession = join(sessionDir, "parent.jsonl");
		const profile = {
			id: "reviewer",
			name: "Review",
			description: "Review profile",
			scope: "project" as const,
			systemPrompt: "Review the change.",
		};

		const manager = SessionManager.create(root, sessionDir, {
			persistHeader: true,
			parentSession,
			relation: "collaboration",
			profile,
		});
		expect(manager.getHeader()).toMatchObject({
			parentSession,
			relation: "collaboration",
			profile,
		});
		manager.dispose();

		const listed = await SessionManager.list(root, sessionDir, undefined, { metadataOnly: true });
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ parentSessionPath: parentSession, relation: "collaboration", profile });
	});

	it("persists a collaboration task and its latest result", async () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-session-result-"));
		tempDirs.push(root);
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const task = {
			id: "task-1",
			description: "检查改动",
			parentSessionId: "parent-1",
			createdAt: "2026-09-21T00:00:00.000Z",
		};
		const workspace = {
			id: "workspace-1",
			mode: "worktree" as const,
			projectCwd: root,
			cwd: join(root, "worktree"),
			status: "active" as const,
			baseCommit: "0123456789abcdef0123456789abcdef01234567",
		};
		const manager = SessionManager.create(root, sessionDir, {
			persistHeader: true,
			collaborationTask: task,
			collaborationWorkspace: workspace,
		});
		manager.appendCollaborationResult({
			taskId: task.id,
			outcome: "completed",
			resultText: "检查完成",
			resultMessageId: "assistant-result-1",
			completedAt: "2026-09-21T00:01:00.000Z",
		});
		expect(manager.getCollaborationTask()).toEqual(task);
		expect(manager.getCollaborationWorkspace()).toEqual(workspace);
		expect(manager.getCollaborationResult()).toMatchObject({
			taskId: task.id,
			outcome: "completed",
			resultText: "检查完成",
			resultMessageId: "assistant-result-1",
		});
		manager.dispose();

		const listed = await SessionManager.list(root, sessionDir, undefined, { metadataOnly: true });
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			collaborationTask: task,
			collaborationWorkspace: workspace,
			collaborationResult: {
				taskId: task.id,
				outcome: "completed",
				resultText: "检查完成",
				resultMessageId: "assistant-result-1",
			},
		});
	});
});
