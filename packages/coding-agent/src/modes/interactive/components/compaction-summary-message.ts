import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";
import type { InteractiveCardAction } from "./interactive-card.ts";
import { renderCardWithDivider } from "./tool-card-layout.ts";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;
	private lastRenderedLineCount = 0;
	private renderVersion = 0;

	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 0, (text) => text);
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	getRenderVersion(): number {
		return this.renderVersion;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	getCardStateKey(): string {
		return `compaction-summary:${this.message.timestamp}`;
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
		this.renderVersion++;
		this.clear();

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const label = theme.bold(theme.fg("customMessageLabel", `${uiGlyphs.list} 上下文压缩`));

		if (this.expanded) {
			this.addChild(new Text(label, 0, 0));
			this.addChild(new Spacer(1));
			const header = `已将 ${tokenStr} Token 压缩为摘要\n\n`;
			this.addChild(
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.addChild(new Text(`${label}${theme.fg("muted", ` · ${tokenStr} Token`)}`, 0, 0));
		}
	}
}
