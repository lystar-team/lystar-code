import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { isStableFailureCode } from "./registry.ts";

export interface RecoveryLedgerEntry {
	schema: 1;
	id: string;
	sessionId: string;
	turnId: string;
	toolCallId: string;
	toolName: string;
	callSignature: string;
	failureFingerprint: string;
	failureCode: string;
	attempt: number;
	action:
		| "observe"
		| "accept_as_success"
		| "retry_same_args"
		| "refresh_context"
		| "ask_model_to_rebuild"
		| "require_user"
		| "stop";
	outcome: "recovered" | "failed" | "needs_model" | "blocked" | "cancelled";
	durationMs: number;
	createdAt: string;
}

export interface SessionRecoveryLedgerKey {
	path: string;
}

/**
 * 账本成功落盘后才在本进程内生成。结构可读，真实性由模块私有 WeakSet 验证。
 */
export interface SessionRecoveryLedgerReceipt {
	readonly entryHash: string;
	readonly sessionHash: string;
	readonly ledgerSequence?: number;
	readonly toolName: string;
	readonly failureCode: string;
	readonly failureFingerprint: string;
	readonly action: RecoveryLedgerEntry["action"];
	readonly outcome: RecoveryLedgerEntry["outcome"];
}

export interface SessionRecoveryLedgerReceiptEvidence {
	entryHash: string;
	sessionHash: string;
	ledgerSequence?: number;
	toolName: string;
	failureCode: string;
	failureFingerprint: string;
	action: RecoveryLedgerEntry["action"];
	outcome: RecoveryLedgerEntry["outcome"];
}

const LEDGER_KEYS = [
	"schema",
	"id",
	"sessionId",
	"turnId",
	"toolCallId",
	"toolName",
	"callSignature",
	"failureFingerprint",
	"failureCode",
	"attempt",
	"action",
	"outcome",
	"durationMs",
	"createdAt",
] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const OUTCOMES = new Set<RecoveryLedgerEntry["outcome"]>([
	"recovered",
	"failed",
	"needs_model",
	"blocked",
	"cancelled",
]);
const ACTIONS = new Set<RecoveryLedgerEntry["action"]>([
	"observe",
	"accept_as_success",
	"retry_same_args",
	"refresh_context",
	"ask_model_to_rebuild",
	"require_user",
	"stop",
]);
const ledgerQueues = new Map<string, Promise<void>>();
const ledgerReceipts = new WeakSet<SessionRecoveryLedgerReceipt>();
const consumedLedgerReceipts = new WeakSet<SessionRecoveryLedgerReceipt>();

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function hasExactKeys(value: Record<string, unknown>): boolean {
	const keys = Object.keys(value);
	return keys.length === LEDGER_KEYS.length && keys.every((key) => (LEDGER_KEYS as readonly string[]).includes(key));
}

function isLedgerEntry(value: unknown): value is RecoveryLedgerEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	return (
		hasExactKeys(entry) &&
		entry.schema === 1 &&
		typeof entry.id === "string" &&
		SAFE_IDENTIFIER.test(entry.id) &&
		typeof entry.sessionId === "string" &&
		SHA256.test(entry.sessionId) &&
		typeof entry.turnId === "string" &&
		SHA256.test(entry.turnId) &&
		typeof entry.toolCallId === "string" &&
		SHA256.test(entry.toolCallId) &&
		typeof entry.toolName === "string" &&
		TOOL_NAME.test(entry.toolName) &&
		typeof entry.callSignature === "string" &&
		typeof entry.failureFingerprint === "string" &&
		typeof entry.failureCode === "string" &&
		isStableFailureCode(entry.failureCode) &&
		typeof entry.attempt === "number" &&
		Number.isSafeInteger(entry.attempt) &&
		entry.attempt >= 1 &&
		typeof entry.action === "string" &&
		ACTIONS.has(entry.action as RecoveryLedgerEntry["action"]) &&
		typeof entry.outcome === "string" &&
		OUTCOMES.has(entry.outcome as RecoveryLedgerEntry["outcome"]) &&
		typeof entry.durationMs === "number" &&
		Number.isFinite(entry.durationMs) &&
		entry.durationMs >= 0 &&
		typeof entry.createdAt === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(entry.createdAt) &&
		SHA256.test(entry.callSignature) &&
		SHA256.test(entry.failureFingerprint)
	);
}

function assertLedgerEntry(entry: RecoveryLedgerEntry): void {
	if (!isLedgerEntry(entry)) throw new Error("Invalid recovery ledger entry");
}

function createLedgerReceipt(entry: RecoveryLedgerEntry, ledgerSequence?: number): SessionRecoveryLedgerReceipt {
	const receipt = Object.freeze({
		entryHash: sha256(JSON.stringify(entry)),
		sessionHash: entry.sessionId,
		...(ledgerSequence === undefined ? {} : { ledgerSequence }),
		toolName: entry.toolName,
		failureCode: entry.failureCode,
		failureFingerprint: entry.failureFingerprint,
		action: entry.action,
		outcome: entry.outcome,
	});
	ledgerReceipts.add(receipt);
	return receipt;
}

