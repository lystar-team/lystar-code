import type { ResponseOutputItem, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import type { AssistantMessage, TextContent } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";

function normalizeSource(url: string): { title: string; url: string } | undefined {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		return { title: parsed.hostname, url: parsed.toString() };
	} catch {
		return undefined;
	}
}

export function createWebSearchCollector(output: AssistantMessage, stream: AssistantMessageEventStream) {
	const sources = new Map<string, string>();

	const addSource = (url: string | null | undefined, title?: string): void => {
		if (!url) return;
		const normalized = normalizeSource(url);
		if (!normalized) return;
		const current = sources.get(normalized.url);
		if (!current || current === normalized.title) {
			sources.set(normalized.url, title?.replace(/\s+/g, " ").trim() || normalized.title);
		}
	};

	const collectItem = (item: ResponseOutputItem): void => {
		if (item.type === "web_search_call") {
			if (item.action.type === "search") {
				for (const source of item.action.sources ?? []) addSource(source.url);
			} else if (item.action.type === "open_page") {
				addSource(item.action.url);
			} else if (item.action.type === "find_in_page") {
				addSource(item.action.url);
			}
			return;
		}

		if (item.type !== "message") return;
		for (const content of item.content) {
			if (content.type !== "output_text") continue;
			for (const annotation of content.annotations ?? []) {
				if (annotation.type === "url_citation") addSource(annotation.url, annotation.title);
			}
		}
	};

	return {
		observe(event: ResponseStreamEvent): void {
			if (event.type === "response.output_item.done") collectItem(event.item);
		},
		finalize(items: ResponseOutputItem[]): void {
			for (const item of items) collectItem(item);
			if (sources.size === 0) return;

			const existingText = output.content
				.filter((content): content is TextContent => content.type === "text")
				.map((content) => content.text)
				.join("\n");
			const missingSources = [...sources].filter(([url]) => !existingText.includes(url));
			if (missingSources.length === 0) return;

			const block: TextContent = {
				type: "text",
				text: `Sources:\n${missingSources.map(([url, title]) => `- ${title}: <${url}>`).join("\n")}`,
			};
			output.content.push(block);
			const contentIndex = output.content.length - 1;
			stream.push({ type: "text_start", contentIndex, partial: output });
			stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
			stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
		},
	};
}
