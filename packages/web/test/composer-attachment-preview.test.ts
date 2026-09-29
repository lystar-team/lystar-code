import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubmittedAttachmentPreviews } from "../src/components/workbench/composer.tsx";
import { TranscriptMessageView } from "../src/components/workbench/transcript-message.tsx";

afterEach(() => vi.unstubAllGlobals());

describe("submitted image preview", () => {
	it("uses image bytes instead of the revoked composer blob URL before the Agent starts", async () => {
		class TestFileReader {
			result: string | null = null;
			error: Error | null = null;
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;

			async readAsDataURL(file: File) {
				this.result = `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
				this.onload?.();
			}
		}
		vi.stubGlobal("FileReader", TestFileReader);
		const sourceFile = new File(["image bytes"], "screenshot.png", { type: "image/png" });
		const previews = await createSubmittedAttachmentPreviews(
			[
				{
					id: "draft-1",
					type: "file",
					filename: sourceFile.name,
					mediaType: sourceFile.type,
					sourceFile,
					url: "blob:revoked",
				},
			],
			[{ path: "/tmp/upload.png", mimeType: "image/png", byteLength: sourceFile.size }],
		);
		const markup = renderToStaticMarkup(
			createElement(TranscriptMessageView, {
				role: "user",
				text: "请查看截图",
				attachments: previews,
				showCopy: false,
				sessionId: "session-1",
				onOpenPath: () => {},
			}),
		);

		expect(previews[0]?.url).toBe(`data:image/png;base64,${Buffer.from("image bytes").toString("base64")}`);
		expect(markup).toContain('src="data:image/png;base64,');
		expect(markup).not.toContain("blob:revoked");
	});

	it("does not inline non-image files or images above the session preview limit", async () => {
		const largeImage = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "large.png", { type: "image/png" });
		const previews = await createSubmittedAttachmentPreviews(
			[
				{
					id: "draft-1",
					type: "file",
					filename: "notes.txt",
					mediaType: "text/plain",
					sourceFile: new File(["notes"], "notes.txt"),
					url: "blob:notes",
				},
				{
					id: "draft-2",
					type: "file",
					filename: "large.png",
					mediaType: "image/png",
					sourceFile: largeImage,
					url: "blob:large",
				},
			],
			[
				{ path: "/tmp/notes.txt", mimeType: "text/plain", byteLength: 5 },
				{ path: "/tmp/large.png", mimeType: "image/png", byteLength: largeImage.size },
			],
		);

		expect(previews.map(({ url }) => url)).toEqual(["", ""]);
	});
});
