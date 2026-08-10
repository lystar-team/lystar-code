import type { AssistantMessage, WebSearchCallContent } from "@earendil-works/pi-ai";
import {
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { t } from "../../../locales/zh-CN.ts";
import {
	formatMarkdownLinks,
	getCitationLinks,
	getWebSearchSourceLinks,
	type WebLink,
} from "../../../utils/web-search.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";
import { type InteractiveCard, type InteractiveCardAction, resolveInteractiveCardAction } from "./interactive-card.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { renderToolDivider } from "./tool-card-layout.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const CODE_BLOCK_LINE_LIMIT = 200;
const CODE_BLOCK_HEAD_LINES = 20;
const CODE_BLOCK_TAIL_LINES = 20;
const LONG_MARKDOWN_CHARACTER_LIMIT = 16 * 1024;
const LONG_MARKDOWN_HEAD_CHARACTERS = 2 * 1024;
const LONG_MARKDOWN_TAIL_CHARACTERS = 1024;

type MarkdownFence = { character: string; length: number; start: number };
type MarkdownFenceRange = { start: number; end: number };
type WebSearchRange = { component: WebSearchCallComponent; start: number; end: number };

class WebSearchCallComponent implements InteractiveCard {
	private call: WebSearchCallContent;
	private sources: WebLink[];
	private expanded = false;
	private outputPad: number;
	private markdownTheme: MarkdownTheme;
	private readonly onExpansionChange: () => void;
	private lastRenderedLineCount = 0;

	constructor(
		call: WebSearchCallContent,
		sources: WebLink[],
		outputPad: number,
		markdownTheme: MarkdownTheme,
		onExpansionChange: () => void,
	) {
		this.call = call;
		this.sources = sources;
		this.outputPad = outputPad;
		this.markdownTheme = markdownTheme;
		this.onExpansionChange = onExpansionChange;
	}

	update(call: WebSearchCallContent, sources: WebLink[], outputPad: number, markdownTheme: MarkdownTheme): void {
		this.call = call;
		this.sources = sources;
		this.outputPad = outputPad;
		this.markdownTheme = markdownTheme;
		this.onExpansionChange();
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.onExpansionChange();
	}

	getCardStateKey(): string {
		return `web-search:${this.call.id}`;
	}

	getCardClickActionAtRow(row: number): InteractiveCardAction | undefined {
		return row >= 0 && row < this.lastRenderedLineCount - 1 && this.sources.length > 0
			? { type: "toggle", component: this }
			: undefined;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const status =
			this.call.status === "failed"
				? t("status.webSearchFailed")
				: this.call.status === "completed"
					? t("status.webSearchCompleted")
					: t("status.webSearchInProgress");
		const sourceCount =
			this.sources.length > 0 ? ` · ${t("status.webSearchSources", { count: this.sources.length })}` : "";
		const left = theme.fg(
			this.call.status === "failed" ? "error" : this.call.status === "completed" ? "success" : "warning",
			`${uiGlyphs.search} ${status}${sourceCount}`,
		);
		const right =
			this.sources.length > 0 ? theme.fg("dim", this.expanded ? uiGlyphs.expanded : uiGlyphs.collapsed) : "";
		const rightWidth = visibleWidth(right);
		const fittedLeft = truncateToWidth(left, Math.max(1, width - rightWidth - (right ? 1 : 0)), "…");
		const header = right
			? `${fittedLeft}${" ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth))}${right}`
			: fittedLeft;
		const lines = [header];
		if (this.expanded && this.sources.length > 0) {
			lines.push(
				...new Markdown(
					formatMarkdownLinks(t("status.webSearchSourceList"), this.sources),
					this.outputPad,
					0,
					this.markdownTheme,
				).render(width),
			);
		}
		lines.push(renderToolDivider(width));
		this.lastRenderedLineCount = lines.length;
		return lines;
	}
}

function getMarkdownFenceRanges(markdown: string): MarkdownFenceRange[] {
	const ranges: MarkdownFenceRange[] = [];
	let fence: MarkdownFence | undefined;
	let offset = 0;
	for (const line of markdown.match(/.*(?:\n|$)/g) ?? []) {
		if (!line) continue;
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker) {
			if (!fence) {
				fence = { character: marker[0], length: marker.length, start: offset };
			} else if (marker[0] === fence.character && marker.length >= fence.length) {
				ranges.push({ start: fence.start, end: offset + line.length });
				fence = undefined;
			}
		}
		offset += line.length;
	}
	if (fence) ranges.push({ start: fence.start, end: markdown.length });
	return ranges;
}

