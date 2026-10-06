import { toLiveToolViewModel } from "../../adapters/live-tool-view-model.ts";
import { committedToolCallIds } from "../../state/chat-lifecycle.ts";
import type { WorkbenchState } from "../../state/use-workbench";
import { approximateValueBytes } from "../../state/workbench-session-cache.ts";
import type { ToolBatchTool } from "../ai-elements/tool-batch";
import {
	buildConversationRenderItems,
	buildPersistedRenderItems,
	preserveConversationToolStackKeys,
	type ConversationContentRenderItem,
	type ConversationRenderItem,
	type ToolIndex,
} from "./conversation-render-model";

export const CONVERSATION_RENDER_CACHE_LIMIT = 8;
// 与 sessionDetail 缓存同量级的内存预算；渲染条目派生自语料，超限时只保留最近会话。
export const CONVERSATION_RENDER_CACHE_BYTES_LIMIT = 24 * 1024 * 1024;

export type ConversationRenderCacheEntry = {
	transcript: WorkbenchState["transcript"];
	agentSteps: WorkbenchState["agentSteps"];
	pendingUserPrompts: WorkbenchState["pendingUserPrompts"];
	promptSendTimes: WorkbenchState["promptSendTimes"];
	liveTools: WorkbenchState["liveTools"];
	liveSteps: WorkbenchState["liveSteps"];
	liveTurnItems: WorkbenchState["liveTurnItems"];
	liveCompaction: WorkbenchState["liveCompaction"];
	liveTurnId: number;
	responseActive: boolean;
	canEditPrompts: boolean;
	editingEntryId?: string;
	settledTurns?: WorkbenchState["settledTurns"];
	toolIndex: ToolIndex;
	persistedItems: ConversationContentRenderItem[];
	committedToolCallIds: ReadonlySet<string>;
	renderItems: ConversationRenderItem[];
	historyBytes: number;
	bytes: number;
};

export type ConversationRenderPipelineInput = {
	sessionId?: string;
	transcript: WorkbenchState["transcript"];
	agentSteps: WorkbenchState["agentSteps"];
	pendingUserPrompts: WorkbenchState["pendingUserPrompts"];
	promptSendTimes: WorkbenchState["promptSendTimes"];
	liveTools: WorkbenchState["liveTools"];
	liveSteps: WorkbenchState["liveSteps"];
	liveTurnItems: WorkbenchState["liveTurnItems"];
	liveCompaction: WorkbenchState["liveCompaction"];
	liveTurnId: number;
	responseActive: boolean;
	canEditPrompts: boolean;
	editingEntryId?: string;
	settledTurns?: WorkbenchState["settledTurns"];
	observedElapsed?: (sentAt: number) => number | undefined;
};

export type ConversationRenderPipelineOptions = {
	cacheLimit?: number;
	cacheBytesLimit?: number;
};

type ConversationHistory = {
	sessionId?: string;
	transcript: WorkbenchState["transcript"];
	agentSteps: WorkbenchState["agentSteps"];
	pendingUserPrompts: WorkbenchState["pendingUserPrompts"];
	promptSendTimes: WorkbenchState["promptSendTimes"];
	liveTools: WorkbenchState["liveTools"];
	liveSteps: WorkbenchState["liveSteps"];
	toolIndex: ToolIndex;
	persistedItems: ConversationContentRenderItem[];
	committedToolCallIds: ReadonlySet<string>;
	/** 历史（toolIndex 与历史渲染项）的字节估算，只在历史变化时重算。 */
	bytes: number;
};

export function buildConversationToolIndex(transcript: WorkbenchState["transcript"]): ToolIndex {
	const callIds = new Set<string>();
	const results = new Map<string, ToolBatchTool>();
	const statuses = new Map<string, "success" | "error">();
	for (const item of transcript) {
		if (item.view?.type === "tool_call") {
			for (const call of item.view.calls) callIds.add(call.id);
		}
		if (item.view?.type === "tool_result") {
			const tool: ToolBatchTool = {
				id: item.view.callId,
				name: item.view.name,
				summary: item.view.summary,
				state: item.view.status === "success" ? "output-available" : "output-error",
				detail: item.view.detail,
				codemode: item.view.codemode,
				images: item.view.images,
				diff: item.view.diff,
			};
			results.set(item.view.callId, tool);
			statuses.set(item.view.callId, item.view.status);
		}
	}
	return { callIds, results, statuses };
}

export function mergeConversationLiveToolIndex(
	persistedToolIndex: ToolIndex,
	liveTools: WorkbenchState["liveTools"],
): ToolIndex {
	let liveResults: Map<string, ToolBatchTool> | undefined;
	for (const tool of Object.values(liveTools)) {
		if (!persistedToolIndex.callIds.has(tool.id)) continue;
		const persisted = (liveResults ?? persistedToolIndex.results).get(tool.id);
		if (!persisted || tool.state === "cancelled" || tool.state === "interrupted") {
			liveResults ??= new Map(persistedToolIndex.results);
			const live = toLiveToolViewModel(tool);
			liveResults.set(tool.id, { ...persisted, ...live, images: persisted?.images });
		}
	}
	return liveResults ? { ...persistedToolIndex, results: liveResults } : persistedToolIndex;
}

