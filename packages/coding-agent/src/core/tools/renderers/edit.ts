/** Shared edit presentation for execution, history, and display-only clients. */
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { renderDiff } from "../../../modes/interactive/components/diff.ts";
import { formatToolSummary, getToolSummary } from "../../../modes/interactive/components/tool-summary.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { uiGlyphs } from "../../../modes/interactive/ui-glyphs.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { EditToolDetails } from "../edit.ts";
import type { Edit, EditDiffError, EditDiffResult } from "../edit-diff.ts";
import type { SnapshotRangeEdit } from "../file-edit-state.ts";
import { renderToolPath, str } from "../render-utils.ts";

type EditPreview = EditDiffResult | EditDiffError;
export type EditRenderState = { callComponent?: EditCallRenderComponent };

function isRangeEdit(value: unknown): value is SnapshotRangeEdit {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	return typeof entry.startLine === "number" && typeof entry.endLine === "number" && typeof entry.newText === "string";
}

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	snapshot?: string;
	plan?: string;
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
	previewArgsReleased?: boolean;
	previewInitialized?: boolean;
	previewFinalized?: boolean;
	resultStatus?: EditToolDetails["status"];
	alreadyApplied?: number;
	resultPath?: string;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 0, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgs: undefined as unknown,
		previewArgsRevision: undefined as number | undefined,
		previewArgsReleased: false,
		previewInitialized: false,
		previewFinalized: false,
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
const MAX_PREVIEW_PARAMETER_CHARS = 128 * 1024;
const MAX_PREVIEW_EDIT_ENTRIES = 128;

type PreviewBuffer = {
	lines: string[];
	length: number;
	truncated: boolean;
};

type PreviewEdit = Edit | SnapshotRangeEdit;

function parseRenderableEdits(value: unknown): PreviewEdit[] {
	if (Array.isArray(value)) {
		if (value.length > MAX_PREVIEW_EDIT_ENTRIES) return [];
		return value.filter((entry): entry is PreviewEdit => {
			if (isRangeEdit(entry)) return true;
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
			const historical = entry as Record<string, unknown>;
			return typeof historical.oldText === "string" && typeof historical.newText === "string";
		});
	}
	if (typeof value === "string") {
		if (value.length > MAX_PREVIEW_PARAMETER_CHARS) return [];
		try {
			return parseRenderableEdits(JSON.parse(value));
		} catch {
			return [];
		}
	}
	return value && typeof value === "object" ? parseRenderableEdits([value]) : [];
}

function getRenderablePreviewInput(
	args: RenderableEditArgs | undefined,
): { path?: string; edits: PreviewEdit[] } | null {
	if (!args) return null;
	const path =
		typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
	const edits = parseRenderableEdits(args.edits);
	if (edits.length) return { ...(path ? { path } : {}), edits };
	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { ...(path ? { path } : {}), edits: [{ oldText: args.oldText, newText: args.newText }] };
	}
	return null;
}

function boundedEditPreviewText(value: string): string {
	let end = Math.min(value.length, MAX_EDIT_PREVIEW_CHARS);
	let truncated = end < value.length;
	let lineCount = 0;
	for (let index = 0; index < end; index++) {
		if (value.charCodeAt(index) !== 10) continue;
		lineCount++;
		if (lineCount < MAX_EDIT_PREVIEW_LINES - 1) continue;
		end = index;
		truncated = true;
		break;
	}
	if (!truncated) return value;
	if (end > 0 && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
	return `${value.slice(0, end)}\n…`;
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

function createArgumentPreview(edits: PreviewEdit[]): EditDiffResult {
	const buffer: PreviewBuffer = { lines: [], length: 0, truncated: false };
	let firstChangedLine: number | undefined;
	let additions = 0;
	let deletions = 0;
	for (const edit of edits) {
		if ("oldText" in edit) {
			firstChangedLine ??= 1;
			deletions += appendPreviewLines(buffer, edit.oldText, "-", 1) - 1;
			additions += appendPreviewLines(buffer, edit.newText, "+", 1) - 1;
		} else {
			firstChangedLine ??= edit.startLine;
			if (!buffer.truncated) {
				const heading =
					edit.endLine < edit.startLine
						? `@@ insert before line ${edit.startLine} @@`
						: edit.newText.length === 0
							? `@@ delete lines ${edit.startLine}-${edit.endLine} @@`
							: `@@ read lines ${edit.startLine}-${edit.endLine} @@`;
				if (buffer.length + heading.length + 1 <= MAX_EDIT_PREVIEW_CHARS) {
					buffer.lines.push(heading);
					buffer.length += heading.length + 1;
				} else buffer.truncated = true;
			}
			deletions += Math.max(0, edit.endLine - edit.startLine + 1);
			additions += appendPreviewLines(buffer, edit.newText, "+", edit.startLine) - edit.startLine;
		}
	}
	if (buffer.truncated && buffer.length + 2 <= MAX_EDIT_PREVIEW_CHARS) buffer.lines.push("…");
	return { diff: buffer.lines.join("\n"), firstChangedLine, additions, deletions };
}

function isRenderedDiffLine(diff: string, start: number, end: number, prefix: "-" | "+"): boolean {
	if (diff[start] !== prefix) return false;
	let index = start + 1;
	while (index < end && /\s/.test(diff[index] ?? "")) index++;
	const digitStart = index;
	while (index < end && diff.charCodeAt(index) >= 48 && diff.charCodeAt(index) <= 57) index++;
	return index > digitStart && index < end && /\s/.test(diff[index] ?? "");
}

function countRenderedDiff(diff: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	let start = 0;
	while (start <= diff.length) {
		const newline = diff.indexOf("\n", start);
		const end = newline === -1 ? diff.length : newline;
		if (isRenderedDiffLine(diff, start, end, "+")) additions++;
		if (isRenderedDiffLine(diff, start, end, "-")) deletions++;
		if (newline === -1) break;
		start = newline + 1;
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
	component: EditCallRenderComponent,
): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path ?? component.resultPath), theme, cwd);
	const counts = preview && !("error" in preview) ? `+${preview.additions} -${preview.deletions}` : undefined;
	const detail = counts
		? `${component.previewFinalized ? "" : "预览 "}${counts}${component.alreadyApplied ? `，已完成 ${component.alreadyApplied} 项` : ""}`
		: undefined;
	return formatToolSummary({
		icon: uiGlyphs.edit,
		subject: pathDisplay,
		isPartial,
		isError: isError || Boolean(preview && "error" in preview),
		labels: {
			running: "正在编辑",
			success: component.resultStatus === "unchanged" ? "无需修改" : "已编辑",
			error: "编辑失败",
		},
		detail,
	});
}

