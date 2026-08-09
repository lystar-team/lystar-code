import type { ResponseFunctionWebSearch, ResponseOutputMessage } from "openai/resources/responses/responses.js";
import type { UrlCitation, WebSearchAction, WebSearchCallContent, WebSearchSource } from "../types.ts";

function normalizeHttpUrl(url: string | null | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		return parsed.toString();
	} catch {
		return undefined;
	}
}

function normalizeSources(
	sources: ResponseFunctionWebSearch.Search.Source[] | undefined,
): WebSearchSource[] | undefined {
	const normalized = new Map<string, WebSearchSource>();
	for (const source of sources ?? []) {
		const url = normalizeHttpUrl(source.url);
		if (url) normalized.set(url, { type: "url", url });
	}
	return normalized.size > 0 ? [...normalized.values()] : undefined;
}

function convertWebSearchAction(action: ResponseFunctionWebSearch["action"] | undefined): WebSearchAction {
	if (!action) return { type: "search" };
	switch (action.type) {
		case "search":
			return {
				type: "search",
				query: action.query || undefined,
				queries: action.queries?.filter(Boolean),
				sources: normalizeSources(action.sources),
			};
		case "open_page":
			return { type: "open_page", url: normalizeHttpUrl(action.url) };
		case "find_in_page":
			return {
				type: "find_in_page",
				url: normalizeHttpUrl(action.url) ?? action.url,
				pattern: action.pattern,
			};
	}
}

export function convertWebSearchCall(item: ResponseFunctionWebSearch): WebSearchCallContent {
	return {
		type: "webSearchCall",
		id: item.id,
		status: item.status,
		action: convertWebSearchAction(item.action),
	};
}

export function convertUrlCitation(annotation: unknown): UrlCitation | undefined {
	if (!annotation || typeof annotation !== "object") return undefined;
	const candidate = annotation as Record<string, unknown>;
	if (candidate.type !== "url_citation") return undefined;
	if (
		typeof candidate.start_index !== "number" ||
		typeof candidate.end_index !== "number" ||
		typeof candidate.title !== "string" ||
		typeof candidate.url !== "string"
	) {
		return undefined;
	}
	const url = normalizeHttpUrl(candidate.url);
	if (!url || candidate.start_index < 0 || candidate.end_index < candidate.start_index) return undefined;
	return {
		type: "url_citation",
		startIndex: candidate.start_index,
		endIndex: candidate.end_index,
		title: candidate.title.replace(/\s+/g, " ").trim() || new URL(url).hostname,
		url,
	};
}

export function extractMessageUrlCitations(message: ResponseOutputMessage): UrlCitation[] {
	const citations: UrlCitation[] = [];
	let textOffset = 0;
	for (const content of message.content) {
		if (content.type !== "output_text") continue;
		for (const annotation of content.annotations ?? []) {
			const citation = convertUrlCitation(annotation);
			if (!citation) continue;
			citations.push({
				...citation,
				startIndex: citation.startIndex + textOffset,
				endIndex: citation.endIndex + textOffset,
			});
		}
		textOffset += content.text.length;
	}
	return citations;
}

export function toResponseUrlCitations(citations: readonly UrlCitation[] | undefined) {
	return (citations ?? []).map((citation) => ({
		type: "url_citation" as const,
		start_index: citation.startIndex,
		end_index: citation.endIndex,
		title: citation.title,
		url: citation.url,
	}));
}

export function toResponseWebSearchCall(call: WebSearchCallContent): ResponseFunctionWebSearch {
	let action: ResponseFunctionWebSearch["action"];
	switch (call.action.type) {
		case "search":
			action = {
				type: "search",
				query: call.action.query ?? call.action.queries?.[0] ?? "",
				queries: call.action.queries,
				sources: call.action.sources,
			};
			break;
		case "open_page":
			action = { type: "open_page", url: call.action.url };
			break;
		case "find_in_page":
			action = { type: "find_in_page", url: call.action.url, pattern: call.action.pattern };
			break;
	}
	return {
		type: "web_search_call",
		id: call.id,
		status: call.status,
		action,
	};
}
