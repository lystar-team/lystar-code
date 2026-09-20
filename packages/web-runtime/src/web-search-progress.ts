import type { WebSearchProgress, WebSearchProgressSource } from "@lystar/code-web-protocol";

const MAX_QUERY_LENGTH = 16 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function bounded(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function normalizeHttpUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

function source(value: unknown): WebSearchProgressSource | undefined {
	const item = record(value);
	const url = normalizeHttpUrl(item?.url);
	if (!url) return undefined;
	const title =
		typeof item?.title === "string" && item.title.trim() ? bounded(item.title.trim(), MAX_QUERY_LENGTH) : undefined;
	return { url, ...(title ? { title } : {}) };
}

export function mergeWebSearchProgress(
	previous: WebSearchProgress | undefined,
	next: WebSearchProgress | undefined,
): WebSearchProgress | undefined {
	if (!previous) return next;
	if (!next) return previous;
	const query = next.query ?? previous.query;
	const pattern = next.pattern ?? previous.pattern;
	const url = next.url ?? previous.url;
	const sources = new Map<string, WebSearchProgressSource>();
	for (const item of [...previous.sources, ...next.sources]) {
		if (!sources.has(item.url) || item.title) sources.set(item.url, item);
	}
	return {
		status: next.status,
		action: next.action,
		...(query ? { query } : {}),
		...(pattern ? { pattern } : {}),
		...(url ? { url } : {}),
		sources: [...sources.values()].slice(0, 32),
	};
}

export function webSearchProgressSummary(progress: WebSearchProgress | undefined): string {
	if (!progress) return "网页搜索";
	switch (progress.action) {
		case "search":
			return progress.query?.trim() || "网页搜索";
		case "open_page":
			return progress.url ? `打开 ${progress.url}` : "打开网页";
		case "find_in_page":
			return progress.pattern?.trim()
				? `查找 ${progress.pattern.trim()}`
				: progress.url
					? `查找 ${progress.url}`
					: "查找网页内容";
	}
}

export function webSearchProgressFromCall(value: unknown): WebSearchProgress | undefined {
	const call = record(value);
	if (!call) return undefined;
	const status = call.status;
	if (status !== "in_progress" && status !== "searching" && status !== "completed" && status !== "failed")
		return undefined;
	const action = record(call.action);
	const actionType = action?.type;
	const normalizedAction =
		actionType === "open_page" || actionType === "find_in_page" || actionType === "search" ? actionType : "search";
	const queryValue =
		typeof action?.query === "string" && action.query.trim()
			? action.query.trim()
			: Array.isArray(action?.queries)
				? action.queries
						.find((query): query is string => typeof query === "string" && query.trim().length > 0)
						?.trim()
				: undefined;
	const pattern = typeof action?.pattern === "string" && action.pattern.trim() ? action.pattern.trim() : undefined;
	const url = normalizeHttpUrl(action?.url);
	const sources = new Map<string, WebSearchProgressSource>();
	if (Array.isArray(action?.sources)) {
		for (const value of action.sources) {
			const item = source(value);
			if (item && (!sources.has(item.url) || item.title)) sources.set(item.url, item);
		}
	}
	if (url && normalizedAction !== "search" && !sources.has(url)) sources.set(url, { url });
	return {
		status,
		action: normalizedAction,
		...(queryValue ? { query: bounded(queryValue, MAX_QUERY_LENGTH) } : {}),
		...(pattern ? { pattern: bounded(pattern, MAX_QUERY_LENGTH) } : {}),
		...(url ? { url } : {}),
		sources: [...sources.values()].slice(0, 32),
	};
}
