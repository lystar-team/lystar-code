import { describe, expect, it, vi } from "vitest";
import * as renderModel from "../src/components/workbench/conversation-render-model.ts";
import {
	CONVERSATION_RENDER_CACHE_BYTES_LIMIT,
	CONVERSATION_RENDER_CACHE_LIMIT,
	type ConversationRenderCacheEntry,
	ConversationRenderPipeline,
	type ConversationRenderPipelineInput,
	pruneConversationRenderCache,
	writeConversationRenderCache,
} from "../src/components/workbench/conversation-render-pipeline.ts";
import type { WorkbenchState } from "../src/state/use-workbench";
import * as sessionCache from "../src/state/workbench-session-cache.ts";

const timestamp = "2026-09-24T00:00:00.000Z";

function baseTranscript(detail = "读取完成"): WorkbenchState["transcript"] {
	return [
		{
			entryId: "user-1",
			renderId: "user-1",
			parentId: null,
			timestamp,
			kind: "message",
			view: { type: "user", text: "检查项目" },
		},
		{
			entryId: "call-1",
			renderId: "call-1",
			parentId: "user-1",
			timestamp,
			kind: "message",
			view: { type: "tool_call", calls: [{ id: "read-1", name: "read", summary: "README.md" }] },
		},
		{
			entryId: "result-1",
			renderId: "result-1",
			parentId: "call-1",
			timestamp,
			kind: "message",
			view: {
				type: "tool_result",
				callId: "read-1",
				name: "read",
				summary: "README.md",
				status: "success",
				detail,
			},
		},
		{
			entryId: "assistant-1",
			renderId: "assistant-1",
			parentId: "result-1",
			timestamp,
			kind: "message",
			view: { type: "assistant", text: "检查完成。" },
		},
	];
}

function pipelineInput(overrides: Partial<ConversationRenderPipelineInput> = {}): ConversationRenderPipelineInput {
	return {
		sessionId: "session-a",
		transcript: baseTranscript(),
		agentSteps: {},
		pendingUserPrompts: [],
		promptSendTimes: {},
		liveTools: {},
		liveSteps: {},
		liveTurnItems: [],
		liveCompaction: undefined,
		liveTurnId: 1,
		responseActive: true,
		canEditPrompts: false,
		settledTurns: {},
		...overrides,
	};
}

function cacheEntry(bytes: number): ConversationRenderCacheEntry {
	return { bytes } as unknown as ConversationRenderCacheEntry;
}

