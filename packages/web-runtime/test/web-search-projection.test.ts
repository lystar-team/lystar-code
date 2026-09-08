import type { TranscriptItem } from "@lystar/code-web-protocol";
import { describe, expect, it } from "vitest";
import { projectTranscriptItems } from "../src/transcript-projection.ts";

function assistant(content: unknown): TranscriptItem {
	return {
		entryId: "assistant-entry",
		parentId: null,
		timestamp: "2026-09-08T00:00:00Z",
		kind: "message",
		payload: {
			type: "message",
			message: { role: "assistant", content },
		},
	} as TranscriptItem;
}

describe("web search transcript projection", () => {
	it("projects webSearchCall as a structured web search view instead of JSON", () => {
		const projected = projectTranscriptItems(
			assistant([
				{
					type: "webSearchCall",
					id: "ws-1",
					status: "completed",
					action: {
						type: "search",
						query: "uni-app Canvas touch event",
						sources: [{ type: "url", url: "https://uniapp.dcloud.net.cn/api/canvas" }],
					},
				},
				{ type: "text", text: "参考文档" },
			]),
		);

		expect(projected.map((item) => item.view?.type)).toEqual(["web_search", "assistant"]);
		expect(projected[0]?.view).toEqual({
			type: "web_search",
			id: "ws-1",
			status: "completed",
			query: "uni-app Canvas touch event",
			sources: [{ url: "https://uniapp.dcloud.net.cn/api/canvas", title: "uniapp.dcloud.net.cn" }],
		});
		expect(JSON.stringify(projected[0]?.view)).not.toContain('"type":"webSearchCall"');
	});

	it("uses assistant URL citations when the provider omits search sources", () => {
		const projected = projectTranscriptItems(
			assistant([
				{
					type: "webSearchCall",
					id: "ws-2",
					status: "completed",
					action: { type: "search", query: "Canvas touch" },
				},
				{
					type: "text",
					text: "请参考 MDN",
					annotations: [
						{
							type: "url_citation",
							start_index: 5,
							end_index: 8,
							title: "MDN Web Docs",
							url: "https://developer.mozilla.org/en-US/docs/Web/API/TouchEvent",
						},
					],
				},
			]),
		);

		expect(projected[0]?.view).toMatchObject({
			type: "web_search",
			sources: [
				{
					title: "MDN Web Docs",
					url: "https://developer.mozilla.org/en-US/docs/Web/API/TouchEvent",
				},
			],
		});
	});
});
