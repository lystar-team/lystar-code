"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import type { ToolDiff, WebSearchProgress } from "@lystar/code-web-protocol";
import {
	BotIcon,
	CheckCircleIcon,
	ChevronDownIcon,
	Code2Icon,
	ExternalLinkIcon,
	EyeIcon,
	FileCode2Icon,
	FileTextIcon,
	FolderIcon,
	GitBranchIcon,
	ImagesIcon,
	LoaderCircleIcon,
	PackageIcon,
	PencilIcon,
	SearchIcon,
	SparklesIcon,
	TerminalIcon,
	WrenchIcon,
	XCircleIcon,
} from "lucide-react";
import { type MouseEvent as ReactMouseEvent, type ReactNode, memo, useEffect, useRef, useState } from "react";
import type { BundledLanguage } from "shiki";
import { cn } from "@/lib/utils";
import { toCodemodeToolViewModel } from "../../adapters/codemode-tool-view-model.ts";
import { readSourcePresentation } from "../../adapters/read-source-presentation.ts";
import type { ToolBatchState, ToolBatchTool } from "../../types.ts";
import { StabilityBoundary } from "../stability-boundary";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { GsapCollapsibleContent } from "../ui/gsap-collapsible-content";
import { CodeBlock, CodeBlockActions, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from "./code-block";
import { Button } from "../ui/button";
import {
	ResourceImage,
	ResourceImageGallery,
	ResourceImageViewer,
	type ResourceImageGenerationMetadata,
	type ResourceImageItem,
	useResourceImageSource,
} from "./resource-preview";
import { ImageGeneration, type ImageGenerationStatus } from "../agents/image-generation";
import {
	isSessionTool,
	sessionToolActivityLabel,
	sessionToolSessionId,
	sessionToolTask,
	skillNameFromTool,
} from "../../state/tool-batching";
import { languageForPath } from "../../lib/file-language.ts";
import { commandPresentation } from "./command-presentation";
import { commandFromToolSummary, filePathFromTool, toolPresentationContext, toolPresentationTitle } from "./tool-presentation.ts";
import { Source } from "./sources";
import { CodemodeToolDetail } from "./codemode-tool";
import { SessionCollaborationToolDetail } from "./session-collaboration-tool";

export type ToolBatchAutoCollapse = boolean | (() => boolean);

function webSearchSources(tool: ToolBatchTool): readonly { url: string; title?: string }[] {
	return tool.sources ?? tool.webSearch?.sources ?? [];
}

export interface ToolBatchProps {
	tools: ToolBatchTool[];
	className?: string;
	initialOpen?: boolean;
	summaryLabel?: string;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	toolOpen?: ReadonlyMap<string, boolean>;
	initialToolOpen?: ReadonlyMap<string, boolean>;
	onToolOpenChange?: (toolId: string, open: boolean) => void;
	autoCollapseWhenComplete?: ToolBatchAutoCollapse;
	sessionId?: string;
	onOpenPath?: (path: string) => void;
	onOpenSubagent?: (agentId: string) => void;
	onOpenSession?: (sessionId: string) => void;
}

function resolveAutoCollapse(value: ToolBatchAutoCollapse): boolean {
	return typeof value === "function" ? value() : value;
}

function transcriptAnchorKey(tool: ToolBatchTool): string {
	let hash = 2166136261;
	for (const character of `${tool.name}:${tool.id}`) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return `tool:${(hash >>> 0).toString(36)}`;
}

function canCollapseFromContent(event: ReactMouseEvent<HTMLElement>): boolean {
	if (event.defaultPrevented) return false;
	const target = event.target;
	if (target instanceof Element && target.closest("button, a, input, textarea, select, summary, details, [role=button], [role=tab]")) return false;
	const selection = window.getSelection();
	return !selection || selection.isCollapsed;
}

type AnsiStyleState = {
	foreground?: string;
	background?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
};

const ANSI_COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

function ansiColorClass(code: number, background: boolean): string | undefined {
	const base = background ? (code >= 100 ? 100 : 40) : code >= 90 ? 90 : 30;
	const color = ANSI_COLORS[code - base];
	if (!color) return undefined;
	const bright = code >= 90;
	return `ansi-${bright ? "bright-" : ""}${color}-${background ? "bg" : "fg"}`;
}

function applyAnsiCodes(current: AnsiStyleState, codes: readonly number[]): AnsiStyleState {
	let next = { ...current };
	for (const code of codes) {
		if (code === 0) next = {};
		else if (code === 1) next.bold = true;
		else if (code === 2) next.dim = true;
		else if (code === 3) next.italic = true;
		else if (code === 4) next.underline = true;
		else if (code === 9) next.strikethrough = true;
		else if (code === 22) {
			delete next.bold;
			delete next.dim;
		} else if (code === 23) delete next.italic;
		else if (code === 24) delete next.underline;
		else if (code === 29) delete next.strikethrough;
		else if (code === 39) delete next.foreground;
		else if (code === 49) delete next.background;
		else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) next.foreground = ansiColorClass(code, false);
		else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) next.background = ansiColorClass(code, true);
	}
	return next;
}

function ansiStyleClassName(style: AnsiStyleState): string | undefined {
	return cn(
		style.foreground,
		style.background,
		style.bold && "ansi-bold",
		style.dim && "ansi-dim",
		style.italic && "ansi-italic",
		style.underline && "ansi-underline",
		style.strikethrough && "ansi-strikethrough",
	);
}

