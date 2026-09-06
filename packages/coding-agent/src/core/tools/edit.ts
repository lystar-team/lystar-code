import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ToolExecutionError, type ToolRecoveryReplacementResult } from "@earendil-works/pi-agent-core";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import { formatToolSummary, getToolSummary } from "../../modes/interactive/components/tool-summary.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { uiGlyphs } from "../../modes/interactive/ui-glyphs.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { registerBuiltInRecoveryError } from "../tool-recovery/registry.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
	generateDiffString,
	generateUnifiedPatch,
	normalizeForFuzzyMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { getMutationQueueKey, withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

type EditPreview = EditDiffResult | EditDiffError;

type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{},
);

export const editToolSystemPromptContribution = {
	snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	guidelines: [
		"Use edit for precise changes (edits[].oldText must match exactly)",
		"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
	],
} as const;

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};
type SingleEditInput = { oldText: string; newText: string };

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	additions?: number;
	deletions?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models send edits as a JSON string instead of an array.
	if (typeof args.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: unknown;
	oldText?: string;
	newText?: string;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	previewArgs?: unknown;
	previewArgsRevision?: number;
	previewInitialized?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 0, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgs: undefined as unknown,
		previewArgsRevision: undefined as number | undefined,
		previewInitialized: false,
		settledError: false,
	});
}

function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = createEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

const MAX_EDIT_PREVIEW_CHARS = 16 * 1024;
const MAX_EDIT_PREVIEW_LINES = 120;

type PreviewBuffer = {
	lines: string[];
	length: number;
	truncated: boolean;
};

function parseRenderableEdits(value: unknown): Edit[] {
	if (Array.isArray(value)) {
		return value.filter((edit): edit is Edit => isSingleEditInput(edit));
	}
	if (typeof value === "string") {
		try {
			return parseRenderableEdits(JSON.parse(value));
		} catch {
			return [];
		}
	}
	return isSingleEditInput(value) ? [value] : [];
}

function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) {
		return null;
	}

	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) {
		return null;
	}

	const edits = parseRenderableEdits(args.edits);
	if (edits.length > 0) {
		return { path, edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}

function boundedEditPreviewText(value: string): string {
	if (value.length <= MAX_EDIT_PREVIEW_CHARS) return value;
	let end = MAX_EDIT_PREVIEW_CHARS - 1;
	if (
		end > 0 &&
		value.charCodeAt(end - 1) >= 0xd800 &&
		value.charCodeAt(end - 1) <= 0xdbff &&
		value.charCodeAt(end) >= 0xdc00 &&
		value.charCodeAt(end) <= 0xdfff
	) {
		end--;
	}
	return `${value.slice(0, end)}…`;
}

function forEachTextLine(text: string, callback: (source: string, start: number, end: number) => void): void {
	if (!text) return;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code !== 10 && code !== 13) continue;
		callback(text, start, index);
		if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
		start = index + 1;
	}
	if (start < text.length) callback(text, start, text.length);
}

function appendPreviewLines(buffer: PreviewBuffer, text: string, prefix: "-" | "+", startLine: number): number {
	let lineNumber = startLine;
	forEachTextLine(text, (source, start, end) => {
		if (!buffer.truncated) {
			if (buffer.lines.length >= MAX_EDIT_PREVIEW_LINES - 1) {
				buffer.truncated = true;
				lineNumber++;
				return;
			}
			const separatorLength = buffer.lines.length > 0 ? 1 : 0;
			const linePrefix = `${prefix}${lineNumber} `;
			const available = MAX_EDIT_PREVIEW_CHARS - buffer.length - separatorLength;
			if (available <= linePrefix.length) {
				buffer.truncated = true;
			} else {
				const contentLength = Math.min(end - start, available - linePrefix.length);
				buffer.lines.push(`${linePrefix}${source.slice(start, start + contentLength)}`);
				buffer.length += separatorLength + linePrefix.length + contentLength;
				if (contentLength < end - start) buffer.truncated = true;
			}
		}
		lineNumber++;
	});
	return lineNumber;
}

