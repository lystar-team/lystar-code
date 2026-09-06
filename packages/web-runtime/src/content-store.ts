import { randomUUID } from "node:crypto";
import type { ContentChunk, ContentReference, JsonValue, TranscriptItem } from "@lystar/code-web-protocol";

const REFERENCE_THRESHOLD = 64 * 1024;
const PREVIEW_HEAD_BYTES = 24 * 1024;
const PREVIEW_TAIL_BYTES = 8 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const REFERENCE_TTL_MS = 15 * 60 * 1000;

interface StoredContent {
	bytes: Buffer;
	sessionPath: string;
	mimeType: string;
	expiresAt: number;
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

function isToolResult(item: TranscriptItem): boolean {
	if (!item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) return false;
	const message = item.payload.message;
	return !!message && typeof message === "object" && !Array.isArray(message) && message.role === "toolResult";
}

export class ContentStore {
	private readonly entries = new Map<string, StoredContent>();
	private totalBytes = 0;

	compactTranscriptItem(sessionPath: string, item: TranscriptItem): TranscriptItem {
		const payload = this.compactImages(sessionPath, item.payload);
		return { ...item, payload: isToolResult(item) ? this.compactValue(sessionPath, payload) : payload };
	}

	read(sessionPath: string, contentRef: string, offset: number, limit: number): ContentChunk {
		this.evictExpired();
		const entry = this.entries.get(contentRef);
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
		if (offset > entry.bytes.length) {
			throw Object.assign(new Error("Content offset exceeds the referenced value"), {
				code: "content_offset_invalid",
				retryable: false,
			});
		}
		entry.expiresAt = Date.now() + REFERENCE_TTL_MS;
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
		entry.expiresAt = Date.now() + REFERENCE_TTL_MS;
		return {
			contentRef,
			mimeType: entry.mimeType,
			byteLength: entry.bytes.length,
			data: entry.bytes.toString("base64"),
		};
	}

	clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
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

	private compactImages(sessionPath: string, value: JsonValue): JsonValue {
		if (Array.isArray(value)) return value.map((item) => this.compactImages(sessionPath, item));
		if (!value || typeof value !== "object") return value;
		if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
			const bytes = Buffer.from(value.data, "base64");
			return {
				...value,
				data: this.createReference(sessionPath, bytes, value.mimeType) as unknown as JsonValue,
			};
		}
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, this.compactImages(sessionPath, item)]),
		);
	}

	private createReference(sessionPath: string, bytes: Buffer, mimeType: string, text?: string): ContentReference {
		if (bytes.length > MAX_CONTENT_BYTES) {
			throw Object.assign(new Error(`Tool output exceeds the ${MAX_CONTENT_BYTES} byte content reference limit`), {
				code: "content_too_large",
				retryable: false,
			});
		}
		this.evictExpired();
		while (this.totalBytes + bytes.length > MAX_TOTAL_BYTES && this.entries.size > 0) {
			const oldest = this.entries.keys().next().value;
			if (typeof oldest !== "string") break;
			this.delete(oldest);
		}
		const contentRef = randomUUID();
		this.entries.set(contentRef, {
			bytes,
			sessionPath,
			mimeType,
			expiresAt: Date.now() + REFERENCE_TTL_MS,
		});
		this.totalBytes += bytes.length;
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
		const entry = this.entries.get(contentRef);
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

	private evictExpired(): void {
		const now = Date.now();
		for (const [contentRef, entry] of this.entries) if (entry.expiresAt <= now) this.delete(contentRef);
	}

	private delete(contentRef: string): void {
		const entry = this.entries.get(contentRef);
		if (!entry) return;
		this.entries.delete(contentRef);
		this.totalBytes -= entry.bytes.length;
	}
}
