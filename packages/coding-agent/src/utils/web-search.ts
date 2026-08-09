import type { TextContent, WebSearchCallContent } from "@earendil-works/pi-ai";

export interface WebLink {
	title: string;
	url: string;
}

function titleFromUrl(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

function uniqueLinks(links: readonly WebLink[]): WebLink[] {
	const unique = new Map<string, WebLink>();
	for (const link of links) {
		if (!unique.has(link.url)) unique.set(link.url, link);
	}
	return [...unique.values()];
}

export function getCitationLinks(content: TextContent): WebLink[] {
	return uniqueLinks(
		(content.annotations ?? []).map((citation) => ({
			title: citation.title || titleFromUrl(citation.url),
			url: citation.url,
		})),
	);
}

export function getWebSearchSourceLinks(call: WebSearchCallContent): WebLink[] {
	const urls =
		call.action.type === "search"
			? (call.action.sources ?? []).map((source) => source.url)
			: call.action.url
				? [call.action.url]
				: [];
	return uniqueLinks(urls.map((url) => ({ title: titleFromUrl(url), url })));
}

function escapeMarkdownLabel(value: string): string {
	return value.replace(/[\\[\]]/gu, "\\$&");
}

export function formatMarkdownLinks(label: string, links: readonly WebLink[]): string {
	if (links.length === 0) return "";
	return `${label}\n${links.map((link, index) => `${index + 1}. [${escapeMarkdownLabel(link.title)}](<${link.url}>)`).join("\n")}`;
}

export function formatPlainLinks(label: string, links: readonly WebLink[]): string {
	if (links.length === 0) return "";
	return `${label}\n${links.map((link, index) => `${index + 1}. ${link.title}: ${link.url}`).join("\n")}`;
}
