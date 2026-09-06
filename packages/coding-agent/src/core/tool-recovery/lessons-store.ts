import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { satisfies, validRange } from "semver";
import type { SessionRecoveryLedgerReceipt } from "./ledger.ts";
import {
	consumeSessionRecoveryLedgerReceipt,
	createSessionRecoveryLedgerReplayReceipt,
	readSessionRecoveryLedger,
} from "./ledger.ts";
import { isStableFailureCode } from "./registry.ts";

export type ToolRecoveryLessonStatus = "candidate" | "verified" | "active" | "suspended" | "expired";
export type ToolRecoveryLessonScope = "project" | "global";
export type ToolRecoveryLessonAction = "guidance" | "safe_refresh";
export type ToolRecoveryLessonHistoryAction =
	| "create"
	| "update"
	| "verify"
	| "approve"
	| "disable"
	| "rollback"
	| "prune"
	| "checkpoint";

export interface ToolRecoveryLessonLedgerCursor {
	sessionHash: string;
	sequence: number;
	entryHash: string;
}

export interface ToolRecoveryLessonEvidence {
	occurrences: number;
	sessions: number;
	recovered: number;
	failed: number;
	attempts?: number;
	terminalFailures?: number;
	needsModel?: number;
	blocked?: number;
	cancelled?: number;
	matched?: number;
	guidanceShown?: number;
	/** 只由确定性候选写入，用于跨 Session 去重；不保存原始 Session ID。 */
	sessionHashes?: string[];
	/** 由账本 entry hash 组成，只保留最近窗口，覆盖进程崩溃后的重复提交。 */
	receiptHashes?: string[];
	/** 每个 Session 已完成重放的最后账本序号，避免截断 hash 后重复聚合。 */
	ledgerCursors?: ToolRecoveryLessonLedgerCursor[];
}

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
	evidence: ToolRecoveryLessonEvidence;
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
	checkpoint?: ToolRecoveryLessonsSnapshot;
}

export interface ToolRecoveryLessonsPaths {
	directory: string;
	snapshot: string;
	history: string;
	historyArchiveDirectory: string;
	lock: string;
}

export interface ToolRecoveryLessonCounts {
	candidate: number;
	verified: number;
	active: number;
	disabled: number;
	expired: number;
}

export type ToolRecoveryLessonStoreDiagnostic =
	| { available: true; counts: ToolRecoveryLessonCounts }
	| {
			available: false;
			counts: ToolRecoveryLessonCounts;
			error: { code: "lesson_store_unreadable" | "lesson_store_corrupt" };
	  };

export interface CreateToolRecoveryLessonInput {
	/** 普通 create 固定为 candidate；非 candidate 状态只由受控状态流转写入。 */
	status?: "candidate";
	scope: ToolRecoveryLessonScope;
	scopeHash?: string;
	matcher: ToolRecoveryLesson["matcher"];
	guidance: string;
	allowedAction: ToolRecoveryLessonAction;
	/** 普通 create 只能创建零证据；账本 receipt 只能由候选聚合消费。 */
	evidence?: { occurrences: 0; sessions: 0; recovered: 0; failed: 0 };
	expiresAt: string;
}

