import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "../src/components/ai-elements/message.tsx";
import { TranscriptMessageView } from "../src/components/workbench/transcript.tsx";

describe("MessageResponse local resource links", () => {

	it("将用户图片作为缩略图展示，不显示图片回退名称", () => {
		const markup = renderToStaticMarkup(
			createElement(TranscriptMessageView, {
				role: "user",
				text: "请查看截图",
				attachments: [
					{
						id: "upload-1",
						filename: "图片 1",
						mediaType: "image/png",
						url: "data:image/png;base64,AAAA",
					},
				],
				showCopy: false,
				sessionId: "session-1",
				onOpenPath: () => {},
			}),
		);

		expect(markup).toContain("<img");
		expect(markup).not.toContain(">图片 1<");
	});

	it("keeps project-relative file links clickable instead of marking them blocked", () => {
		const markup = renderToStaticMarkup(
			createElement(
				MessageResponse,
				{
					linkSafety: { enabled: true },
					onOpenPath: () => {},
				},
				"- [use-workbench.ts](packages/web/src/state/use-workbench.ts)",
			),
		);

		expect(markup).toContain("use-workbench.ts");
		expect(markup).toContain("<button");
		expect(markup).not.toContain("[blocked]");
	});
});
