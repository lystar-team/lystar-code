import {
	type Component,
	type Focusable,
	getKeybindings,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentRunState, SingleResult, SubagentSessionRef } from "../../../extensions/subagent/index.ts";
import { parseMouseEvent } from "../mouse.ts";
import { theme } from "../theme/theme.ts";

export interface AgentWorkbenchAgent {
	agentId: string;
	agent: string;
	task?: string;
	state: AgentRunState;
	controllable: boolean;
	detail?: string;
	agentSource?: SingleResult["agentSource"];
	agentScope?: "user" | "project" | "both";
	session?: SubagentSessionRef;
	legacyMessages?: SingleResult["messages"];
}

export interface AgentWorkbenchData {
	agents: AgentWorkbenchAgent[];
}

const ROW_HEIGHT = 1;
const WIDE_LAYOUT_COLUMNS = 100;

function titleFor(agent: AgentWorkbenchAgent, index: number): string {
	const title = agent.task
		?.split(/\r?\n/)
		.find((line) => line.trim())
		?.trim();
	return title || agent.agent || `agent #${index + 1}`;
}

function statusLabel(state: AgentRunState): string {
	switch (state) {
		case "queued":
			return "排队中";
		case "running":
			return "运行中";
		case "waiting":
			return "等待中";
		case "succeeded":
			return "已完成";
		case "failed":
			return "失败";
		case "cancelled":
			return "已取消";
	}
}

function isActive(agent: AgentWorkbenchAgent): boolean {
	return agent.state === "queued" || agent.state === "running" || agent.state === "waiting";
}

function statusColor(state: AgentRunState): "warning" | "success" | "error" | "muted" {
	if (state === "queued" || state === "running" || state === "waiting") return "warning";
	if (state === "succeeded") return "success";
	if (state === "failed") return "error";
	return "muted";
}

function fitToWidth(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "...");
}

