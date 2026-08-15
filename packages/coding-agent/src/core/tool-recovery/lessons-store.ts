import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { validRange } from "semver";
import { isStableFailureCode } from "./registry.ts";

export type ToolRecoveryLessonStatus = "candidate" | "verified" | "active" | "suspended" | "expired";
export type ToolRecoveryLessonScope = "project" | "global";
export type ToolRecoveryLessonAction = "guidance" | "safe_refresh";
export type ToolRecoveryLessonHistoryAction = "create" | "update" | "approve" | "disable" | "rollback" | "prune";

export interface ToolRecoveryLesson {
	schema: 1;
	id: string;
	status: ToolRecoveryLessonStatus;
	scope: ToolRecoveryLessonScope;
	scopeHash?: string;
	matcher: {
		toolName: string;
		failureCode: string;
		fingerprintPrefix?: string;
		toolVersionRange?: string;
	};
	guidance: string;
	allowedAction: ToolRecoveryLessonAction;
	evidence: {
		occurrences: number;
		sessions: number;
		recovered: number;
		failed: number;
	};
	version: number;
	expiresAt: string;
	createdAt: string;
	updatedAt: string;
	rollbackOf?: string;
}

export interface ToolRecoveryLessonsSnapshot {
	schema: 1;
	lessons: ToolRecoveryLesson[];
}

export interface ToolRecoveryLessonHistoryEntry {
	schema: 1;
	id: string;
	action: ToolRecoveryLessonHistoryAction;
	source: string;
	time: string;
	before: ToolRecoveryLesson | null;
	after: ToolRecoveryLesson | null;
}

export interface ToolRecoveryLessonsPaths {
	directory: string;
	snapshot: string;
	history: string;
	lock: string;
}

export interface CreateToolRecoveryLessonInput {
	status?: "candidate" | "verified";
	scope: ToolRecoveryLessonScope;
	scopeHash?: string;
	matcher: ToolRecoveryLesson["matcher"];
	guidance: string;
	allowedAction: ToolRecoveryLessonAction;
	evidence: ToolRecoveryLesson["evidence"];
	expiresAt: string;
}

export interface UpdateToolRecoveryLessonInput {
	scope?: ToolRecoveryLessonScope;
	scopeHash?: string;
	matcher?: ToolRecoveryLesson["matcher"];
	guidance?: string;
	allowedAction?: ToolRecoveryLessonAction;
	evidence?: ToolRecoveryLesson["evidence"];
	expiresAt?: string;
}

export interface ToolRecoveryLessonsOptions {
	now?: Date;
	source?: string;
	onHistorySynced?: () => void | Promise<void>;
}

export interface PruneToolRecoveryLessonsOptions extends ToolRecoveryLessonsOptions {
	suspendedTtlMs?: number;
}

export class ToolRecoveryLessonsError extends Error {}
export class ToolRecoveryLessonNotFoundError extends ToolRecoveryLessonsError {}
export class ToolRecoveryLessonVersionConflictError extends ToolRecoveryLessonsError {}

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const FINGERPRINT_PREFIX = /^[a-f0-9]{8,64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SOURCE = /^[a-z][a-z0-9_-]{0,31}$/;
const STATUS = new Set<ToolRecoveryLessonStatus>(["candidate", "verified", "active", "suspended", "expired"]);
const ACTIONS = new Set<ToolRecoveryLessonAction>(["guidance", "safe_refresh"]);
const HISTORY_ACTIONS = new Set<ToolRecoveryLessonHistoryAction>([
	"create",
	"update",
	"approve",
	"disable",
	"rollback",
	"prune",
]);
const LESSON_KEYS = new Set([
	"schema",
	"id",
	"status",
	"scope",
	"scopeHash",
	"matcher",
	"guidance",
	"allowedAction",
	"evidence",
	"version",
	"expiresAt",
	"createdAt",
	"updatedAt",
	"rollbackOf",
]);
const HISTORY_KEYS = new Set(["schema", "id", "action", "source", "time", "before", "after"]);
const storeQueues = new Map<string, Promise<void>>();
const DEFAULT_SUSPENDED_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isTime(value: unknown): value is string {
	return typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));
}

function isEvidence(value: unknown): value is ToolRecoveryLesson["evidence"] {
	if (!isRecord(value)) return false;
	const keys = ["occurrences", "sessions", "recovered", "failed"];
	return (
		Object.keys(value).length === keys.length &&
		keys.every((key) => {
			const candidate = value[key];
			return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
		})
	);
}