/**
 * 从已校验的持久化账本条目重建一次性 receipt，供启动时补偿聚合使用。
 * 调用方必须先通过 readSessionRecoveryLedger() 读取条目，不能把普通对象直接当成可信证据。
 */
export function createSessionRecoveryLedgerReplayReceipt(
	entry: RecoveryLedgerEntry,
	ledgerSequence?: number,
): SessionRecoveryLedgerReceipt {
	assertLedgerEntry(entry);
	if (ledgerSequence !== undefined && (!Number.isSafeInteger(ledgerSequence) || ledgerSequence < 1)) {
		throw new Error("Invalid recovery ledger sequence");
	}
	return createLedgerReceipt(entry, ledgerSequence);
}

/**
 * 只允许候选聚合消费一次由账本实际条目导出的证据，普通对象和重复消费都会被拒绝。
 */
export function consumeSessionRecoveryLedgerReceipt(
	receipt: unknown,
): SessionRecoveryLedgerReceiptEvidence | undefined {
	if (
		typeof receipt !== "object" ||
		receipt === null ||
		!ledgerReceipts.has(receipt as SessionRecoveryLedgerReceipt) ||
		consumedLedgerReceipts.has(receipt as SessionRecoveryLedgerReceipt)
	) {
		return undefined;
	}
	const verified = receipt as SessionRecoveryLedgerReceipt;
	consumedLedgerReceipts.add(verified);
	return {
		entryHash: verified.entryHash,
		sessionHash: verified.sessionHash,
		...(verified.ledgerSequence === undefined ? {} : { ledgerSequence: verified.ledgerSequence }),
		toolName: verified.toolName,
		failureCode: verified.failureCode,
		failureFingerprint: verified.failureFingerprint,
		action: verified.action,
		outcome: verified.outcome,
	};
}

async function readLedgerContent(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

function parseLedgerContent(content: string): { entries: RecoveryLedgerEntry[]; repairedContent: string } {
	if (content.length === 0) return { entries: [], repairedContent: content };
	const entries: RecoveryLedgerEntry[] = [];
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
			if (!isLedgerEntry(entry)) throw new Error("Invalid recovery ledger entry");
			entries.push(entry);
			validEnd = newline === -1 ? content.length : nextOffset;
			offset = nextOffset;
		} catch {
			// 只允许修复最后一个损坏尾部，不能跳过中间损坏后继续解释账本。
			const remainder = content.slice(nextOffset);
			if (remainder.split("\n").some((candidate) => candidate.length > 0)) {
				throw new Error("Invalid recovery ledger entry");
			}
			return { entries, repairedContent: content.slice(0, validEnd) };
		}
	}
	return { entries, repairedContent: content.endsWith("\n") ? content : `${content}\n` };
}

async function parseLedger(path: string): Promise<RecoveryLedgerEntry[]> {
	return parseLedgerContent(await readLedgerContent(path)).entries;
}

async function rewriteLedgerAtomically(path: string, content: string): Promise<void> {
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporaryPath, "wx");
	try {
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await rename(temporaryPath, path);
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

async function repairLedgerTail(path: string): Promise<RecoveryLedgerEntry[]> {
	const content = await readLedgerContent(path);
	const parsed = parseLedgerContent(content);
	if (parsed.repairedContent !== content) await rewriteLedgerAtomically(path, parsed.repairedContent);
	return parsed.entries;
}

async function canonicalSessionPath(sessionPath: string): Promise<string> {
	const resolved = resolve(sessionPath);
	try {
		return await realpath(resolved);
	} catch {
		return join(await realpath(dirname(resolved)), basename(resolved));
	}
}

async function ledgerKey(agentDir: string, sessionPath: string): Promise<SessionRecoveryLedgerKey> {
	const canonicalPath = await canonicalSessionPath(sessionPath);
	return { path: join(resolve(agentDir), "tool-recovery", "sessions", `${sha256(canonicalPath)}.jsonl`) };
}

async function withLedgerQueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const previous = ledgerQueues.get(path);
	let release: () => void = () => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	ledgerQueues.set(path, current);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (ledgerQueues.get(path) === current) ledgerQueues.delete(path);
	}
}

async function acquireLedgerLock(path: string): Promise<() => Promise<void>> {
	const file = await open(path, "a");
	await file.close();
	return await lockfile.lock(path, {
		realpath: false,
		retries: { retries: 2_000, factor: 1, minTimeout: 1, maxTimeout: 5, maxRetryTime: 10_000 },
	});
}