function createArgumentPreview(edits: Edit[]): EditDiffResult {
	const buffer: PreviewBuffer = { lines: [], length: 0, truncated: false };
	let oldLine = 1;
	let newLine = 1;
	let firstChangedLine: number | undefined;
	let additions = 0;
	let deletions = 0;

	for (const edit of edits) {
		if (firstChangedLine === undefined && (edit.oldText.length > 0 || edit.newText.length > 0)) {
			firstChangedLine = newLine;
		}
		const oldStart = oldLine;
		oldLine = appendPreviewLines(buffer, edit.oldText, "-", oldLine);
		const newStart = newLine;
		newLine = appendPreviewLines(buffer, edit.newText, "+", newLine);
		deletions += oldLine - oldStart;
		additions += newLine - newStart;
	}

	if (buffer.truncated) {
		const separatorLength = buffer.lines.length > 0 ? 1 : 0;
		if (buffer.length + separatorLength < MAX_EDIT_PREVIEW_CHARS) buffer.lines.push("…");
	}

	return {
		diff: buffer.lines.join("\n"),
		firstChangedLine,
		additions,
		deletions,
	};
}

function countRenderedDiff(diff: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (/^\+\s*\d+\s/.test(line)) additions++;
		if (/^-\s*\d+\s/.test(line)) deletions++;
	}
	return { additions, deletions };
}

function formatEditCall(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	theme: Theme,
	cwd: string,
	isPartial: boolean,
	isError: boolean,
): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	const detail = preview && !("error" in preview) ? `+${preview.additions} -${preview.deletions}` : undefined;
	return formatToolSummary({
		icon: uiGlyphs.edit,
		subject: pathDisplay,
		isPartial,
		isError: isError || Boolean(preview && "error" in preview),
		labels: { running: "正在编辑", success: "已编辑", error: "编辑失败" },
		detail,
	});
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return renderDiff(boundedEditPreviewText(resultDiff), { filePath: rawPath ?? undefined });
	}

	return undefined;
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
	options: { expanded: boolean; isPartial: boolean; isError: boolean },
): EditCallRenderComponent {
	const previewIsError = component.preview && "error" in component.preview;
	const showPreview = !options.isError && (options.expanded || Boolean(previewIsError));
	component.setBgFn((text) => text);
	component.clear();
	const summary = getToolSummary(undefined);
	summary.setText(formatEditCall(args, component.preview, theme, cwd, options.isPartial, options.isError));
	component.addChild(summary);

	if (!component.preview || !showPreview) {
		return component;
	}

	const body =
		"error" in component.preview
			? theme.fg(
					"error",
					options.expanded
						? component.preview.error
						: (component.preview.error.split(/\r?\n/).find((line) => line.trim()) ?? component.preview.error),
				)
			: renderDiff(component.preview.diff);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function setEditPreview(component: EditCallRenderComponent, preview: EditPreview): boolean {
	const displayPreview = "error" in preview ? preview : { ...preview, diff: boundedEditPreviewText(preview.diff) };
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in displayPreview
			? current.error !== displayPreview.error
			: "error" in current !== "error" in displayPreview) ||
		(!("error" in current) &&
			!("error" in displayPreview) &&
			(current.diff !== displayPreview.diff || current.firstChangedLine !== displayPreview.firstChangedLine));
	component.preview = displayPreview;
	return changed;
}

const editRecoveryHandlerSymbol = Symbol.for("pi.toolRecoveryHandler");

type EditRecoveryHandler = (context: { signal?: AbortSignal }) => Promise<unknown> | unknown;

function attachEditRecoveryHandler(error: ToolExecutionError, handler: EditRecoveryHandler): ToolExecutionError {
	registerBuiltInRecoveryError("edit", error);
	Object.defineProperty(error, editRecoveryHandlerSymbol, { value: handler });
	return error;
}

function hashEditText(text: string): string {
	return createHash("sha256").update(normalizeToLF(text), "utf8").digest("hex");
}

