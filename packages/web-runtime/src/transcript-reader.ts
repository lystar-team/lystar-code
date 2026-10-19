import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	AgentStep,
	JsonValue,
	TranscriptItem,
	TranscriptPage,
	TranscriptSearchHit,
	TranscriptSearchResult,
} from "@lystar/code-web-protocol";

import { SessionReadIndex } from "./session-read-index.ts";
import type { SessionTranscriptOptions } from "./session-read-index-protocol.ts";
import { projectedAgentStepFromItem, projectTranscriptItems, relevantAgentSteps } from "./transcript-projection.ts";

let standaloneIndex: SessionReadIndex | undefined;

const READ_BUFFER_SIZE = 64 * 1024;
const DEFAULT_MAX_JSONL_LINE_BYTES = 128 * 1024 * 1024;
const SEARCH_CURSOR_VERSION = 4;
const TRANSCRIPT_FINGERPRINT_BYTES = 64 * 1024;
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
type SearchCursor = {
	version: number;
	generation: string;
	transcriptRevision: number;
	leafId: string | null;
	query: string;
	offset: number;
	mode: "cached" | "stream";
};
type SearchIndexEntry = { entryId: string; kind: string; timestamp: string; text: string; lowerText: string };
type SearchIndex = {
	generation: string;
	transcriptRevision: number;
	leafId: string | null;
	entryCount: number;
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

	constructor(limit: number) {
		super(`Transcript JSONL line exceeds the ${limit} byte limit`);
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
	return entry.type === "custom_message";
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
			(cursor.leafId !== null && typeof cursor.leafId !== "string") ||
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

function finishLine(
	chunks: readonly Buffer[],
	length: number,
	segment: Buffer,
	maxLineBytes: number,
	prepend = false,
): Buffer {
	const total = length + segment.length;
	if (total > maxLineBytes) throw new TranscriptLineTooLargeError(maxLineBytes);
	if (length === 0) return segment;
	return Buffer.concat(prepend ? [segment, ...chunks] : [...chunks, segment], total);
}

function appendLineSegment(
	chunks: Buffer[],
	length: number,
	segment: Buffer,
	maxLineBytes: number,
	prepend = false,
): number {
	const total = length + segment.length;
	if (total > maxLineBytes) throw new TranscriptLineTooLargeError(maxLineBytes);
	if (prepend) chunks.unshift(segment);
	else chunks.push(segment);
	return total;
}

async function scanReverse(
	handle: Awaited<ReturnType<typeof open>>,
	offset: number,
	maxLineBytes: number,
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
			const line = finishLine(pending, pendingLength, segment, maxLineBytes, true);
			pending = [];
			pendingLength = 0;
			if (onLine(line, start + index)) return start + index;
			lineEnd = index;
		}
		if (lineEnd > 0) {
			const segment = chunk.subarray(0, lineEnd);
			pendingLength = appendLineSegment(pending, pendingLength, segment, maxLineBytes, true);
		}
		end = start;
	}
	if (pendingLength > 0) {
		if (pendingLength > maxLineBytes) throw new TranscriptLineTooLargeError(maxLineBytes);
		onLine(Buffer.concat(pending, pendingLength), 0);
	}
	return 0;
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
	private readonly searchIndexes = new Map<string, SearchIndex>();
	private readonly index: SessionReadIndex;
	private readonly maxJsonlLineBytes: number;
	private searchCacheBytes = 0;

	constructor(maxJsonlLineBytes = DEFAULT_MAX_JSONL_LINE_BYTES, index?: SessionReadIndex) {
		this.maxJsonlLineBytes = maxJsonlLineBytes;
		if (index) this.index = index;
		else {
			standaloneIndex ??= new SessionReadIndex();
			this.index = standaloneIndex;
		}
	}

	async read(
		sessionPath: string,
		options: SessionTranscriptOptions,
		signal?: AbortSignal,
	): Promise<TranscriptPage & { contextCalls?: TranscriptItem[] }> {
		try {
			const { stepItems, ...page } = await this.index.readTranscript(
				sessionPath,
				options,
				this.maxJsonlLineBytes,
				signal,
			);
			const steps = stepItems
				.map(projectedAgentStepFromItem)
				.filter((step): step is AgentStep => step !== undefined)
				.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
			const agentSteps = relevantAgentSteps(page.items, steps);
			return {
				...page,
				...(page.leafId === null || agentSteps.length > 0 ? { agentSteps } : {}),
			};
		} catch (error) {
			if ((error as { code?: string }).code === "cursor_stale") {
				throw new TranscriptCursorInvalidError(error instanceof Error ? error.message : undefined);
			}
			throw error;
		}
	}

	async search(
		sessionPath: string,
		options: { query: string; cursor?: string; limit: number; emptyGeneration?: string; leafId?: string | null },
	): Promise<TranscriptSearchResult> {
		const query = options.query.trim();
		if (!query) throw Object.assign(new Error("搜索内容不能为空"), { code: "transcript_search_query_empty" });
		const resolvedPath = resolve(sessionPath);
		let index = this.remembered(this.searchIndexes, resolvedPath);
		if (
			!index ||
			(options.leafId !== undefined && options.leafId !== index.leafId) ||
			!(await this.isSearchIndexCurrent(resolvedPath, index))
		) {
			index = await this.buildSearchIndex(resolvedPath, options);
			this.rememberSearchIndex(resolvedPath, index);
		}
		const normalizedQuery = query.toLocaleLowerCase();
		const cursor = options.cursor ? decodeSearchCursor(options.cursor) : undefined;
		if (
			cursor &&
			(cursor.generation !== index.generation ||
				cursor.leafId !== index.leafId ||
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
							leafId: index.leafId,
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
		offset: number,
		limit: number,
	): Promise<TranscriptSearchResult> {
		if (index.transcriptRevision === 0 || index.leafId === null) {
			return {
				generation: index.generation,
				transcriptRevision: index.transcriptRevision,
				complete: true,
				hits: [],
			};
		}
		const handle = await open(path, "r");
		try {
			const before = await handle.stat();
			if (
				before.dev !== index.rewriteGeneration.device ||
				before.ino !== index.rewriteGeneration.inode ||
				before.size < index.transcriptRevision ||
				((before.mtimeMs !== index.rewriteGeneration.mtimeMs ||
					before.ctimeMs !== index.rewriteGeneration.ctimeMs) &&
					(await hashPrefix(handle, index.transcriptRevision)) !== index.rewriteGeneration.contentHash)
			)
				throw new TranscriptCursorInvalidError();
			let wantedId: string | null = index.leafId;
			let entryOffset = index.entryCount;
			const matches: Array<{ hit: TranscriptSearchHit; offset: number }> = [];
			let nextHit = 0;
			await scanReverse(handle, index.transcriptRevision, this.maxJsonlLineBytes, (line) => {
				const entry = parseLine(line);
				if (!entry || entry.type === "session" || !entry.id || entry.id !== wantedId) return false;
				wantedId = typeof entry.parentId === "string" ? entry.parentId : null;
				if (!isVisible(entry)) return false;
				entryOffset--;
				if (entryOffset < offset) return true;
				const hit = searchEntry(entry, query);
				if (!hit) return false;
				// 反向扫描只保留最早的 limit+1 个命中，与缓存搜索保持相同顺序和分页边界。
				matches[nextHit] = { hit, offset: entryOffset };
				nextHit = (nextHit + 1) % (limit + 1);
				return false;
			});
			const after = await handle.stat();
			if (
				(after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) &&
				(await hashPrefix(handle, index.transcriptRevision)) !== index.rewriteGeneration.contentHash
			)
				throw new TranscriptCursorInvalidError();
			matches.sort((left, right) => left.offset - right.offset);
			const hits = matches.slice(0, limit).map(({ hit }) => hit);
			return {
				generation: index.generation,
				transcriptRevision: index.transcriptRevision,
				complete: true,
				hits,
				...(matches.length > limit
					? {
							nextCursor: encodeSearchCursor({
								version: SEARCH_CURSOR_VERSION,
								generation: index.generation,
								leafId: index.leafId,
								transcriptRevision: index.transcriptRevision,
								query,
								offset: matches[limit - 1]!.offset + 1,
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

	private async buildSearchIndex(
		path: string,
		options: Pick<SessionTranscriptOptions, "emptyGeneration" | "leafId">,
	): Promise<SearchIndex> {
		const readOptions = { limit: 1, compact: true, emptyGeneration: options.emptyGeneration, leafId: options.leafId };
		const page = await this.read(path, readOptions);
		if (page.transcriptRevision === 0) {
			return {
				generation: page.transcriptGeneration,
				transcriptRevision: 0,
				leafId: page.leafId,
				entryCount: 0,
				rewriteGeneration: { size: 0, device: 0, inode: 0, mtimeMs: 0, ctimeMs: 0, contentHash: "", tailHash: "" },
				mode: "cached",
				entries: [],
				bytes: 0,
			};
		}
		const handle = await open(path, "r");
		try {
			const stat = await handle.stat();
			// 搜索内容、分支和版本均取自同一历史页，不能混入随后追加的 JSONL。
			const completeSize = page.transcriptRevision;
			if (stat.size < completeSize) throw new TranscriptCursorInvalidError();
			let wantedId = page.leafId;
			let entryCount = 0;
			let bytes = 0;
			let cacheable = true;
			const entries: SearchIndexEntry[] = [];
			await scanReverse(handle, completeSize, this.maxJsonlLineBytes, (line) => {
				const entry = parseLine(line);
				if (!entry || entry.type === "session" || !entry.id || entry.id !== wantedId) return false;
				wantedId = typeof entry.parentId === "string" ? entry.parentId : null;
				if (!isVisible(entry)) return false;
				entryCount++;
				if (!cacheable) return false;
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
			const contentHash = await hashPrefix(handle, completeSize);
			const current = await this.read(path, readOptions);
			if (current.transcriptGeneration !== page.transcriptGeneration || current.transcriptRevision < completeSize)
				throw new TranscriptCursorInvalidError();
			return {
				generation: page.transcriptGeneration,
				transcriptRevision: completeSize,
				leafId: page.leafId,
				entryCount,
				rewriteGeneration: {
					size: completeSize,
					device: stat.dev,
					inode: stat.ino,
					mtimeMs: stat.mtimeMs,
					ctimeMs: stat.ctimeMs,
					contentHash,
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
