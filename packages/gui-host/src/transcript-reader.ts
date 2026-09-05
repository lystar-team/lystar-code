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

import { projectTranscriptItems } from "./transcript-projection.ts";

const READ_BUFFER_SIZE = 64 * 1024;
const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;
const CURSOR_VERSION = 3;
const SEARCH_CURSOR_VERSION = 3;
const TRANSCRIPT_FINGERPRINT_BYTES = 64 * 1024;
const OBSERVED_GENERATION_LIMIT = 512;
const SEARCH_CACHE_LIMIT = 8;
const SEARCH_CACHE_BYTES = 32 * 1024 * 1024;
const SEARCH_CACHE_ENTRY_BYTES = 256 * 1024;
const SEARCH_SNIPPET_LENGTH = 320;

type RawEntry = Record<string, unknown> & { type: string; id?: string; parentId?: string | null; timestamp?: string };
type RewriteGeneration = {
	size: number;
	device: number;
	inode: number;
	mtimeMs: number;
	ctimeMs: number;
	contentHash: string;
	tailHash: string;
};
type ObservedGeneration = RewriteGeneration & { generation: string; sessionId: string };
type TranscriptCursor = {
	version: number;
	sessionId: string;
	leafId: string;
	offset: number;
	wantedId: string | null;
	rewriteGeneration: RewriteGeneration;
};
type SearchCursor = {
	version: number;
	generation: string;
	transcriptRevision: number;
	query: string;
	offset: number;
	mode: "cached" | "stream";
};
type SearchIndexEntry = { entryId: string; kind: string; timestamp: string; text: string; lowerText: string };
type SearchIndex = {
	generation: string;
	transcriptRevision: number;
	rewriteGeneration: RewriteGeneration;
	mode: "cached" | "stream";
	entries: SearchIndexEntry[];
	bytes: number;
};

export class TranscriptCursorInvalidError extends Error {
	readonly code = "cursor_stale" as const;
	readonly retryable = true as const;

	constructor(message = "Transcript cursor is no longer valid; read the tail again") {
		super(message);
		this.name = "TranscriptCursorInvalidError";
	}
}

export class TranscriptLineTooLargeError extends Error {
	readonly code = "transcript_line_too_large" as const;
	readonly retryable = false as const;

