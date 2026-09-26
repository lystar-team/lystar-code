import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolBatch, type ToolBatchTool, toolRowTitle } from "../src/components/ai-elements/tool-batch.tsx";
import { buildConversationRenderItems, buildPersistedRenderItems } from "../src/components/workbench/conversation-render-model.ts";
import { committedToolCallIds } from "../src/state/chat-lifecycle.ts";
import type { WebTranscriptItem } from "../src/types.ts";

describe("file tool paths across transcript pages", () => {
	it("shows the recovered path and source line range for a segmented read", () => {
		const tool: ToolBatchTool = {
			id: "read-1", name: "read", state: "output-available",
			summary: '{"path":"src/a.ts","offset":323,"limit":300}',
			detail: `${Array.from({ length: 300 }, (_, index) => `line ${index}`).join("\n")}\n\n[1088 more lines in file. Use offset=623 to continue.]`,
		};
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool] }));
		expect(markup).toContain("src/a.ts");
		expect(markup).toContain("第323-622行");
		expect(markup).not.toContain("第1-302行");
	});

	it("does not show a made-up filename or line range for a result without its call", () => {
		const markup = renderToStaticMarkup(createElement(ToolBatch, {
			tools: [{ id: "orphan", name: "read", summary: "read", state: "output-available", detail: "file contents" }],
		}));
		expect(markup).toContain("已读取 文件路径未记录");
		expect(markup).not.toContain("第1-");
		const namedReadTool: ToolBatchTool = {
			id: "named-read", name: "read", summary: '{"path":"read"}', state: "output-available", detail: "contents",
		};
		const namedRead = renderToStaticMarkup(createElement(ToolBatch, { tools: [namedReadTool] }));
		expect(toolRowTitle(namedReadTool)).toBe("已读取 read");
		expect(namedRead).toContain('title="read"');
		expect(namedRead).not.toContain("文件路径未记录");
	});

	it("replaces a live card with the persisted result when only the result is in the page", () => {
		const transcript: WebTranscriptItem[] = [{
			entryId: "read-result", renderId: "read-result", parentId: "call", timestamp: "2026-09-26T00:00:00Z",
			kind: "message",
			view: { type: "tool_result", callId: "read-1", name: "read", status: "success", summary: "read", detail: "source" },
		}];
		const index = {
			callIds: new Set<string>(),
			statuses: new Map([["read-1", "success" as const]]),
			results: new Map<string, ToolBatchTool>([["read-1", {
				id: "read-1", name: "read", summary: "read", state: "output-available", detail: "source",
			}]]),
		};
		const liveTools = {
			"read-1": { id: "read-1", name: "read", batchId: "batch-1", summary: "src/a.ts", state: "success" as const, status: "success" as const },
		};
		const persisted = buildPersistedRenderItems(transcript, index, [], {}, {}, {}, liveTools);
		const liveItems = [{ id: "live-read", kind: "tools" as const, turnId: 1, batchId: "batch-1", toolIds: ["read-1"] }];
		const rendered = buildConversationRenderItems(
			persisted, liveItems, liveTools, committedToolCallIds(transcript), undefined, 1, true,
		);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toMatchObject({
			kind: "tool-stack", live: false,
			batches: [{ tools: [{ summary: "src/a.ts", detail: "source" }] }],
		});
	});
});