function pad(text: string, width: number): string {
	return `${fitToWidth(text, width)}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

export class AgentWorkbenchComponent implements Component, Focusable {
	private _focused = false;
	private selectedIndex = 0;
	private detailVisible = false;
	private detailScroll = 0;
	private detailMaxScroll = 0;
	private lastWideLayout = false;
	private lastListStart = 0;
	private lastListCount = 0;
	private lastAgentStartIndex = 0;
	private lastListWidth = 0;
	private readonly data: AgentWorkbenchData;
	private readonly getAgents: (() => AgentWorkbenchAgent[]) | undefined;
	private readonly getHeight: () => number;
	private readonly requestRender: () => void;
	private readonly onReturn: () => void;
	private readonly onSteer: (agent: AgentWorkbenchAgent) => void;
	private readonly onFollowUp: (agent: AgentWorkbenchAgent) => void;
	private readonly onAbort: (agent: AgentWorkbenchAgent) => void;
	private readonly onOpen: ((agent: AgentWorkbenchAgent) => void) | undefined;
	private readonly overlayTop: number;

	constructor(options: {
		data: AgentWorkbenchData;
		getAgents?: () => AgentWorkbenchAgent[];
		initialAgentId?: string;
		getHeight: () => number;
		requestRender: () => void;
		onReturn: () => void;
		onSteer?: (agent: AgentWorkbenchAgent) => void;
		onFollowUp?: (agent: AgentWorkbenchAgent) => void;
		onAbort?: (agent: AgentWorkbenchAgent) => void;
		onOpen?: (agent: AgentWorkbenchAgent) => void;
		overlayTop?: number;
	}) {
		this.data = options.data;
		this.getAgents = options.getAgents;
		if (options.initialAgentId) {
			const initialIndex = this.data.agents.findIndex((agent) => agent.agentId === options.initialAgentId);
			if (initialIndex >= 0) {
				this.selectedIndex = initialIndex;
				this.detailVisible = true;
			}
		}
		this.getHeight = options.getHeight;
		this.requestRender = options.requestRender;
		this.onReturn = options.onReturn;
		this.onSteer = options.onSteer ?? (() => {});
		this.onFollowUp = options.onFollowUp ?? (() => {});
		this.onAbort = options.onAbort ?? (() => {});
		this.onOpen = options.onOpen;
		this.overlayTop = options.overlayTop ?? 1;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	get selectedAgent(): AgentWorkbenchAgent | undefined {
		return this.data.agents[this.selectedIndex];
	}

	invalidate(): void {}

	private refreshAgents(): void {
		if (!this.getAgents) return;
		const selectedId = this.selectedAgent?.agentId;
		this.data.agents = this.getAgents();
		if (selectedId) {
			const nextIndex = this.data.agents.findIndex((agent) => agent.agentId === selectedId);
			if (nextIndex >= 0) this.selectedIndex = nextIndex;
		}
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.data.agents.length - 1));
	}

	private select(index: number): void {
		if (index < 0 || index >= this.data.agents.length) return;
		if (this.selectedIndex !== index) this.detailScroll = 0;
		this.selectedIndex = index;
	}

	private moveSelection(direction: 1 | -1): void {
		const count = this.data.agents.length;
		if (count === 0) return;
		this.select((this.selectedIndex + direction + count) % count);
	}

	private scrollDetail(delta: number): void {
		this.detailScroll = Math.max(0, Math.min(this.detailScroll + delta, this.detailMaxScroll));
	}

	private runSelectedAction(): void {
		const selected = this.selectedAgent;
		if (!selected) return;
		if (this.onOpen) {
			this.onOpen(selected);
			return;
		}
		if (!selected.controllable) return;
		if (isActive(selected)) this.onSteer(selected);
		else this.onFollowUp(selected);
	}

	private abortSelected(): void {
		const selected = this.selectedAgent;
		if (selected?.controllable && isActive(selected)) this.onAbort(selected);
	}

	private renderRow(agent: AgentWorkbenchAgent, index: number, width: number): string[] {
		const selected = index === this.selectedIndex;
		const marker = selected ? theme.fg("accent", ">") : " ";
		const name = theme.fg("muted", agent.agent);
		const status = theme.fg(statusColor(agent.state), statusLabel(agent.state));
		const prefix = `${marker} ${name} `;
		const titleWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(status) - 1);
		const title = theme.fg(selected ? "text" : "muted", fitToWidth(titleFor(agent, index), titleWidth));
		const gap = Math.max(1, width - visibleWidth(prefix) - visibleWidth(title) - visibleWidth(status));
		return [`${prefix}${title}${" ".repeat(gap)}${status}`];
	}

	private renderList(width: number, availableRows: number): string[] {
		const maxAgents = Math.max(1, Math.floor(availableRows / ROW_HEIGHT));
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxAgents / 2), this.data.agents.length - maxAgents),
		);
		const agents = this.data.agents.slice(start, start + maxAgents);
		this.lastAgentStartIndex = start;
		this.lastListCount = agents.length;
		this.lastListWidth = width;
		const lines: string[] = [];
		for (let offset = 0; offset < agents.length; offset++) {
			lines.push(...this.renderRow(agents[offset]!, start + offset, width));
		}
		if (agents.length === 0) lines.push(fitToWidth(theme.fg("muted", "  没有 Agent"), width));
		return lines;
	}

	private renderDetail(width: number, availableRows: number): string[] {
		const selected = this.selectedAgent;
		const lines: string[] = [];
		if (!selected) {
			this.detailMaxScroll = 0;
			lines.push(fitToWidth(theme.fg("muted", "没有可查看的 Agent"), width));
			return lines;
		}

		const append = (text: string, color: "text" | "muted" | "dim" | "accent" = "text") => {
			for (const sourceLine of text.split(/\r?\n/)) {
				lines.push(...wrapTextWithAnsi(theme.fg(color, sourceLine || " "), Math.max(1, width)));
			}
		};
		const index = this.selectedIndex;
		const status = theme.fg(statusColor(selected.state), statusLabel(selected.state));
		append(`${theme.bold(theme.fg("text", titleFor(selected, index)))}  ${status}`);
		append(selected.agent, "muted");
		append("任务", "dim");
		append(selected.task?.trim() || "未提供任务");
		if (selected.detail) {
			append("详情", "dim");
			append(selected.detail, "muted");
		}
		const action = !selected.controllable
			? "该 Agent 已不可控制"
			: isActive(selected)
				? "Enter 发送引导"
				: "Enter 发送后续任务";
		append(action, "accent");
		this.detailMaxScroll = Math.max(0, lines.length - availableRows);
		this.detailScroll = Math.min(this.detailScroll, this.detailMaxScroll);
		return lines.slice(this.detailScroll, this.detailScroll + availableRows);
	}

	private renderWide(width: number, height: number): string[] {
		const listWidth = Math.max(28, Math.min(42, Math.floor(width * 0.38)));
		const detailWidth = Math.max(1, width - listWidth - 3);
		const detail = this.renderDetail(detailWidth, height - 1);
		this.lastListStart = 1;
		const list = this.renderList(listWidth, height - 1);
		const lines: string[] = [];
		for (let row = 0; row < height - 1; row++) {
			const left = pad(list[row] ?? "", listWidth);
			const right = fitToWidth(detail[row] ?? "", detailWidth);
			lines.push(fitToWidth(`${left}${theme.fg("dim", " | ")}${right}`, width));
		}
		return lines;
	}

	render(width: number): string[] {
		this.refreshAgents();
		const height = Math.max(4, this.getHeight() - 2);
		const wide = width >= WIDE_LAYOUT_COLUMNS;
		this.lastWideLayout = wide;
		const active = this.data.agents.filter(isActive).length;
		const header = fitToWidth(
			`${theme.fg("accent", "← 主会话")}  ${theme.bold(theme.fg("text", "Agent 工作台"))}  ${theme.fg("muted", `${this.data.agents.length} 个 Agent · ${active} 个执行中`)}`,
			width,
		);
		const lines = [header];
		if (this.onOpen) {
			lines.push(fitToWidth(theme.fg("muted", "上下键选择 · Enter 打开会话 · Esc 返回主会话"), width));
			this.lastListStart = lines.length;
			lines.push(...this.renderList(width, height - lines.length - 1));
			while (lines.length < height - 1) lines.push("");
			lines.push(fitToWidth(theme.fg("dim", "Enter 打开会话 · Ctrl+C 取消执行中的 Agent"), width));
			return lines.slice(0, height).map((line) => fitToWidth(line, width));
		}

		if (wide) {
			this.detailVisible = false;
			lines.push(...this.renderWide(width, height));
		} else if (this.detailVisible) {
			this.lastListCount = 0;
			lines.push(...this.renderDetail(width, height - 2));
			while (lines.length < height - 1) lines.push("");
			lines.push(fitToWidth(theme.fg("dim", "Enter 发送任务 · Ctrl+C 取消 Agent · Esc 返回列表"), width));
		} else {
			lines.push(fitToWidth(theme.fg("muted", "上下键选择 · Enter 查看 · Esc 返回主会话"), width));
			this.lastListStart = lines.length;
			lines.push(...this.renderList(width, height - lines.length - 1));
			while (lines.length < height - 1) lines.push("");
			lines.push(fitToWidth(theme.fg("dim", "Enter 查看 · Esc 返回主会话"), width));
		}
		return lines.slice(0, height).map((line) => fitToWidth(line, width));
	}

	handleInput(data: string): void {
		this.refreshAgents();
		const mouse = parseMouseEvent(data);
		if (mouse) {
			if (mouse.shift || mouse.released) return;
			if (mouse.button === "wheel-up" || mouse.button === "wheel-down") {
				if (this.detailVisible || (this.lastWideLayout && mouse.column >= this.lastListWidth)) {
					this.scrollDetail(mouse.button === "wheel-up" ? -3 : 3);
					this.requestRender();
				}
				return;
			}
			if (mouse.button !== "left") return;
			const localRow = mouse.row - this.overlayTop;
			if (localRow === 0) {
				this.onReturn();
				return;
			}
			const offset = localRow - this.lastListStart;
			if (mouse.column < this.lastListWidth && offset >= 0 && offset < this.lastListCount) {
				this.select(this.lastAgentStartIndex + offset);
				if (this.onOpen) this.runSelectedAction();
				else if (!this.lastWideLayout) this.detailVisible = true;
				this.requestRender();
			}
			return;
		}

		const kb = getKeybindings();
		if (matchesKey(data, "ctrl+c")) {
			this.abortSelected();
			this.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.detailVisible) {
				this.detailVisible = false;
				this.requestRender();
			} else {
				this.onReturn();
			}
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			if (this.detailVisible && !this.lastWideLayout) this.scrollDetail(-1);
			else this.moveSelection(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			if (this.detailVisible && !this.lastWideLayout) this.scrollDetail(1);
			else this.moveSelection(1);
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollDetail(-Math.max(1, this.getHeight() - 6));
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollDetail(Math.max(1, this.getHeight() - 6));
		} else if (kb.matches(data, "tui.select.confirm")) {
			if (this.onOpen || this.lastWideLayout || this.detailVisible) this.runSelectedAction();
			else this.detailVisible = true;
		} else {
			return;
		}
		this.requestRender();
	}
}
