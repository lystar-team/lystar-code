"use client";

import { CheckCircle2Icon, CircleXIcon, Clock3Icon, Code2Icon, LoaderCircleIcon, TerminalIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { BundledLanguage } from "shiki";
import type { ToolBatchTool } from "../../types.ts";
import { Button } from "../ui/button";
import { Tabs, TabsContent } from "../ui/tabs";
import { WorkbenchTabBar } from "../workbench/workbench-tab-bar";
import { CodeBlock, CodeBlockActions, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from "./code-block";
import { CodemodeOutput } from "./codemode-output";

const CODEMODE_TABS = [
	{ value: "output", label: "输出", icon: TerminalIcon },
	{ value: "script", label: "脚本", icon: Code2Icon },
] as const;

function formatDuration(durationMs: number | undefined): string {
	if (durationMs === undefined) return "";
	return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

function callStatus(call: NonNullable<ToolBatchTool["codemode"]>["calls"][number]): ReactNode {
	if (call.status === "running") return <LoaderCircleIcon aria-label="执行中" className="size-3.5 animate-spin text-primary" />;
	if (call.status === "ok") return <CheckCircle2Icon aria-label="成功" className="size-3.5 text-emerald-600" />;
	if (call.status === "error") return <CircleXIcon aria-label="失败" className="size-3.5 text-destructive" />;
	return <Clock3Icon aria-label="已取消" className="size-3.5 text-muted-foreground" />;
}

function callStatusLabel(status: NonNullable<ToolBatchTool["codemode"]>["calls"][number]["status"]): string {
	if (status === "running") return "执行中";
	if (status === "ok") return "成功";
	if (status === "error") return "失败";
	return "已取消";
}

function formatCallArgs(args: string): string {
	try {
		const parsed: unknown = JSON.parse(args);
		return JSON.stringify(parsed, null, 2);
	} catch {
		return args;
	}
}

function CodemodeExecutionSummary({ tool }: { tool: ToolBatchTool }) {
	const calls = tool.codemode?.calls ?? [];
	if (calls.length === 0) return null;
	return (
		<section aria-label="脚本执行过程" className="grid min-w-0 gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
			<div className="flex items-center justify-between gap-2 text-xs">
				<span className="font-medium text-foreground">执行过程</span>
				<span className="text-muted-foreground">{calls.length} 次工具调用</span>
			</div>
			<div className="grid min-w-0 gap-1">
				{calls.map((call) => (
					<details className="group/codemode-call min-w-0 rounded-sm" key={call.id}>
						<summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-sm px-1 py-1 text-xs hover:bg-muted/60 [&::-webkit-details-marker]:hidden">
							{callStatus(call)}
							<span className="min-w-0 flex-1 truncate font-mono text-foreground" title={call.name}>{call.name}</span>
							<span className="shrink-0 text-muted-foreground">{callStatusLabel(call.status)}</span>
							{call.durationMs !== undefined ? <span className="shrink-0 font-mono text-muted-foreground">{formatDuration(call.durationMs)}</span> : null}
						</summary>
						<div className="ml-5 grid min-w-0 gap-1 border-l border-border/70 pl-2 text-xs">
							<span className="text-muted-foreground">参数</span>
							<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background/70 p-2 font-mono text-[11px] leading-4 text-foreground">{formatCallArgs(call.args)}</pre>
							{call.error ? <p className="whitespace-pre-wrap break-words text-destructive">{call.error}</p> : null}
						</div>
					</details>
				))}
			</div>
		</section>
	);
}

export function CodemodeToolDetail({ tool, imagePreview }: { tool: ToolBatchTool; imagePreview?: ReactNode }) {
	const [selectedTab, setSelectedTab] = useState<string>();
	const [wrap, setWrap] = useState(true);
	const source = useMemo(() => {
		try {
			const input: unknown = JSON.parse(tool.summary);
			if (input && typeof input === "object" && "code" in input && typeof input.code === "string") return input.code;
		} catch {
			// 流式参数或截断的参数保留原文，避免把不完整 JSON 当作脚本。
		}
		return undefined;
	}, [tool.summary]);
	const active = tool.state === "input-available" || tool.state === "input-queued";
	const output = tool.detail === tool.summary && active ? undefined : tool.detail;
	const tab = selectedTab ?? (output ? "output" : active ? "script" : "output");
	const parameterPreview = source === undefined && tool.summary !== tool.name ? tool.summary : undefined;

	return (
		<Tabs className="min-w-0 gap-0" value={tab} onValueChange={setSelectedTab}>
			<CodemodeExecutionSummary tool={tool} />
			<WorkbenchTabBar activeId={tab} tabs={CODEMODE_TABS} label="脚本执行详情" className="mb-2 !w-44 !self-start" compact />
			<TabsContent className="min-w-0" value="output">
				<div className="grid min-w-0 gap-2">
					{imagePreview}
					{output ? (
						<CodemodeOutput output={output} />
					) : (
						<p className="py-2 text-xs text-muted-foreground">
							{active ? "等待脚本输出" : "本次执行未记录文本输出"}
						</p>
					)}
				</div>
			</TabsContent>
			<TabsContent className="min-w-0" value="script">
				{source !== undefined || parameterPreview ? (
					<CodeBlock
						className="my-0 border-border/60 bg-muted/25 [&>div:last-child]:max-h-80 [&>div:last-child]:overflow-auto"
						code={source ?? parameterPreview ?? ""}
						language={source === undefined ? ("text" as BundledLanguage) : "javascript"}
						plainText={source === undefined}
						showLineNumbers
						wrap={wrap}
					>
						<CodeBlockHeader className="border-b-0 bg-transparent px-2 py-1">
							<CodeBlockTitle className="text-foreground">{source === undefined ? "参数预览" : "JavaScript"}</CodeBlockTitle>
							<CodeBlockActions>
								{source !== undefined ? (
									<Button aria-pressed={wrap} className="h-7 px-2 text-xs" onClick={() => setWrap(!wrap)} size="sm" type="button" variant="ghost">自动换行</Button>
								) : null}
								<CodeBlockCopyButton aria-label={source === undefined ? "复制参数预览" : "复制脚本"} />
							</CodeBlockActions>
						</CodeBlockHeader>
					</CodeBlock>
				) : (
					<p className="py-2 text-xs text-muted-foreground">{active ? "脚本生成中" : "本次执行未记录脚本"}</p>
				)}
			</TabsContent>
		</Tabs>
	);
}
