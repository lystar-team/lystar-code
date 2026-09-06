import { Check, CircleHelp, Clipboard, FileCode2 } from "lucide-react";
import { useState } from "react";
import type { BundledLanguage } from "shiki";
import { type TranscriptToolViewModel, toSessionItemViewModel } from "../../adapters/session-view-model";
import { cn } from "../../lib/utils";
import type { WorkbenchState } from "../../state/use-workbench";
import { Attachment, AttachmentInfo, AttachmentPreview, Attachments } from "../ai-elements/attachments";
import { CodeBlock, CodeBlockActions, CodeBlockCopyButton, CodeBlockDownloadButton, CodeBlockFilename, CodeBlockHeader, CodeBlockTitle } from "../ai-elements/code-block";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "../ai-elements/message";
import { PromptTokenContent, hasPromptTokens } from "../ai-elements/prompt-token.tsx";
import { ResourceImage } from "../ai-elements/resource-preview";
import { Source, Sources, SourcesContent, SourcesTrigger } from "../ai-elements/sources";
import { Task, TaskContent, TaskTrigger } from "../ai-elements/task";
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

export function TranscriptItemView({
	item,
	toolStatuses,
	actions,
	sessionId,
	showCopy,
}: {
	item: WorkbenchState["transcript"][number];
	toolStatuses: ReadonlyMap<string, "success" | "error">;
	actions: WorkbenchActions;
	sessionId?: string;
	showCopy: boolean;
}) {
	const viewModel = toSessionItemViewModel(item, toolStatuses);
	if (viewModel.kind === "message") {
		return (
			<Message
				from={viewModel.role}
				className={cn(
					viewModel.role === "user" && "max-w-[84%] self-end",
					viewModel.role === "system" && "rounded-md bg-muted/50 p-3",
				)}
			>
				<TranscriptSources urls={viewModel.sources} />
				<MessageContent>
					{viewModel.role === "user" && hasPromptTokens(viewModel.text) ? (
						<PromptTokenContent text={viewModel.text} />
					) : (
						<MessageResponse
							mode="static"
							parseIncompleteMarkdown
							linkSafety={{ enabled: true }}
							controls={{ code: { copy: true, download: true }, table: { copy: true, download: true } }}
							onOpenPath={(path) => void actions.openResource(path)}
						>
							{viewModel.text || " "}
						</MessageResponse>
					)}
					<TranscriptAttachments attachments={viewModel.attachments} sessionId={sessionId} />
				</MessageContent>
				{showCopy && viewModel.role === "assistant" && viewModel.text ? (
					<CopyMessageAction text={viewModel.text} />
				) : null}
			</Message>
		);
	}
	if (viewModel.kind === "reasoning") return null;
	if (viewModel.kind === "tools")
		return (
			<ToolBatch
				className="tool-batch-render-item"
				tools={viewModel.tools}
				sessionId={sessionId}
				onOpenPath={(path) => void actions.openResource(path)}
			/>
		);
	if (viewModel.kind === "code") return <CodeBlockView code={viewModel.code} language={viewModel.language} />;
	return (
		<Task defaultOpen>
			<TaskTrigger title={viewModel.title} />
			<TaskContent>
				<MessageResponse mode="static" onOpenPath={(path) => void actions.openResource(path)}>
					{viewModel.text}
				</MessageResponse>
			</TaskContent>
		</Task>
	);
}

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
		<Attachments className="mt-2" variant="inline">
			{attachments.map((attachment) => (
				<Attachment key={attachment.id} data={{ ...attachment, type: "file" }}>
					{attachment.mediaType.startsWith("image/") && sessionId ? (
						<ResourceImage
							sessionId={sessionId}
							contentRef={attachment.id}
							alt={attachment.filename}
							className="w-48"
						/>
					) : (
						<AttachmentPreview />
					)}
					<AttachmentInfo />
				</Attachment>
			))}
		</Attachments>
	);
}

export function CodeBlockView({
	code,
	language,
	wrap = false,
	embedded = false,
}: {
	code: string;
	language: string;
	wrap?: boolean;
	embedded?: boolean;
}) {
	return (
		<CodeBlock
			className={cn("my-0", embedded && "border-0 bg-transparent shadow-none")}
			code={code}
			language={language as BundledLanguage}
			transparent={embedded}
			wrap={wrap}
		>
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