async function removeLedgerPath(path: string): Promise<void> {
	try {
		await withLedgerQueue(path, async () => {
			const release = await acquireLedgerLock(path);
			try {
				await rm(path, { force: true });
			} finally {
				await release();
			}
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function getSessionRecoveryLedgerKey(
	agentDir: string,
	sessionPath: string,
): Promise<SessionRecoveryLedgerKey> {
	return await ledgerKey(agentDir, sessionPath);
}

export async function getSessionRecoveryLedgerPath(agentDir: string, sessionPath: string): Promise<string> {
	return (await ledgerKey(agentDir, sessionPath)).path;
}

export async function readSessionRecoveryLedger(agentDir: string, sessionPath: string): Promise<RecoveryLedgerEntry[]> {
	return await parseLedger((await ledgerKey(agentDir, sessionPath)).path);
}

export async function appendSessionRecoveryLedger(
	agentDir: string,
	sessionPath: string,
	entry: RecoveryLedgerEntry,
): Promise<SessionRecoveryLedgerReceipt | undefined> {
	assertLedgerEntry(entry);
	const path = (await ledgerKey(agentDir, sessionPath)).path;
	await mkdir(dirname(path), { recursive: true });
	return await withLedgerQueue(path, async () => {
		const release = await acquireLedgerLock(path);
		try {
			const entries = await repairLedgerTail(path);
			if (entries.some((existing) => existing.id === entry.id)) return undefined;
			await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
			return createLedgerReceipt(entry);
		} finally {
			await release();
		}
	});
}

export async function removeSessionRecoveryLedger(agentDir: string, sessionPath: string): Promise<void> {
	await removeLedgerPath((await ledgerKey(agentDir, sessionPath)).path);
}

/**
 * 删除会话前固定账本 key，成功删除会话后才在同一账本队列和锁内清理账本。
 * 回调抛错时保留账本，避免删除失败造成恢复证据丢失。
 */
export async function deleteSessionWithRecoveryLedger<T>(
	agentDir: string,
	sessionPath: string,
	deleteSession: () => Promise<T> | T,
): Promise<T> {
	const key = await ledgerKey(agentDir, sessionPath);
	const result = await deleteSession();
	await removeLedgerPath(key.path);
	return result;
}

async function collectSessionLedgerNames(agentDir: string): Promise<Set<string>> {
	const names = new Set<string>();
	const visit = async (directory: string): Promise<void> => {
		try {
			const entries = await readdir(directory, { withFileTypes: true });
			for (const entry of entries) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) {
					await visit(path);
				} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
					names.add(`${sha256(await canonicalSessionPath(path))}.jsonl`);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	};
	await visit(join(resolve(agentDir), "sessions"));
	return names;
}

export async function cleanupOrphanRecoveryLedgers(
	agentDir: string,
	options: { now?: number; ttlMs?: number } = {},
): Promise<number> {
	const now = options.now ?? Date.now();
	const ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
	const directory = join(resolve(agentDir), "tool-recovery", "sessions");
	let removed = 0;
	try {
		const files = await readdir(directory, { withFileTypes: true });
		for (const file of files) {
			if (!file.isFile() || !/^[a-f0-9]{64}\.jsonl$/.test(file.name)) continue;
			const path = join(directory, file.name);
			if (ttlMs > 0 && now - (await stat(path)).mtimeMs < ttlMs) continue;
			await withLedgerQueue(path, async () => {
				const release = await acquireLedgerLock(path);
				try {
					const latest = await stat(path).catch((error: NodeJS.ErrnoException) =>
						error.code === "ENOENT" ? undefined : Promise.reject(error),
					);
					if (!latest || (ttlMs > 0 && now - latest.mtimeMs < ttlMs)) return;
					// 等待同一账本锁后再扫描真实 Session 根，避免删除刚恢复活动的账本。
					if ((await collectSessionLedgerNames(agentDir)).has(file.name)) return;
					await rm(path, { force: true });
					removed++;
				} finally {
					await release();
				}
			});
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
	return removed;
}

function opaqueIdentifier(value: string): string {
	return sha256(value);
}

function normalizeToolName(value: string): string {
	return TOOL_NAME.test(value) ? value : "unknown";
}

function normalizeFailureCode(value: string): string {
	return isStableFailureCode(value) ? value : "UNCLASSIFIED";
}

export function createRecoveryLedgerEntry(
	input: Omit<RecoveryLedgerEntry, "schema" | "id" | "sessionId" | "turnId" | "toolCallId"> & {
		sessionId: string;
		turnId: string;
		toolCallId: string;
	},
): RecoveryLedgerEntry {
	const entry: RecoveryLedgerEntry = {
		schema: 1,
		id: randomUUID(),
		sessionId: opaqueIdentifier(input.sessionId),
		turnId: opaqueIdentifier(input.turnId),
		toolCallId: opaqueIdentifier(input.toolCallId),
		toolName: normalizeToolName(input.toolName),
		callSignature: input.callSignature,
		failureFingerprint: input.failureFingerprint,
		failureCode: normalizeFailureCode(input.failureCode),
		attempt: input.attempt,
		action: input.action,
		outcome: input.outcome,
		durationMs: Math.max(0, input.durationMs),
		createdAt: input.createdAt,
	};
	assertLedgerEntry(entry);
	return entry;
}
