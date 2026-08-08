import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
} from "../../core/session-manager.ts";

const READ_BUFFER_SIZE = 64 * 1024;
const CURSOR_VERSION = 1;

type RewriteGeneration = {
	size: number;
	tailHash: string;
	device: number;
	inode: number;
};

type TranscriptCursor = {
	version: number;
	sessionId: string;
	leafId: string;
	offset: number;
	wantedId: string | null;
	rewriteGeneration: RewriteGeneration;
	resetGeneration: number;
};

export interface TranscriptPage {
	entries: SessionEntry[];
	previousCursor?: string;
	hasMore: boolean;
}

export interface TranscriptSource {
	readTail(options: { leafId: string | null; limit: number }): Promise<TranscriptPage>;
	readPrevious(cursor: string, limit: number): Promise<TranscriptPage>;
	reset(leafId: string | null): void;
}

export class TranscriptCursorInvalidError extends Error {
	constructor(message = "Transcript cursor is no longer valid; read the tail again") {
		super(message);
		this.name = "TranscriptCursorInvalidError";
	}
}

export class TranscriptMigrationRequiredError extends Error {
	constructor(version: number | undefined) {
		super(`Session version ${version ?? 1} requires a full open and migration before transcript pagination`);
		this.name = "TranscriptMigrationRequiredError";
	}
}

export class TranscriptSessionFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TranscriptSessionFormatError";
	}
}

function parseSessionEntryLine(line: Buffer): FileEntry | null {
	const text = line.toString("utf8");
	if (!text.trim()) return null;
	try {
		return JSON.parse(text) as FileEntry;
	} catch {
		// 与 SessionManager.loadEntriesFromFile() 保持一致，跳过坏行。
		return null;
	}
}

function isSessionHeader(entry: FileEntry): entry is SessionHeader {
	return entry.type === "session" && typeof entry.id === "string";
}

function isChainEntry(entry: FileEntry): entry is SessionEntry {
	return entry.type !== "session" && typeof entry.id === "string";
}

function parentIdOf(entry: SessionEntry): string | null {
	return typeof entry.parentId === "string" ? entry.parentId : null;
}

export function isTuiVisibleSessionEntry(entry: SessionEntry): boolean {
	switch (entry.type) {
		case "message":
		case "custom":
		case "compaction":
		case "branch_summary":
			return true;
		case "custom_message":
			return entry.display;
		default:
			return false;
	}
}

function encodeCursor(cursor: TranscriptCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): TranscriptCursor {
	try {
		const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<TranscriptCursor>;
		if (
			cursor.version !== CURSOR_VERSION ||
			typeof cursor.sessionId !== "string" ||
			typeof cursor.leafId !== "string" ||
			typeof cursor.offset !== "number" ||
			(cursor.wantedId !== null && typeof cursor.wantedId !== "string") ||
			!cursor.rewriteGeneration ||
			typeof cursor.rewriteGeneration.size !== "number" ||
			typeof cursor.rewriteGeneration.tailHash !== "string" ||
			typeof cursor.rewriteGeneration.device !== "number" ||
			typeof cursor.rewriteGeneration.inode !== "number" ||
			typeof cursor.resetGeneration !== "number"
		) {
			throw new Error("invalid cursor");
		}
		return cursor as TranscriptCursor;
	} catch {
		throw new TranscriptCursorInvalidError("Transcript cursor is malformed");
	}
}

function validateLimit(limit: number): void {
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new RangeError("Transcript page limit must be a positive integer");
	}
}

async function readAt(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
	const buffer = Buffer.allocUnsafe(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead);
}

