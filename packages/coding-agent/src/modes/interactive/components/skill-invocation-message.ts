import { Box, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";
import type { InteractiveCardAction } from "./interactive-card.ts";
import { renderCardWithDivider } from "./tool-card-layout.ts";

/**
 * Component that renders a skill invocation message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 * Only renders the skill block itself - user message is rendered separately.
 */
export class SkillInvocationMessageComponent extends Box {
	private expanded = false;
	private skillBlock: ParsedSkillBlock;
	private markdownTheme: MarkdownTheme;
	private lastRenderedLineCount = 0;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 0, (text) => text);
		this.skillBlock = skillBlock;
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

		if (this.expanded) {
			const label = theme.bold(theme.fg("customMessageLabel", `${uiGlyphs.tool} Skill · ${this.skillBlock.name}`));
			this.addChild(new Text(label, 0, 0));
			this.addChild(
				new Markdown(this.skillBlock.content, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			const line = theme.bold(theme.fg("customMessageLabel", `${uiGlyphs.tool} Skill · ${this.skillBlock.name}`));
			this.addChild(new Text(line, 0, 0));
		}
	}
}
