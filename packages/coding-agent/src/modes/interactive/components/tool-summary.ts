import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { toUiGlyph, uiGlyphs } from "../ui-glyphs.ts";

export interface ToolSummaryLabels {
	running: string;
	success: string;
	error: string;
}

export class ToolSummary implements Component {
	private text = "";
	private cachedWidth?: number;
	private cachedLines?: string[];

	setText(text: string): void {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (normalized === this.text) return;
		this.text = normalized;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = [truncateToWidth(this.text, Math.max(1, width), "…")];
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export function getToolSummary(lastComponent: Component | undefined): ToolSummary {
	return lastComponent instanceof ToolSummary ? lastComponent : new ToolSummary();
}

export function formatToolSummary(options: {
	icon: string;
	subject: string;
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	labels: ToolSummaryLabels;
	detail?: string;
}): string {
	const action = options.isError
		? options.labels.error
		: options.isPartial
			? options.labels.running
			: options.labels.success;
	const chevron = options.expanded ? uiGlyphs.expanded : uiGlyphs.collapsed;
	const detail = options.detail ? theme.fg("muted", `  ${options.detail}`) : "";
	return `${theme.fg("dim", chevron)} ${theme.fg("toolTitle", toUiGlyph(options.icon))} ${theme.bold(action)} ${options.subject}${detail}`;
}