describe("conversation render pipeline", () => {
	it("纯实时文本增量复用历史，不重建工具索引与历史渲染项", () => {
		const buildSpy = vi.spyOn(renderModel, "buildPersistedRenderItems");
		const pipeline = new ConversationRenderPipeline();
		const base = pipelineInput();
		const first = pipeline.render(base);
		const second = pipeline.render({
			...base,
			liveTurnItems: [{ id: "text-1", kind: "text", parts: ["第一段"], turnId: 1 }],
		});
		const third = pipeline.render({
			...base,
			liveTurnItems: [{ id: "text-1", kind: "text", parts: ["第一段", "第二段"], turnId: 1 }],
		});

		// 三次渲染只构建一次历史；纯文本增量不重新合并工具状态，也不重建历史渲染项。
		expect(buildSpy).toHaveBeenCalledTimes(1);
		expect(second.toolIndex).toBe(first.toolIndex);
		expect(third.toolIndex).toBe(first.toolIndex);
		expect(third.renderItems).not.toBe(second.renderItems);
		expect(third.renderItems.at(-1)).toMatchObject({ kind: "message", text: "第一段第二段" });
		buildSpy.mockRestore();
	});

	it("实时工具终态变化仍合并进工具索引", () => {
		const pipeline = new ConversationRenderPipeline();
		const base = pipelineInput();
		const first = pipeline.render(base);
		const second = pipeline.render({
			...base,
			liveTools: {
				"read-1": {
					id: "read-1",
					name: "read",
					batchId: "batch-1",
					summary: "读取中断",
					state: "interrupted",
					status: "error",
				},
			},
		});

		expect(second.toolIndex).not.toBe(first.toolIndex);
		expect(second.toolIndex.results.get("read-1")).toMatchObject({
			state: "output-interrupted",
			summary: "读取中断",
		});
	});

	it("切回会话复用缓存渲染身份，缓存按会话计数", () => {
		const pipeline = new ConversationRenderPipeline();
		const sessionA = pipelineInput({ sessionId: "session-a" });
		const sessionB = pipelineInput({ sessionId: "session-b", transcript: baseTranscript("另一个会话") });
		const firstA = pipeline.render(sessionA);
		const firstB = pipeline.render(sessionB);
		const secondA = pipeline.render(sessionA);

		expect(firstB.renderItems).not.toBe(firstA.renderItems);
		expect(secondA.renderItems).toBe(firstA.renderItems);
		expect(secondA.toolIndex).toBe(firstA.toolIndex);
		expect(pipeline.cacheSize).toBe(2);
	});

	it("命中缓存后同步历史，后续直播增量仍复用该会话历史", () => {
		const buildSpy = vi.spyOn(renderModel, "buildPersistedRenderItems");
		const pipeline = new ConversationRenderPipeline();
		const sessionA = pipelineInput({ sessionId: "session-a" });
		const sessionB = pipelineInput({ sessionId: "session-b" });
		const firstA = pipeline.render(sessionA);
		pipeline.render(sessionB);
		const secondA = pipeline.render(sessionA);
		const thirdA = pipeline.render({
			...sessionA,
			liveTurnItems: [{ id: "text-1", kind: "text", parts: ["后续"], turnId: 1 }],
		});

		expect(secondA.renderItems).toBe(firstA.renderItems);
		// 仅 A、B 各构建一次历史；缓存命中的 A 在后续纯文本增量中不重建。
		expect(buildSpy).toHaveBeenCalledTimes(2);
		expect(thirdA.toolIndex).toBe(firstA.toolIndex);
		buildSpy.mockRestore();
	});

	it("直播增长计入渲染缓存字节预算", () => {
		const pipeline = new ConversationRenderPipeline();
		const base = pipelineInput({ sessionId: "live-budget" });
		pipeline.render(base);
		const before = pipeline.cachedBytes("live-budget");
		pipeline.render({
			...base,
			liveTurnItems: [{ id: "text-1", kind: "text", parts: ["a".repeat(4_000)], turnId: 1 }],
		});
		const after = pipeline.cachedBytes("live-budget");

		expect(before).toBeGreaterThan(0);
		expect(after).toBeGreaterThan(before ?? 0);
	});

	it("超大历史不缓存时，纯文本增量不重估整份历史", () => {
		const byteSpy = vi.spyOn(sessionCache, "approximateValueBytes");
		const pipeline = new ConversationRenderPipeline({ cacheBytesLimit: 1 });
		const base = pipelineInput({ sessionId: "oversized" });
		pipeline.render(base);
		expect(pipeline.cachedBytes("oversized")).toBeUndefined();
		byteSpy.mockClear();
		for (let tick = 1; tick <= 5; tick++) {
			pipeline.render({
				...base,
				liveTurnItems: [{ id: "text-1", kind: "text", parts: ["a".repeat(tick * 100)], turnId: 1 }],
			});
		}
		const historyEstimates = byteSpy.mock.calls.filter(
			([value]) => typeof value === "object" && value !== null && "toolIndex" in value,
		);

		expect(historyEstimates).toHaveLength(0);
		expect(byteSpy.mock.calls.length).toBeGreaterThan(0);
		byteSpy.mockRestore();
	});

	it("被裁剪的会话切回时重建历史", () => {
		const pipeline = new ConversationRenderPipeline();
		const sessionA = pipelineInput({ sessionId: "session-a" });
		const sessionB = pipelineInput({ sessionId: "session-b" });
		const firstA = pipeline.render(sessionA);
		pipeline.render(sessionB);
		pipeline.prune(["session-b"]);
		const secondA = pipeline.render(sessionA);

		expect(secondA.renderItems).not.toBe(firstA.renderItems);
		expect(secondA.toolIndex).not.toBe(firstA.toolIndex);
	});

	it("渲染缓存按条数上限淘汰最旧会话", () => {
		const cache = new Map<string, ConversationRenderCacheEntry>();
		for (let index = 0; index < CONVERSATION_RENDER_CACHE_LIMIT + 2; index++) {
			writeConversationRenderCache(cache, `session-${index}`, cacheEntry(1_024));
		}

		expect(cache.size).toBe(CONVERSATION_RENDER_CACHE_LIMIT);
		expect(cache.has("session-0")).toBe(false);
		expect(cache.has(`session-${CONVERSATION_RENDER_CACHE_LIMIT + 1}`)).toBe(true);
	});

	it("渲染缓存按字节预算淘汰，单个超大会话不进入缓存", () => {
		const cache = new Map<string, ConversationRenderCacheEntry>();
		const half = Math.floor(CONVERSATION_RENDER_CACHE_BYTES_LIMIT / 2) + 1;
		writeConversationRenderCache(cache, "large-a", cacheEntry(half));
		writeConversationRenderCache(cache, "large-b", cacheEntry(half));

		expect(cache.has("large-a")).toBe(false);
		expect(cache.has("large-b")).toBe(true);

		writeConversationRenderCache(cache, "oversized", cacheEntry(CONVERSATION_RENDER_CACHE_BYTES_LIMIT + 1));
		expect(cache.has("oversized")).toBe(false);
		expect(cache.size).toBe(1);
	});

	it("按保留会话裁剪缓存并释放其余历史", () => {
		const cache = new Map<string, ConversationRenderCacheEntry>();
		for (const sessionId of ["session-a", "session-b", "session-c"]) {
			writeConversationRenderCache(cache, sessionId, cacheEntry(1_024));
		}
		pruneConversationRenderCache(cache, ["session-a", "session-c"]);

		expect([...cache.keys()]).toEqual(["session-a", "session-c"]);
	});
});
