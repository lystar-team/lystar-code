import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { getWebConversationStream, WebConversationStream } from "../src/core/web-conversation-stream.ts";

describe("WebConversationStream", () => {
	it("消息间的块 ID 不复用，同一事件由 Owner 和 Companion 观察时不更换 ID", () => {
		const session = { agent: { state: {} } } as unknown as AgentSession;
		const owner = getWebConversationStream(session);
		const companion = getWebConversationStream(session);
		expect(companion).toBe(owner);
		const first = fauxAssistantMessage("相同正文");
		const event: AgentSessionEvent = { type: "message_start", message: first };
		owner.apply(event);
		const firstId = owner.blockId(0);
		companion.apply(event);
		expect(companion.blockId(0)).toBe(firstId);
		owner.apply({ type: "message_end", message: first });
		const second = fauxAssistantMessage("相同正文");
		owner.apply({ type: "message_start", message: second });
		expect(owner.blockId(0)).not.toBe(firstId);
		owner.apply({ type: "message_end", message: second });
		const entries: SessionEntry[] = [first, second].map((message, index) => ({
			type: "message",
			id: `entry-${index}`,
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message,
		}));
		const mappings = owner.mappingsForEntries(entries);
		expect(mappings).toHaveLength(2);
		expect(mappings[0]).toEqual({ blockId: firstId, entryId: "entry-0", contentIndex: 0 });
		expect(mappings[1]?.entryId).toBe("entry-1");
		expect(mappings[1]?.blockId).not.toBe(firstId);
		expect(owner.getLiveMessage().blocks).toEqual([]);
	});

	it("恢复消息保留文本、工具、文本的顺序，提交映射使用 contentIndex", () => {
		const message: AssistantMessage = {
			...fauxAssistantMessage(""),
			content: [
				{ type: "thinking", thinking: "计划" },
				{ type: "text", text: "工具前" },
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
				{ type: "text", text: "工具后" },
			],
		};
		const stream = new WebConversationStream();
		stream.apply({ type: "message_start", message });
		const restored = stream.getLiveMessage();
		expect(restored.blocks.map((block) => block.kind)).toEqual(["thinking", "text", "tool", "text"]);
		expect(restored.text).toBe("工具前工具后");
		stream.apply({ type: "message_end", message });
		const mappings = stream.mappingsForEntries([
			{
				type: "message",
				id: "entry",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message,
			},
		]);
		expect(mappings.map((mapping) => mapping.contentIndex)).toEqual([0, 1, 3]);
		expect(mappings.map((mapping) => mapping.blockId)).toEqual(
			restored.blocks.filter((block) => block.kind !== "tool").map((block) => block.blockId),
		);
	});
});
