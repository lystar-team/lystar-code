import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { appendSessionRecoveryLedger, createRecoveryLedgerEntry } from "../src/core/tool-recovery/ledger.ts";
import {
	approveToolRecoveryLesson,
	autoPromoteToolRecoveryLesson,
	createToolRecoveryLesson,
	disableToolRecoveryLesson,
	findMatchingToolRecoveryLessons,
	getToolRecoveryLesson,
	getToolRecoveryLessonsPaths,
	hashToolRecoveryLessonScope,
	listToolRecoveryLessons,
	pruneToolRecoveryLessons,
	readToolRecoveryLessonHistory,
	recordDeterministicToolRecoveryCandidate,
	rollbackToolRecoveryLesson,
	runToolRecoveryLessonReplay,
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
		evidence: { occurrences: 0, sessions: 0, recovered: 0, failed: 0 } as const,
		expiresAt: FUTURE,
		...overrides,
	};
}

function appendCandidateReceipt(agentDir: string, sessionId: string, outcome: "recovered" | "failed" = "recovered") {
	const sessionPath = join(agentDir, "sessions", `${sessionId}.jsonl`);
	mkdirSync(join(agentDir, "sessions"), { recursive: true });
	writeFileSync(sessionPath, "{}\n");
	return appendSessionRecoveryLedger(
		agentDir,
		sessionPath,
		createRecoveryLedgerEntry({
			sessionId,
			turnId: "turn",
			toolCallId: `call-${sessionId}-${Math.random()}`,
			toolName: "read",
			callSignature: "a".repeat(64),
			failureFingerprint: "b".repeat(64),
			failureCode: "TIMEOUT",
			attempt: 1,
			action: "retry_same_args",
			outcome,
			durationMs: 1,
			createdAt: NOW.toISOString(),
		}),
	);
}