function AnsiOutput({ children }: { children: string }) {
	const nodes: ReactNode[] = [];
	const pattern = /\u001b\[([0-9;]*)m/gu;
	let style: AnsiStyleState = {};
	let cursor = 0;
	for (const match of children.matchAll(pattern)) {
		const index = match.index;
		if (index > cursor) nodes.push(<span className={ansiStyleClassName(style)} key={`text-${cursor}`}>{children.slice(cursor, index)}</span>);
		const codes = (match[1] || "0").split(";").map((value) => Number(value || 0));
		style = applyAnsiCodes(style, codes);
		cursor = index + match[0].length;
	}
	if (cursor < children.length) nodes.push(<span className={ansiStyleClassName(style)} key={`text-${cursor}`}>{children.slice(cursor)}</span>);
	return <code>{nodes}</code>;
}

const statusLabels: Record<ToolBatchState, string> = {
	"input-available": "运行中",
	"input-queued": "已排队",
	"output-available": "已完成",
	"output-error": "出错",
	"output-cancelled": "已取消",
	"output-interrupted": "已中断",
};


const commandIcons = {
	search: SearchIcon,
	folder: FolderIcon,
	file: FileTextIcon,
	git: GitBranchIcon,
	script: PackageIcon,
	terminal: TerminalIcon,
} as const;

function toolIcon(name: string, className?: string, skill = false, images = false, command?: string): ReactNode {
	const Icon = name === "codemode"
		? Code2Icon
		: images
		? ImagesIcon
		: skill
			? SparklesIcon
			: name === "bash"
				? commandIcons[commandPresentation(command ?? "").icon]
				: name === "edit" || name === "write" || name === "apply_patch"
					? PencilIcon
					: name === "read"
						? FileTextIcon
						: name === "find" || name === "grep" || name === "web_search"
							? SearchIcon
								: isSessionTool(name)
									? BotIcon
								: name === "ls"
									? FolderIcon
									: WrenchIcon;
	return <Icon className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

// Bash 执行时保留动作图标，运行状态由旁边的进度图标表示。
function toolLeadingIcon(state: ToolBatchState, name: string, skill = false, images = false, command?: string): ReactNode {
	if (state === "input-available" && name === "read")
		return <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />;
	return toolIcon(name, undefined, skill, images, command);
}

function toolStatusIndicator(state: ToolBatchState): ReactNode {
	if (state === "input-queued") return <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />;
	if (state === "output-error" || state === "output-cancelled" || state === "output-interrupted")
		return <span role="img" aria-label={statusLabels[state]} className="size-1.5 shrink-0 rounded-full bg-destructive" />;
	return null;
}

function batchState(tools: readonly ToolBatchTool[]): ToolBatchState {
	if (tools.some((tool) => tool.state === "input-available")) return "input-available";
	if (tools.some((tool) => tool.state === "input-queued")) return "input-queued";
	if (tools.some((tool) => tool.state === "output-error")) return "output-error";
	if (tools.some((tool) => tool.state === "output-interrupted")) return "output-interrupted";
	if (tools.some((tool) => tool.state === "output-cancelled")) return "output-cancelled";
	return "output-available";
}

function isToolComplete(tool: ToolBatchTool): boolean {
	return (
		tool.state === "output-available" ||
		tool.state === "output-error" ||
		tool.state === "output-cancelled" ||
		tool.state === "output-interrupted"
	);
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

function webSearchTitle(summary: string, webSearch?: WebSearchProgress): string {
	if (webSearch?.action === "search" && webSearch.query?.trim()) return webSearch.query.trim();
	if (webSearch?.action === "open_page" && webSearch.url) return `打开 ${webSearch.url}`;
	if (webSearch?.action === "find_in_page" && webSearch.pattern?.trim()) return `查找 ${webSearch.pattern.trim()}`;
	if (webSearch?.action === "find_in_page" && webSearch.url) return `查找 ${webSearch.url}`;
	const parsed = parseToolSummary(summary);
	if (parsed?.type === "webSearchCall") {
		const action =
			parsed.action && typeof parsed.action === "object" && !Array.isArray(parsed.action)
				? (parsed.action as Record<string, unknown>)
				: undefined;
		if (action?.type === "search") {
				if (typeof action.query === "string" && action.query.trim().length > 0) return action.query.trim();
				if (Array.isArray(action.queries)) {
					const query = action.queries.find((value): value is string => typeof value === "string" && value.trim().length > 0);
					if (query) return query.trim();
				}
				return "网页搜索";
			}
			if (action?.type === "open_page") return typeof action.url === "string" ? `打开 ${action.url}` : "打开网页";
			if (action?.type === "find_in_page") return typeof action.url === "string" ? `查找 ${action.url}` : "查找网页内容";
		return "网页搜索";
	}
	return summary || "网页搜索";
}

function webSearchDetail(summary: string, webSearch?: WebSearchProgress): { label: string; value: string } | undefined {
	if (webSearch?.action === "search" && webSearch.query?.trim()) return { label: "搜索内容", value: webSearch.query.trim() };
	if (webSearch?.action === "open_page" && webSearch.url) return { label: "打开网页", value: webSearch.url };
	if (webSearch?.action === "find_in_page" && webSearch.pattern?.trim()) return { label: "查找内容", value: webSearch.pattern.trim() };
	if (webSearch?.action === "find_in_page" && webSearch.url) return { label: "查找网页内容", value: webSearch.url };
	const parsed = parseToolSummary(summary);
	if (parsed?.type === "webSearchCall") {
		const action =
			parsed.action && typeof parsed.action === "object" && !Array.isArray(parsed.action)
				? (parsed.action as Record<string, unknown>)
				: undefined;
		if (action?.type === "search") {
			const query =
				typeof action.query === "string" && action.query.trim().length > 0
					? action.query.trim()
					: Array.isArray(action.queries)
						? action.queries.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim()
						: undefined;
			return query ? { label: "搜索内容", value: query } : undefined;
		}
		if (action?.type === "open_page" && typeof action.url === "string") return { label: "打开网页", value: action.url };
		if (action?.type === "find_in_page" && typeof action.url === "string") return { label: "查找网页内容", value: action.url };
	}
	const value = summary.trim();
	return value && value !== "网页搜索" ? { label: "搜索内容", value } : undefined;
}

function toolTitle(tool: ToolBatchTool): string {
	if (tool.name === "web_search") return webSearchTitle(tool.summary, tool.webSearch);
	if (isSessionTool(tool.name)) return sessionToolTask(tool.summary) ?? "智能体协作";
	if (tool.name === "read" || tool.name === "edit" || tool.name === "write") {
		const path = filePathFromTool(tool);
		if (path) return path;
	}
	const parsed = parseToolSummary(tool.summary);
	if (tool.name === "image_gen" && typeof parsed?.prompt === "string") return parsed.prompt;
	if (typeof parsed?.command === "string") return parsed.command;
	for (const key of ["path", "file_path", "filename", "url"]) {
		if (typeof parsed?.[key] === "string") return parsed[key] as string;
	}
	if (tool.name === "grep" && typeof parsed?.pattern === "string") {
		return [parsed.pattern, typeof parsed.path === "string" ? parsed.path : undefined].filter(Boolean).join(" · ");
	}
	if (tool.diff?.files[0]?.path) return tool.diff.files[0].path;
	if ((tool.name === "read" || tool.name === "edit" || tool.name === "write") && tool.summary === tool.name)
		return tool.name === "edit" && tool.preparing ? "文件" : tool.preparing ? "文件路径尚未返回" : "文件路径未记录";
	return tool.summary || tool.name;
}

function codeLanguageForPath(path: string): BundledLanguage {
	return languageForPath(path) as BundledLanguage;
}

function toolRowActionLabel(name: string, state: ToolBatchState): string {
	if (name !== "read") return name === "write" ? "写入" : name === "apply_patch" ? "应用补丁" : "编辑";
	if (state === "input-available") return "正在读取";
	if (state === "input-queued") return "已排队";
	return "已读取";
}

export function toolRowTitle(tool: ToolBatchTool): string {
	if (tool.name !== "read") return toolPresentationTitle(tool);
	if (tool.images?.length) return `已查看 ${tool.images.length} 张图像`;
	const skillName = skillNameFromTool(tool);
	if (skillName && tool.state === "output-available") return `已加载 ${skillName} 技能`;
	const title = toolTitle(tool);
	const action = toolRowActionLabel(tool.name, tool.state);
	const namedFile = parseToolSummary(tool.summary)?.path === title;
	return title && (title !== tool.name || namedFile) ? `${action} ${title}` : action;
}

export function toolBatchSummaryLabel(tools: readonly ToolBatchTool[]): string {
	if (!tools.length) return "工具记录";
	const imageCount = tools.reduce((count, tool) => count + (tool.images?.length ?? 0), 0);
	if (imageCount > 0 && tools.some((tool) => tool.name === "image_gen")) return `已生成 ${imageCount} 张图片`;
	if (imageCount > 0) return `已查看 ${imageCount} 张图像`;
	if (tools.every((tool) => tool.name === "read")) return toolActivityBatchLabel(tools, "read");
	if (tools.every((tool) => tool.name === "edit" || tool.name === "write" || tool.name === "apply_patch")) return toolActivityBatchLabel(tools, "mutation");
	const titles = [...new Set(tools.map(toolRowTitle))];
	return tools.length === 1 ? titles[0] ?? "工具记录" : `${titles.slice(0, 2).join("、")}${titles.length > 2 ? "等" : ""} ${tools.length} 项`;
}

function hasVisibleDiff(diff?: ToolDiff): boolean {
	return Boolean(diff?.files.some((file) => file.diff));
}

function isActiveFileChange(tool: ToolBatchTool): boolean {
	return (
		(tool.name === "edit" || tool.name === "write" || tool.name === "apply_patch") &&
		(tool.state === "input-available" || tool.state === "input-queued")
	);
}

function visibleToolDetail(tool: ToolBatchTool): string | undefined {
	return isActiveFileChange(tool) && tool.detail === tool.summary ? undefined : tool.detail;
}

function diffStats(diff?: ToolDiff): { additions: number; deletions: number } | undefined {
	if (!diff) return undefined;
	const stats = diff.files.reduce<{ additions: number; deletions: number }>(
		(result, file) => ({
			additions: result.additions + (file.additions ?? 0),
			deletions: result.deletions + (file.deletions ?? 0),
		}),
		{ additions: 0, deletions: 0 },
	);
	return stats.additions || stats.deletions ? stats : undefined;
}

function ToolDiffOutput({
	diff,
	fallbackPath,
	onOpenPath,
	plainText = false,
}: {
	diff: ToolDiff;
	fallbackPath?: string;
	onOpenPath?: (path: string) => void;
	plainText?: boolean;
}) {
	return (
		<div className="grid gap-1">
			{diff.files.map((file, index) => {
				const displayPath = file.path || (diff.files.length === 1 ? fallbackPath : undefined);
				if (!file.diff) return null;
				return (
					<div className="grid gap-1" key={`${file.path ?? "file"}-${file.operation ?? "change"}-${index}`}>
						<CodeBlock
							className="my-0 border-border/60 bg-muted/25"
							code={file.diff}
							language={"diff" as BundledLanguage}
							diffLanguage={displayPath ? codeLanguageForPath(displayPath) : ("text" as BundledLanguage)}
							plainText={plainText}
						>
							<CodeBlockHeader className="border-b-0 bg-transparent px-2 py-1">
								<CodeBlockTitle className="min-w-0 text-foreground">
									<FileCode2Icon className="size-3.5 shrink-0" />
									{onOpenPath && displayPath ? (
										<button
											className="min-w-0 truncate text-left font-mono text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
											onClick={() => onOpenPath(displayPath)}
											title={displayPath}
											type="button"
										>
											{displayPath}
										</button>
									) : (
										<span className="min-w-0 truncate font-mono" title={displayPath}>{displayPath || "修改预览（等待文件路径）"}</span>
									)}
								</CodeBlockTitle>
								<CodeBlockActions>
									{onOpenPath && displayPath ? (
										<Button
											aria-label="预览文件"
											className="shrink-0"
											onClick={() => onOpenPath(displayPath)}
											size="icon"
											type="button"
											variant="ghost"
										>
											<EyeIcon size={14} />
										</Button>
									) : null}
									<CodeBlockCopyButton aria-label="复制差异" />
								</CodeBlockActions>
							</CodeBlockHeader>
						</CodeBlock>
					</div>
				);
			})}
		</div>
	);
}

type ToolActivityKind = "read" | "command" | "mutation";

function activityPathParts(tool: ToolBatchTool): { filename: string; directory?: string } {
	const title = toolTitle(tool).replaceAll("\\", "/");
	const separator = title.lastIndexOf("/");
	if (separator < 0) return { filename: title || "文件" };
	return {
		filename: title.slice(separator + 1) || title,
		directory: title.slice(0, separator + 1),
	};
}

function activityStatusLabel(state: ToolBatchState, preparing = false): string {
	if (state === "input-available") return preparing ? "准备中" : "运行中";
	if (state === "input-queued") return "已排队";
	if (state === "output-available") return "已完成";
	return statusLabels[state];
}

function toolRowStatus(tool: ToolBatchTool): string {
	if (tool.name === "bash" && tool.state === "output-available" && commandPresentation(commandFromToolSummary(tool.summary)).resultUncertain) return "已执行";
	return activityStatusLabel(tool.state, tool.preparing && tool.name !== "edit");
}

function activityStatusIcon(state: ToolBatchState): ReactNode {
	if (state === "input-available") return <LoaderCircleIcon className="size-3 animate-spin text-primary" />;
	if (state === "input-queued") return <span className="size-1.5 rounded-full bg-muted-foreground/45" />;
	if (state === "output-available") return <CheckCircleIcon className="size-3 text-[var(--success)]" />;
	return <XCircleIcon className="size-3 text-destructive" />;
}

function readImagePath(tool: ToolBatchTool): string | undefined {
	if (tool.name !== "read" || tool.state !== "output-available") return undefined;
	if (!/^Read image file \[image\/[^\]\r\n]+\](?:\r?\n|$)/u.test(tool.detail ?? "")) return undefined;
	return filePathFromTool(tool);
}

function readLineRange(tool: ToolBatchTool): string | undefined {
	if (tool.name !== "read" || tool.images?.length || readImagePath(tool)) return undefined;
	const source = readSourcePresentation(tool);
	if (source) return `第${source.startLine}-${source.endLine}行`;
	const parsed = parseToolSummary(tool.summary);
	if (tool.summary === tool.name || (!tool.summary && !parsed?.path)) return undefined;
	const offset = typeof parsed?.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset > 0 ? parsed.offset : 1;
	const limit = typeof parsed?.limit === "number" && Number.isInteger(parsed.limit) && parsed.limit > 0 ? parsed.limit : undefined;
	if (limit) return `第${offset}-${offset + limit - 1}行`;
	return undefined;
}

function activityPaths(tool: ToolBatchTool): string[] {
	if (tool.name === "apply_patch" && tool.diff?.files.some((file) => file.path)) return tool.diff.files.flatMap((file) => file.path ? [file.path] : []);
	return [toolTitle(tool)];
}

function toolActivityBatchLabel(tools: readonly ToolBatchTool[], kind: ToolActivityKind): string {
	if (kind === "command") return toolBatchSummaryLabel(tools);
	const count = new Set(tools.flatMap(activityPaths)).size;
	return `${kind === "read" ? "读取" : "修改"} ${count} 个文件`;
}

function toolBatchStatusLabel(tools: readonly ToolBatchTool[]): string {
	const state = batchState(tools);
	if (state === "output-error" || state === "output-cancelled" || state === "output-interrupted") {
		return `${tools.filter((tool) => tool.state === state).length} 项${statusLabels[state]}`;
	}
	if (state === "output-available" && tools.some((tool) => toolRowStatus(tool) === "已执行")) return "已执行";
	return statusLabels[state];
}

function ToolActivityRow({
	tool,
	sessionId,
	onOpenPath,
	initialOpen = false,
	open: controlledOpen,
	onOpenChange,
}: {
	tool: ToolBatchTool;
	sessionId?: string;
	onOpenPath?: (path: string) => void;
	initialOpen?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const [open, setOpen] = useControllableState({ defaultProp: initialOpen, prop: controlledOpen, onChange: onOpenChange });
	const hasDetails = Boolean(tool.name === "bash" || isActiveFileChange(tool) || visibleToolDetail(tool) || hasVisibleDiff(tool.diff) || tool.images?.length || webSearchSources(tool).length);
	const stats = diffStats(tool.diff);
	const lineRange = readLineRange(tool);
	const { filename, directory } = activityPathParts(tool);
	const title = tool.name === "read" ? toolTitle(tool) : toolRowTitle(tool);
	const outcomeUncertain = tool.name === "bash" && tool.state === "output-available" && commandPresentation(commandFromToolSummary(tool.summary)).resultUncertain;
	const status = toolRowStatus(tool);
	return (
		<Collapsible open={open} onOpenChange={setOpen} className="min-w-0" data-transcript-anchor-key={transcriptAnchorKey(tool)}>
			<CollapsibleTrigger asChild disabled={!hasDetails}>
				<button
					aria-label={`${title}，${status}${hasDetails ? `，${open ? "收起" : "展开"}详情` : ""}`}
					data-transcript-resize-anchor
					className="grid min-h-7 w-full min-w-0 grid-cols-[12px_14px_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
					type="button"
				>
					<span className="relative z-10 flex size-3 items-center justify-center bg-background">
						{outcomeUncertain ? <span aria-label="已执行" className="size-1.5 rounded-full bg-muted-foreground/60" role="img" /> : activityStatusIcon(tool.state)}
					</span>
					{toolIcon(tool.name, "size-3.5", false, false, tool.name === "bash" ? toolTitle(tool) : undefined)}
					{tool.name === "bash" ? (
						<span className="min-w-0 truncate font-mono text-[13px] leading-5 text-foreground" data-command-title="true" title={title}>{title}</span>
					) : tool.name === "apply_patch" ? (
						<span className="min-w-0 truncate font-mono text-[13px]" title={title}>{title}</span>
					) : (
						<span
							className="flex min-w-0 items-baseline overflow-hidden font-mono text-[13px] leading-5"
							title={toolTitle(tool)}
						>
							{tool.name !== "read" ? <span className="mr-1.5 shrink-0 font-sans">{toolRowActionLabel(tool.name, tool.state)}</span> : null}
							{directory ? (
								<span className="hidden min-w-0 truncate text-muted-foreground sm:inline" data-activity-directory>
									{directory}
								</span>
							) : null}
							<span className="min-w-0 truncate text-foreground sm:shrink-0" data-activity-filename>
								{filename}
							</span>
						</span>
					)}
					<span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
						{lineRange ? <span className="text-xs tabular-nums text-muted-foreground">{lineRange}</span> : null}
						{stats ? (
							<span className="flex gap-1 text-xs">
								{stats.additions ? <span className="text-emerald-600">+{stats.additions}</span> : null}
								{stats.deletions ? <span className="text-destructive">-{stats.deletions}</span> : null}
							</span>
						) : null}
						<span className={cn("text-xs", tool.state === "input-available" ? "text-brand" : "text-muted-foreground")}>{status}</span>
					</span>
				</button>
			</CollapsibleTrigger>
			{hasDetails ? (
				<GsapCollapsibleContent
					open={open}
					duration={tool.name === "edit" || tool.name === "write" || tool.name === "apply_patch" ? 0 : undefined}
					className="min-w-0 pb-1 pl-4 pt-0.5"
					onClick={(event) => {
						event.stopPropagation();
						if (canCollapseFromContent(event)) setOpen(false);
					}}
				>
					<StabilityBoundary
						scope={`tool-activity-detail:${tool.name}`}
						fallback={() => <div className="text-xs text-destructive">工具详情渲染失败。</div>}
					>
						<ToolDetail tool={tool} sessionId={sessionId} onOpenPath={onOpenPath} />
					</StabilityBoundary>
				</GsapCollapsibleContent>
			) : null}
		</Collapsible>
	);
}

function ToolActivityGroup({
	tools,
	kind,
	open,
	onOpenChange,
	toolOpen,
	initialToolOpen,
	onToolOpenChange,
	sessionId,
	onOpenPath,
	className,
}: {
	tools: readonly ToolBatchTool[];
	kind: ToolActivityKind;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	toolOpen?: ReadonlyMap<string, boolean>;
	initialToolOpen?: ReadonlyMap<string, boolean>;
	onToolOpenChange?: (toolId: string, open: boolean) => void;
	sessionId?: string;
	onOpenPath?: (path: string) => void;
	className?: string;
}) {
	const active = tools.some((tool) => tool.state === "input-available");
	const label = toolActivityBatchLabel(tools, kind);
	const status = toolBatchStatusLabel(tools);
	const firstCommand = tools[0] ? toolTitle(tools[0]) : undefined;
	const sharedCommand = kind === "command" && firstCommand && tools.every(
		(tool) => commandPresentation(toolTitle(tool)).icon === commandPresentation(firstCommand).icon,
	) ? firstCommand : undefined;
	const headerIcon = active
		? <LoaderCircleIcon className="size-4 animate-spin text-primary" />
		: kind === "command"
			? toolIcon("bash", "size-4", false, false, sharedCommand)
			: kind === "mutation"
				? <PencilIcon className="size-4 text-muted-foreground" />
				: <FileTextIcon className="size-4 text-muted-foreground" />;
	return (
		<Collapsible className={cn("group/tool-activity min-w-0 w-full", className)} open={open} onOpenChange={onOpenChange}>
			<CollapsibleTrigger asChild>
				<button
					aria-label={`${label}，${status}，${open ? "收起" : "展开"}`}
					data-transcript-resize-anchor
					className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					type="button"
				>
					{headerIcon}
					<span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground" title={label}>{label}</span>
					<span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
						{toolStatusIndicator(batchState(tools))}
						<span className="text-xs text-muted-foreground">{status}</span>
						<ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool-activity:rotate-180" />
					</span>
				</button>
			</CollapsibleTrigger>
			<GsapCollapsibleContent open={open} duration={kind === "mutation" ? 0 : undefined} className="pt-1.5">
				<div className="relative ml-1 grid min-w-0 gap-0 pl-4 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-border">
					{tools.map((tool) => (
						<ToolActivityRow
							key={tool.id}
							tool={tool}
							sessionId={sessionId}
							onOpenPath={onOpenPath}
							initialOpen={initialToolOpen?.get(tool.id) ?? false}
							open={toolOpen ? (toolOpen.get(tool.id) ?? false) : undefined}
							onOpenChange={onToolOpenChange ? (nextOpen) => onToolOpenChange(tool.id, nextOpen) : undefined}
						/>
					))}
				</div>
			</GsapCollapsibleContent>
		</Collapsible>
	);
}

type ImageGenerationPresentation = ResourceImageGenerationMetadata & { filename?: string };

function imageGenerationPresentation(tool: ToolBatchTool): ImageGenerationPresentation {
	const parsed = parseToolSummary(tool.summary);
	const prompt = typeof parsed?.prompt === "string" ? parsed.prompt : undefined;
	const parsedModel = typeof parsed?.model === "string" ? parsed.model.trim() : "";
	const model = parsedModel || undefined;
	const filename = typeof parsed?.filename === "string" ? parsed.filename : undefined;
	return { ...(prompt ? { prompt } : {}), ...(model ? { model } : {}), ...(filename ? { filename } : {}) };
}

function sameImageResource(previous: ResourceImageItem, next: ResourceImageItem): boolean {
	return (
		previous.id === next.id &&
		previous.src === next.src &&
		previous.path === next.path &&
		previous.projectId === next.projectId &&
		previous.sessionId === next.sessionId &&
		previous.contentRef === next.contentRef &&
		previous.alt === next.alt
	);
}

const GeneratedImageFrame = memo(
	function GeneratedImageFrame({
		item,
		status,
		onOpen,
	}: {
		item: ResourceImageItem;
		status: ImageGenerationStatus;
		onOpen: () => void;
	}) {
		const { source, loading, failed } = useResourceImageSource(item);
		const [aspectRatio, setAspectRatio] = useState<number>();
		const label = item.alt ?? "生成图片";
		// 媒体还没到位时沿用 beUI 的生成中框，让占位和真实状态共用同一个容器。
		const frameStatus: ImageGenerationStatus = failed ? "error" : source ? status : loading ? "generating" : "error";
		const statusText = failed ? "图片内容读取失败" : source ? undefined : loading ? "正在读取图片" : "没有图片内容";

		return (
			<ImageGeneration
				aspectRatio={aspectRatio}
				className="w-full max-w-[32rem]"
				mediaClassName="[&_img]:object-contain"
				onMediaClick={source ? onOpen : undefined}
				size="fluid"
				status={frameStatus}
				statusText={statusText}
			>
				{source ? (
					<img
						alt={label}
						className="size-full object-contain"
						onLoad={(event) => {
							const image = event.currentTarget;
							if (image.naturalWidth && image.naturalHeight) setAspectRatio(image.naturalWidth / image.naturalHeight);
						}}
						src={source}
					/>
				) : null}
			</ImageGeneration>
		);
	},
	(previous, next) => previous.status === next.status && sameImageResource(previous.item, next.item),
);

function ImageGenerationDetails({
	model,
	prompt,
	onOpen,
}: {
	model?: string;
	prompt?: string;
	onOpen?: () => void;
}) {
	return (
		<div className="grid min-w-0 content-start gap-5 border-border/60 md:border-l md:pl-5">
			{model ? (
				<div className="grid min-w-0 gap-1.5">
					<span className="text-xs text-muted-foreground">请求模型</span>
					<span className="break-all font-mono text-sm text-foreground">{model}</span>
				</div>
			) : null}
			<div className="grid min-w-0 gap-1.5">
				<span className="text-xs text-muted-foreground">提示词</span>
				{prompt ? (
					<p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{prompt}</p>
				) : (
					<p className="text-sm leading-6 text-muted-foreground">未返回提示词</p>
				)}
			</div>
			{onOpen ? (
				<Button className="h-8 w-fit gap-1 px-2 text-[13px]! font-normal leading-5!" onClick={onOpen} size="sm" type="button" variant="ghost">
					<ExternalLinkIcon className="size-3.5" />查看大图
				</Button>
			) : null}
		</div>
	);
}

function ImageGenerationToolResult({ tool, sessionId }: { tool: ToolBatchTool; sessionId?: string }) {
	const [viewerIndex, setViewerIndex] = useState<number>();
	const metadata = imageGenerationPresentation(tool);
	const status = IMAGE_GENERATION_STATE[tool.state];
	const items: ResourceImageItem[] = (tool.images ?? []).map((image, index) => ({
		id: `${tool.id}:${image.contentRef}`,
		sessionId,
		contentRef: image.contentRef,
		mimeType: image.mimeType,
		alt: metadata.filename ?? image.alt ?? `生成图片 ${index + 1}`,
		generation: {
			...(metadata.model ? { model: metadata.model } : {}),
			...(metadata.prompt ? { prompt: metadata.prompt } : {}),
		},
	}));

	return (
		<div className="grid min-w-0 w-full gap-6">
			{items.length ? items.map((item, index) => (
				<div className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)] md:items-start" key={item.id}>
					<GeneratedImageFrame item={item} onOpen={() => setViewerIndex(index)} status={status} />
					{status === "complete" ? (
						<ImageGenerationDetails
							model={metadata.model}
							onOpen={() => setViewerIndex(index)}
							prompt={metadata.prompt}
						/>
					) : null}
				</div>
			)) : <ImageGenerationProgress tool={tool} />}
			{items.length ? <ResourceImageViewer items={items} open={viewerIndex !== undefined} initialIndex={viewerIndex ?? 0} onOpenChange={(nextOpen) => { if (!nextOpen) setViewerIndex(undefined); }} /> : null}
		</div>
	);
}

function ImageToolGallery({
	tools,
	sessionId,
	onOpenPath,
	large = false,
}: {
	tools: readonly ToolBatchTool[];
	sessionId?: string;
	onOpenPath?: (path: string) => void;
	large?: boolean;
}) {
	return (
		<div className="min-w-0 pt-1">
			<ResourceImageGallery
				items={tools.flatMap((tool) =>
					(tool.images ?? []).map((image, index) => ({
						id: `${tool.id}:${image.contentRef}`,
						sessionId,
						contentRef: image.contentRef,
						mimeType: image.mimeType,
						alt:
							image.alt ||
							(tool.name === "image_gen" ? `生成图片 ${index + 1}` : toolTitle(tool)),
					})),
				)}
				itemClassName={
					large
						? "w-full [&>button]:min-h-52 [&>button]:w-full [&>button>img]:max-h-[32rem] [&>button>img]:w-full"
						: "w-40 [&>button]:h-32 [&>button]:w-40 [&>button]:min-h-0 [&>button>img]:h-full [&>button>img]:w-full"
				}
				onOpenPath={onOpenPath}
			/>
		</div>
	);
}

const IMAGE_GENERATION_STATE: Record<ToolBatchState, ImageGenerationStatus> = {
	"input-available": "generating",
	"input-queued": "queued",
	"output-available": "complete",
	"output-cancelled": "error",
	"output-error": "error",
	"output-interrupted": "error",
};

const ImageGenerationProgress = memo(
	function ImageGenerationProgress({ tool }: { tool: ToolBatchTool }) {
		const status = IMAGE_GENERATION_STATE[tool.state];
		const detail = tool.detail?.trim();
		const statusText = status === "error" ? detail || undefined : status === "complete" ? "图片结果正在写入会话" : undefined;
		const metadata = imageGenerationPresentation(tool);

		return (
			<div className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)] md:items-start">
				<ImageGeneration className="w-full max-w-[32rem]" size="fluid" status={status} statusText={statusText} />
				{metadata.prompt || status === "complete" ? (
					<ImageGenerationDetails model={status === "complete" ? metadata.model : undefined} prompt={metadata.prompt} />
				) : null}
			</div>
		);
	},
	(previous, next) => {
		if (previous.tool.id !== next.tool.id || previous.tool.state !== next.tool.state) return false;
		if (previous.tool.summary !== next.tool.summary) return false;
		if (next.tool.state === "input-available" || next.tool.state === "input-queued") return true;
		return previous.tool.detail === next.tool.detail;
	},
);

