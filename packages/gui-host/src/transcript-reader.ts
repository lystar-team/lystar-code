import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { JsonValue, TranscriptItem, TranscriptPage } from "@lystar/code-gui-protocol";

const READ_BUFFER_SIZE = 64 * 1024;
const CURSOR_VERSION = 1;

type RawEntry = Record<string, unknown> & { type: string; id?: string; parentId?: string | null; timestamp?: string };
type RewriteGeneration = { size: number; tailHash: string; device: number; inode: number };
type ObservedGeneration = RewriteGeneration & { generation: string; sessionId: string };
type TranscriptCursor = {
	version: number;
	sessionId: string;
	leafId: string;
	offset: number;
	wantedId: string | null;
	rewriteGeneration: RewriteGeneration;
};

export class TranscriptCursorInvalidError extends Error {
	readonly code = "transcript_cursor_invalid" as const;
	readonly retryable = true as const;

	constructor(message = "Transcript cursor is no longer valid; read the tail again") {
		super(message);
		this.name = "TranscriptCursorInvalidError";
	}
}

function parseLine(line: Buffer): RawEntry | null {
	if (!line.toString("utf8").trim()) return null;
	try {
		return JSON.parse(line.toString("utf8")) as RawEntry;
	} catch {
		return null;
	}
}

function isVisible(entry: RawEntry): boolean {
	if (["message", "custom", "compaction", "branch_summary"].includes(entry.type)) return true;
	return entry.type === "custom_message" && entry.display === true;
}

function toTranscriptItem(entry: RawEntry): TranscriptItem {
	return {
		entryId: entry.id!,
		parentId: typeof entry.parentId === "string" ? entry.parentId : null,
		timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
		kind: entry.type,
		payload: structuredClone(entry) as JsonValue,
	};
}

function encodeCursor(cursor: TranscriptCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): TranscriptCursor {
	try {
		const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as TranscriptCursor;
		if (cursor.version !== CURSOR_VERSION || !cursor.sessionId || !cursor.leafId || !cursor.rewriteGeneration) {
			throw new Error("invalid cursor");
		}
		return cursor;
	} catch {
		throw new TranscriptCursorInvalidError("Transcript cursor is malformed");
	}
}

async function readAt(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
	const buffer = Buffer.allocUnsafe(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead);
}

