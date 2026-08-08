import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SubagentSessionViewComponent } from "../src/modes/interactive/components/subagent-session-view.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

describe("SubagentSessionViewComponent", () => {
	it("renders a bounded transcript and returns to the main session with Esc or the header", () => {
		let returned = 0;
		const view = new SubagentSessionViewComponent({
			agent: "worker",
			status: "已完成",
			readOnly: true,
			getHeight: () => 12,
			requestRender: () => {},
			renderMessages: (messages) => messages.map((message, index) => new Text(`${index + 1}:${message.role}`, 0, 0)),
			onReturn: () => returned++,
			onAbort: () => {},
			overlayTop: 1,
		});
		const messages = Array.from({ length: 20 }, () => ({ role: "user", content: "hello" })) as AgentMessage[];
		view.setMessages(messages);

		const lines = view.render(40);
		expect(lines[0]).toContain("← 主会话");
		expect(lines.join("\n")).toContain("20:user");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);

		view.handleInput("\x1b");
		view.handleInput("\x1b[<0;1;2M");
		expect(returned).toBe(2);
	});

	it("keeps older transcript rows reachable with PageUp", () => {
		const view = new SubagentSessionViewComponent({
			agent: "reader",
			status: "运行中",
			readOnly: true,
			getHeight: () => 10,
			requestRender: () => {},
			renderMessages: (messages) => messages.map((_, index) => new Text(`line-${index + 1}`, 0, 0)),
			onReturn: () => {},
			onAbort: () => {},
		});
		view.setMessages(Array.from({ length: 30 }, () => ({ role: "user", content: "x" })) as AgentMessage[]);
		expect(view.render(40).join("\n")).toContain("line-30");
		view.handleInput("\x1b[5~");
		expect(view.render(40).join("\n")).toContain("line-22");
	});
});