export function writeConversationRenderCache(
	cache: Map<string, ConversationRenderCacheEntry>,
	sessionId: string,
	entry: ConversationRenderCacheEntry,
	maxEntries = CONVERSATION_RENDER_CACHE_LIMIT,
	maxBytes = CONVERSATION_RENDER_CACHE_BYTES_LIMIT,
): void {
	cache.delete(sessionId);
	// 单个超大会话不进缓存，避免它挤掉其他会话，也不让缓存长期握住这份历史。
	if (entry.bytes > maxBytes) return;
	cache.set(sessionId, entry);
	let totalBytes = 0;
	for (const current of cache.values()) totalBytes += current.bytes;
	while (cache.size > maxEntries || totalBytes > maxBytes) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		const removed = cache.get(oldest);
		cache.delete(oldest);
		totalBytes -= removed?.bytes ?? 0;
	}
}

export function pruneConversationRenderCache(
	cache: Map<string, ConversationRenderCacheEntry>,
	retainedSessionIds: Iterable<string>,
): void {
	const retained = retainedSessionIds instanceof Set ? retainedSessionIds : new Set(retainedSessionIds);
	for (const sessionId of [...cache.keys()]) {
		if (!retained.has(sessionId)) cache.delete(sessionId);
	}
}

function historyFromCacheEntry(entry: ConversationRenderCacheEntry, sessionId?: string): ConversationHistory {
	return {
		sessionId,
		transcript: entry.transcript,
		agentSteps: entry.agentSteps,
		pendingUserPrompts: entry.pendingUserPrompts,
		promptSendTimes: entry.promptSendTimes,
		liveTools: entry.liveTools,
		liveSteps: entry.liveSteps,
		toolIndex: entry.toolIndex,
		persistedItems: entry.persistedItems,
		committedToolCallIds: entry.committedToolCallIds,
		bytes: entry.historyBytes,
	};
}

/**
 * 会话渲染管线。
 *
 * 历史部分（toolIndex 与 buildPersistedRenderItems 的产物）只随 transcript、工具状态、步骤索引变化；
 * 纯实时文本增量只走 renderItems 重算，历史产物与字节估算保持引用。
 * 渲染缓存按会话保存上一份结果，供工具组 key 保持与切回会话时复用，并用条数加字节双预算淘汰。
 */
export class ConversationRenderPipeline {
	private history: ConversationHistory | undefined;
	private readonly cache = new Map<string, ConversationRenderCacheEntry>();
	private readonly liveBytesCache = new Map<string, { value: unknown; bytes: number }>();
	private readonly cacheLimit: number;
	private readonly cacheBytesLimit: number;

	constructor(options: ConversationRenderPipelineOptions = {}) {
		this.cacheLimit = options.cacheLimit ?? CONVERSATION_RENDER_CACHE_LIMIT;
		this.cacheBytesLimit = options.cacheBytesLimit ?? CONVERSATION_RENDER_CACHE_BYTES_LIMIT;
	}

	get cacheSize(): number {
		return this.cache.size;
	}

	cachedBytes(sessionId: string): number | undefined {
		return this.cache.get(sessionId)?.bytes;
	}

	prune(retainedSessionIds: Iterable<string>): void {
		const retained = retainedSessionIds instanceof Set ? retainedSessionIds : new Set(retainedSessionIds);
		pruneConversationRenderCache(this.cache, retained);
		// 历史只保留仍被 sessionDetail 缓存持有的会话，避免缓存淘汰后管线继续握着旧历史。
		if (this.history && this.history.sessionId !== undefined && !retained.has(this.history.sessionId)) {
			this.history = undefined;
			this.liveBytesCache.clear();
		}
	}

