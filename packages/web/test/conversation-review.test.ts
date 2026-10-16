import { describe, expect, it, vi } from "vitest";
import { webApi } from "../src/adapters/host-protocol/api.ts";
import { readTranscriptText } from "../src/adapters/transcript-content.ts";
import {
	appendLiveRenderItems,
	type CompactionRenderItem,
	preserveConversationToolStackKeys,
	type TranscriptToolStackRenderItem,
} from "../src/components/workbench/conversation-render-model.ts";
import { Virtualizer } from "@tanstack/react-virtual";
import { buildConversationListModel, type ConversationListModel } from "../src/components/workbench/conversation-list-model.ts";
import { reconcileCommittedTurn } from "../src/state/chat-lifecycle.ts";
import {
	decorateTranscriptItems,
	mergeTranscriptEntries,
	transcriptRenderIdOverrides,
} from "../src/state/transcript-state.ts";
import { restoreLiveMessage } from "../src/state/workbench-live-state.ts";
import { initialState } from "../src/state/workbench-state.ts";
import type { WorkbenchState } from "../src/state/workbench-types.ts";
import type { WebTranscriptItem } from "../src/types.ts";

vi.mock("../src/adapters/host-protocol/api.ts", () => ({ webApi: { request: vi.fn(), hasToken: () => false } }));

function entry(entryId: string, parentId: string | null, text = entryId): WebTranscriptItem {
	return {
		entryId,
		parentId,
		timestamp: new Date(0).toISOString(),
		kind: "message",
		payload: null,
		view: { type: "assistant", text },
	};
}

function state(): WorkbenchState {
	return {
		...initialState(),
		sessionId: "review",
		transcriptRevision: 1,
		liveTurnStartRevision: 1,
		liveTurnId: 1,
		liveTurnItems: [],
	};
}

