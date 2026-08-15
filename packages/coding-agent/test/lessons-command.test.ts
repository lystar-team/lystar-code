import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createToolRecoveryLesson,
	hashToolRecoveryLessonScope,
	readToolRecoveryLessonHistory,
} from "../src/core/tool-recovery/lessons-store.ts";
import { main } from "../src/main.ts";

const tempDirs: string[] = [];
let agentDir: string;
let originalAgentDir: string | undefined;
let originalExitCode: typeof process.exitCode;

function createTempDir(): string {
	const directory = join(tmpdir(), `pi-lessons-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	tempDirs.push(directory);
	return directory;
}

function lessonInput(overrides: Record<string, unknown> = {}) {
	return {
		scope: "project" as const,
		scopeHash: hashToolRecoveryLessonScope("cli-project"),
		matcher: { toolName: "read", failureCode: "TARGET_NOT_FOUND" },
		guidance: "先查看父目录。",
		allowedAction: "guidance" as const,
		expiresAt: "2030-01-01T00:00:00.000Z",
		...overrides,
	};
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		process.exitCode = undefined;
		await main(args);
		return {
			stdout: log.mock.calls.map(([message]) => String(message)).join("\n"),
			stderr: error.mock.calls.map(([message]) => String(message)).join("\n"),
			exitCode: process.exitCode,
		};
	} finally {
		log.mockRestore();
		error.mockRestore();
	}
}

beforeEach(() => {
	agentDir = createTempDir();
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	originalExitCode = process.exitCode;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.exitCode = undefined;
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("lessons CLI", () => {
	it("handles list, show, approve, disable, rollback, and prune", async () => {
		const candidate = await createToolRecoveryLesson(agentDir, lessonInput());
		const listed = await runCli(["lessons", "list", "--status", "candidate"]);
		expect(listed).toMatchObject({ stdout: expect.stringContaining(candidate.id), exitCode: undefined });

		const shown = await runCli(["lessons", "show", candidate.id]);
		expect(shown.stdout).toContain("建议：先查看父目录。");

		const approved = await runCli(["lessons", "approve", candidate.id, "--version", "1"]);
		expect(approved).toMatchObject({ stdout: expect.stringContaining("当前状态为 active"), exitCode: undefined });

		const disabled = await runCli(["lessons", "disable", candidate.id, "--version", "2"]);
		expect(disabled).toMatchObject({ stdout: expect.stringContaining("已停用"), exitCode: undefined });

		const disableHistory = (await readToolRecoveryLessonHistory(agentDir)).find(
			(entry) => entry.action === "disable",
		);
		if (!disableHistory) throw new Error("missing disable history");
		const rolledBack = await runCli(["lessons", "rollback", disableHistory.id, "--version", "3"]);
		expect(rolledBack).toMatchObject({
			stdout: expect.stringContaining("当前状态为 candidate，需再次批准"),
			exitCode: undefined,
		});

		await createToolRecoveryLesson(agentDir, lessonInput({ expiresAt: "2020-01-01T00:00:00.000Z" }));
		const pruned = await runCli(["lessons", "prune"]);
		expect(pruned).toMatchObject({ stdout: expect.stringContaining("已清理 1 条"), exitCode: undefined });
	});

	it("reports empty data and command errors with nonzero exit codes", async () => {
		const help = await runCli(["lessons", "help"]);
		expect(help.stdout).toContain("suspended 可以重新批准");
		expect(help.stdout).toContain("回滚到 active 会改为 candidate");

		expect(await runCli(["lessons", "list"])).toMatchObject({ stdout: "没有保存的恢复经验。", exitCode: undefined });
		expect(await runCli(["lessons", "prune"])).toMatchObject({
			stdout: "没有可清理的恢复经验。",
			exitCode: undefined,
		});

		for (const args of [
			["lessons", "list", "--status", "wrong"],
			["lessons", "show", "missing"],
			["lessons", "approve", "missing", "--version", "zero"],
			["lessons", "disable", "missing"],
			["lessons", "rollback", "missing"],
		]) {
			const result = await runCli(args);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("错误：");
		}
	});
});
