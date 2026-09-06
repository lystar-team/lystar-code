import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { diffLines } from "diff";
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import { formatToolSummary, ToolSummary } from "../../modes/interactive/components/tool-summary.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { uiGlyphs } from "../../modes/interactive/ui-glyphs.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getMutationQueueKey, withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { normalizeDisplayText, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["Use write only for new files or complete rewrites."],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
	/** Read existing content when available so the UI can report create/update statistics. */
	readFile?: (absolutePath: string) => Promise<Buffer>;
}

export interface WriteToolDetails {
	operation: "created" | "updated" | "written";
	additions: number;
	deletions: number;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
	readFile: (path) => fsReadFile(path),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
}

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	truncated: boolean;
	normalizedLines: string[];
	highlightedLines: string[];
};

class WriteCallRenderComponent implements Component {
	cache?: WriteHighlightCache;
	private readonly summary = new ToolSummary();
	private bodyLines: string[] = [];

	setText(text: string): void {
		const [header = "", subject = "", ...bodyLines] = text.split("\n");
		this.summary.setText(subject ? `${header}\n${subject}` : header);
		this.bodyLines = bodyLines;
	}

	render(width: number): string[] {
		return [
			...this.summary.render(width),
			...this.bodyLines.map((line) => truncateToWidth(line, Math.max(1, width), "…")),
		];
	}

	invalidate(): void {
		this.summary.invalidate();
	}
}

const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;
const MAX_WRITE_DISPLAY_CHARS = 16 * 1024;
const MAX_WRITE_DISPLAY_LINES = 120;

function boundedWriteDisplayText(value: string): { text: string; truncated: boolean } {
	let end = Math.min(value.length, MAX_WRITE_DISPLAY_CHARS);
	let truncated = end < value.length;
	let lineCount = 0;
	for (let index = 0; index < end; index++) {
		const code = value.charCodeAt(index);
		if (code !== 10 && code !== 13) continue;
		if (code === 13 && value.charCodeAt(index + 1) === 10) index++;
		lineCount++;
		if (lineCount < MAX_WRITE_DISPLAY_LINES - 1) continue;
		end = index + 1;
		truncated = true;
		break;
	}
	if (end > 0 && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
	return { text: truncated ? `${value.slice(0, end)}\n…` : value, truncated };
}

function highlightSingleLine(line: string, lang: string): string {
	const highlighted = highlightCode(line, lang);
	return highlighted[0] ?? "";
}

function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
	const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	if (prefixCount === 0) return;
	const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
	const prefixHighlighted = highlightCode(prefixSource, cache.lang);
	for (let i = 0; i < prefixCount; i++) {
		cache.highlightedLines[i] =
			prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
	}
}

function rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	const bounded = boundedWriteDisplayText(fileContent);
	const displayContent = normalizeDisplayText(bounded.text);
	const normalized = replaceTabs(displayContent);
	return {
		rawPath,
		lang,
		rawContent: bounded.text,
		truncated: bounded.truncated,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, lang),
	};
}

function updateWriteHighlightCacheIncremental(
	cache: WriteHighlightCache | undefined,
	rawPath: string | null,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (cache.lang !== lang || cache.rawPath !== rawPath) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (cache.truncated || boundedWriteDisplayText(fileContent).truncated)
		return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (!fileContent.startsWith(cache.rawContent)) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (fileContent.length === cache.rawContent.length) return cache;

	const deltaRaw = fileContent.slice(cache.rawContent.length);
	const deltaDisplay = normalizeDisplayText(deltaRaw);
	const deltaNormalized = replaceTabs(deltaDisplay);
	cache.rawContent = fileContent;
	if (cache.normalizedLines.length === 0) {
		cache.normalizedLines.push("");
		cache.highlightedLines.push("");
	}

	const segments = deltaNormalized.split("\n");
	const lastIndex = cache.normalizedLines.length - 1;
	cache.normalizedLines[lastIndex] += segments[0];
	cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);
	for (let i = 1; i < segments.length; i++) {
		cache.normalizedLines.push(segments[i]);
		cache.highlightedLines.push(highlightSingleLine(segments[i], cache.lang));
	}
	refreshWriteHighlightPrefix(cache);
	return cache;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function countLines(text: string): number {
	if (!text) return 0;
	let lines = 0;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code !== 10 && code !== 13) continue;
		lines++;
		if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
		start = index + 1;
	}
	return start < text.length ? lines + 1 : lines;
}

