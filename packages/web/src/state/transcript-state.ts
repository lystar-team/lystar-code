import type { WebTranscriptItem } from "../types.ts";

export type WorkbenchTranscriptItem = WebTranscriptItem & { renderId: string };

export interface TranscriptWindow {
	transcript: WorkbenchTranscriptItem[];
	previousCursor?: string;
	hasMorePrevious: boolean;
	transcriptPageLoaded: boolean;
}

export type LiveRenderSource =
	| { kind: "text"; id: string }
	| { kind: "thinking"; id: string }
	| { kind: "tools"; id: string; toolIds: readonly string[] };

export type TranscriptRenderIdOverrides = ReadonlyMap<string, string>;

export function mergeTranscriptPage(
	current: TranscriptWindow,
	page: { items: readonly WebTranscriptItem[]; previousCursor?: string; hasMorePrevious: boolean },
	prepend: boolean,
	sameHistory: boolean,
	renderIdOverrides?: TranscriptRenderIdOverrides,
): TranscriptWindow {
	// 游标属于窗口最早一页；尾页刷新不能覆盖它，包括“历史已读完”的空游标。
	const preserveBoundary = sameHistory && !prepend && current.transcriptPageLoaded && current.transcript.length > 0;
	return {
		transcript: sameHistory
			? mergeTranscriptEntries(current.transcript, page.items, prepend, renderIdOverrides)
			: decorateTranscriptItems(page.items, [], renderIdOverrides),
		previousCursor: preserveBoundary ? current.previousCursor : page.previousCursor,
		hasMorePrevious: preserveBoundary ? current.hasMorePrevious : page.hasMorePrevious,
		transcriptPageLoaded: true,
	};
}

function transcriptViewIdentity(item: WebTranscriptItem): string {
	const view = item.view;
	if (!view) return item.kind;
	if (view.type === "tool_call") return `${view.type}:${view.calls.map((call) => call.id).join(",")}`;
	if (view.type === "tool_result") return `${view.type}:${view.callId}`;
	return view.type;
}

function transcriptRenderIdentity(item: WebTranscriptItem): string {
	return `${item.entryId}:${transcriptViewIdentity(item)}`;
}

export function transcriptRenderIdOverrides(
	liveItems: readonly LiveRenderSource[],
	liveCompactionKey: string | undefined,
	items: readonly WebTranscriptItem[],
): TranscriptRenderIdOverrides {
	const overrides = new Map<string, string>();
	let textId: string | undefined;
	for (let index = liveItems.length - 1; index >= 0; index--) {
		const item = liveItems[index];
		if (item?.kind === "text") {
			textId = item.id;
			break;
		}
	}
	const toolIds = new Map<string, string>();
	for (const item of liveItems) {
		if (item.kind !== "tools") continue;
		for (const toolId of item.toolIds) toolIds.set(toolId, item.id);
	}
	for (const item of items) {
		const view = item.view;
		if (!view) continue;
		const key = transcriptRenderIdentity(item);
		if (view.type === "assistant" && textId) {
			overrides.set(key, textId);
		} else if (view.type === "tool_call") {
			const liveId = view.calls.map((call) => toolIds.get(call.id)).find(Boolean);
			if (liveId) overrides.set(key, liveId);
		} else if (view.type === "tool_result") {
			const liveId = toolIds.get(view.callId);
			if (liveId) overrides.set(key, liveId);
		} else if (view.type === "summary" && view.variant === "compaction" && liveCompactionKey) {
			overrides.set(key, liveCompactionKey);
		}
	}
	return overrides;
}

export function decorateTranscriptItems(
	items: readonly WebTranscriptItem[],
	previous: readonly WorkbenchTranscriptItem[] = [],
	renderIdOverrides?: TranscriptRenderIdOverrides,
): WorkbenchTranscriptItem[] {
	const occurrences = new Map<string, number>();
	const previousByBase = new Map<string, WorkbenchTranscriptItem[]>();
	for (const item of previous) {
		const base = transcriptRenderIdentity(item);
		const group = previousByBase.get(base) ?? [];
		group.push(item);
		previousByBase.set(base, group);
	}
	return items.map((item) => {
		const base = transcriptRenderIdentity(item);
		const occurrence = occurrences.get(base) ?? 0;
		occurrences.set(base, occurrence + 1);
		const existing = previousByBase.get(base)?.[occurrence];
		if (
			existing &&
			existing.entryId === item.entryId &&
			existing.parentId === item.parentId &&
			existing.timestamp === item.timestamp &&
			existing.kind === item.kind &&
			JSON.stringify(existing.view) === JSON.stringify(item.view)
		)
			return existing;
		return { ...item, renderId: renderIdOverrides?.get(base) ?? existing?.renderId ?? `${base}:${occurrence}` };
	});
}

export function mergeTranscriptEntries(
	current: readonly WorkbenchTranscriptItem[],
	incoming: readonly WebTranscriptItem[],
	prepend = false,
	renderIdOverrides?: TranscriptRenderIdOverrides,
): WorkbenchTranscriptItem[] {
	const next = decorateTranscriptItems(incoming, current, renderIdOverrides);
	const replacements = new Map<string, WorkbenchTranscriptItem[]>();
	for (const item of next) {
		const group = replacements.get(item.entryId) ?? [];
		group.push(item);
		replacements.set(item.entryId, group);
	}
	const currentIds = new Set(current.map((item) => item.entryId));
	const emitted = new Set<string>();
	const merged: WorkbenchTranscriptItem[] = [];
	let pending: WorkbenchTranscriptItem[] = [];
	const before = new Map<string, WorkbenchTranscriptItem[]>();
	for (const item of next) {
		if (currentIds.has(item.entryId)) {
			if (pending.length) before.set(item.entryId, pending);
			pending = [];
		} else {
			pending.push(item);
		}
	}
	// 重叠页和重复提交更新原位置，不把已存在的消息搬到列表末尾。
	for (const item of current) {
		if (emitted.has(item.entryId)) continue;
		const replacement = replacements.get(item.entryId);
		if (replacement) {
			merged.push(...(before.get(item.entryId) ?? []), ...replacement);
			emitted.add(item.entryId);
		} else {
			merged.push(item);
		}
	}
	return prepend && !next.some((item) => currentIds.has(item.entryId))
		? [...pending, ...merged]
		: [...merged, ...pending];
}