describe("conversation review regressions", () => {
	it("冷恢复先收到有序块、后收到工具快照时，工具位置不丢失", () => {
		const restored = restoreLiveMessage(state(), [
			{ blockId: "message:0", kind: "text", text: "前" },
			{ blockId: "message:1", kind: "tool", toolCallId: "read-1" },
			{ blockId: "message:2", kind: "text", text: "后" },
		]);
		expect(restored.liveTurnItems.map((item) => item.kind)).toEqual(["text", "tools", "text"]);
		const again = restoreLiveMessage(restored, [
			{ blockId: "message:0", kind: "text", text: "前，完整恢复" },
			{ blockId: "message:1", kind: "tool", toolCallId: "read-1" },
			{ blockId: "message:2", kind: "text", text: "后，完整恢复" },
		]);
		expect(again.liveTurnItems.map((item) => item.id)).toEqual(restored.liveTurnItems.map((item) => item.id));
		expect(again.liveTurnItems[0]).toMatchObject({ parts: ["前，完整恢复"] });
	});

	it("相同正文的上一条消息提交时，只移除它的块，不移除下一条消息", () => {
		const current = state();
		current.liveTurnItems = [
			{ id: "first", kind: "text", blockId: "first-message:0", parts: ["相同"], turnId: 1 },
			{ id: "second", kind: "text", blockId: "second-message:0", parts: ["相同"], turnId: 1 },
		];
		const committed = entry("persisted-first", null, "相同");
		const mappings = [{ blockId: "first-message:0", entryId: committed.entryId, viewIndex: 0 }];
		const overrides = transcriptRenderIdOverrides(current.liveTurnItems, undefined, [committed], mappings);
		expect(decorateTranscriptItems([committed], [], overrides)[0]?.renderId).toBe("first");
		expect(reconcileCommittedTurn(current, [committed], 2, mappings).liveTurnItems.map((item) => item.id)).toEqual([
			"second",
		]);
		expect(transcriptRenderIdOverrides(current.liveTurnItems, undefined, [committed]).size).toBe(0);
	});

	it("无重叠页面按父链放到已知提交之前，不按时间戳猜顺序", () => {
		const current = decorateTranscriptItems([entry("later", "earlier")]);
		const merged = mergeTranscriptEntries(current, [entry("earlier", null)]);
		expect(merged.map((item) => item.entryId)).toEqual(["earlier", "later"]);
		expect(mergeTranscriptEntries(merged, [entry("earlier", null)]).map((item) => item.entryId)).toEqual([
			"earlier",
			"later",
		]);
	});

	it("更新压缩卡片不修改输入卡片", () => {
		const original: CompactionRenderItem = Object.freeze({
			kind: "compaction",
			key: "compact",
			live: true,
			state: { status: "running", summaryCountAtStart: 0 },
		});
		const next = appendLiveRenderItems(
			[original],
			[{ id: "compact", kind: "compaction", turnId: 1 }],
			{},
			new Set(),
			{ status: "completed", summaryCountAtStart: 0 },
			1,
		);
		expect(original.state?.status).toBe("running");
		expect(next[0]).toMatchObject({ state: { status: "completed" } });
	});

	it("工具组 key 变化与内部补页时，由 TanStack 保持正文行偏移", () => {
		const project = (ids: string[]) => buildConversationListModel([{
			kind: "tool-stack", key: ids[0]!, live: false, collapseForResult: false,
			batches: [{ kind: "tool-batch", key: ids[0]!, tools: ids.map((id) => ({ id, name: "read", summary: id, state: "input-available" })) }],
		}], {
			expandedAgentSteps: new Map(), expandedWorkProcesses: new Map(), expandedThinking: new Map(), expandedToolBatches: new Map(), retainedGroups: new Set(),
			toolActivityPresentation: () => ({ kind: "file", repeatedFileReads: false }), toolPresentation: () => "group", gap: () => 0,
		});
		const scroller = { scrollTop: 42, scrollHeight: 1000, clientHeight: 24 } as HTMLElement;
		const options = (model: ConversationListModel) => ({
			count: model.rows.length, getItemKey: (index: number) => model.rows[index]!.key,
			getScrollElement: () => scroller, estimateSize: (index: number) => model.rows[index]!.height,
			initialRect: { width: 500, height: 24 }, initialOffset: 42, anchorTo: "end" as const,
			observeElementRect: () => undefined, observeElementOffset: () => undefined, scrollToFn: () => {},
		});
		const original = project(["read-2", "read-3"]);
		const virtualizer = new Virtualizer<HTMLElement, HTMLElement>(options(original));
		virtualizer._willUpdate();
		virtualizer.getVirtualItems();
		const before = virtualizer.measurementsCache.find((row) => row.key === "tool:read-2")!.start - virtualizer.scrollOffset!;
		const prepended = project(["read-1", "read-2", "read-3"]);
		virtualizer.setOptions(options(prepended));
		virtualizer.getVirtualItems();
		expect(virtualizer.measurementsCache.find((row) => row.key === "tool:read-2")!.start - virtualizer.scrollOffset!).toBe(before);
		virtualizer.resizeItem(0, 65);
		virtualizer.getVirtualItems();
		expect(virtualizer.measurementsCache.find((row) => row.key === "tool:read-2")!.start - virtualizer.scrollOffset!).toBe(before);
	});

	it("工具组补入历史后复用组 key，展开状态不因第一条工具改变而丢失", () => {
		const stack = (key: string, ids: string[]): TranscriptToolStackRenderItem => ({
			kind: "tool-stack",
			key,
			live: false,
			collapseForResult: false,
			batches: [
				{
					kind: "tool-batch",
					key,
					tools: ids.map((id) => ({ id, name: "read", summary: id, state: "output-available" })),
				},
			],
		});
		const original = stack("old-stack", ["read-2", "read-3"]);
		const next = stack("new-stack", ["read-1", "read-2", "read-3"]);
		expect(preserveConversationToolStackKeys([next], [original])[0]?.key).toBe("old-stack");
		expect(next.key).toBe("new-stack");
	});

	it("全文跨 UTF-8 字节边界读取，末尾和中文不丢失", async () => {
		const text = `${"长正文中文".repeat(30000)}末尾标记`;
		const bytes = new TextEncoder().encode(text);
		vi.mocked(webApi.request).mockReset();
		for (let offset = 0; offset < bytes.length; offset += 262145) {
			const nextOffset = Math.min(bytes.length, offset + 262145);
			vi.mocked(webApi.request).mockResolvedValueOnce({
				contentRef: "text-ref",
				offset,
				nextOffset,
				byteLength: bytes.length,
				data: Buffer.from(bytes.subarray(offset, nextOffset)).toString("base64"),
				encoding: "base64",
				done: nextOffset === bytes.length,
			});
		}
		expect(await readTranscriptText("review", "text-ref")).toBe(text);
	});
});