function WebSearchToolDetail({ tool }: { tool: ToolBatchTool }) {
	const sources = webSearchSources(tool);
	const detail = webSearchDetail(tool.summary, tool.webSearch);
	const active = tool.state === "input-available" || tool.state === "input-queued";
	return (
		<div className="grid min-w-0 gap-2">
			{detail ? (
				<div className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-2 text-xs leading-5 max-sm:grid-cols-1 max-sm:gap-0.5">
					<span className="text-muted-foreground">{detail.label}</span>
					<span className="min-w-0 break-words text-foreground">{detail.value}</span>
				</div>
			) : (
				<div className="text-xs leading-5 text-muted-foreground">{active ? "搜索词尚未返回" : "本次搜索未返回搜索词"}</div>
			)}
			{sources.length ? (
				<div className="grid min-w-0 gap-1.5">
					{sources.map((source) => (
						<Source href={source.url} key={source.url} title={source.title} />
					))}
				</div>
			) : (
				<div className="text-xs leading-5 text-muted-foreground">{active ? "来源尚未返回" : "本次搜索未返回网页来源"}</div>
			)}
		</div>
	);
}

function CommandToolDetail({
	command,
	output,
	imagePreview,
}: {
	command: string;
	output?: string;
	imagePreview: ReactNode;
}) {
	const content = [`$ ${command}`, output].filter(Boolean).join("\n\n");
	return (
		<div className="grid min-w-0 gap-1">
			{imagePreview}
			<div className="overflow-hidden rounded-md border border-border/60 bg-muted/25">
				<CodeBlock
					className="tool-command-block my-0 rounded-none border-0 bg-transparent shadow-none"
					code={`$ ${command}`}
					language={"bash" as BundledLanguage}
					transparent
					wrap
				>
					<CodeBlockHeader className="border-b border-border/50 bg-transparent px-2 py-1">
						<CodeBlockTitle className="font-mono text-[13px] text-foreground">Shell</CodeBlockTitle>
						<CodeBlockActions>
							<CodeBlockCopyButton aria-label="复制命令和输出" code={content} />
						</CodeBlockActions>
					</CodeBlockHeader>
				</CodeBlock>
				{output ? (
					<div className="border-t border-border/50 bg-background/50">
						<div className="px-3 pt-2 font-mono text-xs text-muted-foreground">输出</div>
						<pre className="tool-command-output max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 pt-1 font-mono text-[13px] leading-5 text-foreground">
							<AnsiOutput>{output}</AnsiOutput>
						</pre>
					</div>
				) : null}
			</div>
		</div>
	);
}