function hashFileContent(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function createWriteConflictError(
	path: string,
	expectedContentHash: string,
	actualContentHash: string,
): ToolExecutionError {
	return new ToolExecutionError(
		`Could not edit file: ${path}. Target changed before write; no changes were written. Re-read the target region and retry.`,
		{
			code: "WRITE_CONFLICT",
			category: "stale_state",
			retryable: false,
			details: { expectedContentHash, actualContentHash },
			fingerprintConstraint: {
				kind: "edit_write_conflict",
				expectedContentHash,
				actualContentHash,
			},
		},
	);
}

function getEditFailureIndex(message: string, edits: readonly Edit[]): number | undefined {
	const indexed = message.match(/edits\[(\d+)\]/);
	if (indexed) {
		const index = Number(indexed[1]);
		return Number.isSafeInteger(index) && index >= 0 && index < edits.length ? index : undefined;
	}
	return edits.length === 1 && /^Could not find the exact text/.test(message) ? 0 : undefined;
}

function getEditFailureMetadata(
	message: string,
	edits: readonly Edit[],
): { details: Record<string, unknown>; fingerprintConstraint?: unknown } {
	const details: Record<string, unknown> = {};
	const overlap = message.match(/^edits\[(\d+)\] and edits\[(\d+)\] overlap/);
	if (overlap) {
		const indexes = [Number(overlap[1]), Number(overlap[2])].sort((left, right) => left - right);
		details.overlapEditIndexes = indexes;
		return {
			details,
			fingerprintConstraint: {
				kind: "edit_overlap",
				editIndexes: indexes,
				oldTextHashes: indexes.map((index) => (edits[index] ? hashEditText(edits[index].oldText) : "")),
			},
		};
	}

	const editIndex = getEditFailureIndex(message, edits);
	if (editIndex === undefined) return { details };
	const oldText = edits[editIndex]?.oldText;
	details.editIndex = editIndex;
	if (oldText === undefined) return { details, fingerprintConstraint: { kind: "edit", editIndex } };
	const oldTextHash = hashEditText(oldText);
	details.oldTextHash = oldTextHash;
	return { details, fingerprintConstraint: { kind: "edit", editIndex, oldTextHash } };
}

function normalizeEditFailure(error: unknown, edits: readonly Edit[] = []): ToolExecutionError {
	if (error instanceof ToolExecutionError) return error;
	const message = error instanceof Error ? error.message : String(error);
	const metadata = getEditFailureMetadata(message, edits);
	const code = /^edits\[\d+\] and edits\[\d+\] overlap/.test(message)
		? "EDIT_OVERLAP"
		: /Error code: (?:EACCES|EPERM)/.test(message)
			? "PERMISSION_DENIED"
			: /Error code: (?:ENOENT|ENOTDIR)/.test(message)
				? "TARGET_NOT_FOUND"
				: /^Could not find(?: the exact text| edits\[)/.test(message)
					? "MATCH_NOT_FOUND"
					: /^Found \d+ occurrences/.test(message)
						? "MATCH_AMBIGUOUS"
						: /^No changes made/.test(message)
							? "NO_CHANGE"
							: "UNCLASSIFIED";
	const category =
		code === "PERMISSION_DENIED"
			? "permission"
			: code === "TARGET_NOT_FOUND" ||
					code === "MATCH_NOT_FOUND" ||
					code === "MATCH_AMBIGUOUS" ||
					code === "EDIT_OVERLAP" ||
					code === "NO_CHANGE"
				? "precondition"
				: "unknown";
	return new ToolExecutionError(message, {
		code,
		category,
		retryable: false,
		details: metadata.details,
		...(metadata.fingerprintConstraint === undefined
			? {}
			: { fingerprintConstraint: metadata.fingerprintConstraint }),
	});
}

function candidateLines(message: string): number[] {
	const match = message.match(/at lines ([\d, ]+)/);
	return match ? match[1].split(",").map(Number).filter(Number.isSafeInteger) : [];
}

function recoveryLineKey(line: string): string {
	return normalizeForFuzzyMatch(line).trim();
}

function findRecoveryAnchorLine(lines: readonly string[], oldText: string): number | undefined {
	const anchors = normalizeToLF(oldText)
		.split("\n")
		.map(recoveryLineKey)
		.filter((line) => line.length >= 6)
		.sort((left, right) => right.length - left.length);
	if (anchors.length === 0) return undefined;

	const normalizedLines = lines.map(recoveryLineKey);
	for (const anchor of anchors) {
		const exactIndex = normalizedLines.indexOf(anchor);
		if (exactIndex !== -1) return exactIndex + 1;
	}
	for (const anchor of anchors) {
		const partialIndex = normalizedLines.findIndex(
			(line) => line.length >= 6 && (line.includes(anchor) || anchor.includes(line)),
		);
		if (partialIndex !== -1) return partialIndex + 1;
	}
	return undefined;
}

function recoveryBlockLineCount(oldText: string): number {
	const normalized = normalizeToLF(oldText);
	const lines = normalized.split("\n");
	return Math.max(1, normalized.endsWith("\n") ? lines.length - 1 : lines.length);
}

type RecoveryWindow = { start: number; end: number };

function buildRecoveryWindows(
	totalLines: number,
	candidateLineNumbers: readonly number[],
	evidenceLine: number | undefined,
	oldText: string,
): RecoveryWindow[] {
	const lineNumbers = candidateLineNumbers.length > 0 ? candidateLineNumbers : evidenceLine ? [evidenceLine] : [];
	if (lineNumbers.length === 0) return [{ start: 0, end: Math.min(totalLines, 80) }];

	const blockLines = recoveryBlockLineCount(oldText);
	const windows = lineNumbers
		.map((lineNumber) => ({
			start: Math.max(0, lineNumber - 1 - 3),
			end: Math.min(totalLines, lineNumber - 1 + blockLines + 3),
		}))
		.sort((left, right) => left.start - right.start);
	const merged: RecoveryWindow[] = [];
	for (const window of windows) {
		const previous = merged.at(-1);
		if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
		else merged.push(window);
	}
	return merged;
}

function formatRecoveryWindows(
	lines: readonly string[],
	windows: readonly RecoveryWindow[],
): {
	text: string;
	lineCount: number;
	truncated: boolean;
} {
	const output: string[] = [];
	let lineCount = 0;
	let byteCount = 0;
	for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
		if (windowIndex > 0) output.push("…");
		for (let index = windows[windowIndex].start; index < windows[windowIndex].end; index++) {
			const rendered = `${index + 1}: ${lines[index]}`;
			const nextBytes = Buffer.byteLength(rendered, "utf8") + (output.length > 0 ? 1 : 0);
			if (lineCount >= 200 || byteCount + nextBytes > 16 * 1024) {
				return { text: output.join("\n"), lineCount, truncated: true };
			}
			output.push(rendered);
			lineCount++;
			byteCount += nextBytes;
		}
	}
	return { text: output.join("\n"), lineCount, truncated: false };
}

function attachEditRecovery(
	error: ToolExecutionError,
	absolutePath: string,
	path: string,
	ops: EditOperations,
	edits: readonly Edit[],
): ToolExecutionError {
	if (error.code !== "MATCH_NOT_FOUND" && error.code !== "MATCH_AMBIGUOUS") return error;
	return attachEditRecoveryHandler(error, async ({ signal }) => {
		if (signal?.aborted) return { type: "stop", reason: "cancelled" };
		return await withFileMutationQueue(absolutePath, async () => {
			if (signal?.aborted) return { type: "stop", reason: "cancelled" } as const;
			try {
				const lines = normalizeToLF(stripBom((await ops.readFile(absolutePath)).toString("utf-8")).text).split(
					"\n",
				);
				const failedEditIndex = getEditFailureIndex(error.message, edits);
				const candidateLineNumbers = candidateLines(error.message);
				const evidenceLine =
					candidateLineNumbers[0] ??
					(failedEditIndex === undefined
						? undefined
						: findRecoveryAnchorLine(lines, edits[failedEditIndex]?.oldText ?? ""));
				const failedOldText = failedEditIndex === undefined ? "" : (edits[failedEditIndex]?.oldText ?? "");
				const windows = buildRecoveryWindows(lines.length, candidateLineNumbers, evidenceLine, failedOldText);
				const formatted = formatRecoveryWindows(lines, windows);
				const locationNote =
					candidateLineNumbers.length > 0
						? `候选位置：${candidateLineNumbers.join(", ")}`
						: evidenceLine === undefined
							? "未定位到 oldText 的稳定上下文，以下为文件开头"
							: `定位行：${evidenceLine}`;
				const truncationNote = formatted.truncated ? "\n（上下文已截断，请使用 read 分段读取目标区域。）" : "";
				const replacementResult: ToolRecoveryReplacementResult = {
					content: [
						{
							type: "text",
							text: `${error.message}\n\n最新 ${path}（${locationNote}）：\n${formatted.text}${truncationNote}\n请基于最新内容重建本次 edits；只保留目标修改，整批确认后再提交。`,
						},
					],
					details: {
						recovery: {
							code: error.code,
							evidenceLines: formatted.lineCount,
							candidateLines: candidateLineNumbers,
							...(failedEditIndex === undefined ? {} : { failedEditIndex }),
							...(evidenceLine === undefined ? {} : { evidenceLine }),
						},
					},
				};
				return {
					type: "ask_model_to_rebuild",
					guidance: "请基于最新内容重建本次 edits，不要原样重复失败参数。",
					replacementResult,
				} as const;
			} catch {
				return undefined;
			}
		});
	});
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. In one assistant response, use only one mutation call for a file. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		getExecutionKeys: async (args) => {
			if (!args || typeof args !== "object") return [];
			const path = (args as { path?: unknown }).path;
			if (typeof path !== "string") return [];
			return [await getMutationQueueKey(resolveToCwd(path, cwd))];
		},
		constrainedSampling: getExperimentalToolSampling(),
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = resolveToCwd(path, cwd);

			try {
				return await withFileMutationQueue(absolutePath, async () => {
					// Do not reject from an abort event listener here: that would release the
					// mutation queue while an in-flight filesystem operation may still finish.
					// Checking signal.aborted after each await observes the same aborts while
					// keeping the queue locked until the current operation has settled.
					const throwIfAborted = (): void => {
						if (signal?.aborted) throw new Error("Operation aborted");
					};

					throwIfAborted();

					// Check if file exists.
					try {
						await ops.access(absolutePath);
					} catch (error: unknown) {
						throwIfAborted();
						const errorMessage =
							error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
						throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
					}
					throwIfAborted();

					// Read the file.
					const buffer = await ops.readFile(absolutePath);
					const snapshotHash = hashFileContent(buffer);
					const rawContent = buffer.toString("utf-8");
					throwIfAborted();

					// Strip BOM before matching. The model will not include an invisible BOM in oldText.
					const { bom, text: content } = stripBom(rawContent);
					const originalEnding = detectLineEnding(content);
					const normalizedContent = normalizeToLF(content);
					const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
					throwIfAborted();

					const finalContent = bom + restoreLineEndings(newContent, originalEnding);
					if (finalContent !== rawContent) {
						const currentBuffer = await ops.readFile(absolutePath);
						throwIfAborted();
						const currentHash = hashFileContent(currentBuffer);
						if (currentHash !== snapshotHash) {
							throw createWriteConflictError(path, snapshotHash, currentHash);
						}
						await ops.writeFile(absolutePath, finalContent);
						throwIfAborted();
					}

					const diffResult = generateDiffString(baseContent, newContent);
					const patch = generateUnifiedPatch(path, baseContent, newContent);
					return {
						content: [
							{
								type: "text",
								text:
									baseContent === newContent
										? `No changes needed for ${path}; the requested content is already present.`
										: `Successfully replaced ${edits.length} block(s) in ${path}.`,
							},
						],
						details: {
							diff: diffResult.diff,
							patch,
							firstChangedLine: diffResult.firstChangedLine,
							additions: diffResult.additions,
							deletions: diffResult.deletions,
						},
					};
				});
			} catch (error) {
				throw attachEditRecovery(normalizeEditFailure(error, edits), absolutePath, path, ops, edits);
			}
		},
		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
			const argsRevision = context.argsRevision;
			const argsChanged =
				!component.previewInitialized ||
				component.previewArgs !== args ||
				component.previewArgsRevision !== argsRevision;
			if (argsChanged) {
				component.preview = previewInput ? createArgumentPreview(previewInput.edits) : undefined;
				component.previewArgs = args;
				component.previewArgsRevision = argsRevision;
				component.previewInitialized = true;
				component.settledError = false;
			}

			return buildEditCallComponent(component, args, theme, context.cwd, {
				expanded: context.expanded,
				isPartial: context.isPartial,
				isError: context.isError,
			});
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const typedResult = result as EditToolResultLike;
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			let changed = false;
			if (callComponent) {
				if (typeof resultDiff === "string") {
					const fallbackStats = countRenderedDiff(resultDiff);
					changed = setEditPreview(callComponent, {
						diff: resultDiff,
						firstChangedLine: typedResult.details?.firstChangedLine,
						additions: typedResult.details?.additions ?? fallbackStats.additions,
						deletions: typedResult.details?.deletions ?? fallbackStats.deletions,
					});
					callComponent.previewInitialized = true;
				}
				if (callComponent.settledError !== context.isError) {
					callComponent.settledError = context.isError;
					changed = true;
				}
				if (changed) {
					buildEditCallComponent(
						callComponent,
						context.args as RenderableEditArgs | undefined,
						theme,
						context.cwd,
						{
							expanded: context.expanded,
							isPartial: context.isPartial,
							isError: context.isError,
						},
					);
				}
			}

			const output =
				context.isError || context.expanded
					? formatEditResult(context.args, callComponent?.preview, typedResult, theme, context.isError)
					: undefined;
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
