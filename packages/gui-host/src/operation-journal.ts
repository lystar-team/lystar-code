import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	isOperationSnapshot,
	type JsonValue,
	type OperationSnapshot,
	type OperationStatus,
} from "@lystar/code-gui-protocol";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;

export class OperationPayloadMismatchError extends Error {
	readonly code = "operation_payload_mismatch" as const;
	readonly retryable = false as const;

	constructor() {
		super("The same client request ID was reused with a different payload");
		this.name = "OperationPayloadMismatchError";
	}
}

export class OperationJournalCorruptError extends Error {
	readonly code = "operation_journal_corrupt" as const;
	readonly retryable = false as const;
	readonly journalPath: string;

	constructor(journalPath: string, options?: ErrorOptions) {
		super(`Operation journal is corrupt: ${journalPath}`, options);
		this.name = "OperationJournalCorruptError";
		this.journalPath = journalPath;
	}
}

export function hashOperationPayload(payload: JsonValue): string {
	return createHash("sha256").update(stableJson(payload)).digest("base64url");
}

function stableJson(value: JsonValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
		.join(",")}}`;
}

function requestKey(clientInstanceId: string, clientRequestId: string): string {
	return `${clientInstanceId}\0${clientRequestId}`;
}

export class OperationJournal {
	readonly path: string;
	private readonly byId = new Map<string, OperationSnapshot>();
	private readonly byRequest = new Map<string, OperationSnapshot>();
	private corruptError?: OperationJournalCorruptError;

	constructor(path: string) {
		this.path = path;
		this.load();
	}

	accept(input: {
		clientInstanceId: string;
		clientRequestId: string;
		sessionPath: string;
		type: string;
		payloadHash: string;
	}): { operation: OperationSnapshot; duplicate: boolean } {
		this.assertWritable();
		const existing = this.find(input.clientInstanceId, input.clientRequestId, input.payloadHash);
		if (existing) return { operation: existing, duplicate: true };
		const now = Date.now();
		const operation: OperationSnapshot = {
			operationId: randomUUID(),
			clientInstanceId: input.clientInstanceId,
			clientRequestId: input.clientRequestId,
			sessionPath: input.sessionPath,
			type: input.type,
			status: "accepted",
			acceptedAt: now,
			updatedAt: now,
			payloadHash: input.payloadHash,
		};
		this.append(operation);
		return { operation, duplicate: false };
	}

	update(
		operationId: string,
		status: OperationStatus,
		options?: { progress?: JsonValue; result?: JsonValue; error?: string },
	): OperationSnapshot {
		this.assertWritable();
		const current = this.byId.get(operationId);
		if (!current) throw new Error(`Unknown operation: ${operationId}`);
		const { progress: _progress, result: _result, error: _error, ...base } = current;
		const operation: OperationSnapshot = {
			...base,
			status,
			updatedAt: Math.max(Date.now(), current.updatedAt + 1),
			...(options?.progress !== undefined ? { progress: options.progress } : {}),
			...(options?.result !== undefined ? { result: options.result } : {}),
			...(options?.error !== undefined ? { error: options.error } : {}),
		};
		this.append(operation);
		return operation;
	}

	get(operationId: string): OperationSnapshot | undefined {
		return this.byId.get(operationId);
	}

	find(clientInstanceId: string, clientRequestId: string, payloadHash: string): OperationSnapshot | undefined {
		const operation = this.byRequest.get(requestKey(clientInstanceId, clientRequestId));
		if (operation && operation.payloadHash !== payloadHash) throw new OperationPayloadMismatchError();
		return operation;
	}

	list(sessionPath?: string): OperationSnapshot[] {
		return [...this.byId.values()]
			.filter((operation) => !sessionPath || operation.sessionPath === sessionPath)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	markInterrupted(): OperationSnapshot[] {
		this.assertWritable();
		const interrupted: OperationSnapshot[] = [];
		for (const operation of this.byId.values()) {
			if (!["accepted", "running", "waiting_for_input"].includes(operation.status)) continue;
			interrupted.push(this.update(operation.operationId, "interrupted", { error: "host_restarted" }));
		}
		return interrupted;
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const lines = readFileSync(this.path, "utf8").split("\n");
			for (const line of lines) {
				if (!line.trim()) continue;
				const record: unknown = JSON.parse(line);
				if (!isOperationSnapshot(record)) throw new Error("invalid operation record");
				this.index(record);
			}
		} catch (error) {
			this.corruptError = new OperationJournalCorruptError(this.path, { cause: error });
		}
	}

	assertWritable(): void {
		if (this.corruptError) throw this.corruptError;
	}

	private append(operation: OperationSnapshot): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const fd = openSync(this.path, "a", 0o600);
		try {
			appendFileSync(fd, `${JSON.stringify(operation)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		this.index(operation);
		if (statSync(this.path).size > MAX_JOURNAL_BYTES) this.compact();
	}

	private index(operation: OperationSnapshot): void {
		this.byId.set(operation.operationId, operation);
		this.byRequest.set(requestKey(operation.clientInstanceId, operation.clientRequestId), operation);
	}

	private compact(): void {
		const cutoff = Date.now() - RETENTION_MS;
		const kept = [...this.byId.values()].filter(
			(operation) =>
				operation.updatedAt >= cutoff || ["accepted", "running", "waiting_for_input"].includes(operation.status),
		);
		const tempPath = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`);
		try {
			const fd = openSync(tempPath, "wx", 0o600);
			try {
				writeFileSync(
					fd,
					kept.map((operation) => JSON.stringify(operation)).join("\n") + (kept.length ? "\n" : ""),
				);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(tempPath, this.path);
			this.byId.clear();
			this.byRequest.clear();
			for (const operation of kept) this.index(operation);
		} finally {
			if (existsSync(tempPath)) unlinkSync(tempPath);
		}
	}
}
