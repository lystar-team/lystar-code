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

export function renderCardWithDivider(lines: readonly string[], width: number, expanded: boolean): string[] {
	if (lines.length === 0) return [];
	return [alignCardExpansion(lines[0]!, width, expanded), ...lines.slice(1), renderToolDivider(width)];
}

export function renderCardHover(lines: string[], width: number, hovered: boolean): string[] {
	if (!hovered) return lines;
	const selectedBackground = theme.getBgAnsi("selectedBg");
	return lines.map((line) => {
		const fitted = truncateToWidth(line, Math.max(1, width), "", true);
		const stableBackground = fitted.replace(/\x1b\[([0-9;]*)m/g, (sequence, params: string) => {
			const codes = params === "" ? [0] : params.split(";").map((value) => Number.parseInt(value, 10));
			return codes.includes(0) || codes.includes(49) ? `${sequence}${selectedBackground}` : sequence;
		});
		return `${selectedBackground}${stableBackground}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}\x1b[49m`;
	});
}