	constructor() {
		super(`Transcript JSONL line exceeds the ${MAX_JSONL_LINE_BYTES} byte limit`);
		this.name = "TranscriptLineTooLargeError";
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
			!Number.isInteger(cursor.transcriptRevision) ||
			cursor.transcriptRevision < 0 ||
			typeof cursor.query !== "string" ||
			!Number.isInteger(cursor.offset) ||
			cursor.offset < 0 ||
			(cursor.mode !== "cached" && cursor.mode !== "stream")
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

async function hashPrefix(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<string> {
	const hash = createHash("sha256");
	for (let offset = 0; offset < size; offset += READ_BUFFER_SIZE) {
		hash.update(await readAt(handle, offset, Math.min(READ_BUFFER_SIZE, size - offset)));
	}
	return hash.digest("base64url");
}

async function hashWindow(handle: Awaited<ReturnType<typeof open>>, offset: number, size: number): Promise<string> {
	const hash = createHash("sha256");
	if (size > 0) hash.update(await readAt(handle, offset, size));
	return hash.digest("base64url");
}

async function fileFingerprint(
	handle: Awaited<ReturnType<typeof open>>,
	size: number,
): Promise<{ contentHash: string; tailHash: string }> {
	const prefixSize = Math.min(size, TRANSCRIPT_FINGERPRINT_BYTES);
	const prefix = await readAt(handle, 0, prefixSize);
	const tailOffset = Math.max(0, size - TRANSCRIPT_FINGERPRINT_BYTES);
	const tail = tailOffset === 0 ? prefix : await readAt(handle, tailOffset, size - tailOffset);
	const contentHash = createHash("sha256")
		.update("lystar-transcript-fingerprint\0")
		.update(prefix)
		.update(tail)
		.digest("base64url");
	const tailHash = createHash("sha256").update(tail).digest("base64url");
	return { contentHash, tailHash };
}

function fileGeneration(sessionId: string, stat: { dev: number; ino: number; birthtimeMs: number }): string {
	return `${sessionId}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function finishLine(chunks: readonly Buffer[], length: number, segment: Buffer, prepend = false): Buffer {
	const total = length + segment.length;
	if (total > MAX_JSONL_LINE_BYTES) throw new TranscriptLineTooLargeError();
	if (length === 0) return segment;
	return Buffer.concat(prepend ? [segment, ...chunks] : [...chunks, segment], total);
}

function appendLineSegment(chunks: Buffer[], length: number, segment: Buffer, prepend = false): number {
	const total = length + segment.length;
	if (total > MAX_JSONL_LINE_BYTES) throw new TranscriptLineTooLargeError();
	if (prepend) chunks.unshift(segment);
	else chunks.push(segment);
	return total;
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
			const line = finishLine(pending, pendingLength, segment);
			pending = [];
			pendingLength = 0;
			if (onLine(line)) return;
			lineStart = index + 1;
		}
		if (lineStart < chunk.length) {
			const segment = chunk.subarray(lineStart);
			pendingLength = appendLineSegment(pending, pendingLength, segment);
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
			const line = finishLine(pending, pendingLength, segment, true);
			pending = [];
			pendingLength = 0;
			if (onLine(line, start + index)) return start + index;
			lineEnd = index;
		}
		if (lineEnd > 0) {
			const segment = chunk.subarray(0, lineEnd);
			pendingLength = appendLineSegment(pending, pendingLength, segment, true);
		}
		end = start;
	}
	if (pendingLength > 0) {
		if (pendingLength > MAX_JSONL_LINE_BYTES) throw new TranscriptLineTooLargeError();
		onLine(Buffer.concat(pending, pendingLength), 0);
	}
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
	return JSON.stringify(
		projectTranscriptItems({
			entryId: entry.id ?? "",
			parentId: typeof entry.parentId === "string" ? entry.parentId : null,
			timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
			kind: entry.type,
			payload: entry as JsonValue,
		}).map((item) => item.view),
	);
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

function searchEntry(entry: RawEntry, query: string): TranscriptSearchHit | undefined {
	if (!entry.id) return undefined;
	const text = searchText(entry);
	return searchHit(
		{
			entryId: entry.id,
			kind: entry.type,
			timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
			text,
			lowerText: text.toLocaleLowerCase(),
		},
		query,
	);
}

export class TranscriptReader {
	private readonly observed = new Map<string, ObservedGeneration>();
	private readonly searchIndexes = new Map<string, SearchIndex>();
	private searchCacheBytes = 0;

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
				complete: true,
			};
		}
		try {
			const stat = await handle.stat();
			const completeSize = await findCompleteSize(handle, stat.size);
			const header = await readHeader(handle, completeSize);
			if (!header || typeof header.id !== "string") throw new Error("Session file has no valid header");
			const previous = this.remembered(this.observed, resolvedPath);
			const unchangedSincePrevious =
				previous?.sessionId === header.id &&
				previous.device === stat.dev &&
				previous.inode === stat.ino &&
				previous.size === completeSize &&
				previous.mtimeMs === stat.mtimeMs &&
				previous.ctimeMs === stat.ctimeMs;
			const fingerprint = unchangedSincePrevious
				? { contentHash: previous.contentHash, tailHash: previous.tailHash }
				: await fileFingerprint(handle, completeSize);
			const contentHash = fingerprint.contentHash;
			const persistedTailId = cursor ? null : await readTailId(handle, completeSize);
			const rewriteGeneration: RewriteGeneration = {
				size: completeSize,
				device: stat.dev,
				inode: stat.ino,
				mtimeMs: stat.mtimeMs,
				ctimeMs: stat.ctimeMs,
				...fingerprint,
			};
			if (cursor) {
				if (cursor.sessionId !== header.id || completeSize < cursor.rewriteGeneration.size) {
					throw new TranscriptCursorInvalidError();
				}
				if (cursor.rewriteGeneration.device !== stat.dev || cursor.rewriteGeneration.inode !== stat.ino) {
					throw new TranscriptCursorInvalidError();
				}
				if (completeSize === cursor.rewriteGeneration.size) {
					if (
						(cursor.rewriteGeneration.mtimeMs !== stat.mtimeMs ||
							cursor.rewriteGeneration.ctimeMs !== stat.ctimeMs) &&
						(stat.size <= completeSize ||
							(await hashWindow(
								handle,
								completeSize - Math.min(completeSize, TRANSCRIPT_FINGERPRINT_BYTES),
								Math.min(completeSize, TRANSCRIPT_FINGERPRINT_BYTES),
							)) !== cursor.rewriteGeneration.tailHash)
					) {
						throw new TranscriptCursorInvalidError();
					}
				} else {
					const tailSize = Math.min(cursor.rewriteGeneration.size, TRANSCRIPT_FINGERPRINT_BYTES);
					if (
						(await hashWindow(handle, cursor.rewriteGeneration.size - tailSize, tailSize)) !==
						cursor.rewriteGeneration.tailHash
					) {
						throw new TranscriptCursorInvalidError();
					}
				}
			}
			const sameFile =
				previous?.sessionId === header.id && previous.device === stat.dev && previous.inode === stat.ino;
			const appendOnly =
				sameFile &&
				completeSize >= previous.size &&
				(completeSize > previous.size
					? (await hashWindow(
							handle,
							previous.size - Math.min(previous.size, TRANSCRIPT_FINGERPRINT_BYTES),
							Math.min(previous.size, TRANSCRIPT_FINGERPRINT_BYTES),
						)) === previous.tailHash
					: unchangedSincePrevious ||
						(stat.size > completeSize &&
							(await hashWindow(
								handle,
								completeSize - Math.min(completeSize, TRANSCRIPT_FINGERPRINT_BYTES),
								Math.min(completeSize, TRANSCRIPT_FINGERPRINT_BYTES),
							)) === previous.tailHash));
			const baseGeneration = fileGeneration(header.id, stat);
			const generation =
				!previous || appendOnly ? (previous?.generation ?? baseGeneration) : `${baseGeneration}:${contentHash}`;
			this.rememberObserved(resolvedPath, { ...rewriteGeneration, generation, sessionId: header.id });
			const leafId = cursor?.leafId ?? persistedTailId;
			if (!leafId) {
				return {
					items: [],
					hasMorePrevious: false,
					leafId: null,
					transcriptGeneration: generation,
					transcriptRevision: completeSize,
					complete: true,
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
				complete: true,
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
		let index = this.remembered(this.searchIndexes, resolvedPath);
		if (!index || !(await this.isSearchIndexCurrent(resolvedPath, index))) {
			index = await this.buildSearchIndex(resolvedPath, options.emptyGeneration);
			this.rememberSearchIndex(resolvedPath, index);
		}
		const normalizedQuery = query.toLocaleLowerCase();
		const cursor = options.cursor ? decodeSearchCursor(options.cursor) : undefined;
		if (
			cursor &&
			(cursor.generation !== index.generation ||
				cursor.transcriptRevision !== index.transcriptRevision ||
				cursor.query !== normalizedQuery ||
				cursor.mode !== index.mode)
		) {
			throw new TranscriptCursorInvalidError("Transcript search cursor is no longer valid");
		}
		if (index.mode === "stream") {
			return this.searchFromDisk(resolvedPath, index, normalizedQuery, cursor?.offset ?? 0, options.limit);
		}
		const hits: TranscriptSearchHit[] = [];
		let offset = cursor?.offset ?? 0;
		for (; offset < index.entries.length && hits.length < options.limit; offset++) {
			const hit = searchHit(index.entries[offset]!, normalizedQuery);
			if (hit) hits.push(hit);
		}
		let hasMore = false;
		for (let probe = offset; probe < index.entries.length; probe++) {
			if (searchHit(index.entries[probe]!, normalizedQuery)) {
				hasMore = true;
				break;
			}
		}
		return {
			generation: index.generation,
			transcriptRevision: index.transcriptRevision,
			complete: true,
			hits,
			...(hasMore
				? {
						nextCursor: encodeSearchCursor({
							version: SEARCH_CURSOR_VERSION,
							generation: index.generation,
							transcriptRevision: index.transcriptRevision,
							query: normalizedQuery,
							offset,
							mode: "cached",
						}),
					}
				: {}),
		};
	}

	private async searchFromDisk(
		path: string,
		index: SearchIndex,
		query: string,
		skipMatches: number,
		limit: number,
	): Promise<TranscriptSearchResult> {
		if (index.transcriptRevision === 0) {
			return { generation: index.generation, transcriptRevision: 0, complete: true, hits: [] };
		}
		const handle = await open(path, "r");
		try {
			const tailId = await readTailId(handle, index.transcriptRevision);
			let wantedId = tailId;
			let seenMatches = 0;
			const hits: TranscriptSearchHit[] = [];
			let hasMore = false;
			await scanReverse(handle, index.transcriptRevision, (line) => {
				const entry = parseLine(line);
				if (!entry || entry.type === "session" || !entry.id || entry.id !== wantedId) return false;
				wantedId = typeof entry.parentId === "string" ? entry.parentId : null;
				if (!isVisible(entry)) return false;
				const hit = searchEntry(entry, query);
				if (!hit) return false;
				if (seenMatches++ < skipMatches) return false;
				if (hits.length < limit) {
					hits.push(hit);
					return false;
				}
				hasMore = true;
				return true;
			});
			return {
				generation: index.generation,
				transcriptRevision: index.transcriptRevision,
				complete: true,
				hits,
				...(hasMore
					? {
							nextCursor: encodeSearchCursor({
								version: SEARCH_CURSOR_VERSION,
								generation: index.generation,
								transcriptRevision: index.transcriptRevision,
								query,
								offset: skipMatches + hits.length,
								mode: "stream",
							}),
						}
					: {}),
			};
		} finally {
			await handle.close();
		}
	}

	private async isSearchIndexCurrent(path: string, index: SearchIndex): Promise<boolean> {
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(path, "r");
		} catch {
			return index.transcriptRevision === 0;
		}
		try {
			const stat = await handle.stat();
			if (stat.dev !== index.rewriteGeneration.device || stat.ino !== index.rewriteGeneration.inode) return false;
			const completeSize = await findCompleteSize(handle, stat.size);
			if (
				completeSize === index.rewriteGeneration.size &&
				stat.mtimeMs === index.rewriteGeneration.mtimeMs &&
				stat.ctimeMs === index.rewriteGeneration.ctimeMs
			) {
				return true;
			}
			return (
				completeSize === index.rewriteGeneration.size &&
				(await hashPrefix(handle, completeSize)) === index.rewriteGeneration.contentHash
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
				rewriteGeneration: { size: 0, device: 0, inode: 0, mtimeMs: 0, ctimeMs: 0, contentHash: "", tailHash: "" },
				mode: "cached",
				entries: [],
				bytes: 0,
			};
		}
		const handle = await open(path, "r");
		try {
			const stat = await handle.stat();
			const completeSize = await findCompleteSize(handle, stat.size);
			const tailId = await readTailId(handle, completeSize);
			let wantedId = tailId;
			let bytes = 0;
			let cacheable = true;
			const entries: SearchIndexEntry[] = [];
			await scanReverse(handle, completeSize, (line) => {
				const entry = parseLine(line);
				if (!entry || entry.type === "session" || !entry.id || entry.id !== wantedId) return false;
				wantedId = typeof entry.parentId === "string" ? entry.parentId : null;
				if (!isVisible(entry) || !cacheable) return false;
				const text = searchText(entry);
				const entryBytes = Buffer.byteLength(text);
				if (entryBytes > SEARCH_CACHE_ENTRY_BYTES || bytes + entryBytes * 2 > SEARCH_CACHE_BYTES) {
					cacheable = false;
					return false;
				}
				bytes += entryBytes * 2;
				entries.push({
					entryId: entry.id,
					kind: entry.type,
					timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
					text,
					lowerText: text.toLocaleLowerCase(),
				});
				return false;
			});
			return {
				generation: page.transcriptGeneration,
				transcriptRevision: page.transcriptRevision,
				rewriteGeneration: {
					size: completeSize,
					device: stat.dev,
					inode: stat.ino,
					mtimeMs: stat.mtimeMs,
					ctimeMs: stat.ctimeMs,
					contentHash: await hashPrefix(handle, completeSize),
					tailHash: await hashWindow(
						handle,
						completeSize - Math.min(completeSize, TRANSCRIPT_FINGERPRINT_BYTES),
						Math.min(completeSize, TRANSCRIPT_FINGERPRINT_BYTES),
					),
				},
				mode: cacheable ? "cached" : "stream",
				entries: cacheable ? entries.reverse() : [],
				bytes: cacheable ? bytes : 0,
			};
		} finally {
			await handle.close();
		}
	}

	private remembered<T>(cache: Map<string, T>, path: string): T | undefined {
		const value = cache.get(path);
		if (value !== undefined) {
			cache.delete(path);
			cache.set(path, value);
		}
		return value;
	}

	private rememberObserved(path: string, generation: ObservedGeneration): void {
		this.observed.delete(path);
		this.observed.set(path, generation);
		while (this.observed.size > OBSERVED_GENERATION_LIMIT) this.observed.delete(this.observed.keys().next().value!);
	}

	private rememberSearchIndex(path: string, index: SearchIndex): void {
		const previous = this.searchIndexes.get(path);
		if (previous) this.searchCacheBytes -= previous.bytes;
		this.searchIndexes.delete(path);
		this.searchIndexes.set(path, index);
		this.searchCacheBytes += index.bytes;
		while (this.searchIndexes.size > SEARCH_CACHE_LIMIT || this.searchCacheBytes > SEARCH_CACHE_BYTES) {
			const oldest = this.searchIndexes.keys().next().value;
			if (typeof oldest !== "string") break;
			const removed = this.searchIndexes.get(oldest);
			if (removed) this.searchCacheBytes -= removed.bytes;
			this.searchIndexes.delete(oldest);
		}
	}
}
