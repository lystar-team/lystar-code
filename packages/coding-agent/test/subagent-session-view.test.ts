import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { InteractiveCardAction } from "../src/modes/interactive/components/interactive-card.ts";
import { SubagentSessionViewComponent } from "../src/modes/interactive/components/subagent-session-view.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

class TestCard implements Component {
	private expanded = false;

	render(): string[] {
		return this.expanded ? ["card", "detail"] : ["card"];
	}

	invalidate(): void {}

	isExpanded(): boolean {
		return this.expanded;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	getCardStateKey(): string {
		return "test-card";
	}
}

class OpenSubagentCard extends TestCard {
	getCardClickActionAtRow(row: number): InteractiveCardAction | undefined {
		return row === 0
			? {
					type: "openSubagent",
					target: {
						agentId: "worker",
						agent: "worker",
						agentSource: "builtin",
						agentScope: "user",
						task: "nested",
						state: "succeeded",
					},
				}
			: undefined;
	}
}

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
			onOpenSubagent: () => {},
			getLinkAtScreenPosition: () => undefined,
			openLinkAtScreenPosition: () => false,
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

	it("scrolls the transcript with page keys and the mouse wheel", () => {
		const view = new SubagentSessionViewComponent({
			agent: "reader",
			status: "运行中",
			readOnly: true,
			getHeight: () => 10,
			requestRender: () => {},
			renderMessages: (messages) => messages.map((_, index) => new Text(`line-${index + 1}`, 0, 0)),
			onOpenSubagent: () => {},
			getLinkAtScreenPosition: () => undefined,
			openLinkAtScreenPosition: () => false,
			onReturn: () => {},
			onAbort: () => {},
		});
		view.setMessages(Array.from({ length: 30 }, () => ({ role: "user", content: "x" })) as AgentMessage[]);
		expect(view.render(40).join("\n")).toContain("line-30");
		view.handleInput("\x1b[5~");
		expect(view.render(40).join("\n")).toContain("line-22");
		view.handleInput("\x1b[6~");
		expect(view.render(40).join("\n")).toContain("line-30");
		view.handleInput("\x1b[<64;10;4M");
		expect(view.render(40).join("\n")).toContain("line-27");
		view.handleInput("\x1b[<65;10;4M");
		expect(view.render(40).join("\n")).toContain("line-28");
		expect(view.render(40).join("\n")).not.toContain("line-30");
	});

	it("toggles transcript cards from any card row and preserves state across rebuilds", () => {
		const cards: TestCard[] = [];
		const view = new SubagentSessionViewComponent({
			agent: "worker",
			status: "运行中",
			readOnly: true,
			getHeight: () => 10,
			requestRender: () => {},
			renderMessages: () => {
				const card = new TestCard();
				cards.push(card);
				return [card];
			},
			onOpenSubagent: () => {},
			getLinkAtScreenPosition: () => undefined,
			openLinkAtScreenPosition: () => false,
			onReturn: () => {},
			onAbort: () => {},
			overlayTop: 1,
		});
		const messages = [{ role: "user", content: "x" }] as AgentMessage[];
		view.setMessages(messages);
		view.render(40);
		view.handleInput("\x1b[<0;1;4M");
		view.handleInput("\x1b[<0;1;4m");
		expect(cards[0].isExpanded()).toBe(true);
		expect(view.render(40).join("\n")).toContain("detail");

		view.setMessages(messages);
		expect(cards[1].isExpanded()).toBe(true);
	});

	it("opens links before card actions and routes nested Subagent actions", () => {
		let linkClicks = 0;
		let openedAgent = "";
		const card = new OpenSubagentCard();
		const view = new SubagentSessionViewComponent({
			agent: "worker",
			status: "已完成",
			readOnly: true,
			getHeight: () => 10,
			requestRender: () => {},
			renderMessages: () => [card],
			onOpenSubagent: (target) => {
				openedAgent = target.agent;
			},
			getLinkAtScreenPosition: () => (linkClicks === 0 ? "https://example.com" : undefined),
			openLinkAtScreenPosition: () => {
				linkClicks++;
				return linkClicks === 1;
			},
			onReturn: () => {},
			onAbort: () => {},
			overlayTop: 1,
		});
		view.setMessages([{ role: "user", content: "x" }] as AgentMessage[]);
		view.render(40);

		view.handleInput("\x1b[<0;1;4M");
		view.handleInput("\x1b[<0;1;4m");
		expect(openedAgent).toBe("");
		view.handleInput("\x1b[<0;1;4M");
		view.handleInput("\x1b[<0;1;4m");
		expect(openedAgent).toBe("worker");
	});
});
