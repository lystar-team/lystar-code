import { createHash } from "node:crypto";
import { Markdown } from "@earendil-works/pi-tui";
import { createMarkdownTransform } from "../modes/interactive/components/markdown-transform.ts";
import { createMermaidMarkdownTransformer } from "../modes/interactive/components/mermaid.ts";
import { getMarkdownTheme, initTheme, theme } from "../modes/interactive/theme/theme.ts";
import type { MarkdownTransformer } from "./extensions/types.ts";
import type { MermaidRenderingMode } from "./settings-manager.ts";

const MAX_LINES = 5_000;
const MAX_BYTES = 1024 * 1024;

export type RichTextMessageType = "user" | "assistant" | "custom" | "summary";

export interface RichTextRenderOptions {
	text: string;
	width: number;
	messageType: RichTextMessageType;
	isStreaming: boolean;
	themeName?: string;
	mermaidMode: MermaidRenderingMode;
	showCodeBlockFences: boolean;
	markdownTransformers?: readonly MarkdownTransformer[];
}

export interface RichTextRenderResult {
	lines: string[];
	contentHash: string;
}

/**
 * 供非交互前端复用的终端 Markdown 渲染入口。只生成 ANSI 行，绝不写入 TTY。
 */
export function renderTerminalRichText(options: RichTextRenderOptions): RichTextRenderResult {
	initTheme(options.themeName, false);
	const builtinTransformers = [
		createMermaidMarkdownTransformer({
			getMode: () => options.mermaidMode,
			theme,
		}),
	];
	const extensionTransformers =
		options.messageType === "user" || options.messageType === "assistant" ? (options.markdownTransformers ?? []) : [];
	const markdown = new Markdown(
		options.text,
		0,
		0,
		{
			...getMarkdownTheme(),
			showCodeBlockFences: options.showCodeBlockFences,
		},
		undefined,
		{
			preserveOrderedListMarkers: options.messageType === "user",
			preserveBackslashEscapes: options.messageType === "user",
			transform: createMarkdownTransform(
				options.messageType === "user" ? "user" : "assistant",
				options.isStreaming,
				[...builtinTransformers, ...extensionTransformers],
			),
		},
	);
	return {
		lines: boundedLines(markdown.render(options.width)),
		contentHash: createHash("sha256").update(options.text).digest("hex"),
	};
}

function boundedLines(lines: readonly string[]): string[] {
	const bounded: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		if (bounded.length === MAX_LINES) break;
		const lineBytes = Buffer.byteLength(line);
		if (bytes + lineBytes > MAX_BYTES) break;
		bounded.push(line);
		bytes += lineBytes;
	}
	return bounded;
}
