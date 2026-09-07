import type { AgentSessionEvent } from "./agent-session.ts";

/** 传输只携带实时投影消费的字段；完整消息与工具结果由 transcript 提供。 */
export function companionProgressEvent(event: AgentSessionEvent): AgentSessionEvent | undefined {
	switch (event.type) {
		case "message_update": {
			if (event.message.role !== "assistant") return undefined;
			const delta = event.assistantMessageEvent;
			if (delta.type !== "text_delta" && delta.type !== "thinking_delta") return undefined;
			return {
				...event,
				message: { ...event.message, content: [] },
				assistantMessageEvent: { ...delta, partial: { ...delta.partial, content: [] } },
			};
		}
		case "message_start":
			if (event.message.role === "assistant") return { ...event, message: { ...event.message, content: [] } };
			if (event.message.role === "user") {
				const content = event.message.content;
				return {
					...event,
					message: {
						...event.message,
						content: typeof content === "string" ? content : content.filter((part) => part.type === "text"),
					},
				};
			}
			return undefined;
		case "queue_update":
			return { ...event, steering: event.steering.map(() => ""), followUp: event.followUp.map(() => "") };
		case "tool_activity":
		case "compaction_start":
		case "agent_settled":
			return event;
		default:
			return undefined;
	}
}
