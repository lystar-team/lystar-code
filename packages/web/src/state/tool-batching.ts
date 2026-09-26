import { webSearchProgressSummary } from "@lystar/code-web-protocol";
import type { WebSearchProgress } from "@lystar/code-web-protocol";

export interface ToolBatchDescriptor {
	name: string;
	summary: string;
}

function parseToolSummary(summary: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(summary);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function skillNameFromPath(path: string): string | undefined {
	let normalizedPath = path.split(/[?#]/u, 1)[0] ?? path;
	try {
		normalizedPath = decodeURIComponent(normalizedPath);
	} catch {
		// 路径不是 URL 编码时继续使用原始值。
	}
	normalizedPath = normalizedPath.replaceAll("\\", "/");
	const segments = normalizedPath.split("/").filter(Boolean);
	const skillDirectoryIndex = segments.findIndex((segment) => segment.toLowerCase() === "skills");
	if (skillDirectoryIndex < 0 || skillDirectoryIndex !== segments.length - 3) return undefined;
	if (segments.at(-1)?.toLowerCase() !== "skill.md") return undefined;
	return segments.at(-2);
}

export function skillNameFromTool(tool: ToolBatchDescriptor): string | undefined {
	if (tool.name !== "read") return undefined;
	const parsed = parseToolSummary(tool.summary);
	for (const key of ["path", "file_path", "filename", "url"]) {
		if (typeof parsed?.[key] === "string") return skillNameFromPath(parsed[key]);
	}
	return skillNameFromPath(tool.summary);
}

export function mergeWebSearchSummary(previous: string | undefined, next: string | undefined): string {
	const nextSummary = next?.trim();
	if (nextSummary && nextSummary !== "网页搜索") return nextSummary;
	return previous?.trim() || nextSummary || "网页搜索";
}

export function mergeWebSearchToolSummary(
	previous: string | undefined,
	next: string | undefined,
	progress: WebSearchProgress | undefined,
): string {
	const structured = webSearchProgressSummary(progress);
	return mergeWebSearchSummary(previous, structured === "网页搜索" ? next : structured);
}

export function mergeImageGenerationSummary(previous: string | undefined, next: string | undefined): string {
	const incomingPrompt = parseToolSummary(next ?? "")?.prompt;
	if (typeof incomingPrompt === "string" && incomingPrompt.trim()) return next ?? "";
	const previousPrompt = parseToolSummary(previous ?? "")?.prompt;
	if (typeof previousPrompt === "string" && previousPrompt.trim()) return previous ?? "";
	return next || previous || "image_gen";
}

export function shouldJoinToolBatch(
	previousTool: ToolBatchDescriptor | undefined,
	nextTool: ToolBatchDescriptor,
): boolean {
	if (!previousTool || skillNameFromTool(previousTool) || skillNameFromTool(nextTool)) return false;
	return (
		(previousTool.name === "bash" && nextTool.name === "bash") ||
		(previousTool.name === "read" && nextTool.name === "read") ||
		(previousTool.name === "web_search" && nextTool.name === "web_search")
	);
}

export function shouldJoinLiveToolBatch(
	previousTool: ToolBatchDescriptor | undefined,
	nextTool: ToolBatchDescriptor,
	previousTurnId: number | undefined,
	currentTurnId: number,
): boolean {
	return previousTurnId === currentTurnId && shouldJoinToolBatch(previousTool, nextTool);
}
