import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ToolExecutionError, type ToolRecoveryReplacementResult } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readdir as fsReaddir, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { getReadmePath } from "../../config.ts";
import { getToolSummary, type ToolSummaryOptions } from "../../modes/interactive/components/tool-summary.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { uiGlyphs } from "../../modes/interactive/ui-glyphs.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { registerBuiltInRecoveryError } from "../tool-recovery/registry.ts";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Read a bounded parent-directory listing for target-missing recovery. */
	readDir?: (absolutePath: string) => Promise<string[]>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	readDir: (path) => fsReaddir(path),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `${startLine}${endLine ? `–${endLine}` : "+"}`);
}

function formatReadCall(
	args: ReadRenderArgs | undefined,
	theme: Theme,
	cwd: string,
	options: { expanded: boolean; isPartial: boolean; isError: boolean },
): ToolSummaryOptions {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return {
		icon: uiGlyphs.file,
		subject: pathDisplay,
		subjectRight: formatReadLineRange(args, theme),
		isPartial: options.isPartial,
		isError: options.isError,
		labels: { running: "正在读取", success: "已读取", error: "读取失败" },
	};
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
	options: { expanded: boolean; isPartial: boolean; isError: boolean },
): ToolSummaryOptions {
	const subject =
		classification.kind === "skill"
			? `${theme.fg("customMessageLabel", "[skill]")} ${theme.fg("customMessageText", classification.label)}`
			: `${theme.fg("accent", classification.label)}`;
	return {
		icon: uiGlyphs.file,
		subject,
		subjectRight: formatReadLineRange(args, theme),
		isPartial: options.isPartial,
		isError: options.isError,
		labels: { running: "正在读取", success: "已读取", error: "读取失败" },
	};
}

interface ReadResultRenderValue {
	text: string;
	lines: string[];
	widths: number[];
	renderedByWidth?: Map<number, string[]>;
}

class ReadResultComponent implements Component {
	private value: ReadResultRenderValue = { text: "", lines: [], widths: [] };
	private cachedWidth?: number;
	private cachedLines?: string[];

	setValue(value: ReadResultRenderValue): void {
		if (this.value.text === value.text) return;
		this.value = value;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === safeWidth) return this.cachedLines;
		const valueCachedLines = this.value.renderedByWidth?.get(safeWidth);
		if (valueCachedLines) {
			this.cachedWidth = safeWidth;
			this.cachedLines = valueCachedLines;
			return valueCachedLines;
		}
		if (this.value.lines.length === 0) {
			this.cachedWidth = safeWidth;
			this.cachedLines = [];
			return this.cachedLines;
		}

		const hasStableAnsiBoundaries = this.value.lines.every((line) => {
			const ansiSequences = line.match(/\x1b\[[0-9;]*m/g);
			const lastAnsiSequence = ansiSequences?.at(-1);
			return !lastAnsiSequence || ["\x1b[0m", "\x1b[39m", "\x1b[49m"].includes(lastAnsiSequence);
		});
		const canRenderDirectly =
			hasStableAnsiBoundaries &&
			this.value.lines.every((line, index) => (this.value.widths[index] ?? visibleWidth(line)) <= safeWidth);
		const lines = canRenderDirectly
			? this.value.lines.map(
					(line, index) =>
						`${line}${" ".repeat(Math.max(0, safeWidth - (this.value.widths[index] ?? visibleWidth(line))))}`,
				)
			: wrapTextWithAnsi(this.value.text, safeWidth).map(
					(line) => `${line}${" ".repeat(Math.max(0, safeWidth - visibleWidth(line)))}`,
				);

		this.value.renderedByWidth ??= new Map<number, string[]>();
		this.value.renderedByWidth.set(safeWidth, lines);
		this.cachedWidth = safeWidth;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

type ReadResultRenderCache = {
	args: unknown;
	content: readonly unknown[];
	details: unknown;
	showImages: boolean;
	isError: boolean;
	themeSignature: string;
	values: Map<string, ReadResultRenderValue>;
};

const readResultRenderCache = new WeakMap<ReadResultComponent, ReadResultRenderCache>();

function getReadThemeSignature(theme: Theme): string {
	return [
		theme.name,
		theme.getColorMode(),
		theme.getFgAnsi("toolOutput"),
		theme.getFgAnsi("warning"),
		theme.getFgAnsi("syntaxComment"),
		theme.getFgAnsi("syntaxKeyword"),
		theme.getFgAnsi("syntaxFunction"),
		theme.getFgAnsi("syntaxVariable"),
		theme.getFgAnsi("syntaxString"),
		theme.getFgAnsi("syntaxNumber"),
		theme.getFgAnsi("syntaxType"),
		theme.getFgAnsi("syntaxOperator"),
		theme.getFgAnsi("syntaxPunctuation"),
	].join("\0");
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
): ReadResultRenderValue {
	if (!options.expanded && !isError) {
		return { text: "", lines: [], widths: [] };
	}

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
	const sourceLines = trimTrailingEmptyLines(replaceTabs(output).split("\n"));
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : sourceLines;
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 1;
	const displayLines = lines.slice(0, maxLines);
	const displayWidths = sourceLines.slice(0, maxLines).map((line) => visibleWidth(line));
	const renderedDisplayLines = displayLines.map((line) =>
		lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)),
	);
	const outputLines = ["", ...renderedDisplayLines];
	const outputWidths = [0, ...displayWidths];
	let text = outputLines.join("\n");

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		let warning: string;
		if (truncation.firstLineExceedsLimit) {
			warning = theme.fg(
				"warning",
				`[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`,
			);
		} else if (truncation.truncatedBy === "lines") {
			warning = theme.fg(
				"warning",
				`[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`,
			);
		} else {
			warning = theme.fg(
				"warning",
				`[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`,
			);
		}
		text += `\n${warning}`;
		outputLines.push(warning);
		outputWidths.push(visibleWidth(warning));
	}
	return { text, lines: outputLines, widths: outputWidths };
}

