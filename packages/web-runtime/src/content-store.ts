import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ContentChunk, ContentReference, JsonValue, TranscriptItem } from "@lystar/code-web-protocol";

const REFERENCE_THRESHOLD = 64 * 1024;
const PREVIEW_HEAD_BYTES = 24 * 1024;
const PREVIEW_TAIL_BYTES = 8 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const REFERENCE_TTL_MS = 15 * 60 * 1000;
const CONTENT_SAMPLE_BYTES = 64;

interface StoredContent {
	bytes: Buffer;
	contentKey: string;
	sessionPath: string;
	mimeType: string;
	expiresAt: number;
}

interface StoredArtifact {
	sessionPath: string;
	path: string;
	mimeType: string;
}

function preview(bytes: Buffer, start: number, end: number, trim: "start" | "end"): string {
	const value = bytes.subarray(start, end).toString("utf8");
	return trim === "start" ? value.replace(/^\uFFFD/, "") : value.replace(/\uFFFD$/, "");
}

function lineCount(value: string): number {
	if (value.length === 0) return 0;
	let count = 1;
	for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) === 10) count++;
	return count;
}

function contentSample(bytes: Buffer, start: number): string {
	return bytes.subarray(start, Math.min(bytes.length, start + CONTENT_SAMPLE_BYTES)).toString("base64url");
}

function contentKey(sessionPath: string, mimeType: string, bytes: Buffer): string {
	const middle = Math.max(0, Math.floor((bytes.length - CONTENT_SAMPLE_BYTES) / 2));
	const tail = Math.max(0, bytes.length - CONTENT_SAMPLE_BYTES);
	return [
		sessionPath,
		mimeType,
		String(bytes.length),
		contentSample(bytes, 0),
		contentSample(bytes, middle),
		contentSample(bytes, tail),
	].join("\0");
}

function isToolResult(item: TranscriptItem): boolean {
	if (!item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) return false;
	const message = item.payload.message;
	return !!message && typeof message === "object" && !Array.isArray(message) && message.role === "toolResult";
}

function toolResultArtifactPath(item: TranscriptItem): string | undefined {
	if (!isToolResult(item) || !item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) {
		return undefined;
	}
	const message = item.payload.message;
	if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
	const details = message.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	return typeof details.savedPath === "string" && details.savedPath.length > 0 ? details.savedPath : undefined;
}

export class ContentStore {
	private readonly entries = new Map<string, StoredContent>();
	private readonly referencesByContent = new Map<string, Set<string>>();
	private readonly artifacts = new Map<string, StoredArtifact>();
	private totalBytes = 0;

	compactTranscriptItem(sessionPath: string, item: TranscriptItem): TranscriptItem {
		const payload = this.compactImages(sessionPath, item.payload, toolResultArtifactPath(item));
		return { ...item, payload: isToolResult(item) ? this.compactValue(sessionPath, payload) : payload };
	}

	read(sessionPath: string, contentRef: string, offset: number, limit: number): ContentChunk {
		const entry = this.entry(sessionPath, contentRef);
		if (offset > entry.bytes.length) {
			throw Object.assign(new Error("Content offset exceeds the referenced value"), {
				code: "content_offset_invalid",
				retryable: false,
			});
		}
		this.touch(contentRef, entry);
		const nextOffset = Math.min(entry.bytes.length, offset + limit);
		return {
			contentRef,
			offset,
			nextOffset,
			byteLength: entry.bytes.length,
			data: entry.bytes.subarray(offset, nextOffset).toString("base64"),
			encoding: "base64",
			done: nextOffset === entry.bytes.length,
		};
	}

	readImage(
		sessionPath: string,
		contentRef: string,
	): {
		contentRef: string;
		mimeType: string;
		byteLength: number;
		data: string;
	} {
		const entry = this.entry(sessionPath, contentRef);
		if (!entry.mimeType.startsWith("image/")) {
			throw Object.assign(new Error("Content reference is not an image"), {
				code: "image_content_not_image",
				retryable: false,
			});
		}
		if (entry.bytes.length > 4 * 1024 * 1024) {
			throw Object.assign(new Error("Image content exceeds the 4 MiB display limit"), {
				code: "image_content_too_large",
				retryable: false,
			});
		}
		this.touch(contentRef, entry);
		return {
			contentRef,
			mimeType: entry.mimeType,
			byteLength: entry.bytes.length,
			data: entry.bytes.toString("base64"),
		};
	}

	clear(): void {
		this.entries.clear();
		this.referencesByContent.clear();
		this.artifacts.clear();
		this.totalBytes = 0;
	}

	evictExpired(now = Date.now()): void {
		for (const [contentRef, entry] of this.entries) if (entry.expiresAt <= now) this.delete(contentRef);
	}

