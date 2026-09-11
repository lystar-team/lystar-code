import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptItem } from "@lystar/code-web-protocol";
import { describe, expect, it } from "vitest";
import { ContentStore } from "../src/content-store.ts";
import { projectTranscriptItem } from "../src/transcript-projection.ts";

function imageItem(data: string): TranscriptItem {
	return {
		entryId: "entry",
		parentId: null,
		timestamp: "2026-08-14T00:00:00Z",
		kind: "message",
		payload: {
			type: "message",
			message: { role: "user", content: [{ type: "image", data, mimeType: "image/png" }] },
		},
	};
}

function toolResultItem(text: string): TranscriptItem {
	return {
		entryId: "tool-result",
		parentId: null,
		timestamp: "2026-09-11T00:00:00Z",
		kind: "message",
		payload: {
			type: "message",
			message: { role: "toolResult", content: [{ type: "text", text }] },
		},
	};
}

function imageToolResultItem(data: string, savedPath: string): TranscriptItem {
	return {
		entryId: "image-tool-result",
		parentId: null,
		timestamp: "2026-09-11T00:00:00Z",
		kind: "message",
		payload: {
			type: "message",
			message: {
				role: "toolResult",
				toolName: "image_gen",
				content: [{ type: "image", data, mimeType: "image/png" }],
				details: { savedPath, mimeType: "image/png" },
			},
		},
	};
}

function textReference(item: TranscriptItem): { contentRef: string } {
	return (item.payload as { message: { content: Array<{ text: { contentRef: string } }> } }).message.content[0]!.text;
}

describe("ContentStore", () => {
	it("moves transcript image bytes behind a Session-bound content reference", () => {
		const store = new ContentStore();
		const bytes = Buffer.from("real-image-bytes");
		const compacted = store.compactTranscriptItem("/tmp/session-a.jsonl", imageItem(bytes.toString("base64")));
		const payload = compacted.payload as {
			message: { content: Array<{ data: { contentRef: string; mimeType: string }; mimeType: string }> };
		};
		const reference = payload.message.content[0].data;
		expect(reference).toMatchObject({ mimeType: "image/png" });
		const chunk = store.read("/tmp/session-a.jsonl", reference.contentRef, 0, 1024);
		expect(Buffer.from(chunk.data, "base64")).toEqual(bytes);
		expect(store.readImage("/tmp/session-a.jsonl", reference.contentRef)).toMatchObject({
			mimeType: "image/png",
			byteLength: bytes.length,
			data: bytes.toString("base64"),
		});
		expect(() => store.readImage("/tmp/session-b.jsonl", reference.contentRef)).toThrow("does not belong");
		expect(projectTranscriptItem(compacted)).toEqual({
			type: "user",
			text: "",
			images: [{ contentRef: reference.contentRef, mimeType: "image/png", byteLength: bytes.length }],
		});
	});

	it("reuses a retained reference for identical large content in the same Session", () => {
		const store = new ContentStore();
		const text = "x".repeat(80 * 1024);
		const item = toolResultItem(text);
		const first = textReference(store.compactTranscriptItem("/tmp/session-a.jsonl", item));
		const second = textReference(store.compactTranscriptItem("/tmp/session-a.jsonl", item));
		const otherSession = textReference(store.compactTranscriptItem("/tmp/session-b.jsonl", item));

		expect(second.contentRef).toBe(first.contentRef);
		expect(otherSession.contentRef).not.toBe(first.contentRef);
		expect(
			Buffer.from(store.read("/tmp/session-a.jsonl", first.contentRef, 0, text.length).data, "base64").toString(),
		).toBe(text);
	});

	it("does not reuse a reference when sampled bytes match but full content differs", () => {
		const store = new ContentStore();
		const firstText = "x".repeat(80 * 1024);
		const secondText = `${firstText.slice(0, 1024)}y${firstText.slice(1025)}`;
		const first = textReference(store.compactTranscriptItem("/tmp/session.jsonl", toolResultItem(firstText)));
		const second = textReference(store.compactTranscriptItem("/tmp/session.jsonl", toolResultItem(secondText)));

		expect(second.contentRef).not.toBe(first.contentRef);
		expect(
			Buffer.from(
				store.read("/tmp/session.jsonl", second.contentRef, 0, secondText.length).data,
				"base64",
			).toString(),
		).toBe(secondText);
	});

	it("restores an expired generated-image reference from its saved artifact", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "content-store-image-artifact-"));
		try {
			const store = new ContentStore();
			const bytes = Buffer.from("persisted-generated-image");
			const savedPath = join(tempDir, "generated.png");
			writeFileSync(savedPath, bytes);
			const compacted = store.compactTranscriptItem(
				"/tmp/session-image.jsonl",
				imageToolResultItem(bytes.toString("base64"), savedPath),
			);
			const payload = compacted.payload as {
				message: { content: Array<{ data: { contentRef: string } }> };
			};
			const reference = payload.message.content[0].data;

			store.evictExpired(Date.now() + 16 * 60 * 1000);

			expect(store.readImage("/tmp/session-image.jsonl", reference.contentRef)).toMatchObject({
				mimeType: "image/png",
				byteLength: bytes.length,
				data: bytes.toString("base64"),
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("removes expired references without waiting for another content request", () => {
		const store = new ContentStore();
		const reference = textReference(
			store.compactTranscriptItem("/tmp/session.jsonl", toolResultItem("x".repeat(80 * 1024))),
		);

		store.evictExpired(Date.now() + 16 * 60 * 1000);

		expect(() => store.read("/tmp/session.jsonl", reference.contentRef, 0, 1024)).toThrow("missing or expired");
	});
});
