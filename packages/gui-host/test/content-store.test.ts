import type { TranscriptItem } from "@lystar/code-gui-protocol";
import { describe, expect, it } from "vitest";
import { ContentStore } from "../src/content-store.ts";

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

describe("ContentStore images", () => {
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
		expect(() => store.read("/tmp/session-b.jsonl", reference.contentRef, 0, 1024)).toThrow("does not belong");
	});
});