function boundedResultText(content: EditToolResultLike["content"]): string {
	let text = "";
	for (const item of content) {
		if (item.type !== "text" || !item.text) continue;
		const separator = text ? "\n" : "";
		const available = MAX_EDIT_PREVIEW_CHARS - text.length - separator.length;
		if (available <= 0) break;
		text += separator + item.text.slice(0, available);
		if (item.text.length > available) break;
	}
	return text;
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path ?? result.details?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = boundedResultText(result.content);
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}

	if (result.details?.status === "unchanged") {
		return result.details.alreadyApplied
			? `已验证 ${result.details.alreadyApplied} 项已经完成，无需再次写入。`
			: "目标内容与修改一致，无需写入。";
	}
	const resultDiff = result.details?.diff;
	const displayResultDiff = typeof resultDiff === "string" ? boundedEditPreviewText(resultDiff) : undefined;
	if (displayResultDiff && displayResultDiff !== previewDiff) {
		return renderDiff(displayResultDiff, { filePath: rawPath ?? undefined });
	}

	return undefined;
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
	options: { expanded: boolean; isPartial: boolean; isError: boolean; outputPad: number },
): EditCallRenderComponent {
	const previewIsError = component.preview && "error" in component.preview;
	const showPreview = !options.isError && (options.expanded || Boolean(previewIsError));
	component.setBgFn((text) => text);
	component.setPaddingX(options.outputPad);
	component.clear();
	const summary = getToolSummary(undefined);
	summary.setText(formatEditCall(args, component.preview, theme, cwd, options.isPartial, options.isError, component));
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

export const editRenderers: Pick<ToolDefinition, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const component = getEditCallRenderComponent(context.state, context.lastComponent);
		const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
		const argsRevision = context.argsRevision;
		const argsChanged =
			!component.previewInitialized ||
			(!component.previewArgsReleased && component.previewArgs !== args) ||
			component.previewArgsRevision !== argsRevision;
		if (argsChanged) {
			component.preview = previewInput ? createArgumentPreview(previewInput.edits) : undefined;
			component.previewArgs = args;
			component.previewArgsRevision = argsRevision;
			component.previewArgsReleased = false;
			component.previewInitialized = true;
			component.previewFinalized = false;
			component.resultStatus = undefined;
			component.alreadyApplied = undefined;
			component.resultPath = undefined;
			component.settledError = false;
		}

		return buildEditCallComponent(component, args as RenderableEditArgs | undefined, theme, context.cwd, {
			expanded: context.expanded,
			isPartial: context.isPartial,
			isError: context.isError,
			outputPad: context.outputPad,
		});
	},
	renderResult(result, _options, theme, context) {
		const callComponent = context.state.callComponent;
		const typedResult = result as EditToolResultLike;
		const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
		let changed = false;
		if (callComponent && !context.preserveCallRenderer) {
			if (
				callComponent.resultStatus !== typedResult.details?.status ||
				callComponent.alreadyApplied !== typedResult.details?.alreadyApplied ||
				callComponent.resultPath !== typedResult.details?.path
			)
				changed = true;
			callComponent.resultStatus = typedResult.details?.status;
			callComponent.alreadyApplied = typedResult.details?.alreadyApplied;
			callComponent.resultPath = typedResult.details?.path;
			callComponent.previewFinalized = true;
			if (context.isError && callComponent.preview) {
				callComponent.preview = undefined;
				changed = true;
			}
			if (typeof resultDiff === "string") {
				const fallbackStats = countRenderedDiff(resultDiff);
				changed =
					setEditPreview(callComponent, {
						diff: resultDiff,
						firstChangedLine: typedResult.details?.firstChangedLine,
						additions: typedResult.details?.additions ?? fallbackStats.additions,
						deletions: typedResult.details?.deletions ?? fallbackStats.deletions,
					}) || changed;
				callComponent.previewInitialized = true;
			}
			if (callComponent.settledError !== context.isError) {
				callComponent.settledError = context.isError;
				changed = true;
			}
			if (changed) {
				buildEditCallComponent(callComponent, context.args as RenderableEditArgs | undefined, theme, context.cwd, {
					expanded: context.expanded,
					isPartial: context.isPartial,
					isError: context.isError,
					outputPad: context.outputPad,
				});
			}
			callComponent.previewArgs = undefined;
			callComponent.previewArgsReleased = true;
		}

		const output =
			context.isError || context.expanded
				? formatEditResult(
						context.args as RenderableEditArgs | undefined,
						callComponent?.preview,
						typedResult,
						theme,
						context.isError,
					)
				: undefined;
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		if (!output) {
			return component;
		}
		component.addChild(new Spacer(1));
		component.addChild(new Text(output, context.outputPad, 0));
		return component;
	},
};
