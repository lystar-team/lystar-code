import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationWorkspaceManager } from "../src/collaboration-workspace.ts";

const tempDirs: string[] = [];

function runGit(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CollaborationWorkspaceManager", () => {
	it("creates an isolated Git worktree and reports its delivery", async () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-worktree-"));
		tempDirs.push(root);
		const projectCwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(projectCwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(projectCwd, "main.txt"), "base\n");
		runGit(projectCwd, "init", "--initial-branch=main");
		runGit(projectCwd, "config", "user.name", "LYStar Test");
		runGit(projectCwd, "config", "user.email", "lystar@example.invalid");
		runGit(projectCwd, "add", ".");
		runGit(projectCwd, "commit", "-m", "base");
		const baseCommit = runGit(projectCwd, "rev-parse", "HEAD").trim();

		const manager = new CollaborationWorkspaceManager(agentDir);
		const workspace = await manager.create(projectCwd, "worktree", "task-worktree");
		expect(workspace).toMatchObject({
			mode: "worktree",
			projectCwd,
			baseCommit,
			branch: "lystar/task/task-worktree",
		});
		expect(workspace.cwd).not.toBe(projectCwd);
		expect(existsSync(workspace.cwd)).toBe(true);

		writeFileSync(join(workspace.cwd, "main.txt"), "child change\n");
		const delivery = await manager.collect(workspace, "completed");
		expect(delivery.changedFiles).toEqual(["main.txt"]);
		expect(delivery.workspace.status).toBe("delivered");
		expect(readFileSync(join(projectCwd, "main.txt"), "utf8")).toBe("base\n");

		const released = await manager.release(delivery.workspace);
		expect(released.status).toBe("released");
		expect(existsSync(workspace.worktreePath ?? workspace.cwd)).toBe(false);
	});

	it("keeps two parallel worktrees isolated from each other and the source", async () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-worktree-parallel-"));
		tempDirs.push(root);
		const projectCwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(projectCwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(projectCwd, "shared.txt"), "base\n");
		runGit(projectCwd, "init", "--initial-branch=main");
		runGit(projectCwd, "config", "user.name", "LYStar Test");
		runGit(projectCwd, "config", "user.email", "lystar@example.invalid");
		runGit(projectCwd, "add", ".");
		runGit(projectCwd, "commit", "-m", "base");

		const manager = new CollaborationWorkspaceManager(agentDir);
		const first = await manager.create(projectCwd, "worktree", "task-first");
		const second = await manager.create(projectCwd, "worktree", "task-second");
		writeFileSync(join(first.cwd, "shared.txt"), "first\n");
		writeFileSync(join(second.cwd, "shared.txt"), "second\n");

		expect(readFileSync(join(first.cwd, "shared.txt"), "utf8")).toBe("first\n");
		expect(readFileSync(join(second.cwd, "shared.txt"), "utf8")).toBe("second\n");
		expect(readFileSync(join(projectCwd, "shared.txt"), "utf8")).toBe("base\n");
		expect((await manager.collect(first, "completed")).changedFiles).toEqual(["shared.txt"]);
		expect((await manager.collect(second, "completed")).changedFiles).toEqual(["shared.txt"]);

		await manager.release(first);
		await manager.release(second);
	});

	it("creates a patch workspace for a non-Git project without changing the source", async () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-patch-"));
		tempDirs.push(root);
		const projectCwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(projectCwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(projectCwd, "main.txt"), "before\n");

		const manager = new CollaborationWorkspaceManager(agentDir);
		const workspace = await manager.create(projectCwd, "patch", "task-patch");
		const initialDelivery = await manager.collect(workspace, "completed");
		expect(initialDelivery.changedFiles).toEqual([]);
		writeFileSync(join(workspace.cwd, "main.txt"), "after\nmore\n");
		const delivery = await manager.collect(workspace, "completed");

		expect(delivery.changedFiles).toEqual(["main.txt"]);
		expect(delivery.patchPath).toBe(workspace.patchPath);
		expect(readFileSync(delivery.patchPath!, "utf8")).toContain("+after");
		expect(readFileSync(join(projectCwd, "main.txt"), "utf8")).toBe("before\n");

		await manager.release(delivery.workspace);
		expect(existsSync(workspace.worktreePath ?? workspace.cwd)).toBe(false);
	});
});
