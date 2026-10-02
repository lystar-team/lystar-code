import { Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private renderVersion = 0;
	private markdownTransformers: readonly MarkdownTransformer[];

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	private rebuild(): void {
		this.renderVersion++;
		this.clear();
		// The Markdown pads and colors its own background: a Box around it would keep a second full-width copy of every
		// line, with identical output.
		this.addChild(
			new Markdown(
				`${uiGlyphs.prompt} ${this.text}`,
				this.outputPad,
				1,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
					bgColor: (content: string) => theme.bg("userMessageBg", content),
				},
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform("user", false, this.markdownTransformers),
				},
			),
		);
	}

	getRenderVersion(): number {
		return this.renderVersion;
	}

	override render(width: number): string[] {
		const railWidth = width >= 3 ? 2 : 0;
		const lines = super.render(Math.max(1, width - railWidth));
		if (lines.length === 0) {
			return lines;
		}

		if (railWidth > 0) {
			const rail = theme.fg("accent", "│");
			for (let index = 0; index < lines.length; index++) {
				lines[index] = `${rail} ${lines[index]}`;
			}
		}
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
