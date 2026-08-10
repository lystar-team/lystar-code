import type { Message } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
	AgentRunState,
	SingleResult,
	SubagentDetails,
	SubagentSessionRef,
} from "../../../extensions/subagent/index.ts";
import { formatSubagentState } from "../../../locales/zh-CN.ts";
import { theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";
import { type InteractiveCard, type InteractiveCardAction, resolveInteractiveCardAction } from "./interactive-card.ts";
import { renderToolDivider } from "./tool-card-layout.ts";

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

function statusColor(state: AgentRunState): "warning" | "success" | "error" | "muted" {
	if (state === "queued" || state === "running" || state === "waiting") return "warning";
	if (state === "succeeded") return "success";
	if (state === "failed") return "error";
	return "muted";
}

function resultState(result: SingleResult): AgentRunState {
	return result.state ?? (result.exitCode === -1 ? "running" : result.exitCode === 0 ? "succeeded" : "failed");
}

export class SubagentRunComponent implements InteractiveCard {
	private target: SubagentRunTarget;
	private expanded = false;
	private openSessionRow = -1;

	constructor(target: SubagentRunTarget) {
		this.target = target;
	}

	setTarget(target: SubagentRunTarget): void {
		this.target = target;
	}

	getTarget(): SubagentRunTarget {
		return this.target;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	getCardStateKey(): string {
		return `subagent-run:${this.target.runId ?? "legacy"}:${this.target.agentId}`;
	}

	getCardClickActionAtRow(row: number): InteractiveCardAction | undefined {
		if (row < 0) return undefined;
		if (row === this.openSessionRow) return { type: "openSubagent", target: this.target };
		return { type: "toggle", component: this };
	}

	invalidate(): void {}

	render(width: number): string[] {
		this.openSessionRow = -1;
		const status = theme.fg(statusColor(this.target.state), formatSubagentState(this.target.state));
		const prefix = `${theme.fg("dim", this.expanded ? uiGlyphs.expanded : uiGlyphs.collapsed)} ${theme.bold(theme.fg("toolTitle", this.target.agent))} `;
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
		const lines = [truncateToWidth(`${prefix}${renderedDetail}${" ".repeat(gap)}${status}`, width, "…")];
		if (!this.expanded) return lines;

		const bodyWidth = Math.max(1, width - 2);
		const task = firstLine(this.target.task);
		if (task) lines.push(truncateToWidth(`  ${theme.fg("dim", "任务：")}${theme.fg("muted", task)}`, bodyWidth, "…"));
		const current = firstLine(this.target.currentAction);
		if (current) {
			lines.push(truncateToWidth(`  ${theme.fg("dim", "当前：")}${theme.fg("text", current)}`, bodyWidth, "…"));
		}
		const result = firstLine(this.target.finalOutput);
		if (result) {
			lines.push(truncateToWidth(`  ${theme.fg("dim", "结果：")}${theme.fg("muted", result)}`, bodyWidth, "…"));
		}
		if (this.target.session || (this.target.legacyMessages?.length ?? 0) > 0) {
			this.openSessionRow = lines.length;
			lines.push(theme.fg("accent", `  ${uiGlyphs.open} 打开 Agent 会话`));
		}
		return lines;
	}
}

function firstLine(value: string | undefined): string {
	return (
		value
			?.split(/\r?\n/)
			.find((line) => line.trim())
			?.trim() ?? ""
	);
}

type RowRange = { row: SubagentRunComponent; start: number; end: number };

export class SubagentResultComponent implements InteractiveCard {
	private rows: SubagentRunComponent[] = [];
	private ranges: RowRange[] = [];
	private renderVersion = 0;
	private visible = true;

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

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.renderVersion++;
	}

	getAgentTargetAtRow(row: number): SubagentRunTarget | undefined {
		return this.ranges.find((range) => row >= range.start && row < range.end)?.row.getTarget();
	}

	setExpanded(expanded: boolean): void {
		for (const row of this.rows) row.setExpanded(expanded);
		this.renderVersion++;
	}

	isExpanded(): boolean {
		return this.rows.length > 0 && this.rows.every((row) => row.isExpanded());
	}

	getChildCards(): readonly SubagentRunComponent[] {
		return this.rows;
	}

	getCardClickActionAtRow(row: number): InteractiveCardAction | undefined {
		const range = this.ranges.find((item) => row >= item.start && row < item.end);
		return range ? resolveInteractiveCardAction(range.row, row - range.start) : undefined;
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
		if (!this.visible) return [];
		const lines: string[] = [];
		for (let index = 0; index < this.rows.length; index++) {
			const row = this.rows[index]!;
			const rendered = row.render(width);
			const start = lines.length;
			lines.push(...rendered);
			this.ranges.push({ row, start, end: lines.length });
			if (index < this.rows.length - 1) lines.push(renderToolDivider(width, 4));
		}
		return lines;
	}
}
