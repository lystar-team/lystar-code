import type { SessionProgress, ToolDiff } from "@lystar/code-gui-protocol";

const MAX_PROGRESS_TEXT_CHARS = 16 * 1024;
const MAX_PROGRESS_DIFF_LINES = 120;
const MAX_PREVIEW_PARAMETER_CHARS = 128 * 1024;
const MAX_PREVIEW_EDIT_ENTRIES = 128;

export function toolRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function toolPath(value: unknown): string | undefined {
	const record = toolRecord(value);
	const path = record?.path ?? record?.file_path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

function toolNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundedDiffText(value: string): { text: string; truncated?: boolean } {
	let end = Math.min(value.length, MAX_PROGRESS_TEXT_CHARS);
	let truncated = end < value.length;
	let lineCount = 0;
	for (let index = 0; index < end; index++) {
		if (value.charCodeAt(index) !== 10) continue;
		lineCount++;
		if (lineCount < MAX_PROGRESS_DIFF_LINES - 1) continue;
		end = index;
		truncated = true;
		break;
	}
	if (!truncated) return { text: value };
	if (end > 0 && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
	return { text: value.slice(0, end), truncated: true };
}

type PreviewBuffer = {
	lines: string[];
	length: number;
	truncated: boolean;
};

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

function appendPrefixedLines(buffer: PreviewBuffer, text: string, prefix: string): number {
	let lineCount = 0;
	forEachTextLine(text, (source, start, end) => {
		lineCount++;
		if (buffer.truncated) return;
		if (buffer.lines.length >= MAX_PROGRESS_DIFF_LINES - 1) {
			buffer.truncated = true;
			return;
		}
		const separatorLength = buffer.lines.length > 0 ? 1 : 0;
		const available = MAX_PROGRESS_TEXT_CHARS - buffer.length - separatorLength;
		if (available <= prefix.length) {
			buffer.truncated = true;
			return;
		}
		const contentLength = Math.min(end - start, available - prefix.length);
		buffer.lines.push(`${prefix}${source.slice(start, start + contentLength)}`);
		buffer.length += separatorLength + prefix.length + contentLength;
		if (contentLength < end - start) buffer.truncated = true;
	});
	return lineCount;
}

function finishPreview(buffer: PreviewBuffer): { text: string; truncated?: boolean } {
	return { text: buffer.lines.join("\n"), ...(buffer.truncated ? { truncated: true } : {}) };
}

function createPrefixedPreview(
	value: string,
	prefix: string,
): { preview: { text: string; truncated?: boolean }; lines: number } {
	const buffer: PreviewBuffer = { lines: [], length: 0, truncated: false };
	const lines = appendPrefixedLines(buffer, value, prefix);
	return { preview: finishPreview(buffer), lines };
}

function countPatchLines(value: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	forEachTextLine(value, (source, start) => {
		const first = source.charCodeAt(start);
		const second = source.charCodeAt(start + 1);
		const third = source.charCodeAt(start + 2);
		if (first === 43 && second === 43 && third === 43) return;
		if (first === 45 && second === 45 && third === 45) return;
		if (first === 43) additions++;
		if (first === 45) deletions++;
	});
	return { additions, deletions };
}

function boundedText(value: string): { text: string; truncated?: boolean } {
	if (value.length <= MAX_PROGRESS_TEXT_CHARS) return { text: value };
	let end = MAX_PROGRESS_TEXT_CHARS;
	if (
		end > 0 &&
		value.charCodeAt(end - 1) >= 0xd800 &&
		value.charCodeAt(end - 1) <= 0xdbff &&
		value.charCodeAt(end) >= 0xdc00 &&
		value.charCodeAt(end) <= 0xdfff
	) {
		end--;
	}
	return { text: value.slice(0, end), truncated: true };
}

function editEntries(value: Record<string, unknown> | undefined): Array<{ oldText: string; newText: string }> {
	if (!value) return [];
	const edits = value.edits;
	if (Array.isArray(edits)) {
		if (edits.length > MAX_PREVIEW_EDIT_ENTRIES) return [];
		const entries: Array<{ oldText: string; newText: string }> = [];
		for (const entry of edits) {
			const item = toolRecord(entry);
			if (typeof item?.oldText === "string" && typeof item.newText === "string") {
				entries.push({ oldText: item.oldText, newText: item.newText });
			}
		}
		return entries;
	}
	if (typeof edits === "string") {
		if (edits.length > MAX_PREVIEW_PARAMETER_CHARS) return [];
		try {
			const parsed = JSON.parse(edits) as unknown;
			if (Array.isArray(parsed)) return editEntries({ edits: parsed });
			return editEntries({ edits: [parsed] });
		} catch {
			return [];
		}
	}
	return typeof value.oldText === "string" && typeof value.newText === "string"
		? [{ oldText: value.oldText, newText: value.newText }]
		: [];
}

function previewWriteDiff(path: string | undefined, args: Record<string, unknown>): ToolDiff | undefined {
	const content = args.content;
	if (typeof content !== "string") return path ? { files: [{ path }] } : undefined;
	const preview = createPrefixedPreview(content, "+");
	return {
		files: [
			{
				...(path ? { path } : {}),
				additions: preview.lines,
				deletions: 0,
				...(preview.preview.text ? { diff: preview.preview.text } : {}),
				...(preview.preview.truncated ? { truncated: true } : {}),
			},
		],
	};
}

function previewEditDiff(path: string | undefined, args: Record<string, unknown>): ToolDiff | undefined {
	const edits = editEntries(args);
	if (edits.length === 0) return path ? { files: [{ path }] } : undefined;

	const buffer: PreviewBuffer = { lines: [], length: 0, truncated: false };
	const deletions = edits.reduce((total, edit) => total + appendPrefixedLines(buffer, edit.oldText, "-"), 0);
	const additions = edits.reduce((total, edit) => total + appendPrefixedLines(buffer, edit.newText, "+"), 0);
	const preview = finishPreview(buffer);
	return {
		files: [
			{
				...(path ? { path } : {}),
				additions,
				deletions,
				...(preview.text ? { diff: preview.text } : {}),
				...(preview.truncated ? { truncated: true } : {}),
			},
		],
	};
}

function previewPatchDiff(args: Record<string, unknown>): ToolDiff | undefined {
	if (typeof args.input !== "string") return undefined;
	const input = args.input;
	const { additions, deletions } = countPatchLines(input);
	const preview = boundedDiffText(input);
	return {
		files: [
			{
				additions,
				deletions,
				...(preview.text ? { diff: preview.text } : {}),
				...(preview.truncated ? { truncated: true } : {}),
			},
		],
	};
}

export function isDiffTool(name: string): boolean {
	return name === "edit" || name === "write" || name === "apply_patch";
}

export function toolProgressDiff(name: string, args: unknown, result?: unknown): ToolDiff | undefined {
	if (!isDiffTool(name)) return undefined;
	const details = toolRecord(toolRecord(result)?.details);
	if (!details) {
		const input = toolRecord(args);
		if (name === "write") return previewWriteDiff(toolPath(args), input ?? {});
		if (name === "edit") return previewEditDiff(toolPath(args), input ?? {});
		return previewPatchDiff(input ?? {});
	}

	if (name === "apply_patch") {
		if (!Array.isArray(details.files)) return undefined;
		const files = details.files.flatMap((value) => {
			const file = toolRecord(value);
			if (!file) return [];
			const preview = typeof file.diff === "string" ? boundedText(file.diff) : undefined;
			const path = toolPath(file);
			const additions = toolNumber(file.additions);
			const deletions = toolNumber(file.deletions);
			const operation = typeof file.operation === "string" ? file.operation : undefined;
			if (!path && additions === undefined && deletions === undefined && !preview?.text) return [];
			return [
				{
					...(path ? { path } : {}),
					...(operation ? { operation } : {}),
					...(additions === undefined ? {} : { additions }),
					...(deletions === undefined ? {} : { deletions }),
					...(preview?.text === undefined ? {} : { diff: preview.text }),
					...(preview?.truncated ? { truncated: true } : {}),
				},
			];
		});
		return files.length > 0 ? { files } : undefined;
	}

	const path = toolPath(args);
	const additions = toolNumber(details.additions);
	const deletions = toolNumber(details.deletions);
	const operation = typeof details.operation === "string" ? details.operation : undefined;
	const preview = typeof details.diff === "string" ? boundedText(details.diff) : undefined;
	if (!path && additions === undefined && deletions === undefined && !operation && !preview?.text) return undefined;
	return {
		files: [
			{
				...(path ? { path } : {}),
				...(operation ? { operation } : {}),
				...(additions === undefined ? {} : { additions }),
				...(deletions === undefined ? {} : { deletions }),
				...(preview?.text === undefined ? {} : { diff: preview.text }),
				...(preview?.truncated ? { truncated: true } : {}),
			},
		],
	};
}

export function toolCallUpdate(toolCallId: string, name: string, summary: string, args: unknown): SessionProgress {
	const diff = toolProgressDiff(name, args);
	return {
		type: "tool_update",
		toolCallId,
		name,
		summary,
		...(diff ? { diff } : {}),
	};
}
