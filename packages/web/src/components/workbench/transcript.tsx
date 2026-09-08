import { Check, CircleHelp, Clipboard, FileCode2 } from "lucide-react";
import { memo, useState } from "react";
import type { BundledLanguage } from "shiki";
import { type TranscriptToolViewModel, toSessionItemViewModel } from "../../adapters/session-view-model";
import { cn } from "../../lib/utils";
import type { WorkbenchState } from "../../state/use-workbench";
import { CodeBlock, CodeBlockActions, CodeBlockCopyButton, CodeBlockDownloadButton, CodeBlockFilename, CodeBlockHeader, CodeBlockTitle } from "../ai-elements/code-block";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "../ai-elements/message";
import { PromptTokenContent, hasPromptTokenCandidates } from "../ai-elements/prompt-token.tsx";
import { ResourceImage } from "../ai-elements/resource-preview";
import { Source, Sources, SourcesContent, SourcesTrigger } from "../ai-elements/sources";
import { Task, TaskContent, TaskTrigger } from "../ai-elements/task";
import { CompactionSummaryCard } from "./compaction-card";
import { ToolBatch } from "../ai-elements/tool-batch";
import { Button } from "../ui/button";
import type { WorkbenchActions } from "./types";

export function AgentErrorCard({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
	return (
		<div
			className="agent-error-card mx-auto flex w-full max-w-none items-center gap-3 rounded-[48px] border border-border bg-background px-5 py-4 text-foreground shadow-none"
			role="alert"
		>
			<CircleHelp className="size-5 shrink-0" />
			<div className="min-w-0 flex-1">
				<div className="text-base font-medium">{title}</div>
				<div className="mt-1 break-words text-sm text-muted-foreground">{message}</div>
			</div>
			{onRetry ? (
				<Button className="shrink-0" size="sm" variant="outline" onClick={onRetry}>
					重试
				</Button>
			) : null}
		</div>
	);
}

export const TranscriptMessageView = memo(function TranscriptMessageView({
	role,
	text,
	attachments = [],
	sources = [],
	showCopy,
	sessionId,
	projectId,
	onOpenPath,
	mode = "static",
}: {
	role: "user" | "assistant" | "system";
	text: string;
	attachments?: Array<{ id: string; filename: string; mediaType: string; url: string }>;
	sources?: string[];
	showCopy: boolean;
	sessionId?: string;
	projectId?: string;
	onOpenPath: WorkbenchActions["openResource"];
	mode?: "static" | "streaming";
}) {
	return (
		<Message
			from={role}
			className={cn(
				role === "user" && "max-w-[84%] self-end",
				role === "system" && "rounded-md bg-muted/50 p-3",
			)}
		>
			<TranscriptSources urls={sources} />
			<MessageContent>
				{role === "user" && hasPromptTokenCandidates(text) ? (
					<PromptTokenContent text={text} projectId={projectId} sessionId={sessionId} />
				) : (
					<MessageResponse
						mode={mode}
						parseIncompleteMarkdown
						linkSafety={{ enabled: true }}
						controls={{ code: { copy: true, download: true }, table: { copy: true, download: true } }}
						onOpenPath={(path) => void onOpenPath(path)}
					>
						{text || " "}
					</MessageResponse>
				)}
				<TranscriptAttachments attachments={attachments} sessionId={sessionId} />
			</MessageContent>
			{showCopy && role === "assistant" && text ? <CopyMessageAction text={text} /> : null}
		</Message>
	);
});

export const TranscriptItemView = memo(function TranscriptItemView({
	item,
	toolStatuses,
	onOpenPath,
	sessionId,
	projectId,
	showCopy,
}: {
	item: WorkbenchState["transcript"][number];
	toolStatuses: ReadonlyMap<string, "success" | "error">;
	onOpenPath: WorkbenchActions["openResource"];
	sessionId?: string;
	projectId?: string;
	showCopy: boolean;
}) {
	const viewModel = toSessionItemViewModel(item, toolStatuses);
	if (viewModel.kind === "message") {
		return (
			<TranscriptMessageView
				role={viewModel.role}
				text={viewModel.text}
				attachments={viewModel.attachments}
				sources={viewModel.sources}
				showCopy={showCopy}
				sessionId={sessionId}
				projectId={projectId}
				onOpenPath={onOpenPath}
			/>
		);
	}
	if (viewModel.kind === "reasoning") return null;
	if (viewModel.kind === "tools")
		return (
			<ToolBatch
				className="tool-batch-render-item"
				tools={viewModel.tools}
				sessionId={sessionId}
				onOpenPath={(path) => void onOpenPath(path)}
			/>
		);
	if (viewModel.kind === "code") return <CodeBlockView code={viewModel.code} language={viewModel.language} />;
	if (viewModel.variant === "compaction" || viewModel.title === "上下文压缩") {
		return <CompactionSummaryCard text={viewModel.text} tokensBefore={viewModel.tokensBefore} onOpenPath={onOpenPath} />;
	}
	return (
		<Task defaultOpen>
			<TaskTrigger title={viewModel.title} />
			<TaskContent>
				<MessageResponse mode="static" onOpenPath={(path) => void onOpenPath(path)}>
					{viewModel.text}
				</MessageResponse>
			</TaskContent>
		</Task>
	);
});

function TranscriptSources({ urls }: { urls: string[] }) {
	if (!urls.length) return null;
	return (
		<Sources>
			<SourcesTrigger count={urls.length}>
				<span>来源 · {urls.length}</span>
			</SourcesTrigger>
			<SourcesContent>
				{urls.map((url) => (
					<Source href={url} key={url} title={url.replace(/^https?:\/\//iu, "").slice(0, 72)} />
				))}
			</SourcesContent>
		</Sources>
	);
}

function TranscriptAttachments({
	attachments,
	sessionId,
}: {
	attachments: Array<{ id: string; filename: string; mediaType: string; url: string }>;
	sessionId?: string;
}) {
	if (!attachments.length) return null;
	return (
		<div className="mt-2 flex flex-wrap gap-2">
			{attachments.map((attachment) => {
				const hasPreviewUrl = Boolean(attachment.url);
				return (
					<ResourceImage
						key={attachment.id}
						src={hasPreviewUrl ? attachment.url : undefined}
						sessionId={hasPreviewUrl ? undefined : sessionId}
						contentRef={hasPreviewUrl ? undefined : attachment.id}
						alt={attachment.filename}
						className="w-48 max-w-full"
					/>
				);
			})}
		</div>
	);
}

export function CodeBlockView({
	code,
	language,
	wrap = false,
	embedded = false,
	showActions = true,
}: {
	code: string;
	language: string;
	wrap?: boolean;
	embedded?: boolean;
	showActions?: boolean;
}) {
	return (
		<CodeBlock
			className={cn("my-0", embedded && "border-0 bg-transparent shadow-none")}
			code={code}
			language={language as BundledLanguage}
			transparent={embedded}
			wrap={wrap}
		>
			{showActions ? (
				<CodeBlockHeader
					className={cn(embedded ? "justify-end border-b-0 bg-transparent px-0 py-0 text-foreground" : undefined)}
				>
					{embedded ? null : (
						<CodeBlockTitle>
							<FileCode2 className="size-4" />
							<CodeBlockFilename>{language}</CodeBlockFilename>
						</CodeBlockTitle>
					)}
					<CodeBlockActions className={embedded ? "-my-1 -mr-1" : undefined}>
						<CodeBlockDownloadButton aria-label="下载代码" filename={`code.${language}`} />
						<CodeBlockCopyButton aria-label="复制代码" />
					</CodeBlockActions>
				</CodeBlockHeader>
			) : null}
		</CodeBlock>
	);
}

function CopyMessageAction({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			setCopied(false);
		}
	};
	return (
		<MessageActions className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
			<MessageAction label="复制回复" tooltip="复制回复" onClick={() => void copy()}>
				{copied ? <Check className="size-4" /> : <Clipboard className="size-4" />}
			</MessageAction>
		</MessageActions>
	);
}
