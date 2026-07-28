import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

export interface ToolGroupExpansionTarget {
	component: Component & { setExpanded(expanded: boolean): void };
	row: number;
}

interface ToolRange {
	component: ToolExecutionComponent;
	start: number;
	end: number;
}

export class ToolExecutionGroupComponent implements Component {
	private readonly tools: ToolExecutionComponent[] = [];
	private expanded = true;
	private ranges: ToolRange[] = [];
	private renderVersion = 0;

	addTool(component: ToolExecutionComponent): void {
		this.tools.push(component);
		this.renderVersion++;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.renderVersion++;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	setToolOutputsExpanded(expanded: boolean): void {
		for (const tool of this.tools) tool.setExpanded(expanded);
	}

	getRenderVersion(): number {
		return this.renderVersion + this.tools.reduce((version, tool) => version + tool.getRenderVersion(), 0);
	}

	isExpansionToggleRow(row: number): boolean {
		return this.tools.length > 1 && row === 0;
	}

	getExpansionTargetAtRow(row: number): ToolGroupExpansionTarget | undefined {
		if (this.tools.length === 1) {
			return row >= 0 ? { component: this.tools[0], row } : undefined;
		}
		if (row === 0) return { component: this, row };
		const range = this.ranges.find((item) => row >= item.start && row < item.end);
		return range ? { component: range.component, row: row - range.start } : undefined;
	}

	invalidate(): void {
		for (const tool of this.tools) tool.invalidate();
		this.renderVersion++;
	}

	render(width: number): string[] {
		this.ranges = [];
		if (this.tools.length === 0) return [];
		if (this.tools.length === 1) {
			const lines = this.tools[0].render(width);
			if (lines.length > 0) this.ranges.push({ component: this.tools[0], start: 0, end: lines.length });
			return lines;
		}

		const lines = [truncateToWidth(this.renderSummary(), width, "…")];
		if (!this.expanded) return lines;

		for (const tool of this.tools) {
			const toolLines = tool.render(width);
			if (toolLines.length === 0) continue;
			if (this.ranges.length > 0) lines.push("");
			const start = lines.length;
			lines.push(...toolLines);
			this.ranges.push({ component: tool, start, end: lines.length });
		}
		return lines;
	}

	private renderSummary(): string {
		const statuses = this.tools.map((tool) => tool.getExecutionStatus());
		const completed = statuses.filter(
			(status) => status === "success" || status === "error" || status === "cancelled",
		).length;
		const failed = statuses.filter((status) => status === "error").length;
		const cancelled = statuses.filter((status) => status === "cancelled").length;
		const chevron = this.expanded ? uiGlyphs.expanded : uiGlyphs.collapsed;
		let text: string;
		if (completed === this.tools.length) {
			text = `${this.tools.length} 条命令${cancelled > 0 ? "执行结束" : "执行完成"}`;
			if (failed > 0) text += ` · ${failed} 条失败`;
			if (cancelled > 0) text += ` · ${cancelled} 条取消`;
		} else if (statuses.some((status) => status === "running")) {
			text = `正在执行 ${this.tools.length} 条命令 · 已完成 ${completed}/${this.tools.length}`;
		} else {
			text = `准备执行 ${this.tools.length} 条命令`;
		}
		return `${theme.fg("dim", chevron)} ${theme.bold(text)}`;
	}
}