const readRecoveryHandlerSymbol = Symbol.for("pi.toolRecoveryHandler");

type ReadRecoveryHandler = (context: { signal?: AbortSignal }) => Promise<unknown> | unknown;

function attachReadRecoveryHandler(error: ToolExecutionError, handler: ReadRecoveryHandler): ToolExecutionError {
	registerBuiltInRecoveryError("read", error);
	Object.defineProperty(error, readRecoveryHandlerSymbol, { value: handler });
	return error;
}

function normalizeReadFailure(error: unknown): ToolExecutionError {
	if (error instanceof ToolExecutionError) return error;
	const code =
		typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
			? error.code
			: undefined;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ENOENT" || code === "ENOTDIR") {
		return new ToolExecutionError(message, {
			code: "TARGET_NOT_FOUND",
			category: "precondition",
			retryable: false,
			details: {},
		});
	}
	if (code === "EACCES" || code === "EPERM") {
		return new ToolExecutionError(message, {
			code: "PERMISSION_DENIED",
			category: "permission",
			retryable: false,
			details: {},
		});
	}
	if (code === "ABORT_ERR" || (error instanceof DOMException && error.name === "AbortError")) {
		return new ToolExecutionError("Operation aborted", {
			code: "CANCELLED",
			category: "cancelled",
			retryable: false,
			details: {},
		});
	}
	return new ToolExecutionError(message, { code: "UNCLASSIFIED", category: "unknown", retryable: false, details: {} });
}

function attachReadRecovery(
	error: ToolExecutionError,
	path: string,
	cwd: string,
	ops: ReadOperations,
): ToolExecutionError {
	if (error.code !== "TARGET_NOT_FOUND" || !ops.readDir) return error;
	const parentPath = dirname(resolveToCwd(path, cwd));
	return attachReadRecoveryHandler(error, async ({ signal }) => {
		if (signal?.aborted) return { type: "stop", reason: "cancelled" };
		try {
			const entries = (await ops.readDir!(parentPath)).slice(0, 200);
			if (signal?.aborted) return { type: "stop", reason: "cancelled" };
			const replacementResult: ToolRecoveryReplacementResult = {
				content: [
					{
						type: "text",
						text: `${error.message}\n\n父目录刷新结果（最多 200 项）：\n${entries.join("\n")}\n请根据目录内容修正 path。`,
					},
				],
				details: { recovery: { code: "TARGET_NOT_FOUND", entryCount: entries.length } },
			};
			return { type: "refresh_context", adapter: "read_parent_directory", replacementResult };
		} catch {
			return undefined;
		}
	});
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		constrainedSampling: getExperimentalToolSampling(),
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(path, cwd);
							if (aborted) return;
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const processed = await processImage(buffer, mimeType, { autoResizeImages });
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Read text content.
								const buffer = await ops.readFile(absolutePath);
								const textContent = buffer.toString("utf-8");
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;
								// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// Check if offset is out of bounds.
								if (startLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}
								let selectedContent: string;
								let userLimitedLines: number | undefined;
								// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}
								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(selectedContent);
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit. Point the model at a bash fallback.
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: unknown) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(attachReadRecovery(normalizeReadFailure(error), path, cwd, ops));
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const summary = getToolSummary(context.lastComponent);
			const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
			const options = {
				expanded: context.expanded,
				isPartial: context.isPartial,
				isError: context.isError,
			};
			summary.setSummary(
				classification
					? formatCompactReadCall(classification, args, theme, options)
					: formatReadCall(args, theme, context.cwd, options),
			);
			return summary;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as ReadResultComponent | undefined) ?? new ReadResultComponent();
			const themeSignature = getReadThemeSignature(theme);
			const cached = readResultRenderCache.get(text);
			const cacheMatches =
				cached !== undefined &&
				cached.args === context.args &&
				cached.content === result.content &&
				cached.details === result.details &&
				cached.showImages === context.showImages &&
				cached.isError === context.isError &&
				cached.themeSignature === themeSignature;
			const renderCache = cacheMatches
				? cached
				: {
						args: context.args,
						content: result.content,
						details: result.details,
						showImages: context.showImages,
						isError: context.isError,
						themeSignature,
						values: new Map<string, ReadResultRenderValue>(),
					};
			const stateKey = `${options.expanded ? "expanded" : "collapsed"}:${options.isPartial ? "partial" : "complete"}`;
			let value = renderCache.values.get(stateKey);
			if (value === undefined) {
				value = formatReadResult(
					context.args,
					result,
					options,
					theme,
					context.showImages,
					context.cwd,
					context.isError,
				);
				renderCache.values.set(stateKey, value);
			}
			if (!cacheMatches) readResultRenderCache.set(text, renderCache);
			text.setValue(value);
			return text;
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
