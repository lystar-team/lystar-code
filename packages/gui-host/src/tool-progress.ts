import type { SessionProgress, ToolDiff } from "@lystar/code-gui-protocol";

const MAX_PROGRESS_TEXT_CHARS = 16 * 1024;

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

function countLines(value: string): number {
	if (!value) return 0;
	const normalized = value.replace(/\r\n?/g, "\n");
	return normalized.endsWith("\n") ? normalized.split("\n").length - 1 : normalized.split("\n").length;
}

function prefixLines(value: string, prefix: string): string {
	const normalized = value.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.map((line) => `${prefix}${line}`).join("\n");
}

function editEntries(value: Record<string, unknown> | undefined): Array<{ oldText: string; newText: string }> {
	if (!value) return [];
	const edits = value.edits;
	if (Array.isArray(edits)) {
		return edits.flatMap((entry) => {
			const item = toolRecord(entry);
			return typeof item?.oldText === "string" && typeof item.newText === "string"
				? [{ oldText: item.oldText, newText: item.newText }]
				: [];
		});
	}
	if (typeof edits === "string") {
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
	const preview = boundedText(prefixLines(content, "+"));
	return {
		files: [
			{
				...(path ? { path } : {}),
				additions: countLines(content),
				deletions: 0,
				...(preview.text ? { diff: preview.text } : {}),
				...(preview.truncated ? { truncated: true } : {}),
			},
		],
	};
}

function previewEditDiff(path: string | undefined, args: Record<string, unknown>): ToolDiff | undefined {
	const edits = editEntries(args);
	if (edits.length === 0) return path ? { files: [{ path }] } : undefined;

	let additions = 0;
	let deletions = 0;
	const lines: string[] = [];
	for (const edit of edits) {
		deletions += countLines(edit.oldText);
		additions += countLines(edit.newText);
		const removed = prefixLines(edit.oldText, "-");
		const added = prefixLines(edit.newText, "+");
		if (removed) lines.push(removed);
		if (added) lines.push(added);
	}
	const preview = boundedText(lines.join("\n"));
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
	const input = args.input.replace(/\r\n?/g, "\n");
	let additions = 0;
	let deletions = 0;
	for (const line of input.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) additions++;
		if (line.startsWith("-")) deletions++;
	}
	const preview = boundedText(input);
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
