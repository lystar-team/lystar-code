import { type InteractiveCard, type InteractiveCardAction, resolveInteractiveCardAction } from "./interactive-card.ts";
import { renderToolDivider } from "./tool-card-layout.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";
import { ToolExecutionGroupComponent } from "./tool-execution-group.ts";

type StackItem = ToolExecutionComponent | ToolExecutionGroupComponent;

interface ItemRange {
	component: StackItem;
	start: number;
	end: number;
}

export class ToolExecutionStackComponent implements InteractiveCard {
	private readonly items: StackItem[] = [];
	private ranges: ItemRange[] = [];
	private renderVersion = 0;

	addTool(component: ToolExecutionComponent): void {
		const last = this.items.at(-1);
		if (component.getToolName() === "bash") {
			const group = last instanceof ToolExecutionGroupComponent ? last : new ToolExecutionGroupComponent();
			if (group !== last) this.items.push(group);
			group.addTool(component);
		} else {
			this.items.push(component);
		}
		this.renderVersion++;
	}

	isEmpty(): boolean {
		return this.items.length === 0;
	}

	setExpanded(expanded: boolean): void {
		for (const item of this.items) {
			item.setExpanded(expanded);
			if (item instanceof ToolExecutionGroupComponent) item.setToolOutputsExpanded(expanded);
		}
		this.renderVersion++;
	}

	isExpanded(): boolean {
		return this.items.length > 0 && this.items.every((item) => item.isExpanded());
	}

	getChildCards(): readonly InteractiveCard[] {
		return this.items;
	}

	getCardClickActionAtRow(row: number): InteractiveCardAction | undefined {
		const range = this.ranges.find((item) => row >= item.start && row < item.end);
		return range ? resolveInteractiveCardAction(range.component, row - range.start) : undefined;
	}

	getRenderVersion(): number {
		return this.renderVersion + this.items.reduce((version, item) => version + item.getRenderVersion(), 0);
	}

	invalidate(): void {
		for (const item of this.items) item.invalidate();
		this.renderVersion++;
	}

	render(width: number): string[] {
		this.ranges = [];
		const lines: string[] = [];
		for (const item of this.items) {
			const rendered = item.render(width);
			if (rendered.length === 0) continue;
			const start = lines.length;
			lines.push(...rendered);
			this.ranges.push({ component: item, start, end: lines.length });
			lines.push(renderToolDivider(width));
		}
		return lines;
	}
}
