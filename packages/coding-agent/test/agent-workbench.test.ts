import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	type AgentWorkbenchAgent,
	AgentWorkbenchComponent,
} from "../src/modes/interactive/components/agent-workbench.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

const states = ["queued", "running", "waiting", "succeeded", "failed", "cancelled"] as const;

const agents: AgentWorkbenchAgent[] = Array.from({ length: 8 }, (_, index) => ({
	agentId: `run-1:${index + 1}`,
	agent: `agent-${index + 1}`,
	task:
		index === 0
			? "这是一个很长的中文任务标题，用于确认四十列终端也不会出现文字越界的问题，后面的内容不应影响列表标题"
			: `任务 ${index + 1}\n第二行不会作为标题显示`,
	state: states[index % states.length]!,
	controllable: index !== 5,
	detail: `第 ${index + 1} 个 Agent 的详情`,
}));

function createWorkbench(
	callbacks: {
		onReturn?: () => void;
		onSteer?: (agent: AgentWorkbenchAgent) => void;
		onFollowUp?: (agent: AgentWorkbenchAgent) => void;
		onAbort?: (agent: AgentWorkbenchAgent) => void;
		onOpen?: (agent: AgentWorkbenchAgent) => void;
	} = {},
) {
	return new AgentWorkbenchComponent({
		data: { agents },
		getHeight: () => 24,
		requestRender: () => {},
		onReturn: callbacks.onReturn ?? (() => {}),
		onSteer: callbacks.onSteer,
		onFollowUp: callbacks.onFollowUp,
		onAbort: callbacks.onAbort,
		onOpen: callbacks.onOpen,
		overlayTop: 0,
	});
}

describe("AgentWorkbenchComponent", () => {
	it.each([40, 60, 80, 120])("renders %i-column output without overflow", (width) => {
		const workbench = createWorkbench();
		const lines = workbench.render(width);

		expect(lines[0]).toContain("← 主会话");
		expect(lines).toHaveLength(22);
		const text = lines.join("\n");
		expect(text).toContain("排队中");
		expect(text).toContain("运行中");
		expect(text).toContain("等待中");
		expect(text).toContain("已完成");
		expect(text).toContain("失败");
		expect(text).toContain("已取消");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("uses the first non-empty task line as the title and falls back to the Agent name", () => {
		const workbench = createWorkbench();
		const withTask = workbench.render(80).join("\n");
		expect(withTask).toContain("这是一个很长的中文任务标题");

		const fallback = new AgentWorkbenchComponent({
			data: { agents: [{ agentId: "run-2:1", agent: "unnamed", state: "succeeded", controllable: true }] },
			getHeight: () => 12,
			requestRender: () => {},
			onReturn: () => {},
			overlayTop: 0,
		});
		expect(fallback.render(80).join("\n")).toContain("unnamed");
	});

	it("maps a list row click to exactly one selected Agent", () => {
		const workbench = createWorkbench();
		workbench.render(80);

		// Header and list hint occupy rows 0 and 1; each Agent occupies exactly one row.
		workbench.handleInput("\x1b[<0;1;6M");
		expect(workbench.selectedAgent).toBe(agents[3]);

		const secondWorkbench = createWorkbench();
		secondWorkbench.render(80);
		secondWorkbench.handleInput("\x1b[<0;1;7M");
		expect(secondWorkbench.selectedAgent).toBe(agents[4]);
	});

	it("opens the requested Agent directly on narrow terminals and scrolls its full detail", () => {
		const detailLines = Array.from({ length: 30 }, (_, index) => `detail-${index + 1}`).join("\n");
		const workbench = new AgentWorkbenchComponent({
			data: {
				agents: [
					{ agentId: "first", agent: "worker", task: "first", state: "succeeded", controllable: true },
					{
						agentId: "target",
						agent: "reader",
						task: "\n\n目标任务\n更多内容",
						state: "succeeded",
						controllable: true,
						detail: detailLines,
					},
				],
			},
			initialAgentId: "target",
			getHeight: () => 12,
			requestRender: () => {},
			onReturn: () => {},
			overlayTop: 0,
		});

		const initial = workbench.render(40).join("\n");
		expect(initial).toContain("目标任务");
		expect(initial).not.toContain("detail-30");
		expect(workbench.selectedAgent?.agentId).toBe("target");
		for (let index = 0; index < 5; index++) workbench.handleInput("\x1b[6~");
		expect(workbench.render(40).join("\n")).toContain("detail-30");
	});

	it("keeps keyboard navigation and returns to the main session with Esc", () => {
		let returned = 0;
		const workbench = createWorkbench({ onReturn: () => returned++ });
		workbench.render(80);
		workbench.handleInput("\x1b[B");
		expect(workbench.selectedAgent).toBe(agents[1]);

		workbench.handleInput("\x1b");
		expect(returned).toBe(1);
	});

	it("dispatches steer, follow-up, and active-only cancellation from the selected row", () => {
		const steer: AgentWorkbenchAgent[] = [];
		const followUp: AgentWorkbenchAgent[] = [];
		const abort: AgentWorkbenchAgent[] = [];
		const workbench = createWorkbench({
			onSteer: (agent) => steer.push(agent),
			onFollowUp: (agent) => followUp.push(agent),
			onAbort: (agent) => abort.push(agent),
		});
		workbench.render(120);
		workbench.handleInput("\r");
		workbench.handleInput("\x1b[B");
		workbench.handleInput("\x1b[B");
		workbench.handleInput("\x1b[B");
		workbench.handleInput("\r");
		workbench.handleInput("\x1b[B");
		workbench.handleInput("\x1b[B");
		workbench.handleInput("\r");
		workbench.handleInput("\x03");

		expect(steer).toEqual([agents[0]]);
		expect(followUp).toEqual([agents[3]]);
		expect(abort).toEqual([]);

		workbench.handleInput("\x1b[A");
		workbench.handleInput("\x1b[A");
		workbench.handleInput("\x1b[A");
		workbench.handleInput("\x1b[A");
		workbench.handleInput("\x03");
		expect(abort).toEqual([agents[1]]);
	});

	it("returns to the main session when the persistent header is clicked", () => {
		let returned = 0;
		const workbench = createWorkbench({ onReturn: () => returned++ });
		workbench.render(120);
		workbench.handleInput("\x1b[<0;1;1M");
		expect(returned).toBe(1);
	});

	it("acts as a session index when onOpen is provided", () => {
		const opened: AgentWorkbenchAgent[] = [];
		const workbench = createWorkbench({ onOpen: (agent) => opened.push(agent) });
		const output = workbench.render(80).join("\n");
		expect(output).toContain("Enter 打开会话");
		expect(output).not.toContain("详情");

		workbench.handleInput("\x1b[B");
		workbench.handleInput("\r");
		expect(opened).toEqual([agents[1]]);
	});
});
