import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	JsonValue,
	TranscriptItem,
	TranscriptPage,
	TranscriptSearchHit,
	TranscriptSearchResult,
} from "@lystar/code-gui-protocol";

const READ_BUFFER_SIZE = 64 * 1024;
const CURSOR_VERSION = 1;
const SEARCH_CURSOR_VERSION = 1;
const SEARCH_CACHE_LIMIT = 8;
const SEARCH_INDEX_TEXT_LIMIT = 64 * 1024 * 1024;
const SEARCH_SNIPPET_LENGTH = 320;

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
type SearchCursor = { version: number; generation: string; query: string; offset: number };
type SearchIndexEntry = { entryId: string; kind: string; timestamp: string; text: string; lowerText: string };
type SearchIndex = {
	generation: string;
	transcriptRevision: number;
	rewriteGeneration: RewriteGeneration;
	entries: SearchIndexEntry[];
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

function encodeSearchCursor(cursor: SearchCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeSearchCursor(value: string): SearchCursor {
	try {
		const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as SearchCursor;
		if (
			cursor.version !== SEARCH_CURSOR_VERSION ||
			typeof cursor.generation !== "string" ||
			typeof cursor.query !== "string" ||
			!Number.isInteger(cursor.offset) ||
			cursor.offset < 0
		) {
			throw new Error("invalid cursor");
		}
		return cursor;
	} catch {
		throw new TranscriptCursorInvalidError("Transcript search cursor is malformed");
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

function searchText(entry: RawEntry): string {
	const payload = JSON.stringify(entry);
	return payload.length > SEARCH_INDEX_TEXT_LIMIT ? payload.slice(0, SEARCH_INDEX_TEXT_LIMIT) : payload;
}

function searchHit(entry: SearchIndexEntry, query: string): TranscriptSearchHit | undefined {
	const first = entry.lowerText.indexOf(query);
	if (first < 0) return undefined;
	const start = Math.max(0, first - Math.floor(SEARCH_SNIPPET_LENGTH / 3));
	const end = Math.min(entry.text.length, start + SEARCH_SNIPPET_LENGTH);
	const snippet = entry.text.slice(start, end);
	const lowerSnippet = entry.lowerText.slice(start, end);
	const matches: Array<{ start: number; end: number }> = [];
	let cursor = 0;
	while (matches.length < 16) {
		const match = lowerSnippet.indexOf(query, cursor);
		if (match < 0) break;
		matches.push({ start: match, end: match + query.length });
		cursor = match + Math.max(query.length, 1);
	}
	return { entryId: entry.entryId, kind: entry.kind, timestamp: entry.timestamp, snippet, matches };
}

export class TranscriptReader {
	private readonly observed = new Map<string, ObservedGeneration>();
	private readonly searchIndexes = new Map<string, SearchIndex>();

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

	async search(
		sessionPath: string,
		options: { query: string; cursor?: string; limit: number; emptyGeneration?: string },
	): Promise<TranscriptSearchResult> {
		const query = options.query.trim();
		if (!query) throw Object.assign(new Error("搜索内容不能为空"), { code: "transcript_search_query_empty" });
		const resolvedPath = resolve(sessionPath);
		let index = this.searchIndexes.get(resolvedPath);
		if (!index || !(await this.isSearchIndexCurrent(resolvedPath, index))) {
			index = await this.buildSearchIndex(resolvedPath, options.emptyGeneration);
			this.rememberSearchIndex(resolvedPath, index);
		}
		const cursor = options.cursor ? decodeSearchCursor(options.cursor) : undefined;
		if (cursor && (cursor.generation !== index.generation || cursor.query !== query.toLocaleLowerCase())) {
			throw new TranscriptCursorInvalidError("Transcript search cursor is no longer valid");
		}
		const normalizedQuery = query.toLocaleLowerCase();
		const hits: TranscriptSearchHit[] = [];
		let offset = cursor?.offset ?? 0;
		for (; offset < index.entries.length && hits.length < options.limit; offset++) {
			const hit = searchHit(index.entries[offset]!, normalizedQuery);
			if (hit) hits.push(hit);
		}
		const nextCursor =
			offset < index.entries.length
				? encodeSearchCursor({
						version: SEARCH_CURSOR_VERSION,
						generation: index.generation,
						query: normalizedQuery,
						offset,
					})
				: undefined;
		return { generation: index.generation, hits, ...(nextCursor ? { nextCursor } : {}) };
	}

	private async isSearchIndexCurrent(path: string, index: SearchIndex): Promise<boolean> {
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(path, "r");
		} catch {
			return false;
		}
		try {
			const stat = await handle.stat();
			if (stat.dev !== index.rewriteGeneration.device || stat.ino !== index.rewriteGeneration.inode) return false;
			const completeSize = await findCompleteSize(handle, stat.size);
			return (
				completeSize === index.rewriteGeneration.size &&
				(await hashTail(handle, completeSize)) === index.rewriteGeneration.tailHash
			);
		} finally {
			await handle.close();
		}
	}

	private async buildSearchIndex(path: string, emptyGeneration?: string): Promise<SearchIndex> {
		const page = await this.read(path, { limit: 1, ...(emptyGeneration ? { emptyGeneration } : {}) });
		if (page.transcriptRevision === 0) {
			return {
				generation: page.transcriptGeneration,
				transcriptRevision: 0,
				rewriteGeneration: { size: 0, tailHash: "", device: 0, inode: 0 },
				entries: [],
			};
		}
		const handle = await open(path, "r");
		try {
			const stat = await handle.stat();
			const completeSize = await findCompleteSize(handle, stat.size);
			const entries = new Map<string, RawEntry>();
			let tailId: string | null = null;
			let indexedBytes = 0;
			await scanForward(handle, completeSize, (line) => {
				const entry = parseLine(line);
				if (!entry || entry.type === "session" || typeof entry.id !== "string") return false;
				entries.set(entry.id, entry);
				tailId = entry.id;
				return false;
			});
			const visible: RawEntry[] = [];
			for (let current: string | null = tailId; current; ) {
				const entry = entries.get(current);
				if (!entry) break;
				if (isVisible(entry)) visible.push(entry);
				current = typeof entry.parentId === "string" ? entry.parentId : null;
			}
			visible.reverse();
			const searchableEntries: SearchIndexEntry[] = [];
			for (const entry of visible) {
				if (!entry.id || indexedBytes >= SEARCH_INDEX_TEXT_LIMIT) break;
				const text = searchText(entry);
				indexedBytes += Buffer.byteLength(text);
				searchableEntries.push({
					entryId: entry.id,
					kind: entry.type,
					timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
					text,
					lowerText: text.toLocaleLowerCase(),
				});
			}
			return {
				generation: page.transcriptGeneration,
				transcriptRevision: page.transcriptRevision,
				rewriteGeneration: {
					size: completeSize,
					tailHash: await hashTail(handle, completeSize),
					device: stat.dev,
					inode: stat.ino,
				},
				entries: searchableEntries,
			};
		} finally {
			await handle.close();
		}
	}

	private rememberSearchIndex(path: string, index: SearchIndex): void {
		this.searchIndexes.delete(path);
		this.searchIndexes.set(path, index);
		while (this.searchIndexes.size > SEARCH_CACHE_LIMIT)
			this.searchIndexes.delete(this.searchIndexes.keys().next().value!);
	}
}