async function recordCandidateReceipt(
	agentDir: string,
	sessionId: string,
	outcome: "recovered" | "failed" = "recovered",
) {
	const receipt = await appendCandidateReceipt(agentDir, sessionId, outcome);
	if (!receipt) throw new Error("missing ledger receipt");
	return await recordDeterministicToolRecoveryCandidate(
		agentDir,
		{ scopeHash: hashToolRecoveryLessonScope("project-a"), receipt },
		{ now: NOW },
	);
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
			createToolRecoveryLesson(agentDir, lessonInput({ status: "verified" as never }), { now: NOW }),
		).rejects.toThrow("只能是 candidate");
		await expect(
			createToolRecoveryLesson(
				agentDir,
				lessonInput({ evidence: { occurrences: 1, sessions: 1, recovered: 1, failed: 0 } as never }),
				{ now: NOW },
			),
		).rejects.toThrow("证据计数");

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

	it("preserves a corrupted snapshot and reconstructs it from history", async () => {
		const agentDir = createTempDir();
		const created = await createToolRecoveryLesson(agentDir, lessonInput(), { now: NOW });
		const paths = getToolRecoveryLessonsPaths(agentDir);
		writeFileSync(paths.snapshot, '{"broken"');

		expect(await listToolRecoveryLessons(agentDir, { now: NOW })).toEqual([created]);
		const backup = readdirSync(paths.directory).find(
			(name) => name.startsWith("lessons.corrupt-") && name.endsWith(".json"),
		);
		expect(backup).toBeDefined();
		expect(readFileSync(join(paths.directory, backup!), "utf8")).toBe('{"broken"');
		expect(JSON.parse(readFileSync(paths.snapshot, "utf8"))).toMatchObject({ lessons: [created] });
	});

	it("appends and syncs history before a snapshot failure, then restores on reopen", async () => {
		const agentDir = createTempDir();
		const created = await createToolRecoveryLesson(agentDir, lessonInput(), { now: NOW });
		const paths = getToolRecoveryLessonsPaths(agentDir);
		await expect(
			updateToolRecoveryLesson(
				agentDir,
				created.id,
				created.version,
				{ guidance: "重新读取父目录。" },
				{
					now: NOW,
					onHistorySynced: () => {
						throw new Error("snapshot write fault");
					},
				},
			),
		).rejects.toThrow("snapshot write fault");

		expect(JSON.parse(readFileSync(paths.snapshot, "utf8"))).toMatchObject({ lessons: [{ version: 1 }] });
		expect(
			readFileSync(paths.history, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).action),
		).toEqual(["create", "update"]);
		expect((await readToolRecoveryLessonHistory(agentDir)).map((entry) => entry.action)).toEqual([
			"create",
			"update",
		]);
		expect(await getToolRecoveryLesson(agentDir, created.id, { now: NOW })).toMatchObject({
			guidance: "重新读取父目录。",
			version: 2,
		});
		expect(JSON.parse(readFileSync(paths.snapshot, "utf8"))).toMatchObject({ lessons: [{ version: 2 }] });
	});

	it("drops an uncommitted truncated history tail and repairs a snapshot that had advanced past it", async () => {
		const agentDir = createTempDir();
		const created = await createToolRecoveryLesson(agentDir, lessonInput(), { now: NOW });
		const updated = await updateToolRecoveryLesson(
			agentDir,
			created.id,
			created.version,
			{ guidance: "不应保留的建议。" },
			{ now: NOW },
		);
		const paths = getToolRecoveryLessonsPaths(agentDir);
		const [create] = readFileSync(paths.history, "utf8").trim().split("\n");
		writeFileSync(paths.history, `${create}\n{"truncated"`);

		expect(await getToolRecoveryLesson(agentDir, created.id, { now: NOW })).toMatchObject({
			guidance: created.guidance,
			version: created.version,
		});
		expect(readFileSync(paths.history, "utf8").trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(readFileSync(paths.snapshot, "utf8"))).toMatchObject({ lessons: [{ version: 1 }] });
		expect(updated.version).toBe(2);
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

	it("returns active lessons to candidate when behavior changes and rejects caller-supplied evidence", async () => {
		const agentDir = createTempDir();
		const created = await createToolRecoveryLesson(agentDir, lessonInput(), { now: NOW });
		const active = await approveToolRecoveryLesson(agentDir, created.id, created.version, { now: NOW });
		await expect(
			updateToolRecoveryLesson(
				agentDir,
				active.id,
				active.version,
				{ evidence: { occurrences: 4, sessions: 2, recovered: 4, failed: 0 } } as never,
				{ now: NOW },
			),
		).rejects.toThrow("receipt");
		const shortened = await updateToolRecoveryLesson(
			agentDir,
			active.id,
			active.version,
			{ expiresAt: "2029-01-01T00:00:00.000Z" },
			{ now: NOW },
		);
		expect(shortened.status).toBe("active");
		const changed = await updateToolRecoveryLesson(
			agentDir,
			shortened.id,
			shortened.version,
			{ guidance: "先列出父目录，再确认目标。" },
			{ now: NOW },
		);
		expect(changed).toMatchObject({ status: "candidate", version: 4 });
	});

	it("requires approval again for active TTL extensions and safe_refresh changes", async () => {
		const agentDir = createTempDir();
		const refresh = await createToolRecoveryLesson(
			agentDir,
			lessonInput({ allowedAction: "safe_refresh", expiresAt: "2027-01-01T00:00:00.000Z" }),
			{ now: NOW },
		);
		const active = await approveToolRecoveryLesson(agentDir, refresh.id, refresh.version, { now: NOW });
		const extended = await updateToolRecoveryLesson(
			agentDir,
			active.id,
			active.version,
			{ expiresAt: "2028-01-01T00:00:00.000Z" },
			{ now: NOW },
		);
		expect(extended.status).toBe("candidate");
		const reapproved = await approveToolRecoveryLesson(agentDir, extended.id, extended.version, { now: NOW });
		const changedRefresh = await updateToolRecoveryLesson(
			agentDir,
			reapproved.id,
			reapproved.version,
			{ guidance: "仅在已验证的刷新后重试。" },
			{ now: NOW },
		);
		expect(changedRefresh.status).toBe("candidate");
	});

	it("allows suspended approval, but requires expired lessons to be revalidated before approval", async () => {
		const agentDir = createTempDir();
		const created = await createToolRecoveryLesson(agentDir, lessonInput(), { now: NOW });
		const active = await approveToolRecoveryLesson(agentDir, created.id, created.version, { now: NOW });
		const suspended = await disableToolRecoveryLesson(agentDir, active.id, active.version, { now: NOW });
		expect(await approveToolRecoveryLesson(agentDir, suspended.id, suspended.version, { now: NOW })).toMatchObject({
			status: "active",
		});

		const expired = await createToolRecoveryLesson(agentDir, lessonInput({ expiresAt: "2020-01-01T00:00:00.000Z" }), {
			now: NOW,
		});
		await expect(approveToolRecoveryLesson(agentDir, expired.id, expired.version, { now: NOW })).rejects.toThrow(
			"已过期",
		);
		const revalidated = await updateToolRecoveryLesson(
			agentDir,
			expired.id,
			expired.version,
			{ expiresAt: FUTURE },
			{ now: NOW },
		);
		expect(revalidated.status).toBe("candidate");
		expect(
			await approveToolRecoveryLesson(agentDir, revalidated.id, revalidated.version, { now: NOW }),
		).toMatchObject({
			status: "active",
		});
	});

	it("rolls back an active state as a candidate requiring approval", async () => {
		const agentDir = createTempDir();
		const created = await createToolRecoveryLesson(agentDir, lessonInput(), { now: NOW });
		const active = await approveToolRecoveryLesson(agentDir, created.id, created.version, { now: NOW });
		const suspended = await disableToolRecoveryLesson(agentDir, active.id, active.version, { now: NOW });
		const disable = (await readToolRecoveryLessonHistory(agentDir)).find((entry) => entry.action === "disable");
		if (!disable) throw new Error("missing disable history");

		expect(await rollbackToolRecoveryLesson(agentDir, disable.id, suspended.version, { now: NOW })).toMatchObject({
			status: "candidate",
			version: 4,
			rollbackOf: disable.id,
		});
	});

	it("rejects middle history corruption without replacing the history file", async () => {
		const agentDir = createTempDir();
		await createToolRecoveryLesson(agentDir, lessonInput(), { now: NOW });
		const paths = getToolRecoveryLessonsPaths(agentDir);
		const raw = readFileSync(paths.history, "utf8");
		writeFileSync(paths.history, `{"broken"\n${raw}`);

		await expect(listToolRecoveryLessons(agentDir, { now: NOW })).rejects.toThrow("中间记录损坏");
		expect(readFileSync(paths.history, "utf8")).toContain('{"broken"');
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

	it("rejects forged or failed ledger receipts and aggregates real receipts across sessions", async () => {
		const agentDir = createTempDir();
		await expect(
			recordDeterministicToolRecoveryCandidate(
				agentDir,
				{
					scopeHash: hashToolRecoveryLessonScope("project-a"),
					receipt: {
						entryHash: "a".repeat(64),
						sessionHash: "b".repeat(64),
						toolName: "read",
						failureCode: "TIMEOUT",
						failureFingerprint: "c".repeat(64),
						action: "retry_same_args",
						outcome: "recovered",
					},
				} as never,
				{ now: NOW },
			),
		).rejects.toThrow("receipt");

		const duplicatePath = join(agentDir, "sessions", "duplicate.jsonl");
		mkdirSync(join(agentDir, "sessions"), { recursive: true });
		writeFileSync(duplicatePath, "{}\n");
		const duplicateEntry = createRecoveryLedgerEntry({
			sessionId: "duplicate",
			turnId: "turn",
			toolCallId: "duplicate-call",
			toolName: "read",
			callSignature: "a".repeat(64),
			failureFingerprint: "b".repeat(64),
			failureCode: "TIMEOUT",
			attempt: 1,
			action: "retry_same_args",
			outcome: "recovered",
			durationMs: 1,
			createdAt: NOW.toISOString(),
		});
		expect(await appendSessionRecoveryLedger(agentDir, duplicatePath, duplicateEntry)).toBeDefined();
		const appendFailure = await appendSessionRecoveryLedger(agentDir, duplicatePath, duplicateEntry);
		expect(appendFailure).toBeUndefined();
		await expect(
			recordDeterministicToolRecoveryCandidate(
				agentDir,
				{ scopeHash: hashToolRecoveryLessonScope("project-a"), receipt: appendFailure as never },
				{ now: NOW },
			),
		).rejects.toThrow("receipt");
		expect(await listToolRecoveryLessons(agentDir)).toEqual([]);

		const failedReceipt = await appendCandidateReceipt(agentDir, "failed", "failed");
		if (!failedReceipt) throw new Error("missing failed receipt");
		await expect(
			recordDeterministicToolRecoveryCandidate(
				agentDir,
				{ scopeHash: hashToolRecoveryLessonScope("project-a"), receipt: failedReceipt },
				{ now: NOW },
			),
		).resolves.toBeUndefined();
		expect(await listToolRecoveryLessons(agentDir)).toEqual([]);

		const first = await recordCandidateReceipt(agentDir, "session-a");
		const second = await recordCandidateReceipt(agentDir, "session-a");
		const third = await recordCandidateReceipt(agentDir, "session-b");
		if (!first || !second || !third) throw new Error("missing candidate");
		expect(third).toMatchObject({
			id: first.id,
			evidence: { occurrences: 3, sessions: 2, recovered: 3, failed: 0 },
		});
		const paths = getToolRecoveryLessonsPaths(agentDir);
		const bytes = `${readFileSync(paths.snapshot, "utf8")}\n${readFileSync(paths.history, "utf8")}`;
		for (const forbidden of ["session-a", "session-b"]) expect(bytes).not.toContain(forbidden);
	});

	it("only verifies through store-controlled replay and promotes after real receipt thresholds", async () => {
		const agentDir = createTempDir();
		const candidate = await recordCandidateReceipt(agentDir, "session-a");
		await recordCandidateReceipt(agentDir, "session-a");
		const aggregated = await recordCandidateReceipt(agentDir, "session-b");
		if (!candidate || !aggregated) throw new Error("missing candidate");

		const failed = await runToolRecoveryLessonReplay(
			agentDir,
			aggregated.id,
			async (context) => {
				expect(context.matcherVersion).toBe(1);
				expect(context.lessonVersion).toBe(aggregated.version);
				return false;
			},
			{ now: NOW },
		);
		expect(failed).toMatchObject({ status: "candidate", version: aggregated.version + 1 });
		expect((await readToolRecoveryLessonHistory(agentDir)).at(-1)?.action).toBe("verify");

		await expect(
			runToolRecoveryLessonReplay(
				agentDir,
				failed.id,
				async (context) => {
					await updateToolRecoveryLesson(
						agentDir,
						context.lesson.id,
						context.lessonVersion,
						{ guidance: "回放期间修改。" },
						{ now: NOW },
					);
					return true;
				},
				{ now: NOW },
			),
		).rejects.toBeInstanceOf(ToolRecoveryLessonVersionConflictError);

		const current = await getToolRecoveryLesson(agentDir, failed.id, { now: NOW });
		const verified = await runToolRecoveryLessonReplay(agentDir, current.id, async () => true, { now: NOW });
		expect(verified.status).toBe("verified");
		await expect(
			autoPromoteToolRecoveryLesson(agentDir, verified.id, verified.version, { now: NOW }),
		).rejects.toThrow("未显式开启");
		expect(
			await autoPromoteToolRecoveryLesson(agentDir, verified.id, verified.version, { enabled: true, now: NOW }),
		).toMatchObject({ status: "active" });
	});

	it("sorts active project lessons before global lessons and excludes mismatched versions, TTL, and suspended lessons", async () => {
		const agentDir = createTempDir();
		const scopeHash = hashToolRecoveryLessonScope("project-a");
		const createActive = async (input: Record<string, unknown>) => {
			const candidate = await createToolRecoveryLesson(agentDir, lessonInput(input), { now: NOW });
			return await approveToolRecoveryLesson(agentDir, candidate.id, candidate.version, { now: NOW });
		};
		const projectExact = await createActive({ guidance: "项目精确。" });
		const projectBroad = await createActive({
			matcher: { toolName: "read", failureCode: "TARGET_NOT_FOUND" },
			guidance: "项目通用。",
		});
		const globalExact = await createActive({
			scope: "global",
			scopeHash: undefined,
			guidance: "全局精确。",
		});
		await createActive({
			scope: "global",
			scopeHash: undefined,
			matcher: { toolName: "read", failureCode: "TARGET_NOT_FOUND" },
			guidance: "全局通用。",
		});
		const suspended = await createActive({
			scope: "global",
			scopeHash: undefined,
			guidance: "暂停经验。",
		});
		await disableToolRecoveryLesson(agentDir, suspended.id, suspended.version, { now: NOW });
		await createActive({
			matcher: { toolName: "read", failureCode: "TARGET_NOT_FOUND", toolVersionRange: ">=2.0.0" },
			guidance: "版本不匹配。",
		});
		await createToolRecoveryLesson(agentDir, lessonInput({ expiresAt: "2020-01-01T00:00:00.000Z" }), { now: NOW });

		const matched = await findMatchingToolRecoveryLessons(agentDir, {
			scopeHash,
			toolName: "read",
			failureCode: "TARGET_NOT_FOUND",
			failureFingerprint: "a".repeat(64),
			toolVersion: "1.0.0",
			now: NOW,
		});
		expect(matched.lessons.map((lesson) => lesson.id)).toEqual([projectExact.id, projectBroad.id, globalExact.id]);
		expect(matched.suspendedLessonIds).toEqual([suspended.id]);
	});
});
