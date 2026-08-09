import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { t } from "../../../locales/zh-CN.ts";
import { formatMarkdownLinks, getCitationLinks, getWebSearchSourceLinks } from "../../../utils/web-search.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

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

class WebSearchSummaryText extends Text {}

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
	private webSearchToggleRows = new Set<number>();

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
		this.webSearchToggleRows.clear();
		for (const child of this.contentContainer.children) {
			const childLines = child.render(width);
			if (child instanceof WebSearchSummaryText && childLines.length > 0) {
				this.webSearchToggleRows.add(lines.length);
			}
			lines.push(...childLines);
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

	isExpansionToggleRow(row: number): boolean {
		return this.webSearchToggleRows.has(row);
	}

	setExpanded(expanded: boolean): void {
		if (
			(!this.hasLongCodeBlock && !this.hasLongMarkdown && !this.hasWebSearchSources) ||
			this.contentExpanded === expanded ||
			!this.lastMessage
		) {
			return;
		}
		this.contentExpanded = expanded;
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
		this.hasWebSearchSources = message.content.some(
			(content) => content.type === "webSearchCall" && getWebSearchSourceLinks(content, citations).length > 0,
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
				const sources = getWebSearchSourceLinks(content, citations);
				const status =
					content.status === "failed"
						? t("status.webSearchFailed")
						: content.status === "completed"
							? t("status.webSearchCompleted")
							: t("status.webSearchInProgress");
				const sourceCount =
					sources.length > 0 ? ` · ${t("status.webSearchSources", { count: sources.length })}` : "";
				this.contentContainer.addChild(
					new WebSearchSummaryText(
						theme.fg(
							content.status === "failed" ? "error" : "thinkingText",
							`${sources.length > 0 ? (this.contentExpanded ? "▾ " : "▸ ") : ""}⌕ ${status}${sourceCount}`,
						),
						this.outputPad,
						0,
					),
				);
				if (this.contentExpanded && sources.length > 0) {
					this.contentContainer.addChild(
						new Markdown(
							formatMarkdownLinks(t("status.webSearchSourceList"), sources),
							this.outputPad,
							0,
							this.markdownTheme,
						),
					);
				}
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