	render(input: ConversationRenderPipelineInput): {
		toolIndex: ToolIndex;
		renderItems: ConversationRenderItem[];
	} {
		const cacheKey = input.sessionId ?? "empty";
		const cached = this.cache.get(cacheKey);
		if (cached && matchesConversationRenderInput(cached, input)) {
			this.cache.delete(cacheKey);
			this.cache.set(cacheKey, cached);
			// 命中缓存时同步历史，避免管线继续握着上一个会话的历史，也让 prune 能释放它。
			this.history = historyFromCacheEntry(cached, input.sessionId);
			// 直播字节缓存属于上一个会话，直接清空；下次非命中重估时只遍历当前直播尾部。
			this.liveBytesCache.clear();
			return { toolIndex: cached.toolIndex, renderItems: cached.renderItems };
		}
		const history = this.resolveHistory(input);
		const computedRenderItems = buildConversationRenderItems(
			history.persistedItems,
			input.liveTurnItems,
			input.liveTools,
			history.committedToolCallIds,
			input.liveCompaction,
			input.liveTurnId,
			input.responseActive,
			input.canEditPrompts,
			input.liveSteps,
			input.observedElapsed,
			input.editingEntryId,
			input.settledTurns?.[input.liveTurnId],
		);
		const renderItems = preserveConversationToolStackKeys(computedRenderItems, cached?.renderItems ?? []);
		const liveBytes =
			this.liveBytesFor("liveTurnItems", input.liveTurnItems) +
			this.liveBytesFor("liveTools", input.liveTools) +
			this.liveBytesFor("liveCompaction", input.liveCompaction);
		const entry: ConversationRenderCacheEntry = {
			transcript: input.transcript,
			agentSteps: input.agentSteps,
			pendingUserPrompts: input.pendingUserPrompts,
			promptSendTimes: input.promptSendTimes,
			liveTools: input.liveTools,
			liveSteps: input.liveSteps,
			liveTurnItems: input.liveTurnItems,
			liveCompaction: input.liveCompaction,
			liveTurnId: input.liveTurnId,
			responseActive: input.responseActive,
			canEditPrompts: input.canEditPrompts,
			editingEntryId: input.editingEntryId,
			settledTurns: input.settledTurns,
			toolIndex: history.toolIndex,
			persistedItems: history.persistedItems,
			committedToolCallIds: history.committedToolCallIds,
			renderItems,
			historyBytes: history.bytes,
			bytes: history.bytes + liveBytes,
		};
		writeConversationRenderCache(this.cache, cacheKey, entry, this.cacheLimit, this.cacheBytesLimit);
		return { toolIndex: entry.toolIndex, renderItems };
	}

	/** 直播部分按引用缓存：文本增量只重估 liveTurnItems，工具或压缩变化才重估各自片段。 */
	private liveBytesFor(key: string, value: unknown): number {
		const cached = this.liveBytesCache.get(key);
		if (cached && cached.value === value) return cached.bytes;
		const bytes = approximateValueBytes(value);
		this.liveBytesCache.set(key, { value, bytes });
		return bytes;
	}

	private resolveHistory(input: ConversationRenderPipelineInput): ConversationHistory {
		const previous = this.history;
		if (
			previous &&
			previous.transcript === input.transcript &&
			previous.agentSteps === input.agentSteps &&
			previous.pendingUserPrompts === input.pendingUserPrompts &&
			previous.promptSendTimes === input.promptSendTimes &&
			previous.liveTools === input.liveTools &&
			previous.liveSteps === input.liveSteps
		) {
			return previous;
		}
		const persistedToolIndex = buildConversationToolIndex(input.transcript);
		const toolIndex = mergeConversationLiveToolIndex(persistedToolIndex, input.liveTools);
		const persistedItems = buildPersistedRenderItems(
			input.transcript,
			toolIndex,
			input.pendingUserPrompts,
			input.promptSendTimes,
			input.agentSteps,
			input.liveSteps,
			input.liveTools,
		);
		const committed = committedToolCallIds(input.transcript);
		const history: ConversationHistory = {
			sessionId: input.sessionId,
			transcript: input.transcript,
			agentSteps: input.agentSteps,
			pendingUserPrompts: input.pendingUserPrompts,
			promptSendTimes: input.promptSendTimes,
			liveTools: input.liveTools,
			liveSteps: input.liveSteps,
			toolIndex,
			persistedItems,
			committedToolCallIds: committed,
			// 历史变动时连同 transcript 本体、步骤与待发 Prompts 一起估算；WeakSet 去重保证共享引用只计一次。
			bytes: approximateValueBytes({
				transcript: input.transcript,
				agentSteps: input.agentSteps,
				liveSteps: input.liveSteps,
				pendingUserPrompts: input.pendingUserPrompts,
				promptSendTimes: input.promptSendTimes,
				toolIndex,
				persistedItems,
				committedToolCallIds: committed,
			}),
		};
		this.history = history;
		return history;
	}
}

function matchesConversationRenderInput(
	cached: ConversationRenderCacheEntry,
	input: ConversationRenderPipelineInput,
): boolean {
	return (
		cached.transcript === input.transcript &&
		cached.agentSteps === input.agentSteps &&
		cached.pendingUserPrompts === input.pendingUserPrompts &&
		cached.promptSendTimes === input.promptSendTimes &&
		cached.liveTools === input.liveTools &&
		cached.liveSteps === input.liveSteps &&
		cached.liveTurnItems === input.liveTurnItems &&
		cached.liveCompaction === input.liveCompaction &&
		cached.liveTurnId === input.liveTurnId &&
		cached.responseActive === input.responseActive &&
		cached.canEditPrompts === input.canEditPrompts &&
		cached.editingEntryId === input.editingEntryId &&
		cached.settledTurns === input.settledTurns
	);
}
