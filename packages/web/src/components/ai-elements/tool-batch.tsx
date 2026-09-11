"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import type { ToolDiff } from "@lystar/code-web-protocol";
import {
	ChevronDownIcon,
	EyeIcon,
	FileCode2Icon,
	FileTextIcon,
	FolderIcon,
	ImagesIcon,
	LoaderCircleIcon,
	PencilIcon,
	SearchIcon,
	SparklesIcon,
	TerminalIcon,
	WrenchIcon,
} from "lucide-react";
import { type MouseEvent as ReactMouseEvent, type ReactNode, memo, useEffect, useRef } from "react";
import type { BundledLanguage } from "shiki";
import { cn } from "@/lib/utils";
import { StabilityBoundary } from "../stability-boundary";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { CodeBlock, CodeBlockActions, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from "./code-block";
import { Button } from "../ui/button";
import { ResourceImageGallery } from "./resource-preview";
import { Source } from "./sources";

export type ToolBatchState =
	| "input-available"
	| "input-queued"
	| "output-available"
	| "output-error"
	| "output-cancelled"
	| "output-interrupted";

export interface ToolBatchTool {
	id: string;
	name: string;
	summary: string;
	state: ToolBatchState;
	detail?: string;
	sources?: Array<{ url: string; title?: string }>;
	images?: Array<{ contentRef: string; mimeType: string; byteLength: number; alt?: string }>;
	diff?: ToolDiff;
	inputPreview?: boolean;
}

export type ToolBatchAutoCollapse = boolean | (() => boolean);

export interface ToolBatchProps {
	tools: ToolBatchTool[];
	className?: string;
	initialOpen?: boolean;
	summaryLabel?: string;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	toolOpen?: ReadonlyMap<string, boolean>;
	onToolOpenChange?: (toolId: string, open: boolean) => void;
	autoCollapseWhenComplete?: ToolBatchAutoCollapse;
	sessionId?: string;
	onOpenPath?: (path: string) => void;
}

function resolveAutoCollapse(value: ToolBatchAutoCollapse): boolean {
	return typeof value === "function" ? value() : value;
}

function canCollapseFromContent(event: ReactMouseEvent<HTMLElement>): boolean {
	if (event.defaultPrevented) return false;
	const target = event.target;
	if (target instanceof Element && target.closest("button, a, input, textarea, select, [role=button]")) return false;
	const selection = window.getSelection();
	return !selection || selection.isCollapsed;
}

const statusLabels: Record<ToolBatchState, string> = {
	"input-available": "运行中",
	"input-queued": "已排队",
	"output-available": "已完成",
	"output-error": "出错",
	"output-cancelled": "已取消",
	"output-interrupted": "已中断",
};

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

export function skillNameFromTool(tool: ToolBatchTool): string | undefined {
	if (tool.name !== "read") return undefined;
	return skillNameFromPath(toolTitle(tool));
}

function toolIcon(name: string, className?: string, skill = false, images = false): ReactNode {
	const Icon = images
		? ImagesIcon
		: skill
			? SparklesIcon
			: name === "bash"
				? TerminalIcon
				: name === "edit" || name === "write" || name === "apply_patch"
					? PencilIcon
					: name === "read"
						? FileTextIcon
				: name === "find" || name === "grep" || name === "web_search"
					? SearchIcon
							: name === "ls"
								? FolderIcon
								: WrenchIcon;
	return <Icon className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

function toolStatusIndicator(state: ToolBatchState): ReactNode {
	if (state === "input-available")
		return <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
	if (state === "input-queued") return <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />;
	if (state === "output-error" || state === "output-cancelled" || state === "output-interrupted")
		return <span role="img" aria-label={statusLabels[state]} className="size-1.5 shrink-0 rounded-full bg-destructive" />;
	return null;
}

function batchState(tools: ToolBatchTool[]): ToolBatchState {
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

function webSearchTitle(summary: string): string {
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

function toolTitle(tool: ToolBatchTool): string {
	if (tool.name === "web_search") return webSearchTitle(tool.summary);
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
	return tool.summary || tool.name;
}

function codeLanguageForPath(path: string): BundledLanguage {
	const fileName = path.split(/[?#]/u)[0]?.split(/[\\/]/u).pop()?.toLowerCase() ?? "";
	if (fileName === "dockerfile") return "dockerfile";
	if (fileName === "makefile") return "make";
	const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1) : "";
	const languages: Record<string, BundledLanguage> = {
		c: "c",
		cpp: "cpp",
		cs: "csharp",
		css: "css",
		go: "go",
		html: "html",
		java: "java",
		js: "javascript",
		json: "json",
		jsx: "jsx",
		kt: "kotlin",
		less: "less",
		md: "markdown",
		php: "php",
		py: "python",
		rb: "ruby",
		rust: "rust",
		sass: "scss",
		scss: "scss",
		sh: "bash",
		sql: "sql",
		svelte: "svelte",
		swift: "swift",
		ts: "typescript",
		tsx: "tsx",
		toml: "toml",
		vue: "vue",
		xml: "xml",
		yaml: "yaml",
		yml: "yaml",
	};
	return languages[extension] ?? "text";
}

function toolActionLabel(name: string): string {
	const labels: Record<string, string> = {
		bash: "运行了命令",
		read: "读取了文件",
		edit: "编辑了文件",
		write: "写入了文件",
		apply_patch: "应用了补丁",
		find: "查找了文件",
		grep: "搜索了内容",
		image_gen: "生成了图片",
		web_search: "搜索了网页",
		ls: "查看了目录",
	};
	return labels[name] ?? `调用了 ${name}`;
}

export function toolBatchSummaryLabel(tools: readonly Pick<ToolBatchTool, "name" | "images">[]): string {
	const imageCount = tools.reduce((count, tool) => count + (tool.images?.length ?? 0), 0);
	if (imageCount > 0 && tools.some((tool) => tool.name === "image_gen")) return `已生成 ${imageCount} 张图片`;
	if (imageCount > 0) return `已查看 ${imageCount} 张图像`;
	return [...new Set(tools.map((tool) => toolActionLabel(tool.name)))].join("并") || "执行了工具";
}

const activeToolLabels: Record<string, string> = {
	bash: "正在执行",
	read: "正在读取",
	edit: "正在编辑",
	write: "正在写入",
	apply_patch: "正在应用补丁",
	find: "正在查找",
	grep: "正在搜索",
	image_gen: "正在生成图片",
	web_search: "正在搜索网页",
	ls: "正在查看目录",
};

function toolRowActionLabel(name: string, state: ToolBatchState): string {
	if (state === "input-available") return activeToolLabels[name] ?? "运行中";
	if (state === "input-queued") return "已排队";
	const labels: Record<string, string> = {
		bash: "已运行",
		read: "已读取",
		edit: "已编辑",
		write: "已写入",
		apply_patch: "已应用补丁",
		find: "已查找",
		grep: "已搜索",
		image_gen: "已生成图片",
		web_search: "已搜索网页",
		ls: "已查看目录",
	};
	return labels[name] ?? `已调用 ${name}`;
}

function batchTitle(tools: ToolBatchTool[]): string {
	if (tools.every((tool) => tool.name === "bash")) {
		const completed = tools.filter(
			(tool) => tool.state === "output-available" || tool.state === "output-error" || tool.state === "output-cancelled",
		).length;
		const failed = tools.filter((tool) => tool.state === "output-error").length;
		const cancelled = tools.filter((tool) => tool.state === "output-cancelled").length;
		if (completed === tools.length) {
			let text = `${tools.length} 条命令${cancelled > 0 ? "执行结束" : "执行完成"}`;
			if (failed > 0) text += ` · ${failed} 条失败`;
			if (cancelled > 0) text += ` · ${cancelled} 条取消`;
			return text;
		}
		if (tools.some((tool) => tool.state === "input-available")) {
			return `正在执行 ${tools.length} 条命令 · 已完成 ${completed}/${tools.length}`;
		}
		return `准备执行 ${tools.length} 条命令`;
	}
	return [...new Set(tools.map((tool) => toolActionLabel(tool.name)))].join("，") || "执行了工具";
}

export function toolRowTitle(tool: ToolBatchTool): string {
	if (tool.name === "image_gen") {
		if (tool.images?.length) return `已生成 ${tool.images.length} 张图片`;
		const title = toolTitle(tool);
		const action =
			tool.state === "output-error"
				? "图片生成失败"
				: tool.state === "output-cancelled"
					? "图片生成已取消"
					: tool.state === "output-interrupted"
						? "图片生成已中断"
						: toolRowActionLabel(tool.name, tool.state);
		return title && title !== tool.name ? `${action} · ${title}` : action;
	}
	if (tool.images?.length) return `已查看 ${tool.images.length} 张图像`;
	const skillName = skillNameFromTool(tool);
	if (skillName && tool.state === "output-available") return `已加载 ${skillName} 技能`;
	const title = toolTitle(tool);
	const action = toolRowActionLabel(tool.name, tool.state);
	if (tool.name === "web_search" && title === "网页搜索") return action;
	return title && title !== tool.name ? `${action} ${title}` : action;
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
										<span className="min-w-0 truncate font-mono">{displayPath || "diff"}</span>
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
						? "w-full max-w-3xl [&>button]:min-h-52 [&>button]:w-full [&>button>img]:max-h-[32rem] [&>button>img]:w-full"
						: "w-40 [&>button]:h-32 [&>button]:w-40 [&>button]:min-h-0 [&>button>img]:h-full [&>button>img]:w-full"
				}
				onOpenPath={onOpenPath}
			/>
		</div>
	);
}

function ImageGenerationStatus({ tool }: { tool: ToolBatchTool }) {
	const active = tool.state === "input-available" || tool.state === "input-queued";
	const failed = tool.state === "output-error" || tool.state === "output-cancelled" || tool.state === "output-interrupted";
	const text =
		tool.detail?.trim() ||
		(active ? "正在生成图片" : failed ? statusLabels[tool.state] : "图片结果正在写入会话");
	return (
		<div
			className={cn(
				"flex min-h-40 w-full max-w-3xl flex-col items-center justify-center gap-3 rounded-xl border bg-muted/20 px-6 py-8 text-center",
				failed && "border-destructive/30 bg-destructive/5",
			)}
			role={failed ? "alert" : "status"}
		>
			{active ? <LoaderCircleIcon className="size-6 animate-spin text-muted-foreground" /> : null}
			<span className={cn("text-sm text-muted-foreground", failed && "text-destructive")}>{text}</span>
		</div>
	);
}

function WebSearchToolDetail({ tool }: { tool: ToolBatchTool }) {
	const sources = tool.sources ?? [];
	if (!sources.length) return null;
	return (
		<div className="grid min-w-0 gap-1.5">
			<div className="flex items-center gap-1 text-xs text-muted-foreground">
				<SearchIcon className="size-3.5 shrink-0" />
				<span>来源 · {sources.length}</span>
			</div>
			<div className="grid min-w-0 gap-1.5">
				{sources.map((source) => (
					<Source href={source.url} key={source.url} title={source.title} />
				))}
			</div>
		</div>
	);
}

function ToolDetail({
	tool,
	sessionId,
	onOpenPath,
}: {
	tool: ToolBatchTool;
	sessionId?: string;
	onOpenPath?: (path: string) => void;
}) {
	const plainText = tool.state === "input-available" || tool.state === "input-queued";
	const title = toolTitle(tool);
	const imagePreview = tool.images?.length ? (
		<ImageToolGallery
			tools={[tool]}
			sessionId={sessionId}
			onOpenPath={onOpenPath}
			large={tool.name === "image_gen"}
		/>
	) : null;

	if (tool.name === "image_gen") {
		return <div className="grid min-w-0 gap-2">{imagePreview ?? <ImageGenerationStatus tool={tool} />}</div>;
	}

	if (tool.name === "web_search") return <WebSearchToolDetail tool={tool} />;

	if (tool.name === "read") {
		if (tool.images?.length) return imagePreview;
		const code = tool.detail ?? "";
		return (
			<div className="grid min-w-0 gap-1">
				{tool.detail ? (
					<CodeBlock
						className="my-0 rounded-md border-0 bg-transparent shadow-none"
						code={code}
						language={plainText ? ("text" as BundledLanguage) : codeLanguageForPath(title)}
						plainText={plainText}
						showLineNumbers
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
			</div>
		);
	}

	if (tool.name === "bash") {
		const code = [`$ ${title}`, tool.detail].filter(Boolean).join("\n\n");
		return (
			<div className="grid min-w-0 gap-1">
				{imagePreview}
				<CodeBlock
					className="my-0 border-border/60 bg-muted/25"
					code={code}
					language={"bash" as BundledLanguage}
					plainText
				>
					<CodeBlockHeader className="border-b-0 bg-transparent px-2 py-1">
						<CodeBlockTitle className="text-foreground">Shell</CodeBlockTitle>
						<CodeBlockActions>
							<CodeBlockCopyButton aria-label="复制命令和输出" />
						</CodeBlockActions>
					</CodeBlockHeader>
				</CodeBlock>
			</div>
		);
	}

	return (
		<div className="grid min-w-0 gap-1">
			{imagePreview}
			{tool.diff ? (
				<ToolDiffOutput
					diff={tool.diff}
					fallbackPath={title}
					onOpenPath={onOpenPath}
					plainText={plainText}
				/>
			) : null}
			{!tool.diff && tool.detail ? (
				<CodeBlock
					className="my-0 border-border/60 bg-muted/25"
					code={tool.detail}
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
		</div>
	);
}

function ToolBatchRow({
	tool,
	sessionId,
	onOpenPath,
	className,
	initialOpen = false,
	open: controlledOpen,
	onOpenChange,
	autoCollapseWhenComplete = false,
}: {
	tool: ToolBatchTool;
	sessionId?: string;
	onOpenPath?: (path: string) => void;
	className?: string;
	initialOpen?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	autoCollapseWhenComplete?: ToolBatchAutoCollapse;
}) {
	const [open, setOpen] = useControllableState({
		defaultProp: initialOpen,
		prop: controlledOpen,
		onChange: onOpenChange,
	});
	const active = tool.state === "input-available" || tool.state === "input-queued";
	const previousActive = useRef(active);
	const title = toolRowTitle(tool);
	const skillName = skillNameFromTool(tool);
	const stats = diffStats(tool.diff);
	const hasDetails =
		tool.name === "image_gen"
			? true
			: tool.name === "web_search"
				? Boolean(tool.sources?.length)
				: Boolean(tool.detail || tool.diff || tool.images?.length || tool.inputPreview || tool.sources?.length);

	useEffect(() => {
		if (
			previousActive.current &&
			!active &&
			tool.name !== "image_gen" &&
			resolveAutoCollapse(autoCollapseWhenComplete)
		)
			setOpen(false);
		previousActive.current = active;
	}, [active, autoCollapseWhenComplete, tool.name]);

	return (
		<Collapsible open={open} onOpenChange={setOpen} className={cn("min-w-0", className)}>
			<CollapsibleTrigger asChild>
				<button
					data-transcript-resize-anchor
					className="flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					type="button"
					aria-label={`${title}，${statusLabels[tool.state]}${hasDetails ? `，${open ? "收起" : "展开"}详情` : ""}`}
				>
					{toolIcon(tool.name, undefined, Boolean(skillName), Boolean(tool.images?.length))}
					<span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={title}>
						{title}
					</span>
					{stats ? (
						<span className="flex shrink-0 gap-1 text-xs">
							{stats.additions ? <span className="text-emerald-600">+{stats.additions}</span> : null}
							{stats.deletions ? <span className="text-destructive">-{stats.deletions}</span> : null}
						</span>
					) : null}
					<span className="flex shrink-0 items-center gap-1.5">
						{toolStatusIndicator(tool.state)}
						{tool.state !== "output-available" ? (
							<span className="text-xs text-muted-foreground">{statusLabels[tool.state]}</span>
						) : null}
						{hasDetails ? (
							<ChevronDownIcon
								className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")}
							/>
						) : null}
					</span>
				</button>
			</CollapsibleTrigger>
			{hasDetails ? (
				<CollapsibleContent
					data-transcript-resize-anchor
					className="min-w-0 max-h-[min(32rem,60vh)] overflow-y-auto overflow-x-hidden overscroll-contain pb-0.5 pl-6 pr-0 pt-0"
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
						<ToolDetail tool={tool} sessionId={sessionId} onOpenPath={onOpenPath} />
					</StabilityBoundary>
				</CollapsibleContent>
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
	toolOpen,
	onToolOpenChange,
}: ToolBatchProps) {
	const active = tools.some((tool) => tool.state === "input-available" || tool.state === "input-queued");
	const aggregateState = batchState(tools);
	const imageGallery = tools.length > 0 && tools.every((tool) => tool.images?.length);
	const imageGeneration = tools.some((tool) => tool.name === "image_gen");
	const searchHasSources = tools.length === 1 && tools[0]?.name === "web_search" && Boolean(tools[0].sources?.length);
	const [open, setOpen] = useControllableState({
		defaultProp: imageGallery || imageGeneration || initialOpen || searchHasSources,
		prop: imageGeneration ? undefined : controlledOpen,
		onChange: imageGeneration ? undefined : onOpenChange,
	});
	const previousActive = useRef(active);

	useEffect(() => {
		if (previousActive.current && !active && !imageGeneration && resolveAutoCollapse(autoCollapseWhenComplete))
			setOpen(false);
		previousActive.current = active;
	}, [active, autoCollapseWhenComplete, imageGeneration]);

	if (!tools.length) return null;
	const allToolsCompleted = tools.every(isToolComplete);
	if (!allToolsCompleted && tools.length > 1) {
		return (
			<div className={cn("tool-batch-stack", className)}>
				{tools.map((tool) => (
					<ToolBatchRow
						key={tool.id}
						tool={tool}
						sessionId={sessionId}
						onOpenPath={onOpenPath}
						initialOpen={false}
						open={toolOpen ? (toolOpen.get(tool.id) ?? false) : undefined}
						onOpenChange={toolOpen ? (nextOpen) => onToolOpenChange?.(tool.id, nextOpen) : undefined}
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
				<CollapsibleContent
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
				</CollapsibleContent>
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
				initialOpen={
					imageTool ||
					imageGenerationTool ||
					initialOpen ||
					(tool.name === "web_search" && Boolean(tool.sources?.length))
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
				aria-label={`${summaryLabel ?? batchTitle(tools)}，${statusLabels[aggregateState]}${open ? "，收起" : "，展开"}`}
			>
				{toolIcon(
					tools[0]?.name ?? "tool",
					undefined,
					Boolean(tools[0] && skillNameFromTool(tools[0])),
					Boolean(tools[0]?.images?.length),
				)}
				<span className="min-w-0 flex-1 truncate font-mono text-[13px]">
					{summaryLabel ?? batchTitle(tools)}
				</span>
				<span className="flex shrink-0 items-center gap-1.5">
					{aggregateState !== "output-available" ? (
						<span className="text-xs text-muted-foreground">{statusLabels[aggregateState]}</span>
					) : null}
					{aggregateState === "input-available" ? toolStatusIndicator(aggregateState) : null}
					<ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]/tool-batch:rotate-180" />
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent
				data-transcript-resize-anchor
				className="relative min-w-0 max-h-[min(34rem,60vh)] overflow-y-auto overflow-x-hidden overscroll-contain pb-0"
				onClick={(event) => {
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
							open={toolOpen ? (toolOpen.get(tool.id) ?? false) : undefined}
							onOpenChange={toolOpen ? (nextOpen) => onToolOpenChange?.(tool.id, nextOpen) : undefined}
						/>
					))}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
});

export { statusLabels as toolBatchStatusLabels, toolTitle };
