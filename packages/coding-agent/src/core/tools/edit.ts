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
	computeEditsDiff,
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
		"In one assistant response, use only one mutation call per file; merge all edits for that file into one edits[] or one patch.",
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
	edits?: Edit[];
	oldText?: string;
	newText?: string;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 0, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
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

function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) {
		return null;
	}

	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) {
		return null;
	}

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		return { path, edits: args.edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
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
		return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
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

function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
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
				const evidenceLine =
					candidateLines(error.message)[0] ??
					(failedEditIndex === undefined
						? undefined
						: findRecoveryAnchorLine(lines, edits[failedEditIndex]?.oldText ?? ""));
				const hasLocatedContext = evidenceLine !== undefined;
				const start = hasLocatedContext ? Math.max(0, evidenceLine - 1 - 25) : 0;
				const limit = hasLocatedContext ? 200 : 80;
				const excerpt = lines.slice(start, start + limit);
				const locationNote = hasLocatedContext ? "" : "（未定位到 oldText 的稳定上下文，以下为文件开头）";
				const replacementResult: ToolRecoveryReplacementResult = {
					content: [
						{
							type: "text",
							text: `${error.message}\n\n最新 ${path} 第 ${start + 1}-${start + excerpt.length} 行${locationNote}：\n${excerpt.map((line, index) => `${start + index + 1}: ${line}`).join("\n")}\n请基于最新内容重建 oldText。`,
						},
					],
					details: {
						recovery: {
							code: error.code,
							evidenceLines: excerpt.length,
							...(failedEditIndex === undefined ? {} : { failedEditIndex }),
							...(evidenceLine === undefined ? {} : { evidenceLine }),
						},
					},
				};
				return {
					type: "ask_model_to_rebuild",
					guidance: "请基于最新内容重建 oldText。",
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
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;

			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
				component.previewPending = true;
				const requestKey = argsKey;
				void computeEditsDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
					if (component.previewArgsKey === requestKey) {
						setEditPreview(component, preview, requestKey);
						context.invalidate();
					}
				});
			}

			return buildEditCallComponent(component, args, theme, context.cwd, {
				expanded: context.expanded,
				isPartial: context.isPartial,
				isError: context.isError,
			});
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;
			const typedResult = result as EditToolResultLike;
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			let changed = false;
			if (callComponent) {
				if (typeof resultDiff === "string") {
					const fallbackStats = countRenderedDiff(resultDiff);
					changed =
						setEditPreview(
							callComponent,
							{
								diff: resultDiff,
								firstChangedLine: typedResult.details?.firstChangedLine,
								additions: typedResult.details?.additions ?? fallbackStats.additions,
								deletions: typedResult.details?.deletions ?? fallbackStats.deletions,
							},
							argsKey,
						) || changed;
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
