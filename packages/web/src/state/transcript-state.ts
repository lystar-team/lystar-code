import type { WebTranscriptItem } from "../types.ts";

export type WorkbenchTranscriptItem = WebTranscriptItem & { renderId: string };

export interface TranscriptWindow {
	transcript: WorkbenchTranscriptItem[];
	previousCursor?: string;
	hasMorePrevious: boolean;
	transcriptPageLoaded: boolean;
}

export type LiveRenderSource =
	| { kind: "text"; id: string; parts: readonly string[]; blockId?: string }
	| { kind: "thinking"; id: string; blockId?: string }
	| { kind: "tools"; id: string; toolIds: readonly string[] }
	| { kind: "compaction"; id: string }
	| { kind: "user"; id: string };

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
	// 无重叠页的顺序由调用方通过 prepend 明确：prepend=true 补更早历史放前面，
	// prepend=false 是尾页更新放后面。首屏历史页与实时条目无重叠时，调用方应传 prepend=true。
	const transcript = sameHistory
		? mergeTranscriptEntries(current.transcript, page.items, prepend, renderIdOverrides)
		: decorateTranscriptItems(page.items, [], renderIdOverrides);
	return {
		transcript,
		previousCursor: preserveBoundary ? current.previousCursor : page.previousCursor,
		hasMorePrevious: preserveBoundary ? current.hasMorePrevious : page.hasMorePrevious,
		transcriptPageLoaded: true,
	};
}

function transcriptViewIdentity(item: WebTranscriptItem): string {
	const view = item.view;
	if (!view) return item.kind;
	if (view.type === "agent_step") return `${view.type}:${view.step.id}`;
	if (view.type === "tool_call") return `${view.type}:${view.calls.map((call) => call.id).join(",")}`;
	if (view.type === "tool_result") return `${view.type}:${view.callId}`;
	return view.type;
}

function transcriptRenderIdentity(item: WebTranscriptItem): string {
	return `${item.entryId}:${transcriptViewIdentity(item)}`;
}

function transcriptRenderKeys(items: readonly WebTranscriptItem[]): string[] {
	const occurrences = new Map<string, number>();
	return items.map((item) => {
		const base = transcriptRenderIdentity(item);
		const occurrence = occurrences.get(base) ?? 0;
		occurrences.set(base, occurrence + 1);
		return `${base}:${occurrence}`;
	});
}

export function transcriptRenderIdOverrides(
	liveItems: readonly LiveRenderSource[],
	liveCompactionKey: string | undefined,
	items: readonly WebTranscriptItem[],
	blockMappings?: ReadonlyArray<{ blockId: string; entryId: string; viewIndex?: number }>,
): TranscriptRenderIdOverrides {
	const overrides = new Map<string, string>();
	const renderKeys = transcriptRenderKeys(items);
	// blockMappings 优先：Runtime 明确给出实时块到落盘条目的映射，不按正文猜测。
	if (blockMappings?.length) {
		const liveIdByBlockId = new Map<string, string>();
		for (const item of liveItems) {
			if ((item.kind === "text" || item.kind === "thinking") && item.blockId && !liveIdByBlockId.has(item.blockId))
				liveIdByBlockId.set(item.blockId, item.id);
		}
		const keyByEntryView = new Map<string, string>();
		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			if (!item) continue;
			keyByEntryView.set(`${item.entryId}:${item.viewIndex ?? 0}`, renderKeys[index]!);
		}
		for (const mapping of blockMappings) {
			const liveId = liveIdByBlockId.get(mapping.blockId);
			const renderKey = keyByEntryView.get(`${mapping.entryId}:${mapping.viewIndex ?? 0}`);
			if (liveId && renderKey && !overrides.has(renderKey)) overrides.set(renderKey, liveId);
		}
	}
	const textIdsByContent = new Map<string, string[]>();
	const liveToolIdByCallId = new Map<string, string>();

	for (const item of liveItems) {
		if (item.kind === "text") {
			const content = item.parts.join("");
			if (!content) continue;
			// 已有显式映射的块不再参与正文匹配，避免相同正文误认领。
			if (item.blockId) continue;
			const ids = textIdsByContent.get(content) ?? [];
			ids.push(item.id);
			textIdsByContent.set(content, ids);
			continue;
		}
		if (item.kind === "tools") {
			for (const toolId of item.toolIds) liveToolIdByCallId.set(toolId, item.id);
		}
	}

	// 旧数据兜底：没有 blockMappings 的历史页仍允许相同正文一对一交接，新提交必须带映射。
	for (let index = items.length - 1; index >= 0; index--) {
		const view = items[index]?.view;
		if (view?.type !== "assistant") continue;
		const ids = textIdsByContent.get(view.text);
		const liveId = ids?.pop();
		if (liveId) overrides.set(renderKeys[index]!, liveId);
	}

	const usedToolRenderIds = new Set<string>();
	for (let index = 0; index < items.length; index++) {
		const view = items[index]?.view;
		if (view?.type !== "tool_call") continue;
		let liveId: string | undefined;
		for (const call of view.calls) {
			const candidate = liveToolIdByCallId.get(call.id);
			if (candidate && !usedToolRenderIds.has(candidate)) {
				liveId = candidate;
				break;
			}
		}
		if (!liveId) continue;
		usedToolRenderIds.add(liveId);
		overrides.set(renderKeys[index]!, liveId);
	}

	if (liveCompactionKey) {
		for (let index = items.length - 1; index >= 0; index--) {
			const view = items[index]?.view;
			if (view?.type !== "summary" || view.variant !== "compaction") continue;
			overrides.set(renderKeys[index]!, liveCompactionKey);
			break;
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
	const renderKeys = transcriptRenderKeys(items);
	const previousByBase = new Map<string, WorkbenchTranscriptItem[]>();
	for (const item of previous) {
		const base = transcriptRenderIdentity(item);
		const group = previousByBase.get(base) ?? [];
		group.push(item);
		previousByBase.set(base, group);
	}
	return items.map((item, index) => {
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
		const renderKey = renderKeys[index]!;
		return { ...item, renderId: renderIdOverrides?.get(renderKey) ?? existing?.renderId ?? renderKey };
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
	if (!next.some((item) => currentIds.has(item.entryId))) {
		const incomingIds = new Set(next.map((item) => item.entryId));
		const childIndex = merged.findIndex((item) => item.parentId !== null && incomingIds.has(item.parentId));
		if (childIndex >= 0) return [...merged.slice(0, childIndex), ...pending, ...merged.slice(childIndex)];
		const parentId = next[0]?.parentId;
		if (parentId && currentIds.has(parentId)) {
			let index = merged.length;
			while (index > 0 && merged[index - 1]?.entryId !== parentId) index--;
			return [...merged.slice(0, index), ...pending, ...merged.slice(index)];
		}
		if (prepend) return [...pending, ...merged];
	}
	return [...merged, ...pending];
}