export interface UpdateToolRecoveryLessonInput {
	scope?: ToolRecoveryLessonScope;
	scopeHash?: string;
	matcher?: ToolRecoveryLesson["matcher"];
	guidance?: string;
	allowedAction?: ToolRecoveryLessonAction;
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

export interface DeterministicToolRecoveryCandidateInput {
	scopeHash: string;
	receipt: SessionRecoveryLedgerReceipt;
	expiresAt?: string;
	/** 仅运行时 ledger 聚合和启动 reconcile 使用，允许确定性证据自动进入 verified。 */
	autoVerify?: boolean;
}

export interface ToolRecoveryLessonReplayContext {
	lesson: Readonly<ToolRecoveryLesson>;
	lessonVersion: number;
	matcherVersion: 1;
}

export type ToolRecoveryLessonDeterministicRunner = (
	context: ToolRecoveryLessonReplayContext,
) => boolean | Promise<boolean>;

export interface AutoPromoteToolRecoveryLessonOptions extends ToolRecoveryLessonsOptions {
	enabled?: boolean;
	toolVersion?: string;
}

export interface FindToolRecoveryLessonsInput {
	scopeHash: string;
	toolName: string;
	failureCode: string;
	failureFingerprint: string;
	toolVersion?: string;
	now?: Date;
}

export interface FindToolRecoveryLessonsResult {
	lessons: ToolRecoveryLesson[];
	suspendedLessonIds: string[];
}

export interface FindRelevantToolRecoveryLessonsInput {
	scopeHash: string;
	toolNames: readonly string[];
	taskText: string;
	now?: Date;
}

export interface FindRelevantToolRecoveryLessonsResult {
	lessons: ToolRecoveryLesson[];
	suspendedLessonIds: string[];
}

export interface ToolRecoveryLessonUsageOptions extends ToolRecoveryLessonsOptions {
	guidanceShown?: boolean;
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
	"verify",
	"approve",
	"disable",
	"rollback",
	"prune",
	"checkpoint",
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
const HISTORY_KEYS = new Set(["schema", "id", "action", "source", "time", "before", "after", "checkpoint"]);
const MAX_HISTORY_ENTRIES = 512;
const MAX_RECEIPT_HASHES = 64;
const MAX_HISTORY_ARCHIVES = 32;
const HISTORY_ARCHIVE_NAME = /^history-(?:\d{13}-)?[a-f0-9]{64}\.jsonl$/u;
const storeQueues = new Map<string, Promise<void>>();
const DEFAULT_SUSPENDED_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DETERMINISTIC_MATCHER_VERSION = 1 as const;
const DETERMINISTIC_VERIFY_OCCURRENCES = 3;
const DETERMINISTIC_VERIFY_SESSIONS = 2;
const DETERMINISTIC_VERIFY_RECOVERED = 3;
const DETERMINISTIC_GUIDANCE = new Map<string, string>([
	["read\u0000TARGET_NOT_FOUND\u0000refresh_context", "先确认目标仍在父目录中，再决定是否调整路径。"],
	["read\u0000TIMEOUT\u0000retry_same_args", "短暂超时后先确认调用已结束，再依据当前状态继续。"],
	["read\u0000TRANSPORT_ERROR\u0000retry_same_args", "连接恢复后先确认当前状态，再继续读取。"],
	["edit\u0000MATCH_NOT_FOUND\u0000ask_model_to_rebuild", "先读取当前内容，再按最新文本重新组织编辑。"],
	["edit\u0000MATCH_AMBIGUOUS\u0000ask_model_to_rebuild", "先读取当前内容，再按最新文本重新组织编辑。"],
	["apply_patch\u0000PATCH_MATCH_NOT_FOUND\u0000ask_model_to_rebuild", "先读取当前内容，再按最新文本重新组织补丁。"],
	["apply_patch\u0000PATCH_MATCH_AMBIGUOUS\u0000ask_model_to_rebuild", "先读取当前内容，再按最新文本重新组织补丁。"],
]);
const NON_GENERALIZABLE_FAILURES = new Set(["UNCLASSIFIED", "PERMISSION_DENIED", "CANCELLED"]);

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

function isEvidence(value: unknown): value is ToolRecoveryLessonEvidence {
	if (!isRecord(value)) return false;
	const requiredKeys = ["occurrences", "sessions", "recovered", "failed"];
	const optionalCounterKeys = [
		"attempts",
		"terminalFailures",
		"needsModel",
		"blocked",
		"cancelled",
		"matched",
		"guidanceShown",
	];
	if (
		!Object.keys(value).every(
			(key) =>
				requiredKeys.includes(key) ||
				optionalCounterKeys.includes(key) ||
				key === "sessionHashes" ||
				key === "receiptHashes" ||
				key === "ledgerCursors",
		)
	)
		return false;
	if (
		![...requiredKeys, ...optionalCounterKeys].every((key) => {
			const candidate = value[key];
			return (
				candidate === undefined ||
				(typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0)
			);
		})
	) {
		return false;
	}
	if (
		value.sessionHashes !== undefined &&
		(!Array.isArray(value.sessionHashes) ||
			!value.sessionHashes.every((hash) => typeof hash === "string" && SHA256.test(hash)) ||
			new Set(value.sessionHashes).size !== value.sessionHashes.length ||
			value.sessionHashes.length !== value.sessions)
	) {
		return false;
	}
	if (
		value.receiptHashes !== undefined &&
		(!Array.isArray(value.receiptHashes) ||
			!value.receiptHashes.every((hash) => typeof hash === "string" && SHA256.test(hash)) ||
			new Set(value.receiptHashes).size !== value.receiptHashes.length ||
			value.receiptHashes.length > MAX_RECEIPT_HASHES)
	) {
		return false;
	}
	if (value.ledgerCursors === undefined) return true;
	return (
		Array.isArray(value.ledgerCursors) &&
		value.ledgerCursors.every(
			(cursor) =>
				isRecord(cursor) &&
				typeof cursor.sessionHash === "string" &&
				SHA256.test(cursor.sessionHash) &&
				typeof cursor.sequence === "number" &&
				Number.isSafeInteger(cursor.sequence) &&
				cursor.sequence >= 1 &&
				typeof cursor.entryHash === "string" &&
				SHA256.test(cursor.entryHash) &&
				Object.keys(cursor).length === 3,
		) &&
		new Set(value.ledgerCursors.map((cursor) => cursor.sessionHash)).size === value.ledgerCursors.length
	);
}

function emptyEvidence(): ToolRecoveryLessonEvidence {
	return { occurrences: 0, sessions: 0, recovered: 0, failed: 0 };
}

function isEmptyEvidence(value: unknown): boolean {
	return (
		isEvidence(value) &&
		value.occurrences === 0 &&
		value.sessions === 0 &&
		value.recovered === 0 &&
		value.failed === 0 &&
		value.attempts === undefined &&
		value.terminalFailures === undefined &&
		value.needsModel === undefined &&
		value.blocked === undefined &&
		value.cancelled === undefined &&
		value.matched === undefined &&
		value.guidanceShown === undefined &&
		value.sessionHashes === undefined &&
		value.receiptHashes === undefined &&
		value.ledgerCursors === undefined
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
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, HISTORY_KEYS) ||
		value.schema !== 1 ||
		typeof value.id !== "string" ||
		!UUID.test(value.id) ||
		typeof value.action !== "string" ||
		!HISTORY_ACTIONS.has(value.action as ToolRecoveryLessonHistoryAction) ||
		typeof value.source !== "string" ||
		!SOURCE.test(value.source) ||
		!isTime(value.time)
	) {
		return false;
	}
	if (value.action === "checkpoint") {
		return (
			Object.keys(value).length === HISTORY_KEYS.size &&
			value.before === null &&
			value.after === null &&
			isSnapshot(value.checkpoint)
		);
	}
	return (
		Object.keys(value).length === HISTORY_KEYS.size - 1 &&
		value.checkpoint === undefined &&
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
	if (input.expiresAt !== undefined && !isTime(input.expiresAt)) {
		throw new ToolRecoveryLessonsError("expiresAt 必须是 ISO 时间");
	}
}

function assertCreateLessonInput(input: CreateToolRecoveryLessonInput): void {
	assertLessonInput(input);
	const attempted = input as CreateToolRecoveryLessonInput & { status?: unknown; evidence?: unknown };
	if (attempted.status !== undefined && attempted.status !== "candidate") {
		throw new ToolRecoveryLessonsError("新建恢复经验只能是 candidate");
	}
	if (attempted.evidence !== undefined && !isEmptyEvidence(attempted.evidence)) {
		throw new ToolRecoveryLessonsError("普通 create 不能指定恢复证据计数");
	}
}

function assertUpdateLessonInput(input: UpdateToolRecoveryLessonInput): void {
	assertLessonInput(input);
	if ("evidence" in (input as object)) {
		throw new ToolRecoveryLessonsError("恢复证据只能由账本 receipt 聚合");
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

async function readHistoryArchives(paths: ToolRecoveryLessonsPaths): Promise<ToolRecoveryLessonHistoryEntry[]> {
	let names: string[];
	try {
		names = (await readdir(paths.historyArchiveDirectory)).filter((name) => HISTORY_ARCHIVE_NAME.test(name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const entries: ToolRecoveryLessonHistoryEntry[] = [];
	for (const name of names.sort()) {
		const raw = await readText(join(paths.historyArchiveDirectory, name));
		const parsed = parseHistory(raw);
		if (parsed.repairedContent !== raw) throw new ToolRecoveryLessonsError("history archive 尾部损坏");
		entries.push(...parsed.entries);
	}
	return entries;
}

async function readAllHistoryEntries(
	paths: ToolRecoveryLessonsPaths,
	currentEntries: readonly ToolRecoveryLessonHistoryEntry[],
): Promise<ToolRecoveryLessonHistoryEntry[]> {
	const entries = [...(await readHistoryArchives(paths)), ...currentEntries];
	const ids = new Set<string>();
	for (const entry of entries) {
		if (ids.has(entry.id)) throw new ToolRecoveryLessonsError("history archive 包含重复记录 ID");
		ids.add(entry.id);
	}
	return entries;
}

function equalLessons(left: ToolRecoveryLesson, right: ToolRecoveryLesson): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function replayHistory(entries: ToolRecoveryLessonHistoryEntry[]): ToolRecoveryLessonsSnapshot {
	let lessons: ToolRecoveryLesson[] = [];
	const entryIds = new Set<string>();
	for (const entry of entries) {
		if (entryIds.has(entry.id)) throw new ToolRecoveryLessonsError("history.jsonl 包含重复记录 ID");
		entryIds.add(entry.id);

		if (entry.action === "checkpoint") {
			lessons = structuredClone(entry.checkpoint!.lessons);
			continue;
		}

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
			(entry.action === "verify" &&
				(entry.before.status !== "candidate" ||
					(entry.after.status !== "candidate" && entry.after.status !== "verified"))) ||
			(entry.action === "update" &&
				entry.after.status !== entry.before.status &&
				!(entry.before.status === "candidate" && entry.after.status === "verified") &&
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
			retries: { retries: 2_000, factor: 1, minTimeout: 1, maxTimeout: 5, maxRetryTime: 10_000 },
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

function checkpointHistoryEntry(
	source: string,
	time: string,
	snapshot: ToolRecoveryLessonsSnapshot,
): ToolRecoveryLessonHistoryEntry {
	return {
		schema: 1,
		id: randomUUID(),
		action: "checkpoint",
		source,
		time,
		before: null,
		after: null,
		checkpoint: structuredClone(snapshot),
	};
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

async function compactHistoryIfNeeded(
	paths: ToolRecoveryLessonsPaths,
	snapshot: ToolRecoveryLessonsSnapshot,
	options: ToolRecoveryLessonsOptions,
): Promise<void> {
	const rawHistory = await readText(paths.history);
	const history = parseHistory(rawHistory).entries;
	if (history.length <= MAX_HISTORY_ENTRIES) return;
	await mkdir(paths.historyArchiveDirectory, { recursive: true, mode: 0o700 });
	const archiveContent = `${history.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	const archiveHash = sha256(archiveContent);
	const archiveNames = (await readdir(paths.historyArchiveDirectory)).filter((name) =>
		HISTORY_ARCHIVE_NAME.test(name),
	);
	const archiveName =
		archiveNames.find((name) => name === `history-${archiveHash}.jsonl` || name.endsWith(`-${archiveHash}.jsonl`)) ??
		`history-${Date.now()}-${archiveHash}.jsonl`;
	await writeAtomically(join(paths.historyArchiveDirectory, archiveName), archiveContent);
	const checkpoint = checkpointHistoryEntry("compaction", nowIso(options), snapshot);
	await writeAtomically(paths.history, `${JSON.stringify(checkpoint)}\n`);
	const archives = (await readdir(paths.historyArchiveDirectory)).filter((name) => HISTORY_ARCHIVE_NAME.test(name));
	for (const name of archives.sort().slice(0, Math.max(0, archives.length - MAX_HISTORY_ARCHIVES))) {
		await rm(join(paths.historyArchiveDirectory, name), { force: true });
	}
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
	await compactHistoryIfNeeded(paths, snapshot, options);
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
		historyArchiveDirectory: join(directory, "history-archive"),
		lock: join(directory, "lock"),
	};
}

function emptyLessonCounts(): ToolRecoveryLessonCounts {
	return { candidate: 0, verified: 0, active: 0, disabled: 0, expired: 0 };
}

function countLessons(lessons: readonly ToolRecoveryLesson[], now: Date): ToolRecoveryLessonCounts {
	const counts = emptyLessonCounts();
	for (const lesson of lessons) {
		switch (effectiveStatus(lesson, now)) {
			case "candidate":
				counts.candidate++;
				break;
			case "verified":
				counts.verified++;
				break;
			case "active":
				counts.active++;
				break;
			case "suspended":
				counts.disabled++;
				break;
			case "expired":
				counts.expired++;
				break;
		}
	}
	return counts;
}

/**
 * 仅用于诊断的 Store 读取：不加锁、不修复截断记录，也不写入快照或备份文件。
 * 写入中的短暂不一致以 history 为准，损坏数据则明确返回不可用状态。
 */
export async function getToolRecoveryLessonDiagnostics(
	agentDir: string,
	options: { now?: Date } = {},
): Promise<ToolRecoveryLessonStoreDiagnostic> {
	const paths = getToolRecoveryLessonsPaths(agentDir);
	try {
		const [snapshotContent, historyContent] = await Promise.all([readText(paths.snapshot), readText(paths.history)]);
		let snapshot = emptySnapshot();
		if (snapshotContent.length > 0) {
			const parsedSnapshot = JSON.parse(snapshotContent);
			if (!isSnapshot(parsedSnapshot)) throw new ToolRecoveryLessonsError("invalid lessons snapshot");
			snapshot = parsedSnapshot;
		}
		const parsedHistory = parseHistory(historyContent);
		if (parsedHistory.repairedContent !== historyContent)
			throw new ToolRecoveryLessonsError("truncated lessons history");
		const archiveEntries = await readHistoryArchives(paths);
		const historyIds = new Set<string>();
		for (const entry of [...archiveEntries, ...parsedHistory.entries]) {
			if (historyIds.has(entry.id)) throw new ToolRecoveryLessonsError("history archive 包含重复记录 ID");
			historyIds.add(entry.id);
		}
		const lessons =
			parsedHistory.entries.length > 0 ? replayHistory(parsedHistory.entries).lessons : snapshot.lessons;
		return { available: true, counts: countLessons(lessons, options.now ?? new Date()) };
	} catch {
		return {
			available: false,
			counts: emptyLessonCounts(),
			error: { code: "lesson_store_corrupt" },
		};
	}
}

export async function createToolRecoveryLesson(
	agentDir: string,
	input: CreateToolRecoveryLessonInput,
	options: ToolRecoveryLessonsOptions = {},
): Promise<ToolRecoveryLesson> {
	assertCreateLessonInput(input);
	assertScope(input.scope, input.scopeHash);
	return await withStoreLock(agentDir, async (paths) => {
		const snapshot = (await loadStore(paths)).snapshot;
		const time = nowIso(options);
		const lesson: ToolRecoveryLesson = {
			schema: 1,
			id: randomUUID(),
			status: "candidate",
			scope: input.scope,
			...(input.scopeHash ? { scopeHash: input.scopeHash } : {}),
			matcher: structuredClone(input.matcher),
			guidance: input.guidance.trim(),
			allowedAction: input.allowedAction,
			evidence: input.evidence ? structuredClone(input.evidence) : emptyEvidence(),
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
	return await withStoreLock(agentDir, async (paths) => {
		const { history } = await loadStore(paths);
		return await readAllHistoryEntries(paths, history);
	});
}

export async function updateToolRecoveryLesson(
	agentDir: string,
	id: string,
	expectedVersion: number,
	input: UpdateToolRecoveryLessonInput,
	options: ToolRecoveryLessonsOptions = {},
): Promise<ToolRecoveryLesson> {
	assertUpdateLessonInput(input);
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
			evidence: current.evidence,
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

/**
 * Store 在锁外运行确定性回放，随后重新读取快照确认 lesson 与 matcher 没有在回放期间变化。
 * 回放失败也写入 verify history，但维持 candidate，不能由调用方传入 passed 对象直接升级。
 */
export async function runToolRecoveryLessonReplay(
	agentDir: string,
	id: string,
	deterministicRunner: ToolRecoveryLessonDeterministicRunner,
	options: ToolRecoveryLessonsOptions = {},
): Promise<ToolRecoveryLesson> {
	const initial = await getToolRecoveryLesson(agentDir, id, { now: options.now });
	if (initial.status === "expired") throw new ToolRecoveryLessonsError("已过期的恢复经验不能验证");
	if (initial.status !== "candidate") throw new ToolRecoveryLessonsError("只有 candidate 恢复经验可以验证");

	let passed = false;
	try {
		passed =
			(await deterministicRunner({
				lesson: structuredClone(initial),
				lessonVersion: initial.version,
				matcherVersion: DETERMINISTIC_MATCHER_VERSION,
			})) === true;
	} catch {
		passed = false;
	}

	return await withStoreLock(agentDir, async (paths) => {
		const snapshot = (await loadStore(paths)).snapshot;
		const current = findLesson(snapshot, id);
		if (current.version !== initial.version || JSON.stringify(current.matcher) !== JSON.stringify(initial.matcher)) {
			throw new ToolRecoveryLessonVersionConflictError(`恢复经验“${id}”在 replay 期间已变化`);
		}
		if (effectiveStatus(current, options.now ?? new Date()) === "expired") {
			throw new ToolRecoveryLessonsError("已过期的恢复经验不能验证");
		}
		if (current.status !== "candidate") throw new ToolRecoveryLessonsError("只有 candidate 恢复经验可以验证");
		const time = nowIso(options);
		const next: ToolRecoveryLesson = {
			...current,
			status: passed ? "verified" : "candidate",
			version: current.version + 1,
			updatedAt: time,
		};
		snapshot.lessons[snapshot.lessons.indexOf(current)] = next;
		await commit(paths, snapshot, historyEntry("verify", "replay", time, current, next), options);
		return presentLesson(next, options.now ?? new Date());
	});
}

/** 受控自动晋升默认关闭，safe_refresh 始终保留人工 approve 路径。 */
export async function autoPromoteToolRecoveryLesson(
	agentDir: string,
	id: string,
	expectedVersion: number,
	options: AutoPromoteToolRecoveryLessonOptions = {},
): Promise<ToolRecoveryLesson> {
	if (options.enabled !== true) throw new ToolRecoveryLessonsError("自动晋升未显式开启");
	return await withStoreLock(agentDir, async (paths) => {
		const snapshot = (await loadStore(paths)).snapshot;
		const current = findLesson(snapshot, id);
		assertExpectedVersion(current, expectedVersion);
		if (effectiveStatus(current, options.now ?? new Date()) === "expired") {
			throw new ToolRecoveryLessonsError("已过期的恢复经验不能自动晋升");
		}
		const { evidence, matcher } = current;
		const versionMatches =
			matcher.toolVersionRange === undefined ||
			(options.toolVersion !== undefined && satisfies(options.toolVersion, matcher.toolVersionRange));
		if (
			current.status !== "verified" ||
			current.allowedAction !== "guidance" ||
			!meetsDeterministicVerificationThreshold(evidence) ||
			(current.scope === "project" && !current.scopeHash) ||
			!isMatcher(matcher) ||
			!versionMatches ||
			hasUnsafeGuidance(current.guidance)
		) {
			throw new ToolRecoveryLessonsError("恢复经验未满足自动晋升门槛");
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

function meetsDeterministicVerificationThreshold(evidence: ToolRecoveryLessonEvidence): boolean {
	return (
		evidence.occurrences >= DETERMINISTIC_VERIFY_OCCURRENCES &&
		evidence.sessions >= DETERMINISTIC_VERIFY_SESSIONS &&
		evidence.recovered >= DETERMINISTIC_VERIFY_RECOVERED &&
		evidence.failed === 0 &&
		(evidence.terminalFailures ?? 0) === 0
	);
}

function deterministicGuidance(
	scopeHash: string,
	evidence: ReturnType<typeof consumeSessionRecoveryLedgerReceipt>,
): string | undefined {
	if (
		!evidence ||
		!SHA256.test(scopeHash) ||
		!TOOL_NAME.test(evidence.toolName) ||
		!isStableFailureCode(evidence.failureCode) ||
		!SHA256.test(evidence.failureFingerprint) ||
		NON_GENERALIZABLE_FAILURES.has(evidence.failureCode)
	) {
		return undefined;
	}
	return DETERMINISTIC_GUIDANCE.get(`${evidence.toolName}\u0000${evidence.failureCode}\u0000${evidence.action}`);
}

/** 只消费一次实际账本 append 生成的 receipt；候选计数和 session hash 一律从 receipt 导出。 */
export async function recordDeterministicToolRecoveryCandidate(
	agentDir: string,
	input: DeterministicToolRecoveryCandidateInput,
	options: ToolRecoveryLessonsOptions = {},
): Promise<ToolRecoveryLesson | undefined> {
	if (!SHA256.test(input.scopeHash)) throw new ToolRecoveryLessonsError("scopeHash 必须是 SHA-256 摘要");
	const receipt = consumeSessionRecoveryLedgerReceipt(input.receipt);
	if (!receipt) throw new ToolRecoveryLessonsError("恢复候选必须使用实际账本 receipt");
	const guidance = deterministicGuidance(input.scopeHash, receipt);
	if (!guidance) return undefined;
	const fingerprintPrefix = receipt.failureFingerprint.slice(0, 16);
	return await withStoreLock(agentDir, async (paths) => {
		const snapshot = (await loadStore(paths)).snapshot;
		const current = snapshot.lessons.find(
			(lesson) =>
				effectiveStatus(lesson, options.now ?? new Date()) !== "expired" &&
				(lesson.status === "candidate" ||
					lesson.status === "verified" ||
					lesson.status === "active" ||
					lesson.status === "suspended") &&
				lesson.scope === "project" &&
				lesson.scopeHash === input.scopeHash &&
				lesson.matcher.toolName === receipt.toolName &&
				lesson.matcher.failureCode === receipt.failureCode &&
				lesson.matcher.fingerprintPrefix === fingerprintPrefix,
		);
		const currentCursor = current?.evidence.ledgerCursors?.find(
			(cursor) => cursor.sessionHash === receipt.sessionHash,
		);
		if (currentCursor && receipt.ledgerSequence !== undefined && receipt.ledgerSequence <= currentCursor.sequence) {
			return undefined;
		}
		if (current?.evidence.receiptHashes?.includes(receipt.entryHash)) return undefined;
		if (!current && receipt.outcome !== "recovered") return undefined;
		const time = nowIso(options);
		if (!current) {
			const expiresAt =
				input.expiresAt ?? new Date((options.now ?? new Date()).getTime() + DEFAULT_CANDIDATE_TTL_MS).toISOString();
			const lesson: ToolRecoveryLesson = {
				schema: 1,
				id: randomUUID(),
				status: "candidate",
				scope: "project",
				scopeHash: input.scopeHash,
				matcher: { toolName: receipt.toolName, failureCode: receipt.failureCode, fingerprintPrefix },
				guidance,
				allowedAction: "guidance",
				evidence: {
					occurrences: 1,
					sessions: 1,
					recovered: 1,
					failed: 0,
					attempts: 1,
					terminalFailures: 0,
					sessionHashes: [receipt.sessionHash],
					receiptHashes: [receipt.entryHash],
					...(receipt.ledgerSequence === undefined
						? {}
						: {
								ledgerCursors: [
									{
										sessionHash: receipt.sessionHash,
										sequence: receipt.ledgerSequence,
										entryHash: receipt.entryHash,
									},
								],
							}),
				},
				version: 1,
				expiresAt,
				createdAt: time,
				updatedAt: time,
			};
			if (!isLesson(lesson)) throw new ToolRecoveryLessonsError("确定性候选结构无效");
			snapshot.lessons.push(lesson);
			await commit(
				paths,
				snapshot,
				historyEntry("create", sourceOf({ ...options, source: options.source ?? "recovery" }), time, null, lesson),
				options,
			);
			return presentLesson(lesson, options.now ?? new Date());
		}

		const sessionHashes = current.evidence.sessionHashes;
		const nextSessionHashes = sessionHashes
			? sessionHashes.includes(receipt.sessionHash)
				? sessionHashes
				: [...sessionHashes, receipt.sessionHash]
			: undefined;
		const receiptHashes = current.evidence.receiptHashes ?? [];
		const ledgerCursors = current.evidence.ledgerCursors ? [...current.evidence.ledgerCursors] : [];
		if (receipt.ledgerSequence !== undefined) {
			const cursorIndex = ledgerCursors.findIndex((cursor) => cursor.sessionHash === receipt.sessionHash);
			const nextCursor = {
				sessionHash: receipt.sessionHash,
				sequence: receipt.ledgerSequence,
				entryHash: receipt.entryHash,
			};
			if (cursorIndex === -1) ledgerCursors.push(nextCursor);
			else ledgerCursors[cursorIndex] = nextCursor;
		}
		const nextEvidence: ToolRecoveryLessonEvidence = {
			occurrences: current.evidence.occurrences + 1,
			sessions: nextSessionHashes ? nextSessionHashes.length : current.evidence.sessions + 1,
			recovered: current.evidence.recovered + (receipt.outcome === "recovered" ? 1 : 0),
			failed:
				current.evidence.failed +
				(receipt.outcome === "failed" || receipt.outcome === "blocked" || receipt.outcome === "cancelled" ? 1 : 0),
			attempts: (current.evidence.attempts ?? current.evidence.occurrences) + 1,
			terminalFailures:
				(current.evidence.terminalFailures ?? current.evidence.failed) +
				(receipt.outcome === "failed" || receipt.outcome === "blocked" || receipt.outcome === "cancelled" ? 1 : 0),
			needsModel: (current.evidence.needsModel ?? 0) + (receipt.outcome === "needs_model" ? 1 : 0),
			blocked: (current.evidence.blocked ?? 0) + (receipt.outcome === "blocked" ? 1 : 0),
			cancelled: (current.evidence.cancelled ?? 0) + (receipt.outcome === "cancelled" ? 1 : 0),
			...(current.evidence.matched === undefined ? {} : { matched: current.evidence.matched }),
			...(current.evidence.guidanceShown === undefined ? {} : { guidanceShown: current.evidence.guidanceShown }),
			...(nextSessionHashes ? { sessionHashes: nextSessionHashes } : {}),
			receiptHashes: [...receiptHashes, receipt.entryHash].slice(-MAX_RECEIPT_HASHES),
			...(ledgerCursors.length > 0 ? { ledgerCursors } : {}),
		};
		const shouldSuspend =
			current.status === "active" &&
			(nextEvidence.terminalFailures ?? 0) >= 3 &&
			(nextEvidence.terminalFailures ?? 0) > nextEvidence.recovered;
		const shouldVerify =
			input.autoVerify === true &&
			current.status === "candidate" &&
			meetsDeterministicVerificationThreshold(nextEvidence);
		const next: ToolRecoveryLesson = {
			...current,
			status: shouldSuspend ? "suspended" : shouldVerify ? "verified" : current.status,
			evidence: nextEvidence,
			version: current.version + 1,
			updatedAt: time,
		};
		if (!isLesson(next)) throw new ToolRecoveryLessonsError("确定性候选更新无效");
		snapshot.lessons[snapshot.lessons.indexOf(current)] = next;
		await commit(
			paths,
			snapshot,
			historyEntry(
				shouldSuspend ? "disable" : shouldVerify ? "verify" : "update",
				sourceOf({ ...options, source: options.source ?? "recovery" }),
				time,
				current,
				next,
			),
			options,
		);
		return presentLesson(next, options.now ?? new Date());
	});
}

/**
 * 启动或恢复 Session 时重放已经落盘但可能尚未聚合到 Store 的 recovery ledger。
 * receiptHashes 让重复启动成为幂等操作；Store 锁保证多个进程不会并发破坏快照。
 */
export async function reconcileToolRecoveryLessons(
	agentDir: string,
	sessionPath: string,
	scopeHash: string,
	options: ToolRecoveryLessonsOptions = {},
): Promise<number> {
	if (!SHA256.test(scopeHash)) throw new ToolRecoveryLessonsError("scopeHash 必须是 SHA-256 摘要");
	const entries = await readSessionRecoveryLedger(agentDir, sessionPath);
	let applied = 0;
	for (const [index, entry] of entries.entries()) {
		const lesson = await recordDeterministicToolRecoveryCandidate(
			agentDir,
			{
				scopeHash,
				receipt: createSessionRecoveryLedgerReplayReceipt(entry, index + 1),
				autoVerify: true,
			},
			options,
		);
		if (lesson) applied++;
	}
	return applied;
}

function lessonMatchesRuntime(lesson: ToolRecoveryLesson, input: FindToolRecoveryLessonsInput, now: Date): boolean {
	if (effectiveStatus(lesson, now) === "expired") return false;
	if (lesson.matcher.toolName !== input.toolName || lesson.matcher.failureCode !== input.failureCode) return false;
	if (lesson.matcher.fingerprintPrefix && !input.failureFingerprint.startsWith(lesson.matcher.fingerprintPrefix))
		return false;
	return (
		lesson.matcher.toolVersionRange === undefined ||
		(input.toolVersion !== undefined && satisfies(input.toolVersion, lesson.matcher.toolVersionRange))
	);
}

/** 查询 active/verified guidance；暂停命中仅供本地 metrics 记录。 */
export async function findMatchingToolRecoveryLessons(
	agentDir: string,
	input: FindToolRecoveryLessonsInput,
): Promise<FindToolRecoveryLessonsResult> {
	const now = input.now ?? new Date();
	return await withStoreLock(agentDir, async (paths) => {
		const snapshot = (await loadStore(paths)).snapshot;
		const matching = snapshot.lessons.filter(
			(lesson) =>
				lessonMatchesRuntime(lesson, input, now) &&
				(lesson.scope === "global" || (lesson.scope === "project" && lesson.scopeHash === input.scopeHash)),
		);
		const suspendedLessonIds = matching.filter((lesson) => lesson.status === "suspended").map((lesson) => lesson.id);
		const rank = (lesson: ToolRecoveryLesson) =>
			(lesson.scope === "project" && lesson.scopeHash === input.scopeHash ? 0 : 2) +
			(lesson.matcher.fingerprintPrefix ? 0 : 1);
		const lessons = matching
			.filter(
				(lesson) =>
					(lesson.status === "active" || lesson.status === "verified") &&
					(lesson.scope === "global" || (lesson.scope === "project" && lesson.scopeHash === input.scopeHash)),
			)
			.sort(
				(left, right) =>
					rank(left) - rank(right) ||
					right.updatedAt.localeCompare(left.updatedAt) ||
					left.id.localeCompare(right.id),
			)
			.slice(0, 3)
			.map((lesson) => presentLesson(lesson, now));
		return { lessons, suspendedLessonIds };
	});
}

function lessonRelevanceScore(lesson: ToolRecoveryLesson, input: FindRelevantToolRecoveryLessonsInput): number {
	const text = input.taskText.toLocaleLowerCase();
	if (!new Set(input.toolNames).has(lesson.matcher.toolName)) return -1;
	let score = lesson.scope === "project" && lesson.scopeHash === input.scopeHash ? 8 : 0;
	if (lesson.status === "verified") score += 2;
	if (text.includes(lesson.matcher.toolName.toLocaleLowerCase())) score += 2;
	if (text.includes(lesson.matcher.failureCode.toLocaleLowerCase())) score += 2;
	for (const token of lesson.guidance
		.toLocaleLowerCase()
		.split(/[^\p{L}\p{N}_-]+/u)
		.filter(Boolean)) {
		if (token.length >= 2 && text.includes(token)) score++;
	}
	return score;
}

export async function findRelevantToolRecoveryLessons(
	agentDir: string,
	input: FindRelevantToolRecoveryLessonsInput,
): Promise<FindRelevantToolRecoveryLessonsResult> {
	const now = input.now ?? new Date();
	return await withStoreLock(agentDir, async (paths) => {
		const snapshot = (await loadStore(paths)).snapshot;
		const candidates = snapshot.lessons.filter(
			(lesson) =>
				(lesson.status === "active" || lesson.status === "verified") &&
				effectiveStatus(lesson, now) === lesson.status &&
				(lesson.scope === "global" || (lesson.scope === "project" && lesson.scopeHash === input.scopeHash)),
		);
		const lessons = candidates
			.map((lesson) => ({ lesson, score: lessonRelevanceScore(lesson, input) }))
			.filter(({ score }) => score >= 10)
			.sort((left, right) => right.score - left.score || right.lesson.updatedAt.localeCompare(left.lesson.updatedAt))
			.slice(0, 3)
			.map(({ lesson }) => presentLesson(lesson, now));
		return { lessons, suspendedLessonIds: [] };
	});
}

/** 记录 active 或 verified lesson 的运行时命中，不执行经验中的任意动作。 */
export async function recordToolRecoveryLessonUsage(
	agentDir: string,
	lessonIds: readonly string[],
	options: ToolRecoveryLessonUsageOptions = {},
): Promise<void> {
	const ids = new Set(lessonIds);
	if (ids.size === 0) return;
	await withStoreLock(agentDir, async (paths) => {
		const snapshot = (await loadStore(paths)).snapshot;
		const time = nowIso(options);
		const entries: ToolRecoveryLessonHistoryEntry[] = [];
		for (const current of snapshot.lessons) {
			if (
				!ids.has(current.id) ||
				(current.status !== "active" && current.status !== "verified") ||
				effectiveStatus(current, options.now ?? new Date()) !== current.status
			) {
				continue;
			}
			const next: ToolRecoveryLesson = {
				...current,
				evidence: {
					...current.evidence,
					matched: (current.evidence.matched ?? 0) + 1,
					...(options.guidanceShown ? { guidanceShown: (current.evidence.guidanceShown ?? 0) + 1 } : {}),
				},
				version: current.version + 1,
				updatedAt: time,
			};
			if (!isLesson(next)) throw new ToolRecoveryLessonsError("恢复经验命中证据无效");
			snapshot.lessons[snapshot.lessons.indexOf(current)] = next;
			entries.push(
				historyEntry("update", sourceOf({ ...options, source: options.source ?? "runtime" }), time, current, next),
			);
		}
		if (entries.length > 0) await commit(paths, snapshot, entries, options);
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
		const target = (await readAllHistoryEntries(paths, history)).find((entry) => entry.id === historyId);
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