function SubagentToolDetail({
	tool,
	onOpenSubagent,
}: {
	tool: ToolBatchTool;
	onOpenSubagent?: (agentId: string) => void;
}) {
	return (
		<div className="grid min-w-0 gap-2">
			{(tool.subagents ?? []).map((subagent) => (
				<Button
					className="h-auto min-w-0 justify-start gap-2 rounded-lg px-2.5 py-2 text-left"
					disabled={!onOpenSubagent}
					key={`${subagent.runId}:${subagent.agentId}`}
					onClick={() => onOpenSubagent?.(subagent.agentId)}
					type="button"
					variant="outline"
				>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-xs font-medium">{subagent.agent}</span>
						<span className="mt-0.5 block truncate text-xs text-muted-foreground">{subagent.task}</span>
					</span>
					<span className="shrink-0 text-xs text-muted-foreground">
						{subagent.state === "failed" ? "失败" : subagent.state === "cancelled" ? "已停止" : "查看"}
					</span>
				</Button>
			))}
		</div>
	);
}

function ToolDetail({
	tool,
	sessionId,
	onOpenPath,
	onOpenSubagent,
	onOpenSession,
}: {
	tool: ToolBatchTool;
	sessionId?: string;
	onOpenPath?: (path: string) => void;
	onOpenSubagent?: (agentId: string) => void;
	onOpenSession?: (sessionId: string) => void;
}) {
	const plainText = tool.state === "input-available" || tool.state === "input-queued";
	const title = toolTitle(tool);
	const detail = visibleToolDetail(tool);
	const diff = hasVisibleDiff(tool.diff) ? tool.diff : undefined;
	const imagePreview = tool.images?.length ? (
		<ImageToolGallery
			tools={[tool]}
			sessionId={sessionId}
			onOpenPath={onOpenPath}
			large={tool.name === "image_gen"}
		/>
	) : null;

	if (tool.name === "codemode") {
		return (
			<CodemodeToolDetail tool={tool} imagePreview={imagePreview}>
				{tool.codemode?.calls.length ? (
					<div aria-label="脚本执行过程" className="grid min-w-0 gap-0 pb-2" onClick={(event) => event.stopPropagation()}>
						{tool.codemode.calls.map((call) => (
							<ToolBatchRow
								key={call.id}
								tool={toCodemodeToolViewModel(call)}
								sessionId={sessionId}
								onOpenPath={onOpenPath}
								onOpenSubagent={onOpenSubagent}
								onOpenSession={onOpenSession}
							/>
						))}
					</div>
				) : null}
			</CodemodeToolDetail>
		);
	}
	if (isSessionTool(tool.name)) {
		return (
			<SessionCollaborationToolDetail
				name={tool.name}
				summary={tool.summary}
				detail={tool.detail}
				progress={tool.progress}
				result={tool.state === "output-available" ? tool.detail : undefined}
				state={tool.state}
				onOpenSession={onOpenSession}
			/>
		);
	}
	if (tool.name === "subagent" && tool.subagents?.length) {
		return <SubagentToolDetail tool={tool} onOpenSubagent={onOpenSubagent} />;
	}
	if (tool.name === "image_gen") {
		return <div className="grid min-w-0 gap-2">{imagePreview ?? <ImageGenerationProgress tool={tool} />}</div>;
	}

	if (tool.name === "web_search") return <WebSearchToolDetail tool={tool} />;

	if (tool.name === "read") {
		if (tool.images?.length) return imagePreview;
		const imagePath = readImagePath(tool);
		if (imagePath) {
			const note = tool.detail?.split("\n").slice(1).join("\n").trim();
			return (
				<div className="grid min-w-0 gap-1">
					<ResourceImage path={imagePath} alt={imagePath.split(/[\\/]/u).at(-1)} onOpenPath={onOpenPath} />
					{note ? <p className="whitespace-pre-wrap text-xs text-muted-foreground">{note}</p> : null}
				</div>
			);
		}
		const source = readSourcePresentation(tool);
		const code = source?.code ?? tool.detail ?? "";
		return (
			<div className="grid min-w-0 gap-1">
				{tool.detail ? (
					<CodeBlock
						className="my-0 rounded-md border-0 bg-transparent shadow-none"
						code={code}
						language={plainText ? ("text" as BundledLanguage) : codeLanguageForPath(title)}
						plainText={plainText}
						showLineNumbers
						startLine={source?.startLine ?? 1}
						transparent
					>
						<CodeBlockHeader className="border-border/40 bg-transparent px-2 py-1">
							<CodeBlockTitle className="min-w-0 text-foreground">
								<FileCode2Icon className="size-3.5 shrink-0" />
								<span className="truncate font-mono text-xs">{title}</span>
							</CodeBlockTitle>
							<CodeBlockActions>
								<CodeBlockCopyButton aria-label="复制文件内容" />
							</CodeBlockActions>
						</CodeBlockHeader>
					</CodeBlock>
				) : null}
				{source && source.remainingLines > 0 ? <p className="px-4 pb-2 text-xs text-muted-foreground">还有 {source.remainingLines} 行未显示</p> : null}
			</div>
		);
	}

	if (tool.name === "bash") {
		return <CommandToolDetail command={title} output={tool.detail} imagePreview={imagePreview} />;
	}

	const parameters = parseToolSummary(tool.summary);
	const input = parameters ? JSON.stringify(parameters, null, 2) : undefined;
	const context = input ? undefined : toolPresentationContext(tool);
	return (
		<div className="grid min-w-0 gap-1">
			{input ? <CodeBlock className="my-0 border-border/60 bg-muted/25" code={input} language={"json" as BundledLanguage} plainText>
				<CodeBlockHeader className="border-b-0 bg-transparent px-2 py-1">
					<CodeBlockTitle className="text-foreground">调用参数</CodeBlockTitle>
					<CodeBlockActions><CodeBlockCopyButton aria-label="复制调用参数" /></CodeBlockActions>
				</CodeBlockHeader>
			</CodeBlock> : null}
			{context ? <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{context}</p> : null}
			{imagePreview}
			{tool.preparing && (tool.name === "edit" || tool.name === "write") && !filePathFromTool(tool) ? (
				<span className="text-xs text-muted-foreground">正在生成修改参数，尚未收到目标文件路径。</span>
			) : null}
			{diff ? (
				<ToolDiffOutput
					diff={diff}
					fallbackPath={filePathFromTool(tool)}
					onOpenPath={onOpenPath}
					plainText={plainText}
				/>
			) : null}
			{!diff && detail ? (
				<CodeBlock
					className="my-0 border-border/60 bg-muted/25"
					code={detail}
					language={"text" as BundledLanguage}
					plainText
				>
					<CodeBlockHeader className="border-b-0 bg-transparent px-2 py-1">
						<CodeBlockTitle className="text-foreground">结果</CodeBlockTitle>
						<CodeBlockActions>
							<CodeBlockCopyButton aria-label="复制结果" />
						</CodeBlockActions>
					</CodeBlockHeader>
				</CodeBlock>
			) : null}
			{!diff && !detail && isActiveFileChange(tool) ? (
				<span className="text-xs text-muted-foreground">修改内容生成中</span>
			) : null}
		</div>
	);
}

