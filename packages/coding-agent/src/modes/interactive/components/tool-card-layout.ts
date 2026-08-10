import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";

export function alignCardExpansion(line: string, width: number, expanded: boolean): string {
	const indicator = theme.fg("dim", expanded ? uiGlyphs.expanded : uiGlyphs.collapsed);
	const indicatorWidth = visibleWidth(indicator);
	if (indicatorWidth >= width) return truncateToWidth(indicator, width, "");
	const left = truncateToWidth(line, Math.max(1, width - indicatorWidth - 1), "…");
	return `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - indicatorWidth))}${indicator}`;
}

export function renderToolDivider(width: number, indent = 2): string {
	const safeIndent = Math.min(Math.max(0, indent), Math.max(0, width - 1));
	const lineWidth = Math.max(1, width - safeIndent * 2);
	return truncateToWidth(`${" ".repeat(safeIndent)}${theme.fg("toolDivider", "─".repeat(lineWidth))}`, width, "");
}

export function renderCardHover(lines: string[], width: number, hovered: boolean): string[] {
	if (!hovered) return lines;
	return lines.map((line) => {
		const fitted = truncateToWidth(line, Math.max(1, width), "", true);
		return theme.bg("selectedBg", `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`);
	});
}