async function readSessionHeader(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<SessionHeader> {
	let position = 0;
	let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

	while (position < size) {
		const chunk = await readAt(handle, position, Math.min(READ_BUFFER_SIZE, size - position));
		if (chunk.length === 0) break;
		position += chunk.length;
		const data = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
		let lineStart = 0;
		for (let newline = data.indexOf(0x0a, lineStart); newline !== -1; newline = data.indexOf(0x0a, lineStart)) {
			const entry = parseSessionEntryLine(data.subarray(lineStart, newline));
			if (entry) {
				if (!isSessionHeader(entry)) {
					throw new TranscriptSessionFormatError("Session file has no valid session header");
				}
				return entry;
			}
			lineStart = newline + 1;
		}
		pending = data.subarray(lineStart);
	}

	const finalEntry = parseSessionEntryLine(pending);
	if (finalEntry && isSessionHeader(finalEntry)) return finalEntry;
	throw new TranscriptSessionFormatError("Session file has no valid session header");
}

async function hashTail(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<string> {
	const length = Math.min(READ_BUFFER_SIZE, size);
	const hash = createHash("sha256");
	hash.update(await readAt(handle, size - length, length));
	return hash.digest("base64url");
}

async function scanLinesReverse(
	handle: Awaited<ReturnType<typeof open>>,
	offset: number,
	onLine: (line: Buffer, previousOffset: number) => boolean,
): Promise<number> {
	let end = offset;
	let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

	while (end > 0) {
		const start = Math.max(0, end - READ_BUFFER_SIZE);
		const chunk = await readAt(handle, start, end - start);
		const data = pending.length === 0 ? chunk : Buffer.concat([chunk, pending]);
		let lineEnd = data.length;

		for (let index = data.length - 1; index >= 0; index--) {
			if (data[index] !== 0x0a) continue;
			if (onLine(data.subarray(index + 1, lineEnd), start + index)) {
				return start + index;
			}
			lineEnd = index;
		}

		pending = data.subarray(0, lineEnd);
		end = start;
	}

	if (pending.length > 0) onLine(pending, 0);
	return 0;
}

export class SessionTranscriptSource implements TranscriptSource {
	private resetGeneration = 0;
	private readonly sessionFile: string;

	constructor(sessionFile: string) {
		this.sessionFile = sessionFile;
	}

	reset(_leafId: string | null): void {
		this.resetGeneration++;
	}

	async readTail(options: { leafId: string | null; limit: number }): Promise<TranscriptPage> {
		validateLimit(options.limit);
		this.reset(options.leafId);

		const handle = await open(resolve(this.sessionFile), "r");
		try {
			const stat = await handle.stat();
			const header = await readSessionHeader(handle, stat.size);
			this.assertCurrentVersion(header);
			const rewriteGeneration = await this.createRewriteGeneration(handle, stat.size, stat.dev, stat.ino);
			return await this.readPage(
				handle,
				header,
				rewriteGeneration,
				options.leafId,
				stat.size,
				options.leafId,
				options.limit,
			);
		} finally {
			await handle.close();
		}
	}

	async readPrevious(cursorValue: string, limit: number): Promise<TranscriptPage> {
		validateLimit(limit);
		const cursor = decodeCursor(cursorValue);
		if (cursor.resetGeneration !== this.resetGeneration) {
			throw new TranscriptCursorInvalidError();
		}

		const handle = await open(resolve(this.sessionFile), "r");
		try {
			const stat = await handle.stat();
			const header = await readSessionHeader(handle, stat.size);
			this.assertCurrentVersion(header);
			if (header.id !== cursor.sessionId) {
				throw new TranscriptCursorInvalidError("Transcript cursor belongs to another session");
			}
			await this.assertRewriteGeneration(handle, stat.size, stat.dev, stat.ino, cursor.rewriteGeneration);
			return await this.readPage(
				handle,
				header,
				cursor.rewriteGeneration,
				cursor.leafId,
				cursor.offset,
				cursor.wantedId,
				limit,
			);
		} finally {
			await handle.close();
		}
	}

	private assertCurrentVersion(header: SessionHeader): void {
		if (header.version !== CURRENT_SESSION_VERSION) {
			throw new TranscriptMigrationRequiredError(header.version);
		}
	}

	private async createRewriteGeneration(
		handle: Awaited<ReturnType<typeof open>>,
		size: number,
		device: number,
		inode: number,
	): Promise<RewriteGeneration> {
		return { size, tailHash: await hashTail(handle, size), device, inode };
	}

	private async assertRewriteGeneration(
		handle: Awaited<ReturnType<typeof open>>,
		size: number,
		device: number,
		inode: number,
		generation: RewriteGeneration,
	): Promise<void> {
		if (size < generation.size || device !== generation.device || inode !== generation.inode) {
			throw new TranscriptCursorInvalidError();
		}
		if ((await hashTail(handle, generation.size)) !== generation.tailHash) {
			throw new TranscriptCursorInvalidError();
		}
	}

	private async readPage(
		handle: Awaited<ReturnType<typeof open>>,
		header: SessionHeader,
		rewriteGeneration: RewriteGeneration,
		leafId: string | null,
		offset: number,
		wantedId: string | null,
		limit: number,
	): Promise<TranscriptPage> {
		const entries: SessionEntry[] = [];
		let resolvedLeafId = leafId;
		let nextWantedId = wantedId;
		let matchedWanted = wantedId === null;

		const nextOffset = await scanLinesReverse(handle, offset, (line) => {
			const entry = parseSessionEntryLine(line);
			if (!entry || !isChainEntry(entry)) return false;

			if (resolvedLeafId === null) {
				resolvedLeafId = entry.id;
				nextWantedId = entry.id;
			}
			if (entry.id !== nextWantedId) return false;

			matchedWanted = true;
			nextWantedId = parentIdOf(entry);
			if (isTuiVisibleSessionEntry(entry)) entries.push(entry);
			const splitsToolExchange = entry.type === "message" && entry.message.role === "toolResult";
			return entries.length >= limit && !splitsToolExchange;
		});

		entries.reverse();
		if (!matchedWanted || (nextOffset === 0 && nextWantedId !== null)) {
			throw new TranscriptCursorInvalidError("Transcript chain changed while reading the previous page");
		}
		const hasMore = nextWantedId !== null && nextOffset > 0;
		if (!hasMore || resolvedLeafId === null) {
			return { entries, hasMore: false };
		}

		return {
			entries,
			hasMore: true,
			previousCursor: encodeCursor({
				version: CURSOR_VERSION,
				sessionId: header.id,
				leafId: resolvedLeafId,
				offset: nextOffset,
				wantedId: nextWantedId,
				rewriteGeneration,
				resetGeneration: this.resetGeneration,
			}),
		};
	}
}
