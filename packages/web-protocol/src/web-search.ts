import type { WebSearchProgress, WebSearchProgressSource } from "./schemas.ts";

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
	for (const source of [...previous.sources, ...next.sources]) {
		if (!sources.has(source.url) || source.title) sources.set(source.url, source);
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