function isMatcher(value: unknown): value is ToolRecoveryLesson["matcher"] {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, new Set(["toolName", "failureCode", "fingerprintPrefix", "toolVersionRange"]))
	) {
		return false;
	}
	if (typeof value.toolName !== "string" || !TOOL_NAME.test(value.toolName)) return false;
	if (typeof value.failureCode !== "string" || !isStableFailureCode(value.failureCode)) return false;
	if (
		value.fingerprintPrefix !== undefined &&
		(typeof value.fingerprintPrefix !== "string" || !FINGERPRINT_PREFIX.test(value.fingerprintPrefix))
	) {
		return false;
	}
	return (
		value.toolVersionRange === undefined ||
		(typeof value.toolVersionRange === "string" && validRange(value.toolVersionRange) !== null)
	);
}

function hasUnsafeGuidance(value: string): boolean {
	return [
		/\b(?:api[_ -]?key|oauth|access[_ -]?token|secret|token|cookie|authorization)\b/iu,
		/(?:^|[\s"'`])(?:~\/|\/[^^\s]+)/u,
		/[A-Za-z]:[\\/]/u,
		/https?:\/\/[^\s?#]+[?#]/iu,
		/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/\S+/iu,
		/(?:ssh:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:HostName|IdentityFile|ProxyJump)\b)/u,
		/(?:^|\s)[A-Za-z0-9._-]+@[A-Za-z0-9._-]+(?::\d+)?(?:\s|$)/u,
		/\b(?:host|server|database|user(?:name)?|password|port)\s*=/iu,
	].some((pattern) => pattern.test(value));
}

function isLesson(value: unknown): value is ToolRecoveryLesson {
	if (!isRecord(value) || !hasOnlyKeys(value, LESSON_KEYS)) return false;
	if (value.schema !== 1 || typeof value.id !== "string" || !UUID.test(value.id)) return false;
	if (typeof value.status !== "string" || !STATUS.has(value.status as ToolRecoveryLessonStatus)) return false;
	if (value.scope !== "project" && value.scope !== "global") return false;
	if (value.scope === "project" && (typeof value.scopeHash !== "string" || !SHA256.test(value.scopeHash)))
		return false;
	if (value.scope === "global" && value.scopeHash !== undefined) return false;
	if (
		!isMatcher(value.matcher) ||
		typeof value.guidance !== "string" ||
		value.guidance.length === 0 ||
		hasUnsafeGuidance(value.guidance)
	) {
		return false;
	}
	if (typeof value.allowedAction !== "string" || !ACTIONS.has(value.allowedAction as ToolRecoveryLessonAction))
		return false;
	if (!isEvidence(value.evidence)) return false;
	if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1) return false;
	if (!isTime(value.expiresAt) || !isTime(value.createdAt) || !isTime(value.updatedAt)) return false;
	return value.rollbackOf === undefined || (typeof value.rollbackOf === "string" && UUID.test(value.rollbackOf));
}

function isSnapshot(value: unknown): value is ToolRecoveryLessonsSnapshot {
	return (
		isRecord(value) &&
		value.schema === 1 &&
		Array.isArray(value.lessons) &&
		Object.keys(value).length === 2 &&
		value.lessons.every(isLesson)
	);
}

function isHistoryEntry(value: unknown): value is ToolRecoveryLessonHistoryEntry {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, HISTORY_KEYS) &&
		Object.keys(value).length === HISTORY_KEYS.size &&
		value.schema === 1 &&
		typeof value.id === "string" &&
		UUID.test(value.id) &&
		typeof value.action === "string" &&
		HISTORY_ACTIONS.has(value.action as ToolRecoveryLessonHistoryAction) &&
		typeof value.source === "string" &&
		SOURCE.test(value.source) &&
		isTime(value.time) &&
		(value.before === null || isLesson(value.before)) &&
		(value.after === null || isLesson(value.after))
	);
}