function ToolBatchRow({
	tool,
	sessionId,
	onOpenPath,
	onOpenSubagent,
	onOpenSession,
	className,
	initialOpen = false,
	open: controlledOpen,
	onOpenChange,
	autoCollapseWhenComplete = false,
}: {
	tool: ToolBatchTool;
	sessionId?: string;
	onOpenPath?: (path: string) => void;
	onOpenSubagent?: (agentId: string) => void;
	onOpenSession?: (sessionId: string) => void;
	className?: string;
	initialOpen?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	autoCollapseWhenComplete?: ToolBatchAutoCollapse;
}) {
	const userOpened = useRef(initialOpen || controlledOpen === true);
	const [open, setOpen] = useControllableState({
		defaultProp: initialOpen,
		prop: controlledOpen,
		onChange: (nextOpen) => {
			userOpened.current = nextOpen;
			onOpenChange?.(nextOpen);
		},
	});
	const active = tool.state === "input-available" || tool.state === "input-queued";
	const previousActive = useRef(active);
	const title = toolRowTitle(tool);
	const targetSessionId = sessionToolSessionId(tool.name, tool.summary, tool.detail);
	const sessionNavigation = Boolean(targetSessionId && onOpenSession);
	const status = sessionNavigation && (tool.state === "input-available" || tool.state === "input-queued" || tool.state === "output-available")
		? sessionToolActivityLabel(tool.detail) ?? sessionToolActivityLabel(tool.progress) ?? toolRowStatus(tool)
		: toolRowStatus(tool);
	const skillName = skillNameFromTool(tool);
	const standaloneRead = tool.name === "read" && !skillName && !tool.images?.length;
	const standaloneMutation = tool.name === "edit" || tool.name === "write" || tool.name === "apply_patch";
	const pathActivity = standaloneRead || (standaloneMutation && tool.name !== "apply_patch");
	const pathParts = pathActivity ? activityPathParts(tool) : undefined;
	const lineRange = standaloneRead ? readLineRange(tool) : undefined;
	const stats = diffStats(tool.diff);
	const hasDetails = !sessionNavigation &&
		(isSessionTool(tool.name)
			? true
			: tool.name === "image_gen" || tool.name === "codemode"
				? true
				: tool.name === "web_search"
				? true
				: Boolean(tool.name === "bash" || (tool.name !== "read" && parseToolSummary(tool.summary)) || isActiveFileChange(tool) || visibleToolDetail(tool) || hasVisibleDiff(tool.diff) || tool.images?.length || webSearchSources(tool).length || tool.subagents?.length));

	useEffect(() => {
		if (
			previousActive.current &&
			!active &&
			tool.name !== "image_gen" &&
			(tool.name === "read" || !userOpened.current) &&
			resolveAutoCollapse(autoCollapseWhenComplete)
		)
			setOpen(false);
		previousActive.current = active;
	}, [active, autoCollapseWhenComplete, tool.name]);

	return (
		<Collapsible open={open} onOpenChange={setOpen} className={cn("min-w-0", className)} data-transcript-anchor-key={transcriptAnchorKey(tool)}>
			<CollapsibleTrigger asChild>
				<button
					data-transcript-resize-anchor
					className="flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onClick={(event) => {
						if (targetSessionId && onOpenSession) {
							event.preventDefault();
							event.stopPropagation();
							onOpenSession(targetSessionId);
							return;
						}
						const subagent = tool.subagents?.length === 1 ? tool.subagents[0] : undefined;
						if (!subagent || !onOpenSubagent) return;
						event.preventDefault();
						event.stopPropagation();
						onOpenSubagent(subagent.agentId);
					}}
					type="button"
					aria-label={`${title}，${status}${sessionNavigation ? "，切换会话" : hasDetails ? `，${open ? "收起" : "展开"}详情` : ""}`}
				>
					{toolLeadingIcon(tool.state, tool.name, Boolean(skillName), Boolean(tool.images?.length), tool.name === "bash" ? toolTitle(tool) : undefined)}
					{pathParts ? (
						<span
							className="flex min-w-0 flex-1 items-baseline overflow-hidden font-mono text-[13px]"
							title={toolTitle(tool)}
						>
							<span className="mr-1.5 shrink-0">{toolRowActionLabel(tool.name, tool.state)}</span>
							{pathParts.directory ? (
								<span className="hidden min-w-0 truncate text-muted-foreground sm:inline">
									{pathParts.directory}
								</span>
							) : null}
							<span className="min-w-0 truncate text-foreground sm:shrink-0">{pathParts.filename}</span>
						</span>
					) : (
						<span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={title}>{title}</span>
					)}
					{lineRange ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{lineRange}</span> : null}
					{stats ? (
						<span className="flex shrink-0 gap-1 text-xs">
							{stats.additions ? <span className="text-emerald-600">+{stats.additions}</span> : null}
							{stats.deletions ? <span className="text-destructive">-{stats.deletions}</span> : null}
						</span>
					) : null}
					<span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
						{tool.name !== "read" && tool.state === "input-available" ? <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-primary" /> : null}
						{tool.name === "web_search" && webSearchSources(tool).length ? (
							<span className="text-xs text-muted-foreground">{webSearchSources(tool).length} 个来源</span>
						) : null}
						{toolStatusIndicator(tool.state)}
						{!standaloneRead || tool.state !== "output-available" ? (
							<span className="text-xs text-muted-foreground">{status}</span>
						) : null}
						{hasDetails ? (
							<ChevronDownIcon
								className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
							/>
						) : null}
					</span>
				</button>
			</CollapsibleTrigger>
			{hasDetails ? (
				<GsapCollapsibleContent
					open={open}
					duration={standaloneMutation ? 0 : undefined}
					data-transcript-resize-anchor
					className={cn(
						"min-w-0 pb-0.5 pl-6 pr-0 pt-0",
						tool.name === "image_gen" || tool.name === "codemode"
							? "overflow-visible"
							: "max-h-[min(32rem,60vh)] overflow-y-auto overflow-x-hidden overscroll-y-auto",
					)}
					onClick={(event) => {
						event.stopPropagation();
						if (canCollapseFromContent(event)) setOpen(false);
					}}
				>
					<StabilityBoundary
						scope={`tool-detail:${tool.name}`}
						fallback={() => (
							<div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
								工具详情渲染失败，工具结果仍保留在会话记录中。
						</div>
						)}
					>
						<ToolDetail
							tool={tool}
							sessionId={sessionId}
							onOpenPath={onOpenPath}
							onOpenSubagent={onOpenSubagent}
							onOpenSession={onOpenSession}
						/>
					</StabilityBoundary>
				</GsapCollapsibleContent>
			) : null}
		</Collapsible>
	);
}

