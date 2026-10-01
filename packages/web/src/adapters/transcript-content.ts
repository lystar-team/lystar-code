import type { ContentChunk } from "@lystar/code-web-protocol";
import { webApi } from "./host-protocol/api.ts";

export async function readTranscriptText(sessionId: string, contentRef: string): Promise<string> {
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let offset = 0;
	for (;;) {
		const chunk = await webApi.request<ContentChunk>(
			`/api/sessions/${encodeURIComponent(sessionId)}/content/${encodeURIComponent(contentRef)}?offset=${offset}`,
		);
		const bytes = Uint8Array.from(atob(chunk.data), (character) => character.charCodeAt(0));
		parts.push(decoder.decode(bytes, { stream: !chunk.done }));
		if (chunk.done) return parts.join("");
		offset = chunk.nextOffset;
	}
}