function assertLessonInput(input: CreateToolRecoveryLessonInput | UpdateToolRecoveryLessonInput): void {
	if ("scope" in input && input.scope !== undefined && input.scope !== "project" && input.scope !== "global") {
		throw new ToolRecoveryLessonsError("scope 只能是 project 或 global");
	}
	if ("scopeHash" in input && input.scopeHash !== undefined && !SHA256.test(input.scopeHash)) {
		throw new ToolRecoveryLessonsError("scopeHash 必须是 SHA-256 摘要");
	}
	if (input.matcher !== undefined && !isMatcher(input.matcher)) {
		throw new ToolRecoveryLessonsError("matcher 只能包含稳定的 Tool、失败码、指纹前缀和版本范围");
	}
	if (input.guidance !== undefined && (input.guidance.trim().length === 0 || hasUnsafeGuidance(input.guidance))) {
		throw new ToolRecoveryLessonsError("guidance 包含敏感信息或不允许的路径、连接信息");
	}
	if (input.allowedAction !== undefined && !ACTIONS.has(input.allowedAction)) {
		throw new ToolRecoveryLessonsError("allowedAction 只能是 guidance 或 safe_refresh");
	}
	if (input.evidence !== undefined && !isEvidence(input.evidence)) {
		throw new ToolRecoveryLessonsError("evidence 必须是非负整数计数");
	}
	if (input.expiresAt !== undefined && !isTime(input.expiresAt)) {
		throw new ToolRecoveryLessonsError("expiresAt 必须是 ISO 时间");
	}
}

function assertScope(scope: ToolRecoveryLessonScope, scopeHash: string | undefined): void {
	if (scope === "project" && !scopeHash) throw new ToolRecoveryLessonsError("project lesson 必须提供 scopeHash");
	if (scope === "global" && scopeHash !== undefined)
		throw new ToolRecoveryLessonsError("global lesson 不能提供 scopeHash");
}

function nowIso(options: ToolRecoveryLessonsOptions): string {
	return (options.now ?? new Date()).toISOString();
}

function sourceOf(options: ToolRecoveryLessonsOptions): string {
	const source = options.source ?? "api";
	if (!SOURCE.test(source)) throw new ToolRecoveryLessonsError("source 格式无效");
	return source;
}

function emptySnapshot(): ToolRecoveryLessonsSnapshot {
	return { schema: 1, lessons: [] };
}

function effectiveStatus(lesson: ToolRecoveryLesson, now: Date): ToolRecoveryLessonStatus {
	return Date.parse(lesson.expiresAt) <= now.getTime() ? "expired" : lesson.status;
}

function presentLesson(lesson: ToolRecoveryLesson, now: Date): ToolRecoveryLesson {
	const copy = structuredClone(lesson);
	copy.status = effectiveStatus(copy, now);
	return copy;
}

async function withQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = storeQueues.get(key);
	let release: () => void = () => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	storeQueues.set(key, current);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (storeQueues.get(key) === current) storeQueues.delete(key);
	}
}

