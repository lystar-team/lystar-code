import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

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
	action: "observe";
	outcome: "recovered" | "failed" | "needs_model" | "blocked" | "cancelled";
	durationMs: number;
	createdAt: string;
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
const OUTCOMES = new Set<RecoveryLedgerEntry["outcome"]>([
	"recovered",
	"failed",
	"needs_model",
	"blocked",
	"cancelled",
]);
const ledgerQueues = new Map<string, Promise<void>>();

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
		SAFE_IDENTIFIER.test(entry.sessionId) &&
		typeof entry.turnId === "string" &&
		SAFE_IDENTIFIER.test(entry.turnId) &&
		typeof entry.toolCallId === "string" &&
		SAFE_IDENTIFIER.test(entry.toolCallId) &&
		typeof entry.toolName === "string" &&
		SAFE_IDENTIFIER.test(entry.toolName) &&
		typeof entry.callSignature === "string" &&
		typeof entry.failureFingerprint === "string" &&
		typeof entry.failureCode === "string" &&
		SAFE_IDENTIFIER.test(entry.failureCode) &&
		typeof entry.attempt === "number" &&
		Number.isSafeInteger(entry.attempt) &&
		entry.attempt >= 1 &&
		entry.action === "observe" &&
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
	if (!isLedgerEntry(entry)) {
		throw new Error("Invalid recovery ledger entry");
	}
}

async function parseLedger(path: string): Promise<RecoveryLedgerEntry[]> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const lines = content.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const entries: RecoveryLedgerEntry[] = [];
	for (let index = 0; index < lines.length; index++) {
		try {
			const entry = JSON.parse(lines[index]!);
			if (!isLedgerEntry(entry)) throw new Error("Invalid recovery ledger entry");
			entries.push(entry);
		} catch (error) {
			if (index === lines.length - 1) continue;
			throw error;
		}
	}
	return entries;
}

async function canonicalSessionPath(sessionPath: string): Promise<string> {
	const resolved = resolve(sessionPath);
	try {
		return await realpath(resolved);
	} catch {
		return join(await realpath(dirname(resolved)), basename(resolved));
	}
}

async function ledgerPath(agentDir: string, sessionPath: string): Promise<string> {
	const canonicalPath = await canonicalSessionPath(sessionPath);
	return join(resolve(agentDir), "tool-recovery", "sessions", `${sha256(canonicalPath)}.jsonl`);
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
		retries: { retries: 100, factor: 1, minTimeout: 1, maxTimeout: 5 },
	});
}

export async function getSessionRecoveryLedgerPath(agentDir: string, sessionPath: string): Promise<string> {
	return await ledgerPath(agentDir, sessionPath);
}

export async function readSessionRecoveryLedger(agentDir: string, sessionPath: string): Promise<RecoveryLedgerEntry[]> {
	return await parseLedger(await ledgerPath(agentDir, sessionPath));
}

export async function appendSessionRecoveryLedger(
	agentDir: string,
	sessionPath: string,
	entry: RecoveryLedgerEntry,
): Promise<boolean> {
	assertLedgerEntry(entry);
	const path = await ledgerPath(agentDir, sessionPath);
	await mkdir(dirname(path), { recursive: true });
	return await withLedgerQueue(path, async () => {
		const release = await acquireLedgerLock(path);
		try {
			const entries = await parseLedger(path);
			if (entries.some((existing) => existing.id === entry.id)) return false;
			await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
			return true;
		} finally {
			await release();
		}
	});
}

export async function removeSessionRecoveryLedger(agentDir: string, sessionPath: string): Promise<void> {
	const path = await ledgerPath(agentDir, sessionPath);
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
	const knownLedgers = await collectSessionLedgerNames(agentDir);
	let removed = 0;
	try {
		const files = await readdir(directory, { withFileTypes: true });
		for (const file of files) {
			if (!file.isFile() || !/^[a-f0-9]{64}\.jsonl$/.test(file.name) || knownLedgers.has(file.name)) continue;
			const path = join(directory, file.name);
			if (now - (await stat(path)).mtimeMs < ttlMs) continue;
			await rm(path, { force: true });
			removed++;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
	return removed;
}

function opaqueIdentifier(value: string): string {
	return SAFE_IDENTIFIER.test(value) ? value : sha256(value);
}

function normalizeFailureCode(value: string): string {
	return /^[A-Z][A-Z_]{0,63}$/.test(value) ? value : "UNCLASSIFIED";
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
		toolName: opaqueIdentifier(input.toolName),
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