async function findCompleteSize(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<number> {
	let end = size;
	while (end > 0) {
		const start = Math.max(0, end - READ_BUFFER_SIZE);
		const chunk = await readAt(handle, start, end - start);
		for (let index = chunk.length - 1; index >= 0; index--) {
			if (chunk[index] === 0x0a) return start + index + 1;
		}
		end = start;
	}
	return 0;
}

async function hashTail(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<string> {
	const length = Math.min(READ_BUFFER_SIZE, size);
	return createHash("sha256")
		.update(await readAt(handle, size - length, length))
		.digest("base64url");
}

function fileGeneration(sessionId: string, stat: { dev: number; ino: number; birthtimeMs: number }): string {
	return `${sessionId}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

async function scanForward(
	handle: Awaited<ReturnType<typeof open>>,
	offset: number,
	onLine: (line: Buffer) => boolean,
): Promise<void> {
	let start = 0;
	let pending: Buffer[] = [];
	let pendingLength = 0;
	while (start < offset) {
		const chunk = await readAt(handle, start, Math.min(READ_BUFFER_SIZE, offset - start));
		let lineStart = 0;
		for (let index = 0; index < chunk.length; index++) {
			if (chunk[index] !== 0x0a) continue;
			const segment = chunk.subarray(lineStart, index);
			const line =
				pendingLength === 0 ? segment : Buffer.concat([...pending, segment], pendingLength + segment.length);
			pending = [];
			pendingLength = 0;
			if (onLine(line)) return;
			lineStart = index + 1;
		}
		if (lineStart < chunk.length) {
			const segment = chunk.subarray(lineStart);
			pending.push(segment);
			pendingLength += segment.length;
		}
		start += chunk.length;
	}
}

async function scanReverse(
	handle: Awaited<ReturnType<typeof open>>,
	offset: number,
	onLine: (line: Buffer, previousOffset: number) => boolean,
): Promise<number> {
	let end = offset;
	let pending: Buffer[] = [];
	let pendingLength = 0;
	while (end > 0) {
		const start = Math.max(0, end - READ_BUFFER_SIZE);
		const chunk = await readAt(handle, start, end - start);
		let lineEnd = chunk.length;
		for (let index = chunk.length - 1; index >= 0; index--) {
			if (chunk[index] !== 0x0a) continue;
			const segment = chunk.subarray(index + 1, lineEnd);
			const line =
				pendingLength === 0 ? segment : Buffer.concat([segment, ...pending], segment.length + pendingLength);
			pending = [];
			pendingLength = 0;
			if (onLine(line, start + index)) return start + index;
			lineEnd = index;
		}
		if (lineEnd > 0) {
			const segment = chunk.subarray(0, lineEnd);
			pending.unshift(segment);
			pendingLength += segment.length;
		}
		end = start;
	}
	if (pendingLength > 0) onLine(Buffer.concat(pending, pendingLength), 0);
	return 0;
}

async function readHeader(
	handle: Awaited<ReturnType<typeof open>>,
	completeSize: number,
): Promise<RawEntry | undefined> {
	let header: RawEntry | undefined;
	await scanForward(handle, completeSize, (line) => {
		const entry = parseLine(line);
		if (!entry) return false;
		if (entry.type === "session") header = entry;
		return true;
	});
	return header;
}

async function readTailId(handle: Awaited<ReturnType<typeof open>>, completeSize: number): Promise<string | null> {
	let tailId: string | null = null;
	await scanReverse(handle, completeSize, (line) => {
		const entry = parseLine(line);
		if (!entry || entry.type === "session" || typeof entry.id !== "string") return false;
		tailId = entry.id;
		return true;
	});
	return tailId;
}

export class TranscriptReader {
	private readonly observed = new Map<string, ObservedGeneration>();

	async read(
		sessionPath: string,
		options: { cursor?: string; limit: number; emptyGeneration?: string },
	): Promise<TranscriptPage> {
		const resolvedPath = resolve(sessionPath);
		const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(resolvedPath, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.emptyGeneration || cursor) throw error;
			return {
				items: [],
				hasMorePrevious: false,
				leafId: null,
				transcriptGeneration: options.emptyGeneration,
				transcriptRevision: 0,
			};
		}
		try {
			const stat = await handle.stat();
			const completeSize = await findCompleteSize(handle, stat.size);
			const [header, persistedTailId] = await Promise.all([
				readHeader(handle, completeSize),
				readTailId(handle, completeSize),
			]);
			if (!header || typeof header.id !== "string") throw new Error("Session file has no valid header");
			const tailHash = await hashTail(handle, completeSize);
			const rewriteGeneration = { size: completeSize, tailHash, device: stat.dev, inode: stat.ino };
			if (cursor) {
				if (cursor.sessionId !== header.id || completeSize < cursor.rewriteGeneration.size)
					throw new TranscriptCursorInvalidError();
				if (cursor.rewriteGeneration.device !== stat.dev || cursor.rewriteGeneration.inode !== stat.ino) {
					throw new TranscriptCursorInvalidError();
				}
				if ((await hashTail(handle, cursor.rewriteGeneration.size)) !== cursor.rewriteGeneration.tailHash) {
					throw new TranscriptCursorInvalidError();
				}
			}
			const previous = this.observed.get(resolvedPath);
			const sameFile =
				previous?.sessionId === header.id && previous.device === stat.dev && previous.inode === stat.ino;
			const appendOnly =
				sameFile && completeSize >= previous.size && (await hashTail(handle, previous.size)) === previous.tailHash;
			const baseGeneration = fileGeneration(header.id, stat);
			const generation =
				!previous || appendOnly
					? (previous?.generation ?? baseGeneration)
					: sameFile
						? `${baseGeneration}:${tailHash}`
						: baseGeneration;
			this.observed.set(resolvedPath, { ...rewriteGeneration, generation, sessionId: header.id });
			const leafId = cursor?.leafId ?? persistedTailId;
			if (!leafId) {
				return {
					items: [],
					hasMorePrevious: false,
					leafId: null,
					transcriptGeneration: generation,
					transcriptRevision: completeSize,
				};
			}
			const items: RawEntry[] = [];
			let wantedId: string | null = cursor?.wantedId ?? leafId;
			let matched = wantedId === null;
			const nextOffset = await scanReverse(handle, cursor?.offset ?? completeSize, (line) => {
				const entry = parseLine(line);
				if (!entry || entry.type === "session" || typeof entry.id !== "string" || entry.id !== wantedId)
					return false;
				matched = true;
				wantedId = typeof entry.parentId === "string" ? entry.parentId : null;
				if (isVisible(entry)) items.push(entry);
				const splitsToolExchange =
					entry.type === "message" && (entry.message as { role?: string } | undefined)?.role === "toolResult";
				return items.length >= options.limit && !splitsToolExchange;
			});
			if (!matched || (nextOffset === 0 && wantedId !== null)) throw new TranscriptCursorInvalidError();
			items.reverse();
			const hasMorePrevious = wantedId !== null && nextOffset > 0;
			return {
				items: items.map(toTranscriptItem),
				previousCursor: hasMorePrevious
					? encodeCursor({
							version: CURSOR_VERSION,
							sessionId: header.id,
							leafId,
							offset: nextOffset,
							wantedId,
							rewriteGeneration,
						})
					: undefined,
				hasMorePrevious,
				leafId,
				transcriptGeneration: generation,
				transcriptRevision: completeSize,
			};
		} finally {
			await handle.close();
		}
	}
}
