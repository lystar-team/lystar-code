import { Box, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import type { BranchSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";
import type { InteractiveCardAction } from "./interactive-card.ts";
import { renderCardWithDivider } from "./tool-card-layout.ts";

/**
 * Component that renders a branch summary message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class BranchSummaryMessageComponent extends Box {
	private expanded = false;
	private message: BranchSummaryMessage;
	private markdownTheme: MarkdownTheme;
	private lastRenderedLineCount = 0;

	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 0, (text) => text);
		this.message = message;
		this.markdownTheme = markdownTheme;
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
		return `branch-summary:${this.message.timestamp}`;
	}

	getCardClickActionAtRow(row: number): InteractiveCardAction | undefined {
		return row >= 0 && row < this.lastRenderedLineCount - 1 ? { type: "toggle", component: this } : undefined;
	}

	override render(width: number): string[] {
		const lines = renderCardWithDivider(super.render(width), width, this.expanded);
		this.lastRenderedLineCount = lines.length;
		return lines;
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const label = theme.bold(theme.fg("customMessageLabel", `${uiGlyphs.branch} 分支摘要`));
		this.addChild(new Text(label, 0, 0));

		if (this.expanded) {
			this.addChild(
				new Markdown(this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		}
	}
}
