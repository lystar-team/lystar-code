import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	approveToolRecoveryLesson,
	createToolRecoveryLesson,
	disableToolRecoveryLesson,
	getToolRecoveryLesson,
	getToolRecoveryLessonsPaths,
	hashToolRecoveryLessonScope,
	listToolRecoveryLessons,
	pruneToolRecoveryLessons,
	readToolRecoveryLessonHistory,
	rollbackToolRecoveryLesson,
	ToolRecoveryLessonVersionConflictError,
	updateToolRecoveryLesson,
} from "../src/core/tool-recovery/lessons-store.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const FUTURE = "2030-01-01T00:00:00.000Z";
const NOW = new Date("2026-08-15T00:00:00.000Z");

function createTempDir(): string {
	const directory = join(tmpdir(), `pi-lessons-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	tempDirs.push(directory);
	return directory;
}

function lessonInput(overrides: Record<string, unknown> = {}) {
	return {
		scope: "project" as const,
		scopeHash: hashToolRecoveryLessonScope("project-a"),
		matcher: { toolName: "read", failureCode: "TARGET_NOT_FOUND", fingerprintPrefix: "a".repeat(16) },
		guidance: "先确认目标是否仍在父目录中。",
		allowedAction: "guidance" as const,
		evidence: { occurrences: 3, sessions: 2, recovered: 3, failed: 0 },
		expiresAt: FUTURE,
		...overrides,
	};
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Tool recovery lessons store", () => {
	it("creates, lists, and reads structured lessons", async () => {
		const agentDir = createTempDir();
		const created = await createToolRecoveryLesson(agentDir, lessonInput(), { now: NOW, source: "test" });

		expect(created).toMatchObject({ schema: 1, status: "candidate", version: 1, scope: "project" });
		expect(await listToolRecoveryLessons(agentDir, { status: "candidate", now: NOW })).toEqual([created]);
		expect(await getToolRecoveryLesson(agentDir, created.id, { now: NOW })).toEqual(created);
	});

	it("keeps every lesson when independent processes write concurrently", async () => {
		const agentDir = createTempDir();
		const worker = join(import.meta.dirname, "fixtures", "lessons-store-worker.ts");
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				execFileAsync(process.execPath, ["--import", "tsx", worker, agentDir, String(index)]),
			),
		);
		const lessons = await listToolRecoveryLessons(agentDir);
		expect(lessons).toHaveLength(8);
		expect(new Set(lessons.map((lesson) => lesson.guidance))).toHaveLength(8);
	});

	it("rejects stale optimistic versions", async () => {
		const agentDir = createTempDir();
		const created = await createToolRecoveryLesson(agentDir, lessonInput(), { now: NOW });
		const updated = await updateToolRecoveryLesson(
			agentDir,
			created.id,
			created.version,
			{ guidance: "先读取父目录再继续。" },
			{ now: NOW },
		);

		expect(updated.version).toBe(2);
		await expect(
			approveToolRecoveryLesson(agentDir, created.id, created.version, { now: NOW }),
		).rejects.toBeInstanceOf(ToolRecoveryLessonVersionConflictError);
	});

	it("requires manual approval, disables lessons, expires TTL, and prunes expired or long-suspended lessons", async () => {
		const agentDir = createTempDir();
		await expect(
			createToolRecoveryLesson(agentDir, lessonInput({ status: "active" as never }), { now: NOW }),
		).rejects.toThrow("只能是 candidate 或 verified");

		const refresh = await createToolRecoveryLesson(agentDir, lessonInput({ allowedAction: "safe_refresh" }), {
			now: NOW,
		});
		const active = await approveToolRecoveryLesson(agentDir, refresh.id, refresh.version, {
			now: NOW,
			source: "cli",
		});
		expect(active.status).toBe("active");
		const suspended = await disableToolRecoveryLesson(agentDir, active.id, active.version, { now: NOW });
		expect(suspended.status).toBe("suspended");

		const expired = await createToolRecoveryLesson(agentDir, lessonInput({ expiresAt: "2020-01-01T00:00:00.000Z" }), {
			now: NOW,
		});
		expect((await getToolRecoveryLesson(agentDir, expired.id, { now: NOW })).status).toBe("expired");
		const later = new Date("2027-01-01T00:00:00.000Z");
		expect(await pruneToolRecoveryLessons(agentDir, { now: later, suspendedTtlMs: 1 })).toBe(2);
		expect(await listToolRecoveryLessons(agentDir, { now: later })).toEqual([]);
	});

	it("repairs only a damaged history tail before the next write", async () => {
		const agentDir = createTempDir();
		const created = await createToolRecoveryLesson(agentDir, lessonInput(), { now: NOW });
		const paths = getToolRecoveryLessonsPaths(agentDir);
		appendFileSync(paths.history, '{"truncated"\n');
		await updateToolRecoveryLesson(
			agentDir,
			created.id,
			created.version,
			{ guidance: "重新读取父目录。" },
			{ now: NOW },
		);

		const raw = readFileSync(paths.history, "utf8");
		expect(
			raw
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).action),
		).toEqual(["create", "update"]);
	});

	it("preserves a corrupted snapshot before starting from an empty snapshot", async () => {
		const agentDir = createTempDir();
		const paths = getToolRecoveryLessonsPaths(agentDir);
		mkdirSync(paths.directory, { recursive: true });
		writeFileSync(paths.snapshot, '{"broken"');

		expect(await listToolRecoveryLessons(agentDir)).toEqual([]);
		const backup = readdirSync(paths.directory).find(
			(name) => name.startsWith("lessons.corrupt-") && name.endsWith(".json"),
		);
		expect(backup).toBeDefined();
		expect(readFileSync(join(paths.directory, backup!), "utf8")).toBe('{"broken"');
		await createToolRecoveryLesson(agentDir, lessonInput(), { now: NOW });
		expect(existsSync(paths.snapshot)).toBe(true);
	});

	it("rolls back a history entry as a new version without deleting history", async () => {
		const agentDir = createTempDir();
		const created = await createToolRecoveryLesson(agentDir, lessonInput(), { now: NOW });
		const updated = await updateToolRecoveryLesson(
			agentDir,
			created.id,
			created.version,
			{ guidance: "更新后的建议。" },
			{ now: NOW },
		);
		const update = (await readToolRecoveryLessonHistory(agentDir)).find((entry) => entry.action === "update");
		if (!update) throw new Error("missing update history");

		const rolledBack = await rollbackToolRecoveryLesson(agentDir, update.id, updated.version, { now: NOW });
		expect(rolledBack).toMatchObject({ guidance: created.guidance, version: 3, rollbackOf: update.id });
		expect((await readToolRecoveryLessonHistory(agentDir)).map((entry) => entry.action)).toEqual([
			"create",
			"update",
			"rollback",
		]);
	});

	it("rejects sensitive guidance and writes no raw paths or test secrets", async () => {
		const agentDir = createTempDir();
		for (const guidance of [
			"Authorization: Bearer test-secret",
			"读取 /private/test-secret",
			"https://example.invalid/?token=test-secret",
		]) {
			await expect(createToolRecoveryLesson(agentDir, lessonInput({ guidance }), { now: NOW })).rejects.toThrow(
				"guidance",
			);
		}
		await expect(
			createToolRecoveryLesson(
				agentDir,
				lessonInput({ matcher: { toolName: "read", failureCode: "TARGET_NOT_FOUND", fingerprintPrefix: "bad" } }),
				{ now: NOW },
			),
		).rejects.toThrow("matcher");

		await createToolRecoveryLesson(
			agentDir,
			lessonInput({ scopeHash: hashToolRecoveryLessonScope("/private/test-secret") }),
			{ now: NOW },
		);
		const paths = getToolRecoveryLessonsPaths(agentDir);
		const bytes = `${readFileSync(paths.snapshot, "utf8")}\n${readFileSync(paths.history, "utf8")}`;
		for (const forbidden of ["test-secret", "/private", "token="]) expect(bytes).not.toContain(forbidden);
	});
});
