import type { WebTranscriptItem } from "../types.ts";

export type WorkbenchTranscriptItem = WebTranscriptItem & { renderId: string };

export interface TranscriptWindow {
	transcript: WorkbenchTranscriptItem[];
	previousCursor?: string;
	hasMorePrevious: boolean;
	transcriptPageLoaded: boolean;
}

export function mergeTranscriptPage(
	current: TranscriptWindow,
	page: { items: readonly WebTranscriptItem[]; previousCursor?: string; hasMorePrevious: boolean },
	prepend: boolean,
	sameHistory: boolean,
): TranscriptWindow {
	// 游标属于窗口最早一页；尾页刷新不能覆盖它，包括“历史已读完”的空游标。
	const preserveBoundary = sameHistory && !prepend && current.transcriptPageLoaded && current.transcript.length > 0;
	return {
		transcript: sameHistory
			? mergeTranscriptEntries(current.transcript, page.items, prepend)
			: decorateTranscriptItems(page.items),
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

export function decorateTranscriptItems(items: readonly WebTranscriptItem[]): WorkbenchTranscriptItem[] {
	const occurrences = new Map<string, number>();
	return items.map((item) => {
		const base = `${item.entryId}:${transcriptViewIdentity(item)}`;
		const occurrence = occurrences.get(base) ?? 0;
		occurrences.set(base, occurrence + 1);
		return { ...item, renderId: `${base}:${occurrence}` };
	});
}

export function mergeTranscriptEntries(
	current: readonly WorkbenchTranscriptItem[],
	incoming: readonly WebTranscriptItem[],
	prepend = false,
): WorkbenchTranscriptItem[] {
	const next = decorateTranscriptItems(incoming);
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
