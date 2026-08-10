import { Box, type Component, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";
import type { InteractiveCardAction } from "./interactive-card.ts";
import { alignCardExpansion, renderToolDivider } from "./tool-card-layout.ts";

export interface TurnFileSummary {
	path: string;
	additions?: number;
	deletions?: number;
	diff?: string;
}

export interface TurnToolSummary {
	name: string;
	subject?: string;
	status: "success" | "error" | "cancelled";
	error?: string;
}

export type TurnOutcome = "completed" | "failed" | "incomplete" | "cancelled";

export function resolveTurnOutcome(options: {
	cancelled: boolean;
	stopReason?: string;
	hasUnfinishedTools: boolean;
}): TurnOutcome {
	if (options.cancelled || options.stopReason === "aborted") return "cancelled";
	if (options.stopReason === "error") return "failed";
	if (options.hasUnfinishedTools || options.stopReason !== "stop") return "incomplete";
	return "completed";
}

export interface TurnSummaryData {
	startedAt: number;
	endedAt: number;
	outcome?: TurnOutcome;
	toolErrors?: number;
	totalTools: number;
	successfulTools: number;
	failedTools: number;
	cancelledTools: number;
	commandCount: number;
	successfulCommands: number;
	files: TurnFileSummary[];
	tools: TurnToolSummary[];
	retried: boolean;
	compacted: boolean;
	cancelled: boolean;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function totals(files: readonly TurnFileSummary[]): { additions: number; deletions: number; known: boolean } {
	let additions = 0;
	let deletions = 0;
	let known = false;
	for (const file of files) {
		if (file.additions !== undefined) {
			additions += file.additions;
			known = true;
		}
		if (file.deletions !== undefined) {
			deletions += file.deletions;
			known = true;
		}
	}
	return { additions, deletions, known };
}

function getOutcome(data: TurnSummaryData): TurnOutcome {
	return data.outcome ?? (data.cancelled ? "cancelled" : "completed");
}

function formatTurnSummaryVariant(
	data: TurnSummaryData,
	options: { compact: boolean; includeCommands: boolean; includeDuration: boolean },
): string {
	const duration = formatDuration(data.endedAt - data.startedAt);
	const parts: string[] = [];
	const outcome = getOutcome(data);
	if (outcome === "cancelled") {
		parts.push("已取消", `完成 ${data.successfulTools}/${data.totalTools} 个操作`);
	} else if (outcome === "failed") {
		parts.push("执行失败");
		if (data.successfulTools > 0) parts.push(`${data.successfulTools} 个操作成功`);
		const incompleteTools = Math.max(0, data.totalTools - data.successfulTools);
		if (incompleteTools > 0) parts.push(`${incompleteTools} 个操作未完成`);
	} else if (outcome === "incomplete") {
		parts.push("未完成");
	} else {
		parts.push("完成");
	}
	if (data.files.length > 0) {
		parts.push(`${options.compact ? "" : "修改 "}${data.files.length} 个文件`);
		const count = totals(data.files);
		if (count.known) parts.push(`+${count.additions} -${count.deletions}`);
	}
	if (options.includeCommands && data.commandCount > 0) {
		parts.push(
			options.compact
				? `${data.successfulCommands}/${data.commandCount} 条命令`
				: `命令 ${data.successfulCommands}/${data.commandCount}`,
		);
	}
	if (options.includeDuration) parts.push(duration);
	return parts.join(" · ");
}

export function formatTurnSummary(data: TurnSummaryData): string {
	return formatTurnSummaryVariant(data, { compact: false, includeCommands: true, includeDuration: true });
}

class TurnSummaryHeader implements Component {
	private readonly data: TurnSummaryData;

	constructor(data: TurnSummaryData) {
		this.data = data;
	}

	render(width: number): string[] {
		const outcome = getOutcome(this.data);
		const color = outcome === "completed" ? "accent" : "warning";
		const icon = outcome === "completed" ? uiGlyphs.success : uiGlyphs.failure;
		const prefix = `${theme.bold(theme.fg(color, icon))} `;
		const available = Math.max(1, width - visibleWidth(prefix));
		const candidates = [
			formatTurnSummary(this.data),
			formatTurnSummaryVariant(this.data, { compact: true, includeCommands: true, includeDuration: true }),
			formatTurnSummaryVariant(this.data, { compact: true, includeCommands: true, includeDuration: false }),
			formatTurnSummaryVariant(this.data, { compact: true, includeCommands: false, includeDuration: false }),
		];
		const summary = candidates.find((candidate) => visibleWidth(candidate) <= available) ?? candidates.at(-1)!;
		return [`${prefix}${theme.fg("text", truncateToWidth(summary, available, "…"))}`];
	}

	invalidate(): void {}
}

export class TurnSummaryComponent extends Box {
	private expanded = false;
	private readonly data: TurnSummaryData;
	private lastRenderedLineCount = 0;

	constructor(data: TurnSummaryData) {
		super(1, 0, (text) => text);
		this.data = data;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	getCardStateKey(): string {
		return `turn-summary:${this.data.startedAt}`;
	}

	getCardClickActionAtRow(row: number): InteractiveCardAction | undefined {
		return row >= 0 && row < this.lastRenderedLineCount - 1 ? { type: "toggle", component: this } : undefined;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		lines[0] = alignCardExpansion(lines[0]!, width, this.expanded);
		lines.push(renderToolDivider(width));
		this.lastRenderedLineCount = lines.length;
		return lines;
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const outcome = getOutcome(this.data);
		this.addChild(new TurnSummaryHeader(this.data));
		if (!this.expanded) return;

		if (this.data.files.length > 0) {
			this.addChild(new Spacer(1));
			for (const file of this.data.files) {
				const count =
					file.additions !== undefined || file.deletions !== undefined
						? `  +${file.additions ?? 0} -${file.deletions ?? 0}`
						: "";
				this.addChild(
					new Text(
						`${theme.fg("accent", uiGlyphs.edit)} ${theme.fg("text", file.path)}${theme.fg("muted", count)}`,
						0,
						0,
					),
				);
			}
		}

		if (this.data.toolErrors && outcome === "completed") {
			this.addChild(
				new Text(theme.fg("muted", `过程中有 ${this.data.toolErrors} 次 Tool 调用失败，Agent 已继续处理`), 0, 0),
			);
		}

		const failures = this.data.tools.filter((tool) => tool.status !== "success");
		if (failures.length > 0) {
			this.addChild(new Spacer(1));
			for (const tool of failures) {
				const subject = [tool.name, tool.subject].filter(Boolean).join(" ");
				const error = tool.error ? `：${tool.error}` : "";
				this.addChild(new Text(theme.fg("warning", `${uiGlyphs.failure} ${subject}${error}`), 0, 0));
			}
		}

		const notes = [
			this.data.retried ? "发生过重试" : undefined,
			this.data.compacted ? "压缩过上下文" : undefined,
		].filter((note): note is string => Boolean(note));
		if (notes.length > 0) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", notes.join(" · ")), 0, 0));
		}
	}
}
