import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import type { SessionEntry } from "./session-manager.ts";

export type WebConversationBlock =
	| { blockId: string; kind: "text" | "thinking"; text: string }
	| { blockId: string; kind: "tool"; toolCallId: string };

export type WebConversationMessage = {
	text: string;
	thinking: string;
	blocks: WebConversationBlock[];
};

export type WebConversationBlockMapping = { blockId: string; entryId: string; contentIndex: number };

/** The owner and its Companion share identities, including when both observe the same event. */
export class WebConversationStream {
	private readonly seen = new WeakSet<AgentSessionEvent>();
	private readonly completed = new WeakMap<AssistantMessage, string>();
	private messageId = randomUUID();
	private message?: AssistantMessage;

	constructor(message?: AssistantMessage) {
		this.message = message;
	}

	apply(event: AgentSessionEvent): void {
		if (this.seen.has(event)) return;
		this.seen.add(event);
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.messageId = randomUUID();
			this.message = event.message;
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			this.message = event.message;
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			this.completed.set(event.message, this.messageId);
			this.message = undefined;
		}
	}

	blockId(contentIndex: number): string {
		return `${this.messageId}:${contentIndex}`;
	}

	getLiveMessage(): WebConversationMessage {
		const result: WebConversationMessage = { text: "", thinking: "", blocks: [] };
		for (const [index, part] of (this.message?.content ?? []).entries()) {
			const blockId = this.blockId(index);
			if (part.type === "text") {
				result.text += part.text;
				if (part.text) result.blocks.push({ blockId, kind: "text", text: part.text });
			} else if (part.type === "thinking") {
				result.thinking += part.thinking;
				if (part.thinking) result.blocks.push({ blockId, kind: "thinking", text: part.thinking });
			} else if (part.type === "toolCall" || part.type === "webSearchCall") {
				result.blocks.push({ blockId, kind: "tool", toolCallId: part.id });
			}
		}
		return result;
	}

	mappingsForEntries(entries: readonly SessionEntry[]): WebConversationBlockMapping[] {
		return entries.flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "assistant") return [];
			const messageId = this.completed.get(entry.message);
			if (!messageId) return [];
			return entry.message.content.flatMap((part, contentIndex) =>
				part.type === "text" || part.type === "thinking"
					? [{ blockId: `${messageId}:${contentIndex}`, entryId: entry.id, contentIndex }]
					: [],
			);
		});
	}
}

const streams = new WeakMap<AgentSession, WebConversationStream>();

export function getWebConversationStream(session: AgentSession): WebConversationStream {
	let stream = streams.get(session);
	if (!stream) {
		const message = session.agent?.state.streamingMessage;
		stream = new WebConversationStream(message?.role === "assistant" ? message : undefined);
		streams.set(session, stream);
	}
	return stream;
}
