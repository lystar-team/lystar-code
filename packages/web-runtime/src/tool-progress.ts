import {
	toolProgressDiff as inputProgressDiff,
	isDiffTool,
	toolPath,
	toolRecord,
} from "@earendil-works/pi-coding-agent/core";
import type { SessionProgress, ToolDiff } from "@lystar/code-web-protocol";

export { isDiffTool, toolPath, toolRecord };

const MAX_PROGRESS_TEXT_CHARS = 16 * 1024;

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

export function toolProgressDiff(name: string, args: unknown, result?: unknown): ToolDiff | undefined {
	if (!isDiffTool(name)) return undefined;
	const details = toolRecord(toolRecord(result)?.details);
	if (!details) return inputProgressDiff(name, args);

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

	const path = toolPath(args) ?? toolPath(details);
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

export function toolCallUpdate(
	toolCallId: string,
	name: string,
	summary: string,
	args: unknown,
	includeDiff = true,
): SessionProgress {
	const diff = includeDiff ? toolProgressDiff(name, args) : undefined;
	return {
		type: "tool_update",
		toolCallId,
		name,
		summary,
		...(diff ? { diff } : {}),
	};
}
