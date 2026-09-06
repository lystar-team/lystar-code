"use client";

import type { ToolDiff } from "@lystar/code-gui-protocol";
import {
	ChevronDownIcon,
	FileCode2Icon,
	FileTextIcon,
	FolderIcon,
	LoaderCircleIcon,
	PencilIcon,
	SearchIcon,
	TerminalIcon,
	WrenchIcon,
} from "lucide-react";
import { type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { BundledLanguage } from "shiki";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { CodeBlock, CodeBlockActions, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from "./code-block";
import { ResourceImage } from "./resource-preview";

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
	images?: Array<{ contentRef: string; mimeType: string; byteLength: number; alt?: string }>;
	diff?: ToolDiff;
	inputPreview?: boolean;
}

export interface ToolBatchProps {
	tools: ToolBatchTool[];
	className?: string;
	initialOpen?: boolean;
	autoCollapseWhenComplete?: boolean;
	sessionId?: string;
	onOpenPath?: (path: string) => void;
}

const statusLabels: Record<ToolBatchState, string> = {
	"input-available": "运行中",
	"input-queued": "已排队",
	"output-available": "已完成",
	"output-error": "出错",
	"output-cancelled": "已取消",
	"output-interrupted": "已中断",
};

function toolIcon(name: string, className?: string): ReactNode {
	const Icon =
		name === "bash"
			? TerminalIcon
			: name === "edit" || name === "write" || name === "apply_patch"
				? PencilIcon
				: name === "read"
					? FileTextIcon
					: name === "find" || name === "grep"
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

function toolTitle(tool: ToolBatchTool): string {
	const parsed = parseToolSummary(tool.summary);
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
		ls: "查看了目录",
	};
	return labels[name] ?? `调用了 ${name}`;
}

function toolRowActionLabel(name: string, state: ToolBatchState): string {
	if (state === "input-available") return "运行中";
	if (state === "input-queued") return "已排队";
	const labels: Record<string, string> = {
		bash: "已运行",
		read: "已读取",
		edit: "已编辑",
		write: "已写入",
		apply_patch: "已应用补丁",
		find: "已查找",
		grep: "已搜索",
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

function toolRowTitle(tool: ToolBatchTool): string {
	const title = toolTitle(tool);
	const action = toolRowActionLabel(tool.name, tool.state);
	return title && title !== tool.name ? `${action} ${title}` : action;
}

function canCollapseFromContent(event: ReactMouseEvent<HTMLElement>): boolean {
	if (event.defaultPrevented) return false;
	const target = event.target;
	if (target instanceof Element && target.closest("button, a, input, textarea, select, [role=button]")) return false;
	const selection = window.getSelection();
	return !selection || selection.isCollapsed;
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
}: {
	diff: ToolDiff;
	fallbackPath?: string;
	onOpenPath?: (path: string) => void;
}) {
	return (
		<div className="grid gap-1">
			{diff.files.map((file, index) => {
				const displayPath = file.path || (diff.files.length === 1 ? fallbackPath : undefined);
				return (
					<div className="grid gap-1" key={`${file.path ?? "file"}-${file.operation ?? "change"}-${index}`}>
						<div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
							<FileCode2Icon className="size-3.5 shrink-0" />
							{onOpenPath && displayPath ? (
								<button
									className="min-w-0 flex-1 truncate text-left font-mono text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
									onClick={() => onOpenPath(displayPath)}
									type="button"
								>
									{displayPath}
								</button>
							) : (
								<span className="min-w-0 flex-1 truncate font-mono">{displayPath || "未命名文件"}</span>
							)}
							{typeof file.additions === "number" ? (
								<span className="text-emerald-600">+{file.additions}</span>
							) : null}
							{typeof file.deletions === "number" ? (
								<span className="text-destructive">-{file.deletions}</span>
							) : null}
						</div>
						{file.diff ? (
							<CodeBlock
								className="my-0 border-border/60 bg-muted/25"
								code={file.diff}
								language={"diff" as BundledLanguage}
							>
								<CodeBlockHeader className="border-b-0 bg-transparent px-2 py-1">
									<CodeBlockTitle className="min-w-0 text-foreground">
										<FileCode2Icon className="size-3.5 shrink-0" />
										<span className="truncate font-mono">{displayPath || "diff"}</span>
									</CodeBlockTitle>
									<CodeBlockActions>
										<CodeBlockCopyButton aria-label="复制差异" />
									</CodeBlockActions>
								</CodeBlockHeader>
							</CodeBlock>
						) : null}
					</div>
				);
			})}
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
	const title = toolTitle(tool);
	const stats = diffStats(tool.diff);
	const imagePreview = tool.images?.length ? (
		<div className="grid min-w-0 gap-1">
			{tool.images.map((image) => (
				<ResourceImage
					key={image.contentRef}
					sessionId={sessionId}
					contentRef={image.contentRef}
					alt={image.alt || title}
					pathLabel={title}
					onOpenPath={onOpenPath}
				/>
			))}
		</div>
	) : null;

	if (tool.name === "read") {
		const code = tool.detail ?? "";
		return (
			<div className="grid min-w-0 gap-1">
				{imagePreview}
				{tool.detail ? (
					<CodeBlock
						className="my-0 rounded-md border-0 bg-transparent shadow-none"
						code={code}
						language={codeLanguageForPath(title)}
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
			{tool.inputPreview ? <div className="text-xs text-muted-foreground">参数预览，终态以工具真实结果为准</div> : null}
			{imagePreview}
			{stats ? (
				<div className="text-xs text-muted-foreground">
					{stats.additions ? <span className="mr-2 text-emerald-600">+{stats.additions}</span> : null}
					{stats.deletions ? <span className="text-destructive">-{stats.deletions}</span> : null}
				</div>
			) : null}
			{tool.diff ? <ToolDiffOutput diff={tool.diff} fallbackPath={title} onOpenPath={onOpenPath} /> : null}
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
	autoCollapseWhenComplete = false,
}: {
	tool: ToolBatchTool;
	sessionId?: string;
	onOpenPath?: (path: string) => void;
	className?: string;
	initialOpen?: boolean;
	autoCollapseWhenComplete?: boolean;
}) {
	const [open, setOpen] = useState(initialOpen);
	const active = tool.state === "input-available" || tool.state === "input-queued";
	const previousActive = useRef(active);
	const title = toolRowTitle(tool);
	const stats = diffStats(tool.diff);
	const hasDetails = Boolean(tool.detail || tool.diff || tool.images?.length || tool.inputPreview);

	useEffect(() => {
		if (!previousActive.current && active) setOpen(true);
		if (previousActive.current && !active && autoCollapseWhenComplete) setOpen(false);
		previousActive.current = active;
	}, [active, autoCollapseWhenComplete]);

	return (
		<Collapsible open={open} onOpenChange={setOpen} className={cn("min-w-0", className)}>
			<CollapsibleTrigger asChild>
				<button
					className="flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					type="button"
					aria-label={`${title}，${statusLabels[tool.state]}${hasDetails ? "，展开详情" : ""}`}
				>
					{toolIcon(tool.name)}
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
					className="min-w-0 overflow-hidden pb-0.5 pl-6 pr-0 pt-0 data-[state=closed]:animate-out data-[state=open]:animate-in"
					onClick={(event) => {
						if (canCollapseFromContent(event)) setOpen(false);
					}}
				>
					<ToolDetail tool={tool} sessionId={sessionId} onOpenPath={onOpenPath} />
				</CollapsibleContent>
			) : null}
		</Collapsible>
	);
}

export function ToolBatch({
	tools,
	className,
	initialOpen = false,
	autoCollapseWhenComplete = false,
	sessionId,
	onOpenPath,
}: ToolBatchProps) {
	const active = tools.some((tool) => tool.state === "input-available" || tool.state === "input-queued");
	const aggregateState = batchState(tools);
	const [open, setOpen] = useState(initialOpen);
	const previousActive = useRef(active);

	useEffect(() => {
		if (!previousActive.current && active) setOpen(true);
		if (previousActive.current && !active && autoCollapseWhenComplete) setOpen(false);
		previousActive.current = active;
	}, [active, autoCollapseWhenComplete]);

	if (!tools.length) return null;
	if (tools.length === 1) {
		const tool = tools[0];
		return tool ? (
			<ToolBatchRow
				tool={tool}
				sessionId={sessionId}
				onOpenPath={onOpenPath}
				initialOpen={initialOpen}
				className={className}
				autoCollapseWhenComplete={autoCollapseWhenComplete}
			/>
		) : null;
	}

	return (
		<Collapsible
			className={cn("group/tool-batch relative min-w-0 w-full", className)}
			open={open}
			onOpenChange={setOpen}
		>
			<CollapsibleTrigger
				className="flex min-h-8 w-full min-w-0 items-center gap-1.5 px-0 py-0.5 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				type="button"
				aria-label={`${batchTitle(tools)}，${statusLabels[aggregateState]}${open ? "，收起" : "，展开"}`}
			>
				{toolIcon(tools[0]?.name ?? "tool")}
				<span className="min-w-0 flex-1 truncate font-medium text-sm text-muted-foreground">
					{batchTitle(tools)}
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
				className="relative min-w-0 max-h-[min(34rem,60vh)] overflow-y-auto overflow-x-hidden pb-0 pl-0.5 data-[state=closed]:animate-out data-[state=open]:animate-in"
				onClick={(event) => {
					if (canCollapseFromContent(event)) setOpen(false);
				}}
			>
				<div className="relative z-0 grid min-w-0 gap-0">
					{tools.map((tool) => (
						<ToolBatchRow key={tool.id} tool={tool} sessionId={sessionId} onOpenPath={onOpenPath} />
					))}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

export { statusLabels as toolBatchStatusLabels, toolTitle };
