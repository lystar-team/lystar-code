import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { companionProgressEvent } from "../src/core/web-companion-events.ts";

describe("Companion 实时消息体量", () => {
	it("文本增量不重复携带完整 message 和 partial", () => {
		const message = { role: "assistant", content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }] };
		const event = {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", delta: "新增", contentIndex: 0, partial: message },
		} as AgentSessionEvent;
		const projected = companionProgressEvent(event);
		expect(JSON.stringify(projected).length).toBeLessThan(1024);
		expect(projected).toMatchObject({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "新增" },
		});
		expect(message.content[0].text.length).toBe(2 * 1024 * 1024);
	});
	it("工具原始结果不重复走实时通道", () => {
		const event = {
			type: "tool_execution_update",
			toolCallId: "tool",
			toolName: "bash",
			args: {},
			partialResult: { output: "x".repeat(2 * 1024 * 1024) },
		} as AgentSessionEvent;
		expect(companionProgressEvent(event)).toBeUndefined();
	});
});
