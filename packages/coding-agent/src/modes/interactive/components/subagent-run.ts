import type { Message } from "@earendil-works/pi-ai";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
	AgentRunState,
	SingleResult,
	SubagentDetails,
	SubagentSessionRef,
} from "../../../extensions/subagent/index.ts";
import { theme } from "../theme/theme.ts";

export interface SubagentRunTarget {
	runId?: string;
	agentId: string;
	agent: string;
	agentSource: SingleResult["agentSource"];
	agentScope: SubagentDetails["agentScope"];
	task: string;
	state: AgentRunState;
	currentAction?: string;
	finalOutput?: string;
	session?: SubagentSessionRef;
	legacyMessages?: Message[];
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

function statusColor(state: AgentRunState): "warning" | "success" | "error" | "muted" {
	if (state === "queued" || state === "running" || state === "waiting") return "warning";
	if (state === "succeeded") return "success";
	if (state === "failed") return "error";
	return "muted";
}

function resultState(result: SingleResult): AgentRunState {
	return result.state ?? (result.exitCode === -1 ? "running" : result.exitCode === 0 ? "succeeded" : "failed");
}

export class SubagentRunComponent implements Component {
	private target: SubagentRunTarget;

	constructor(target: SubagentRunTarget) {
		this.target = target;
	}

	setTarget(target: SubagentRunTarget): void {
		this.target = target;
	}

	getTarget(): SubagentRunTarget {
		return this.target;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const status = theme.fg(statusColor(this.target.state), statusLabel(this.target.state));
		const sessionMark = this.target.session ? theme.fg("accent", "↗") : theme.fg("muted", "·");
		const prefix = `${sessionMark} ${theme.bold(theme.fg("toolTitle", this.target.agent))} `;
		const detail =
			this.target.currentAction ||
			this.target.task
				.split(/\r?\n/)
				.find((line) => line.trim())
				?.trim() ||
			"";
		const detailWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(status) - 2);
		const renderedDetail = theme.fg("muted", truncateToWidth(detail, detailWidth, "…"));
		const gap = Math.max(1, width - visibleWidth(prefix) - visibleWidth(renderedDetail) - visibleWidth(status));
		return [truncateToWidth(`${prefix}${renderedDetail}${" ".repeat(gap)}${status}`, width, "…")];
	}
}

type RowRange = { row: SubagentRunComponent; start: number; end: number };

export class SubagentResultComponent implements Component {
	private rows: SubagentRunComponent[] = [];
	private ranges: RowRange[] = [];
	private renderVersion = 0;

	constructor(details: SubagentDetails) {
		this.setDetails(details);
	}

	setDetails(details: SubagentDetails): void {
		const existing = new Map(this.rows.map((row) => [row.getTarget().agentId, row]));
		this.rows = details.results.map((result, index) => {
			const agentId = result.agentId ?? `${details.runId ?? "subagent"}:${index + 1}`;
			const target: SubagentRunTarget = {
				runId: result.runId ?? details.runId,
				agentId,
				agent: result.agent,
				agentSource: result.agentSource,
				agentScope: details.agentScope,
				task: result.task,
				state: resultState(result),
				currentAction: result.currentAction,
				finalOutput: result.finalOutput,
				session: result.session,
				legacyMessages: result.messages,
			};
			const row = existing.get(agentId) ?? new SubagentRunComponent(target);
			row.setTarget(target);
			return row;
		});
		this.renderVersion++;
	}

	getAgentTargetAtRow(row: number): SubagentRunTarget | undefined {
		return this.ranges.find((range) => row >= range.start && row < range.end)?.row.getTarget();
	}

	getRenderVersion(): number {
		return this.renderVersion;
	}

	invalidate(): void {
		for (const row of this.rows) row.invalidate();
		this.renderVersion++;
	}

	render(width: number): string[] {
		this.ranges = [];
		const lines: string[] = [];
		for (const row of this.rows) {
			const rendered = row.render(width);
			const start = lines.length;
			lines.push(...rendered);
			this.ranges.push({ row, start, end: lines.length });
		}
		return lines;
	}
}