function getWriteDetails(previous: string | undefined, content: string, canRead: boolean): WriteToolDetails {
	if (!canRead) {
		return { operation: "written", additions: countLines(content), deletions: 0 };
	}
	if (previous === undefined) {
		return { operation: "created", additions: countLines(content), deletions: 0 };
	}

	let additions = 0;
	let deletions = 0;
	for (const part of diffLines(previous, content)) {
		if (part.added) additions += part.count ?? countLines(part.value);
		if (part.removed) deletions += part.count ?? countLines(part.value);
	}
	return { operation: "updated", additions, deletions };
}

function formatWriteCall(
	args: { path?: string; file_path?: string; content?: string } | undefined,
	options: ToolRenderResultOptions & { isError: boolean; details?: WriteToolDetails },
	theme: Theme,
	cache: WriteHighlightCache | undefined,
	cwd: string,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const fileContent = str(args?.content);
	const displayContent = fileContent === null ? null : boundedWriteDisplayText(fileContent).text;
	const pathDisplay = renderToolPath(rawPath, theme, cwd);
	const additions = options.details?.additions ?? countLines(fileContent ?? "");
	const deletions = options.details?.deletions ?? 0;
	const detail = deletions > 0 ? `+${additions} -${deletions}` : `+${additions}`;
	const successLabel = options.details?.operation === "created" ? "已创建" : "已写入";
	let text = formatToolSummary({
		icon: uiGlyphs.write,
		subject: pathDisplay,
		isPartial: options.isPartial,
		isError: options.isError,
		labels: { running: "正在写入", success: successLabel, error: "写入失败" },
		detail,
	});

	if (fileContent === null) {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
	} else if (fileContent && options.expanded) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const renderedLines = lang
			? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(displayContent ?? "")), lang))
			: normalizeDisplayText(displayContent ?? "").split("\n");
		const lines = trimTrailingEmptyLines(renderedLines);
		text += `\n\n${lines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	}

	return text;
}

function formatWriteResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean },
	theme: Theme,
): string | undefined {
	if (!result.isError) {
		return undefined;
	}
	const output = result.content
		.filter((c) => c.type === "text")
		.reduce((text, c) => {
			if (!c.text || text.length >= MAX_WRITE_DISPLAY_CHARS) return text;
			const separator = text ? "\n" : "";
			const available = MAX_WRITE_DISPLAY_CHARS - text.length - separator.length;
			return text + separator + c.text.slice(0, Math.max(0, available));
		}, "");
	if (!output) {
		return undefined;
	}
	return `\n${theme.fg("error", output)}`;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, WriteToolDetails> {
	const ops = options?.operations ?? defaultWriteOperations;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. In one assistant response, use only one mutation call for a file. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		getExecutionKeys: async (args) => {
			if (!args || typeof args !== "object") return [];
			const path = (args as { path?: unknown }).path;
			if (typeof path !== "string") return [];
			return [await getMutationQueueKey(resolveToCwd(path, cwd))];
		},
		constrainedSampling: getExperimentalToolSampling(),
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			const absolutePath = resolveToCwd(path, cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				let previousContent: string | undefined;
				if (ops.readFile) {
					try {
						previousContent = (await ops.readFile(absolutePath)).toString("utf-8");
					} catch {
						previousContent = undefined;
					}
				}
				throwIfAborted();

				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				// Write the file contents.
				await ops.writeFile(absolutePath, content);
				throwIfAborted();

				return {
					content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
					details: getWriteDetails(previousContent, content, ops.readFile !== undefined),
				};
			});
		},
		renderCall(args, theme, context) {
			const renderArgs = args as { path?: string; file_path?: string; content?: string } | undefined;
			const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
			const fileContent = str(renderArgs?.content);
			const component =
				(context.lastComponent as WriteCallRenderComponent | undefined) ?? new WriteCallRenderComponent();
			if (context.expanded && fileContent !== null) {
				component.cache = context.argsComplete
					? rebuildWriteHighlightCacheFull(rawPath, fileContent)
					: updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
			} else {
				component.cache = undefined;
			}
			component.setText(
				formatWriteCall(
					renderArgs,
					{
						expanded: context.expanded,
						isPartial: context.isPartial,
						isError: context.isError,
						details: context.resultDetails as WriteToolDetails | undefined,
					},
					theme,
					component.cache,
					context.cwd,
				),
			);
			return component;
		},
		renderResult(result, _options, theme, context) {
			const output = formatWriteResult({ ...result, isError: context.isError }, theme);
			if (!output) {
				const component = (context.lastComponent as Container | undefined) ?? new Container();
				component.clear();
				return component;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(output);
			return text;
		},
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
