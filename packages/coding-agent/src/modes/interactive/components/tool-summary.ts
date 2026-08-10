import { type Component, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { toUiGlyph } from "../ui-glyphs.ts";

export interface ToolSummaryLabels {
	running: string;
	success: string;
	error: string;
}

export interface ToolSummaryOptions {
	icon: string;
	subject: string;
	isPartial: boolean;
	isError: boolean;
	labels: ToolSummaryLabels;
	detail?: string;
	expanded?: boolean;
	stacked?: boolean;
}

export class ToolSummary implements Component {
	private text = "";
	private summary?: ToolSummaryOptions;
	private cachedWidth?: number;
	private cachedLines?: string[];

	setText(text: string): void {
		const normalized = text
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			.trim();
		if (!this.summary && normalized === this.text) return;
		this.summary = undefined;
		this.text = normalized;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setSummary(summary: ToolSummaryOptions): void {
		this.summary = summary;
		this.text = "";
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.summary
			? renderStructuredSummary(this.summary, Math.max(1, width))
			: this.text.split("\n").map((line) => truncateToolSummaryLine(line, Math.max(1, width)));
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function truncateToolSummaryLine(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	const pathLike = stripAnsi(line)
		.trim()
		.split(/\s{2,}/)
		.some((part) => part.match(/[/\\]/) && !part.match(/\s/));
	if (!pathLike) return truncateToWidth(line, width, "…");
	const tailWidth = Math.min(Math.max(12, Math.floor(width * 0.55)), width - 2);
	const headWidth = Math.max(1, width - tailWidth - 1);
	const start = sliceByColumn(line, 0, headWidth, true);
	const end = sliceByColumn(line, Math.max(0, visibleWidth(line) - tailWidth), tailWidth, true);
	return `${start}${theme.fg("dim", "…")}${end}`;
}

export function getToolSummary(lastComponent: Component | undefined): ToolSummary {
	return lastComponent instanceof ToolSummary ? lastComponent : new ToolSummary();
}

export function configureToolSummary(lastComponent: Component | undefined, options: ToolSummaryOptions): ToolSummary {
	const summary = getToolSummary(lastComponent);
	summary.setSummary(options);
	return summary;
}

export function formatToolSummary(options: ToolSummaryOptions): string {
	const action = options.isError
		? options.labels.error
		: options.isPartial
			? options.labels.running
			: options.labels.success;
	const detail = options.detail ? theme.fg("muted", `  ${options.detail}`) : "";
	const header = `${theme.fg("toolTitle", toUiGlyph(options.icon))} ${theme.bold(action)}`;
	const subject = `${options.subject}${detail}`.trim();
	return subject ? `${header}\n  ${subject}` : header;
}

function renderStructuredSummary(options: ToolSummaryOptions, width: number): string[] {
	const action = options.isError
		? options.labels.error
		: options.isPartial
			? options.labels.running
			: options.labels.success;
	const stateColor = options.isError ? "error" : options.isPartial ? "warning" : "success";
	const icon = theme.fg(stateColor, toUiGlyph(options.icon));
	const actionText = theme.bold(theme.fg("text", action));
	const expansion =
		options.expanded === undefined ? undefined : theme.fg("dim", toUiGlyph(options.expanded ? "▾" : "▸"));
	const right = [options.detail ? theme.fg("dim", options.detail) : undefined, expansion]
		.filter((part): part is string => Boolean(part))
		.join("  ");
	const stacked = options.stacked ?? true;
	const left = stacked || !options.subject ? `${icon} ${actionText}` : `${icon} ${actionText}  ${options.subject}`;
	const header = alignSummaryLine(left, right, width);
	if (!stacked || !options.subject) return [header];
	return [header, truncateToWidth(`  ${options.subject}`, width, "…")];
}

function alignSummaryLine(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width, "…");
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, "…");
	const leftWidth = Math.max(1, width - rightWidth - 1);
	const fittedLeft = truncateToWidth(left, leftWidth, "…");
	const gap = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth));
	return `${fittedLeft}${gap}${right}`;
}