export const ToolBatch = memo(function ToolBatch({
	tools,
	className,
	initialOpen = false,
	summaryLabel,
	open: controlledOpen,
	onOpenChange,
	autoCollapseWhenComplete = false,
	sessionId,
	onOpenPath,
	onOpenSubagent,
	onOpenSession,
	toolOpen,
	initialToolOpen,
	onToolOpenChange,
}: ToolBatchProps) {
	const active = tools.some((tool) => tool.state === "input-available" || tool.state === "input-queued");
	const aggregateState = batchState(tools);
	const imageGallery = tools.length > 0 && tools.every((tool) => tool.name !== "codemode" && tool.images?.length);
	const imageGeneration = tools.some((tool) => tool.name === "image_gen");
	const ordinaryReads =
		tools.length > 1 &&
		tools.every((tool) => tool.name === "read" && !tool.images?.length && !skillNameFromTool(tool));
	const repeatedFileReads = ordinaryReads && new Set(tools.map(toolTitle)).size < tools.length;
	const readActivity = ordinaryReads && !repeatedFileReads;
	const commandActivity = tools.length > 1 && tools.every((tool) => tool.name === "bash" && !tool.images?.length);
	const mutationActivity =
		tools.length > 1 &&
		tools.every((tool) =>
			tool.name === "edit" || tool.name === "write" || tool.name === "apply_patch",
		);
	const compactActivity = readActivity || commandActivity || mutationActivity;
	const searchHasSources = tools.length === 1 && tools[0]?.name === "web_search" && Boolean(tools[0].sources?.length);
	const userOpened = useRef(initialOpen || controlledOpen === true);
	const preserveExpanded = tools.length !== 1 || tools[0]?.name !== "read";
	const [open, setOpen] = useControllableState({
		defaultProp: imageGallery || imageGeneration || (compactActivity && active) || initialOpen || searchHasSources,
		prop: imageGeneration ? undefined : controlledOpen,
		onChange: (nextOpen) => {
			userOpened.current = nextOpen;
			if (!imageGeneration) onOpenChange?.(nextOpen);
		},
	});
	const previousActive = useRef(active);

	useEffect(() => {
		if (previousActive.current && !active && !imageGeneration && (!preserveExpanded || !userOpened.current) && resolveAutoCollapse(autoCollapseWhenComplete))
			setOpen(false);
		previousActive.current = active;
	}, [active, autoCollapseWhenComplete, imageGeneration, preserveExpanded]);

	if (!tools.length) return null;
	if (readActivity || commandActivity || mutationActivity) {
		return (
			<ToolActivityGroup
				tools={tools}
				kind={readActivity ? "read" : commandActivity ? "command" : "mutation"}
				open={open}
				onOpenChange={setOpen}
				toolOpen={toolOpen}
				initialToolOpen={initialToolOpen}
				onToolOpenChange={onToolOpenChange}
				sessionId={sessionId}
				onOpenPath={onOpenPath}
				className={className}
			/>
		);
	}
	if (
		imageGeneration &&
		(imageGallery ||
			(tools.length === 1 &&
				tools[0]?.name === "image_gen" &&
				(tools[0].state === "input-available" || tools[0].state === "input-queued" || tools[0].state === "output-available")))
	) {
		return (
			<div className={cn("grid min-w-0 gap-5", className)}>
				{tools.map((tool) => (
					<ImageGenerationToolResult key={tool.id} tool={tool} sessionId={sessionId} />
				))}
			</div>
		);
	}
	const allToolsCompleted = tools.every(isToolComplete);
	if ((!allToolsCompleted || repeatedFileReads) && tools.length > 1) {
		return (
			<div className={cn("tool-batch-stack", className)}>
				{tools.map((tool) => (
					<ToolBatchRow
						key={tool.id}
						tool={tool}
						sessionId={sessionId}
						onOpenPath={onOpenPath}
						onOpenSubagent={onOpenSubagent}
						onOpenSession={onOpenSession}
						initialOpen={initialToolOpen?.get(tool.id) ?? false}
						open={toolOpen ? (toolOpen.get(tool.id) ?? false) : undefined}
						onOpenChange={onToolOpenChange ? (nextOpen) => onToolOpenChange(tool.id, nextOpen) : undefined}
						autoCollapseWhenComplete={autoCollapseWhenComplete}
					/>
				))}
			</div>
		);
	}
	if (imageGallery) {
		const imageCount = tools.reduce((count, tool) => count + (tool.images?.length ?? 0), 0);
		const imageLabel = tools.some((tool) => tool.name === "image_gen")
			? `已生成 ${imageCount} 张图片`
			: `已查看 ${imageCount} 张图像`;
		return (
			<Collapsible
				className={cn("group/tool-batch min-w-0 w-full", className)}
				open={open}
				onOpenChange={setOpen}
			>
				<CollapsibleTrigger
					data-transcript-resize-anchor
					className="flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					type="button"
					aria-label={`${imageLabel}${open ? "，收起" : "，展开"}`}
				>
					{toolIcon("read", undefined, false, true)}
					<span className="min-w-0 flex-1 truncate font-mono text-[13px]">
						{summaryLabel ?? imageLabel}
					</span>
					<ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]/tool-batch:rotate-180" />
				</CollapsibleTrigger>
				<GsapCollapsibleContent
					open={open}
					data-transcript-resize-anchor
					className="min-w-0 overflow-hidden pb-0"
					onClick={(event) => {
						if (canCollapseFromContent(event)) setOpen(false);
					}}
				>
					<ImageToolGallery
						tools={tools}
						sessionId={sessionId}
						onOpenPath={onOpenPath}
						large={tools.some((tool) => tool.name === "image_gen")}
					/>
				</GsapCollapsibleContent>
			</Collapsible>
		);
	}
	if (tools.length === 1 && !summaryLabel) {
		const tool = tools[0];
		if (!tool) return null;
		const imageTool = Boolean(tool.images?.length);
		const imageGenerationTool = tool.name === "image_gen";
		return (
			<ToolBatchRow
				tool={tool}
				sessionId={sessionId}
				onOpenPath={onOpenPath}
				onOpenSubagent={onOpenSubagent}
				onOpenSession={onOpenSession}
				initialOpen={
					imageTool ||
					imageGenerationTool ||
					initialOpen ||
					(tool.name === "web_search" && Boolean(webSearchSources(tool).length))
				}
				open={imageTool || imageGenerationTool ? undefined : open}
				onOpenChange={imageTool || imageGenerationTool ? undefined : setOpen}
				className={className}
				autoCollapseWhenComplete={autoCollapseWhenComplete}
			/>
		);
	}

	return (
		<Collapsible
			className={cn("group/tool-batch min-w-0 w-full", className)}
			open={open}
			onOpenChange={setOpen}
		>
			<CollapsibleTrigger
				data-transcript-resize-anchor
				className="flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				type="button"
				aria-label={`${summaryLabel ?? toolBatchSummaryLabel(tools)}，${toolBatchStatusLabel(tools)}${open ? "，收起" : "，展开"}`}
			>
				{toolLeadingIcon(
					aggregateState,
					tools[0]?.name ?? "tool",
					Boolean(tools[0] && skillNameFromTool(tools[0])),
					Boolean(tools[0]?.images?.length),
				)}
				<span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={summaryLabel ?? toolBatchSummaryLabel(tools)}>{summaryLabel ?? toolBatchSummaryLabel(tools)}</span>
				<span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
					{toolStatusIndicator(aggregateState)}
					<span className="text-xs text-muted-foreground">{toolBatchStatusLabel(tools)}</span>
					<ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool-batch:rotate-180" />
				</span>
			</CollapsibleTrigger>
			<GsapCollapsibleContent
				open={open}
				data-transcript-resize-anchor
				className="relative min-w-0 max-h-[min(34rem,60vh)] overflow-y-auto overflow-x-hidden overscroll-y-auto pb-0"
				onClick={(event) => {
					event.stopPropagation();
					if (canCollapseFromContent(event)) setOpen(false);
				}}
			>
				<div className="relative z-0 grid min-w-0 gap-0">
					{tools.map((tool) => (
						<ToolBatchRow
							key={tool.id}
							tool={tool}
							sessionId={sessionId}
							onOpenPath={onOpenPath}
							onOpenSubagent={onOpenSubagent}
							onOpenSession={onOpenSession}
							initialOpen={initialToolOpen?.get(tool.id) ?? false}
							open={toolOpen ? (toolOpen.get(tool.id) ?? false) : undefined}
							onOpenChange={onToolOpenChange ? (nextOpen) => onToolOpenChange(tool.id, nextOpen) : undefined}
						/>
					))}
				</div>
			</GsapCollapsibleContent>
		</Collapsible>
	);
});

export { skillNameFromTool, statusLabels as toolBatchStatusLabels, toolTitle };
export type { ToolBatchState, ToolBatchTool };
