import { open, readFile, stat } from "node:fs/promises";
import type { SessionRoomMessage } from "@earendil-works/pi-coding-agent/core";
import { SessionRoomCoordinator } from "./session-room-coordinator.ts";

const MAX_INLINE_TEXT_BYTES = 128 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export async function roomAttachmentInput(message: SessionRoomMessage): Promise<{
	text: string;
	images: Array<{ data: string; mimeType: string }>;
}> {
	let text = SessionRoomCoordinator.formatMessageForSession(message);
	const images: Array<{ data: string; mimeType: string }> = [];
	for (const attachment of message.attachments ?? []) {
		const size = (await stat(attachment.path)).size;
		if (/^image\/(png|jpeg|gif|webp)$/u.test(attachment.mimeType)) {
			if (size > MAX_IMAGE_BYTES) throw new Error(`Room 图片附件超过 20 MiB：${attachment.filename}`);
			images.push({ data: (await readFile(attachment.path)).toString("base64"), mimeType: attachment.mimeType });
		} else if (
			/^text\//u.test(attachment.mimeType) ||
			/^(application\/(json|xml|javascript)|[^/]+\/[^/]+\+json)$/u.test(attachment.mimeType)
		) {
			const file = await open(attachment.path, "r");
			const buffer = Buffer.alloc(Math.min(size, MAX_INLINE_TEXT_BYTES) + 1);
			let bytesRead: number;
			try {
				({ bytesRead } = await file.read(buffer, 0, buffer.length, 0));
			} finally {
				await file.close();
			}
			text += `\n\n附件 ${attachment.filename} 内容${size > MAX_INLINE_TEXT_BYTES ? "（前 128 KiB）" : ""}：\n${buffer.subarray(0, Math.min(bytesRead, MAX_INLINE_TEXT_BYTES)).toString("utf8")}`;
		} else {
			text += `\n\n附件 ${attachment.filename}（${attachment.mimeType}）已上传，但当前 Room 消息无法读取其内容。`;
		}
	}
	return { text, images };
}