async function writeAtomically(path: string, content: string): Promise<void> {
	const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	const file = await open(temporaryPath, "wx", 0o600);
	try {
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await rename(temporaryPath, path);
		if (process.platform !== "win32") {
			const directory = await open(dirname(path), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

async function readText(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

function parseHistory(content: string): { entries: ToolRecoveryLessonHistoryEntry[]; repairedContent: string } {
	if (content.length === 0) return { entries: [], repairedContent: "" };
	const entries: ToolRecoveryLessonHistoryEntry[] = [];
	let offset = 0;
	let validEnd = 0;
	while (offset < content.length) {
		const newline = content.indexOf("\n", offset);
		const end = newline === -1 ? content.length : newline;
		const line = content.slice(offset, end);
		const nextOffset = newline === -1 ? content.length : newline + 1;
		if (line.length === 0 && nextOffset === content.length)
			return { entries, repairedContent: content.slice(0, validEnd) };
		try {
			const entry = JSON.parse(line);
			if (!isHistoryEntry(entry)) throw new Error("invalid history entry");
			entries.push(entry);
			validEnd = newline === -1 ? content.length : nextOffset;
			offset = nextOffset;
		} catch {
			if (
				content
					.slice(nextOffset)
					.split("\n")
					.some((candidate) => candidate.length > 0)
			) {
				throw new ToolRecoveryLessonsError("history.jsonl 中间记录损坏");
			}
			return { entries, repairedContent: content.slice(0, validEnd) };
		}
	}
	return { entries, repairedContent: content.endsWith("\n") ? content : `${content}\n` };
}

async function appendHistory(paths: ToolRecoveryLessonsPaths, entry: ToolRecoveryLessonHistoryEntry): Promise<void> {
	const file = await open(paths.history, "a", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
}

function equalLessons(left: ToolRecoveryLesson, right: ToolRecoveryLesson): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function replayHistory(entries: ToolRecoveryLessonHistoryEntry[]): ToolRecoveryLessonsSnapshot {
	const lessons: ToolRecoveryLesson[] = [];
	const entryIds = new Set<string>();
	for (const entry of entries) {
		if (entryIds.has(entry.id)) throw new ToolRecoveryLessonsError("history.jsonl 包含重复记录 ID");
		entryIds.add(entry.id);

		if (entry.action === "create") {
			if (
				!entry.after ||
				entry.before ||
				entry.after.version !== 1 ||
				(entry.after.status !== "candidate" && entry.after.status !== "verified") ||
				lessons.some((lesson) => lesson.id === entry.after?.id)
			) {
				throw new ToolRecoveryLessonsError("history.jsonl create 记录无效");
			}
			lessons.push(structuredClone(entry.after));
			continue;
		}

		if (!entry.before) throw new ToolRecoveryLessonsError(`history.jsonl ${entry.action} 记录缺少旧快照`);
		const index = lessons.findIndex((lesson) => lesson.id === entry.before?.id);
		if (index === -1 || !equalLessons(lessons[index], entry.before)) {
			throw new ToolRecoveryLessonsError("history.jsonl 记录与前序状态不一致");
		}
		if (entry.action === "prune") {
			if (entry.after) throw new ToolRecoveryLessonsError("history.jsonl prune 记录无效");
			lessons.splice(index, 1);
			continue;
		}
		if (!entry.after || entry.after.id !== entry.before.id || entry.after.version !== entry.before.version + 1) {
			throw new ToolRecoveryLessonsError(`history.jsonl ${entry.action} 记录无效`);
		}
		if (
			(entry.action === "approve" &&
				(entry.after.status !== "active" ||
					(entry.before.status !== "candidate" &&
						entry.before.status !== "verified" &&
						entry.before.status !== "suspended"))) ||
			(entry.action === "disable" &&
				(entry.after.status !== "suspended" ||
					(entry.before.status !== "active" &&
						entry.before.status !== "candidate" &&
						entry.before.status !== "verified"))) ||
			(entry.action === "rollback" && entry.after.status === "active") ||
			(entry.action === "update" &&
				entry.after.status !== entry.before.status &&
				entry.after.status !== "candidate") ||
			(entry.action === "update" &&
				behaviorChanged(entry.before, entry.after) &&
				(entry.before.status === "active" ||
					entry.before.status === "suspended" ||
					effectiveStatus(entry.before, new Date(entry.time)) === "expired") &&
				entry.after.status !== "candidate")
		) {
			throw new ToolRecoveryLessonsError(`history.jsonl ${entry.action} 状态转换无效`);
		}
		lessons[index] = structuredClone(entry.after);
	}
	return { schema: 1, lessons };
}

async function preserveCorruptSnapshot(paths: ToolRecoveryLessonsPaths): Promise<void> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backup = join(paths.directory, `lessons.corrupt-${timestamp}-${randomUUID()}.json`);
	try {
		await rename(paths.snapshot, backup);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function readStoredSnapshot(
	paths: ToolRecoveryLessonsPaths,
): Promise<{ snapshot: ToolRecoveryLessonsSnapshot; missing: boolean; corrupted: boolean }> {
	let content: string;
	try {
		content = await readText(paths.snapshot);
	} catch {
		await preserveCorruptSnapshot(paths);
		return { snapshot: emptySnapshot(), missing: false, corrupted: true };
	}
	if (content.length === 0) return { snapshot: emptySnapshot(), missing: true, corrupted: false };
	try {
		const snapshot = JSON.parse(content);
		if (!isSnapshot(snapshot)) throw new Error("invalid lessons snapshot");
		return { snapshot, missing: false, corrupted: false };
	} catch {
		await preserveCorruptSnapshot(paths);
		return { snapshot: emptySnapshot(), missing: false, corrupted: true };
	}
}

async function loadStore(
	paths: ToolRecoveryLessonsPaths,
): Promise<{ snapshot: ToolRecoveryLessonsSnapshot; history: ToolRecoveryLessonHistoryEntry[] }> {
	const stored = await readStoredSnapshot(paths);
	const rawHistory = await readText(paths.history);
	const parsedHistory = parseHistory(rawHistory);
	if (parsedHistory.repairedContent !== rawHistory)
		await writeAtomically(paths.history, parsedHistory.repairedContent);
	const replayed = replayHistory(parsedHistory.entries);

	if (parsedHistory.entries.length === 0) {
		return { snapshot: stored.snapshot, history: parsedHistory.entries };
	}
	if (
		stored.corrupted ||
		stored.missing ||
		JSON.stringify(stored.snapshot.lessons) !== JSON.stringify(replayed.lessons)
	) {
		await writeAtomically(paths.snapshot, `${JSON.stringify(replayed, null, 2)}\n`);
	}
	return { snapshot: replayed, history: parsedHistory.entries };
}

async function withStoreLock<T>(
	agentDir: string,
	operation: (paths: ToolRecoveryLessonsPaths) => Promise<T>,
): Promise<T> {
	const paths = getToolRecoveryLessonsPaths(agentDir);
	await mkdir(paths.directory, { recursive: true, mode: 0o700 });
	return await withQueue(paths.lock, async () => {
		const lockFile = await open(paths.lock, "a", 0o600);
		await lockFile.close();
		const release = await lockfile.lock(paths.lock, {
			realpath: false,
			retries: { retries: 100, factor: 1, minTimeout: 1, maxTimeout: 5 },
		});
		try {
			return await operation(paths);
		} finally {
			await release();
		}
	});
}

function findLesson(snapshot: ToolRecoveryLessonsSnapshot, id: string): ToolRecoveryLesson {
	const lesson = snapshot.lessons.find((candidate) => candidate.id === id);
	if (!lesson) throw new ToolRecoveryLessonNotFoundError(`未找到恢复经验“${id}”`);
	return lesson;
}

function assertExpectedVersion(lesson: ToolRecoveryLesson, expectedVersion: number): void {
	if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
		throw new ToolRecoveryLessonsError("expectedVersion 必须是正整数");
	}
	if (lesson.version !== expectedVersion) {
		throw new ToolRecoveryLessonVersionConflictError(
			`恢复经验“${lesson.id}”版本冲突：当前为 ${lesson.version}，期望为 ${expectedVersion}`,
		);
	}
}

function historyEntry(
	action: ToolRecoveryLessonHistoryAction,
	source: string,
	time: string,
	before: ToolRecoveryLesson | null,
	after: ToolRecoveryLesson | null,
): ToolRecoveryLessonHistoryEntry {
	return { schema: 1, id: randomUUID(), action, source, time, before, after };
}

function behaviorChanged(current: ToolRecoveryLesson, next: ToolRecoveryLesson): boolean {
	return (
		current.scope !== next.scope ||
		current.scopeHash !== next.scopeHash ||
		JSON.stringify(current.matcher) !== JSON.stringify(next.matcher) ||
		current.guidance !== next.guidance ||
		current.allowedAction !== next.allowedAction ||
		Date.parse(next.expiresAt) > Date.parse(current.expiresAt)
	);
}

async function commit(
	paths: ToolRecoveryLessonsPaths,
	snapshot: ToolRecoveryLessonsSnapshot,
	entries: ToolRecoveryLessonHistoryEntry | ToolRecoveryLessonHistoryEntry[],
	options: ToolRecoveryLessonsOptions,
): Promise<void> {
	for (const entry of Array.isArray(entries) ? entries : [entries]) await appendHistory(paths, entry);
	await options.onHistorySynced?.();
	await writeAtomically(paths.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function hashToolRecoveryLessonScope(value: string): string {
	return sha256(value);
}

export function getToolRecoveryLessonsPaths(agentDir: string): ToolRecoveryLessonsPaths {
	const directory = join(resolve(agentDir), "tool-recovery");
	return {
		directory,
		snapshot: join(directory, "lessons.json"),
		history: join(directory, "history.jsonl"),
		lock: join(directory, "lock"),
	};
}

export async function createToolRecoveryLesson(
	agentDir: string,
	input: CreateToolRecoveryLessonInput,
	options: ToolRecoveryLessonsOptions = {},
): Promise<ToolRecoveryLesson> {
	assertLessonInput(input);
	assertScope(input.scope, input.scopeHash);
	if (input.status !== undefined && input.status !== "candidate" && input.status !== "verified") {
		throw new ToolRecoveryLessonsError("新建恢复经验只能是 candidate 或 verified");
	}
	return await withStoreLock(agentDir, async (paths) => {
		const snapshot = (await loadStore(paths)).snapshot;
		const time = nowIso(options);
		const lesson: ToolRecoveryLesson = {
			schema: 1,
			id: randomUUID(),
			status: input.status ?? "candidate",
			scope: input.scope,
			...(input.scopeHash ? { scopeHash: input.scopeHash } : {}),
			matcher: structuredClone(input.matcher),
			guidance: input.guidance.trim(),
			allowedAction: input.allowedAction,
			evidence: structuredClone(input.evidence),
			version: 1,
			expiresAt: input.expiresAt,
			createdAt: time,
			updatedAt: time,
		};
		if (!isLesson(lesson)) throw new ToolRecoveryLessonsError("lesson 结构无效");
		snapshot.lessons.push(lesson);
		await commit(paths, snapshot, historyEntry("create", sourceOf(options), time, null, lesson), options);
		return presentLesson(lesson, options.now ?? new Date());
	});
}

export async function listToolRecoveryLessons(
	agentDir: string,
	options: { status?: ToolRecoveryLessonStatus; now?: Date } = {},
): Promise<ToolRecoveryLesson[]> {
	if (options.status !== undefined && !STATUS.has(options.status)) throw new ToolRecoveryLessonsError("status 无效");
	return await withStoreLock(agentDir, async (paths) => {
		const now = options.now ?? new Date();
		return (await loadStore(paths)).snapshot.lessons
			.map((lesson) => presentLesson(lesson, now))
			.filter((lesson) => !options.status || lesson.status === options.status);
	});
}

export async function getToolRecoveryLesson(
	agentDir: string,
	id: string,
	options: { now?: Date } = {},
): Promise<ToolRecoveryLesson> {
	return await withStoreLock(agentDir, async (paths) =>
		presentLesson(findLesson((await loadStore(paths)).snapshot, id), options.now ?? new Date()),
	);
}

export async function readToolRecoveryLessonHistory(agentDir: string): Promise<ToolRecoveryLessonHistoryEntry[]> {
	return await withStoreLock(agentDir, async (paths) => (await loadStore(paths)).history);
}

export async function updateToolRecoveryLesson(
	agentDir: string,
	id: string,
	expectedVersion: number,
	input: UpdateToolRecoveryLessonInput,
	options: ToolRecoveryLessonsOptions = {},
): Promise<ToolRecoveryLesson> {
	assertLessonInput(input);
	return await withStoreLock(agentDir, async (paths) => {
		const snapshot = (await loadStore(paths)).snapshot;
		const current = findLesson(snapshot, id);
		assertExpectedVersion(current, expectedVersion);
		const nextScope = input.scope ?? current.scope;
		const nextScopeHash = input.scope === "global" ? undefined : (input.scopeHash ?? current.scopeHash);
		assertScope(nextScope, nextScopeHash);
		const time = nowIso(options);
		const next: ToolRecoveryLesson = {
			...current,
			...input,
			scope: nextScope,
			...(nextScopeHash ? { scopeHash: nextScopeHash } : {}),
			matcher: input.matcher ? structuredClone(input.matcher) : current.matcher,
			evidence: input.evidence ? structuredClone(input.evidence) : current.evidence,
			guidance: input.guidance?.trim() ?? current.guidance,
			version: current.version + 1,
			updatedAt: time,
		};
		if (nextScopeHash === undefined) delete next.scopeHash;
		if (
			behaviorChanged(current, next) &&
			(current.status === "active" ||
				current.status === "suspended" ||
				effectiveStatus(current, options.now ?? new Date()) === "expired")
		) {
			next.status = "candidate";
		}
		if (!isLesson(next)) throw new ToolRecoveryLessonsError("lesson 更新后结构无效");
		snapshot.lessons[snapshot.lessons.indexOf(current)] = next;
		await commit(paths, snapshot, historyEntry("update", sourceOf(options), time, current, next), options);
		return presentLesson(next, options.now ?? new Date());
	});
}

export async function approveToolRecoveryLesson(
	agentDir: string,
	id: string,
	expectedVersion: number,
	options: ToolRecoveryLessonsOptions = {},
): Promise<ToolRecoveryLesson> {
	return await withStoreLock(agentDir, async (paths) => {
		const snapshot = (await loadStore(paths)).snapshot;
		const current = findLesson(snapshot, id);
		assertExpectedVersion(current, expectedVersion);
		if (effectiveStatus(current, options.now ?? new Date()) === "expired")
			throw new ToolRecoveryLessonsError("已过期的恢复经验不能批准");
		if (current.status !== "candidate" && current.status !== "verified" && current.status !== "suspended") {
			throw new ToolRecoveryLessonsError("只有 candidate、verified 或 suspended 恢复经验可以批准");
		}
		const time = nowIso(options);
		const next: ToolRecoveryLesson = { ...current, status: "active", version: current.version + 1, updatedAt: time };
		snapshot.lessons[snapshot.lessons.indexOf(current)] = next;
		await commit(paths, snapshot, historyEntry("approve", sourceOf(options), time, current, next), options);
		return presentLesson(next, options.now ?? new Date());
	});
}

export async function disableToolRecoveryLesson(
	agentDir: string,
	id: string,
	expectedVersion: number,
	options: ToolRecoveryLessonsOptions = {},
): Promise<ToolRecoveryLesson> {
	return await withStoreLock(agentDir, async (paths) => {
		const snapshot = (await loadStore(paths)).snapshot;
		const current = findLesson(snapshot, id);
		assertExpectedVersion(current, expectedVersion);
		if (effectiveStatus(current, options.now ?? new Date()) === "expired")
			throw new ToolRecoveryLessonsError("已过期的恢复经验不能停用");
		if (current.status !== "active" && current.status !== "candidate" && current.status !== "verified") {
			throw new ToolRecoveryLessonsError("只有 active、candidate 或 verified 恢复经验可以停用");
		}
		const time = nowIso(options);
		const next: ToolRecoveryLesson = {
			...current,
			status: "suspended",
			version: current.version + 1,
			updatedAt: time,
		};
		snapshot.lessons[snapshot.lessons.indexOf(current)] = next;
		await commit(paths, snapshot, historyEntry("disable", sourceOf(options), time, current, next), options);
		return presentLesson(next, options.now ?? new Date());
	});
}

export async function rollbackToolRecoveryLesson(
	agentDir: string,
	historyId: string,
	expectedVersion: number,
	options: ToolRecoveryLessonsOptions = {},
): Promise<ToolRecoveryLesson> {
	return await withStoreLock(agentDir, async (paths) => {
		const { snapshot, history } = await loadStore(paths);
		const target = history.find((entry) => entry.id === historyId);
		if (!target) throw new ToolRecoveryLessonsError(`未找到历史记录“${historyId}”`);
		if (!target.before) throw new ToolRecoveryLessonsError("这条历史记录没有可恢复的旧快照");
		const current = findLesson(snapshot, target.before.id);
		assertExpectedVersion(current, expectedVersion);
		const time = nowIso(options);
		const next: ToolRecoveryLesson = {
			...structuredClone(target.before),
			status: target.before.status === "active" ? "candidate" : target.before.status,
			version: current.version + 1,
			updatedAt: time,
			rollbackOf: historyId,
		};
		if (!isLesson(next)) throw new ToolRecoveryLessonsError("回滚后的 lesson 结构无效");
		snapshot.lessons[snapshot.lessons.indexOf(current)] = next;
		await commit(paths, snapshot, historyEntry("rollback", sourceOf(options), time, current, next), options);
		return presentLesson(next, options.now ?? new Date());
	});
}

export async function pruneToolRecoveryLessons(
	agentDir: string,
	options: PruneToolRecoveryLessonsOptions = {},
): Promise<number> {
	const suspendedTtlMs = options.suspendedTtlMs ?? DEFAULT_SUSPENDED_TTL_MS;
	if (!Number.isSafeInteger(suspendedTtlMs) || suspendedTtlMs < 0) {
		throw new ToolRecoveryLessonsError("suspendedTtlMs 必须是非负整数");
	}
	const source = sourceOf(options);
	return await withStoreLock(agentDir, async (paths) => {
		const snapshot = (await loadStore(paths)).snapshot;
		const now = options.now ?? new Date();
		const time = now.toISOString();
		const removed = snapshot.lessons.filter(
			(lesson) =>
				effectiveStatus(lesson, now) === "expired" ||
				(lesson.status === "suspended" && now.getTime() - Date.parse(lesson.updatedAt) >= suspendedTtlMs),
		);
		if (removed.length === 0) return 0;
		snapshot.lessons = snapshot.lessons.filter((lesson) => !removed.includes(lesson));
		await commit(
			paths,
			snapshot,
			removed.map((lesson) => historyEntry("prune", source, time, lesson, null)),
			options,
		);
		return removed.length;
	});
}
