import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRoomMessage } from "@earendil-works/pi-coding-agent/core";
import { afterEach, expect, it } from "vitest";
import { roomAttachmentInput } from "../src/session-room-attachments.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("gives Room agents the contents of text and image attachments without changing the visible message", async () => {
	const root = mkdtempSync(join(tmpdir(), "lystar-room-input-"));
	directories.push(root);
	const textPath = join(root, "notes.md");
	const imagePath = join(root, "image.png");
	const binaryPath = join(root, "report.pdf");
	writeFileSync(textPath, "待办：检查数据");
	writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));
	writeFileSync(binaryPath, Buffer.from([37, 80, 68, 70]));
	const message: SessionRoomMessage = {
		id: "message",
		roomId: "room",
		seq: 1,
		senderSessionId: "owner",
		senderType: "user",
		targetSessionIds: ["member"],
		route: "direct",
		kind: "message",
		body: "请查看附件",
		attachments: [
			{ path: textPath, filename: "notes.md", mimeType: "text/markdown" },
			{ path: imagePath, filename: "image.png", mimeType: "image/png" },
			{ path: binaryPath, filename: "report.pdf", mimeType: "application/pdf" },
		],
		idempotencyKey: "input",
		createdAt: new Date().toISOString(),
	};
	const result = await roomAttachmentInput(message);
	expect(message.body).toBe("请查看附件");
	expect(result.text).toContain("待办：检查数据");
	expect(result.text).toContain('filename="image.png"');
	expect(result.text).toContain("report.pdf（application/pdf）已上传，但当前 Room 消息无法读取其内容");
	expect(result.images).toEqual([{ data: Buffer.from([137, 80, 78, 71]).toString("base64"), mimeType: "image/png" }]);
});
