"use client";

import { Code2Icon, TerminalIcon } from "lucide-react";
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
const CODEMODE_WAIT_TABS = [
	{ value: "output", label: "输出", icon: TerminalIcon },
	{ value: "script", label: "原脚本", icon: Code2Icon },
] as const;

export function CodemodeToolDetail({
	tool,
	imagePreview,
	children,
}: {
	tool: ToolBatchTool;
	imagePreview?: ReactNode;
	children?: ReactNode;
}) {
	const [tab, setTab] = useState("output");
	const [wrap, setWrap] = useState(true);
	const waiting = tool.name === "codemode_wait";
	const source = useMemo(() => {
		if (waiting) return tool.codemode?.source;
		try {
			const input: unknown = JSON.parse(tool.summary);
			if (input && typeof input === "object" && "code" in input && typeof input.code === "string") return input.code;
		} catch {
			// 流式参数或截断的参数保留原文，避免把不完整 JSON 当作脚本。
		}
		return undefined;
	}, [tool.summary, tool.codemode?.source, waiting]);
	const active = tool.state === "input-available" || tool.state === "input-queued";
	const output = tool.detail === tool.summary && active ? undefined : tool.detail;
	const parameterPreview = !waiting && source === undefined && tool.summary !== tool.name ? tool.summary : undefined;

	return (
		<Tabs className="min-w-0 gap-0" value={tab} onValueChange={setTab}>
			{waiting ? <p className="mb-2 text-xs leading-5 text-muted-foreground">继续收集之前脚本的结果，不会重新执行脚本。{tool.codemode?.status === "running" && !active ? "脚本仍在运行，尚未返回最终结果。" : ""}</p> : null}
			{children}
			<WorkbenchTabBar activeId={tab} tabs={waiting ? CODEMODE_WAIT_TABS : CODEMODE_TABS} label={waiting ? "脚本等待详情" : "脚本执行详情"} className="mb-2 !w-44 !self-start" compact />
			<TabsContent className="min-w-0 data-[state=inactive]:hidden" value="output" forceMount>
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
			<TabsContent className="min-w-0 data-[state=inactive]:hidden" value="script" forceMount>
				{source !== undefined || parameterPreview ? (
					<CodeBlock
						className="my-0 border-border/60 bg-muted/25 [&>div:last-child]:max-h-80 [&>div:last-child]:overflow-auto"
						code={source ?? parameterPreview ?? ""}
						language={source === undefined ? ("text" as BundledLanguage) : "javascript"}
						plainText={active || source === undefined}
						showLineNumbers
						wrap={wrap}
					>
						<CodeBlockHeader className="border-b-0 bg-transparent px-2 py-1">
							<CodeBlockTitle className="text-foreground">{source === undefined ? "参数预览" : "JavaScript"}</CodeBlockTitle>
							<CodeBlockActions>
								{source !== undefined ? (
									<Button aria-pressed={wrap} onClick={() => setWrap(!wrap)} size="xs" type="button" variant="ghost">自动换行</Button>
								) : null}
								<CodeBlockCopyButton aria-label={source === undefined ? "复制参数预览" : "复制脚本"} size="icon-xs" />
							</CodeBlockActions>
						</CodeBlockHeader>
					</CodeBlock>
				) : (
					<p className="py-2 text-xs text-muted-foreground">{waiting ? "本次结果未包含原脚本，可在前面的脚本执行记录中查看。" : active ? "脚本生成中" : "本次执行未记录脚本"}</p>
				)}
			</TabsContent>
		</Tabs>
	);
}