	private compactValue(sessionPath: string, value: JsonValue): JsonValue {
		if (typeof value === "string") {
			const bytes = Buffer.from(value);
			if (bytes.length <= REFERENCE_THRESHOLD) return value;
			return this.createReference(sessionPath, bytes, "text/plain; charset=utf-8", value) as unknown as JsonValue;
		}
		if (Array.isArray(value)) return value.map((item) => this.compactValue(sessionPath, item));
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, this.compactValue(sessionPath, item)]),
			);
		}
		return value;
	}

	private compactImages(sessionPath: string, value: JsonValue, artifactPath?: string): JsonValue {
		if (Array.isArray(value)) return value.map((item) => this.compactImages(sessionPath, item, artifactPath));
		if (!value || typeof value !== "object") return value;
		if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
			const bytes = Buffer.from(value.data, "base64");
			return {
				...value,
				data: this.createReference(
					sessionPath,
					bytes,
					value.mimeType,
					undefined,
					artifactPath,
				) as unknown as JsonValue,
			};
		}
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, this.compactImages(sessionPath, item, artifactPath)]),
		);
	}

	private createReference(
		sessionPath: string,
		bytes: Buffer,
		mimeType: string,
		text?: string,
		artifactPath?: string,
	): ContentReference {
		if (bytes.length > MAX_CONTENT_BYTES) {
			throw Object.assign(new Error(`Tool output exceeds the ${MAX_CONTENT_BYTES} byte content reference limit`), {
				code: "content_too_large",
				retryable: false,
			});
		}
		this.evictExpired();
		const key = contentKey(sessionPath, mimeType, bytes);
		const existingRefs = this.referencesByContent.get(key);
		if (existingRefs) {
			for (const existingRef of existingRefs) {
				const existing = this.entries.get(existingRef);
				if (!existing?.bytes.equals(bytes)) continue;
				this.touch(existingRef, existing);
				if (artifactPath) this.artifacts.set(existingRef, { sessionPath, path: artifactPath, mimeType });
				return this.contentReference(existingRef, existing.bytes, mimeType, text);
			}
		}
		while (this.totalBytes + bytes.length > MAX_TOTAL_BYTES && this.entries.size > 0) {
			const oldest = this.entries.keys().next().value;
			if (typeof oldest !== "string") break;
			this.delete(oldest);
		}
		const contentRef = randomUUID();
		this.store(contentRef, sessionPath, bytes, mimeType, key);
		if (artifactPath) this.artifacts.set(contentRef, { sessionPath, path: artifactPath, mimeType });
		return this.contentReference(contentRef, bytes, mimeType, text);
	}

	private contentReference(contentRef: string, bytes: Buffer, mimeType: string, text?: string): ContentReference {
		return {
			type: "content_ref",
			contentRef,
			previewHead: text === undefined ? "" : preview(bytes, 0, Math.min(PREVIEW_HEAD_BYTES, bytes.length), "end"),
			previewTail:
				text === undefined
					? ""
					: preview(bytes, Math.max(0, bytes.length - PREVIEW_TAIL_BYTES), bytes.length, "start"),
			byteLength: bytes.length,
			lineCount: text === undefined ? 0 : lineCount(text),
			mimeType,
		};
	}

	private entry(sessionPath: string, contentRef: string): StoredContent {
		this.evictExpired();
		const entry = this.entries.get(contentRef) ?? this.restoreArtifact(contentRef);
		if (!entry) {
			throw Object.assign(new Error("Content reference is missing or expired"), {
				code: "content_ref_expired",
				retryable: true,
			});
		}
		if (entry.sessionPath !== sessionPath) {
			throw Object.assign(new Error("Content reference does not belong to this Session"), {
				code: "content_ref_session_mismatch",
				retryable: false,
			});
		}
		return entry;
	}

	private restoreArtifact(contentRef: string): StoredContent | undefined {
		const artifact = this.artifacts.get(contentRef);
		if (!artifact) return undefined;
		let bytes: Buffer;
		try {
			bytes = readFileSync(artifact.path);
		} catch {
			return undefined;
		}
		if (bytes.length > MAX_CONTENT_BYTES) return undefined;
		while (this.totalBytes + bytes.length > MAX_TOTAL_BYTES && this.entries.size > 0) {
			const oldest = this.entries.keys().next().value;
			if (typeof oldest !== "string") break;
			this.delete(oldest);
		}
		const key = contentKey(artifact.sessionPath, artifact.mimeType, bytes);
		return this.store(contentRef, artifact.sessionPath, bytes, artifact.mimeType, key);
	}

	private store(contentRef: string, sessionPath: string, bytes: Buffer, mimeType: string, key: string): StoredContent {
		const entry: StoredContent = {
			bytes,
			contentKey: key,
			sessionPath,
			mimeType,
			expiresAt: Date.now() + REFERENCE_TTL_MS,
		};
		this.entries.set(contentRef, entry);
		const references = this.referencesByContent.get(key) ?? new Set<string>();
		references.add(contentRef);
		this.referencesByContent.set(key, references);
		this.totalBytes += bytes.length;
		return entry;
	}

	private touch(contentRef: string, entry: StoredContent): void {
		entry.expiresAt = Date.now() + REFERENCE_TTL_MS;
		this.entries.delete(contentRef);
		this.entries.set(contentRef, entry);
	}

	private delete(contentRef: string): void {
		const entry = this.entries.get(contentRef);
		if (!entry) return;
		this.entries.delete(contentRef);
		const references = this.referencesByContent.get(entry.contentKey);
		references?.delete(contentRef);
		if (references?.size === 0) this.referencesByContent.delete(entry.contentKey);
		this.totalBytes -= entry.bytes.length;
	}
}
