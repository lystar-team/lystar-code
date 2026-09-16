import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent/core";
import type { JsonValue, TranscriptItem } from "@lystar/code-web-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentStore } from "../src/content-store.ts";
import {
	migrateLegacyWebAttachments,
	promptFileReferences,
	rebindSessionAttachments,
	sessionAttachmentDirectory,
} from "../src/session-attachments.ts";

const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type DisplayOnlyImage = ImageContent & { sendToModel: false };

describe("session attachments", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "web-runtime-attachments-"));
	});

	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	it("migrates legacy display-only Base64 images and serves them through ContentStore", async () => {
		const sourcePath = join(tempDir, "legacy-upload.png");
		const legacyImage: DisplayOnlyImage = {
			type: "image",
			data: IMAGE_DATA,
			mimeType: "image/png",
			sendToModel: false,
		};
		const manager = SessionManager.create(tempDir, tempDir, { persistHeader: true });
		manager.appendMessage({
			role: "user",
			content: [
				{
					type: "text",
					text: `<file name="${sourcePath}" filename="screenshot.png" mimeType="image/png"></file>`,
				},
				legacyImage,
			],
			timestamp: 1,
		});
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const sessionPath = manager.getSessionFile();
		if (!sessionPath) throw new Error("Session path is missing");
		manager.dispose();

		const reopened = await SessionManager.openAsync(sessionPath);
		try {
			expect(await migrateLegacyWebAttachments(reopened)).toBe(true);
			expect(await migrateLegacyWebAttachments(reopened)).toBe(false);

			const contents = readFileSync(sessionPath, "utf8");
			expect(contents).not.toContain(IMAGE_DATA);
			const userEntry = reopened
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!userEntry || userEntry.type !== "message" || userEntry.message.role !== "user") {
				throw new Error("Migrated user entry is missing");
			}
			expect(Array.isArray(userEntry.message.content)).toBe(true);
			if (!Array.isArray(userEntry.message.content)) throw new Error("User content is not structured");
			expect(userEntry.message.content.some((part) => part.type === "image")).toBe(false);
			const references = promptFileReferences(userEntry.message.content);
			expect(references).toHaveLength(1);
			expect(references[0]?.path).toContain(join(tempDir, ".attachments"));
			expect(readFileSync(references[0]!.path).toString("base64")).toBe(IMAGE_DATA);

			const store = new ContentStore();
			const item: TranscriptItem = {
				entryId: userEntry.id,
				parentId: userEntry.parentId,
				kind: "message",
				timestamp: userEntry.timestamp,
				payload: userEntry as unknown as JsonValue,
			};
			const compacted = store.compactTranscriptItem(sessionPath, item);
			const payload = compacted.payload as {
				message: { content: Array<{ type: string; data?: { type?: string; contentRef?: string } }> };
			};
			const image = payload.message.content.find((part) => part.type === "image");
			expect(image?.data?.type).toBe("content_ref");
			if (!image?.data?.contentRef) throw new Error("Image content reference is missing");
			expect(store.readImage(sessionPath, image.data.contentRef).data).toBe(IMAGE_DATA);

			const leafId = reopened.getLeafId();
			if (!leafId) throw new Error("Session leaf is missing");
			const branched = reopened.createBranchedSessionManager(leafId);
			try {
				expect(await rebindSessionAttachments(branched, sessionPath)).toBe(true);
				const branchedPath = branched.getSessionFile();
				if (!branchedPath) throw new Error("Branched Session path is missing");
				const branchedUserEntry = branched
					.getEntries()
					.find((entry) => entry.type === "message" && entry.message.role === "user");
				if (
					!branchedUserEntry ||
					branchedUserEntry.type !== "message" ||
					branchedUserEntry.message.role !== "user"
				) {
					throw new Error("Branched user entry is missing");
				}
				const branchedReference = promptFileReferences(branchedUserEntry.message.content)[0];
				expect(branchedReference?.path).toContain(sessionAttachmentDirectory(branchedPath));
				expect(branchedReference?.path).not.toBe(references[0]?.path);
				expect(readFileSync(branchedReference!.path).toString("base64")).toBe(IMAGE_DATA);
			} finally {
				branched.dispose();
			}
		} finally {
			reopened.dispose();
		}
	});
});