function safeMarkdownOffset(target: number, fenceRanges: MarkdownFenceRange[]): number {
	const fence = fenceRanges.find((range) => target >= range.start && target < range.end);
	return fence?.end ?? target;
}

function collapseLongMarkdown(markdown: string): string {
	if (markdown.length <= LONG_MARKDOWN_CHARACTER_LIMIT) return markdown;
	const fenceRanges = getMarkdownFenceRanges(markdown);
	const headEnd = safeMarkdownOffset(LONG_MARKDOWN_HEAD_CHARACTERS, fenceRanges);
	const tailStart = safeMarkdownOffset(markdown.length - LONG_MARKDOWN_TAIL_CHARACTERS, fenceRanges);
	if (headEnd >= tailStart) return markdown;
	return `${markdown.slice(0, headEnd)}\n... 已省略 ${tailStart - headEnd} 个字符 ...\n${markdown.slice(tailStart)}`;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private renderVersion = 0;
	private isStreaming = false;
	private hasLongCodeBlock = false;
	private hasLongMarkdown = false;
	private hasWebSearchSources = false;
	private contentExpanded = false;
	private webSearchComponents = new Map<string, WebSearchCallComponent>();
	private webSearchRanges: WebSearchRange[] = [];

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = t("status.thinking"),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines: string[] = [];
		this.webSearchRanges = [];
		for (const child of this.contentContainer.children) {
			const start = lines.length;
			const childLines = child.render(width);
			lines.push(...childLines);
			if (child instanceof WebSearchCallComponent && childLines.length > 0) {
				this.webSearchRanges.push({ component: child, start, end: lines.length });
			}
		}
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	getRenderVersion(): number {
		return this.renderVersion;
	}

	isExpanded(): boolean {
		return this.contentExpanded;
	}

	getCardClickActionAtRow(row: number): InteractiveCardAction | undefined {
		if (row < 0) return undefined;
		const webSearchRange = this.webSearchRanges.find((range) => row >= range.start && row < range.end);
		if (webSearchRange) {
			return resolveInteractiveCardAction(webSearchRange.component, row - webSearchRange.start);
		}
		return this.hasLongCodeBlock || this.hasLongMarkdown ? { type: "toggle", component: this } : undefined;
	}

	getChildCards(): readonly InteractiveCard[] {
		return [...this.webSearchComponents.values()];
	}

	setExpanded(expanded: boolean): void {
		if ((!this.hasLongCodeBlock && !this.hasLongMarkdown && !this.hasWebSearchSources) || !this.lastMessage) return;
		const webSearchChanged = [...this.webSearchComponents.values()].some(
			(component) => component.isExpanded() !== expanded,
		);
		if (this.contentExpanded === expanded && !webSearchChanged) return;
		this.contentExpanded = expanded;
		for (const component of this.webSearchComponents.values()) component.setExpanded(expanded);
		this.updateContent(this.lastMessage);
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.renderVersion++;
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		this.hasLongCodeBlock =
			!this.isStreaming &&
			message.content.some((content) => {
				const markdown =
					content.type === "text" ? content.text : content.type === "thinking" ? content.thinking : "";
				return Markdown.hasClosedCodeBlockOverLineLimit(markdown, CODE_BLOCK_LINE_LIMIT);
			});
		this.hasLongMarkdown =
			!this.isStreaming &&
			message.content.some((content) => {
				const markdown =
					content.type === "text" ? content.text : content.type === "thinking" ? content.thinking : "";
				return markdown.length > LONG_MARKDOWN_CHARACTER_LIMIT;
			});
		const citations = message.content.flatMap((content) =>
			content.type === "text" ? getCitationLinks(content) : [],
		);
		const activeWebSearchIds = new Set<string>();
		for (const content of message.content) {
			if (content.type !== "webSearchCall") continue;
			activeWebSearchIds.add(content.id);
			const sources = getWebSearchSourceLinks(content, citations);
			const component = this.webSearchComponents.get(content.id);
			if (component) {
				component.update(content, sources, this.outputPad, this.markdownTheme);
			} else {
				const created = new WebSearchCallComponent(
					content,
					sources,
					this.outputPad,
					this.markdownTheme,
					() => this.renderVersion++,
				);
				created.setExpanded(this.contentExpanded);
				this.webSearchComponents.set(content.id, created);
			}
		}
		for (const id of this.webSearchComponents.keys()) {
			if (!activeWebSearchIds.has(id)) this.webSearchComponents.delete(id);
		}
		this.hasWebSearchSources = [...this.webSearchComponents.values()].some(
			(component) => component.getCardClickActionAtRow(0) !== undefined,
		);
		if (!this.hasLongCodeBlock && !this.hasLongMarkdown && !this.hasWebSearchSources) {
			this.contentExpanded = false;
		}
		const codeBlockCollapse =
			this.hasLongCodeBlock && !this.contentExpanded
				? {
						maxLines: CODE_BLOCK_LINE_LIMIT,
						headLines: CODE_BLOCK_HEAD_LINES,
						tailLines: CODE_BLOCK_TAIL_LINES,
						omittedLine: (hiddenLineCount: number) => `... 已省略 ${hiddenLineCount} 行 ...`,
					}
				: undefined;

		// Clear content container
		this.contentContainer.clear();

		const collapseMarkdown = (markdown: string): string => {
			if (this.isStreaming || this.contentExpanded) return markdown;
			return collapseLongMarkdown(markdown);
		};

		const hasVisibleContent = message.content.some(
			(c) =>
				(c.type === "text" && c.text.trim()) ||
				(c.type === "thinking" && c.thinking.trim()) ||
				c.type === "webSearchCall",
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				const markdown = collapseMarkdown(content.text.trim());
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(markdown, this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
						codeBlockCollapse,
					}),
				);
				const citations = getCitationLinks(content);
				if (citations.length > 0) {
					this.contentContainer.addChild(
						new Markdown(
							formatMarkdownLinks(t("status.citations"), citations),
							this.outputPad,
							0,
							this.markdownTheme,
						),
					);
				}
			} else if (content.type === "webSearchCall") {
				const component = this.webSearchComponents.get(content.id);
				if (component) this.contentContainer.addChild(component);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(
						(c) =>
							(c.type === "text" && c.text.trim()) ||
							(c.type === "thinking" && c.thinking.trim()) ||
							c.type === "webSearchCall",
					);

				if (this.hideThinkingBlock) {
					// Show one static label for each run of thinking blocks when hidden.
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0),
					);
				} else {
					// Render each run of thinking blocks as one Markdown section.
					this.contentContainer.addChild(
						new Markdown(
							collapseMarkdown(thinkingBlocks.join("\n\n")),
							this.outputPad,
							0,
							this.markdownTheme,
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
								codeBlockCollapse,
							},
						),
					);
				}
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", t("common.error", { message: t("status.maxOutput") })), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: t("status.operationAborted");
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || t("status.unknownError");
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(
					new Text(theme.fg("error", t("common.error", { message: errorMsg })), this.outputPad, 0),
				);
			}
		}
	}
}
