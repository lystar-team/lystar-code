import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";
import { keyText } from "./keybinding-hints.ts";

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

export function formatTurnSummary(data: TurnSummaryData): string {
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
		parts.push(`修改 ${data.files.length} 个文件`);
		const count = totals(data.files);
		if (count.known) parts.push(`+${count.additions}/-${count.deletions}`);
	}
	if (data.commandCount > 0) {
		parts.push(`命令 ${data.successfulCommands}/${data.commandCount}`);
	}
	parts.push(duration);
	return parts.join(" · ");
}

export class TurnSummaryComponent extends Box {
	private expanded = false;
	private readonly data: TurnSummaryData;

	constructor(data: TurnSummaryData) {
		super(1, 0, (text) => theme.bg("customMessageBg", text));
		this.data = data;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	isExpansionToggleRow(row: number): boolean {
		return row === 0;
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const outcome = getOutcome(this.data);
		const hasIssue = outcome !== "completed";
		const icon = hasIssue ? uiGlyphs.failure : uiGlyphs.success;
		const color = hasIssue ? "warning" : "accent";
		const hint = theme.fg("dim", `（${keyText("app.tools.expand")} 展开）`);
		this.addChild(
			new Text(
				`${theme.bold(theme.fg(color, icon))} ${theme.fg("text", formatTurnSummary(this.data))} ${hint}`,
				0,
				0,
			),
		);
		if (!this.expanded) return;

		if (this.data.files.length > 0) {
			this.addChild(new Spacer(1));
			for (const file of this.data.files) {
				const count =
					file.additions !== undefined || file.deletions !== undefined
						? `  +${file.additions ?? 0}/-${file.deletions ?? 0}`
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
