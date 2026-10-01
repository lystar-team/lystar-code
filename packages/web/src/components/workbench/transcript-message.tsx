import { Check, Clipboard, Pencil, Trash2 } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { readTranscriptText } from "../../adapters/transcript-content.ts";
import { cn } from "../../lib/utils";
import { Attachment, AttachmentInfo, AttachmentPreview, Attachments } from "../ai-elements/attachments";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse, PromptResponse } from "../ai-elements/message";
import { PromptTokenContent, hasPromptTokenCandidates } from "../ai-elements/prompt-token.tsx";
import { ResourceImage } from "../ai-elements/resource-preview";
import { Source, Sources, SourcesContent, SourcesTrigger } from "../ai-elements/sources";
import { StabilityBoundary } from "../stability-boundary";
import type { WorkbenchActions } from "./types";

export const TranscriptMessageView = memo(function TranscriptMessageView({
	role,
	text,
	fullText,
	contentRef,
	truncated,
	onExpansionIntent,
	durationLabel,
	statusLabel,
	attachments = [],
	sources = [],
	showCopy,
	sessionId,
	projectId,
	onOpenPath,
	onEdit,
	onRemove,
	mode = "static",
}: {
	role: "user" | "assistant" | "system";
	text: string;
	fullText?: string;
	contentRef?: string;
	truncated?: boolean;
	onExpansionIntent?: () => void;
	durationLabel?: string;
	statusLabel?: string;
	attachments?: Array<{ id: string; filename: string; mediaType: string; url: string }>;
	sources?: string[];
	showCopy: boolean;
	sessionId?: string;
	projectId?: string;
	onOpenPath: WorkbenchActions["openResource"];
	onEdit?: () => void;
	onRemove?: () => void;
	mode?: "static" | "streaming";
}) {
	const fullTextRequest = useRef<{ key: string; promise: Promise<string> }>();
	const readFullText = useCallback(() => {
		if (fullText !== undefined) return Promise.resolve(fullText);
		if (!contentRef) return Promise.resolve(text);
		if (!sessionId) return Promise.reject(new Error("缺少全文所属会话"));
		const key = `${sessionId}:${contentRef}`;
		if (fullTextRequest.current?.key === key) return fullTextRequest.current.promise;
		const promise = readTranscriptText(sessionId, contentRef);
		fullTextRequest.current = { key, promise };
		void promise.catch(() => { if (fullTextRequest.current?.promise === promise) fullTextRequest.current = undefined; });
		return promise;
	}, [contentRef, fullText, sessionId, text]);
	return (
		<Message
			from={role}
			className={cn(
				role === "user" && "max-w-[84%] self-end",
				role === "system" && "rounded-md bg-muted/50 p-3",
			)}
		>
			<TranscriptSources urls={sources} />
			<MessageContent className={role === "user" && attachments.length ? "!gap-1" : undefined}>
				<StabilityBoundary
					scope={`message:${role}`}
					fallback={() => (
						<pre className="max-w-full whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 font-mono text-sm" role="alert">
							{text || "消息内容渲染失败"}
						</pre>
					)}
				>
					{role === "user" && hasPromptTokenCandidates(text) ? (
						<PromptTokenContent text={text} projectId={projectId} sessionId={sessionId} />
					) : role === "user" ? (
						<PromptResponse>{text || " "}</PromptResponse>
					) : (
						<ExpandableAssistantText
							text={text}
							fullText={fullText}
							readFullText={readFullText}
							onExpansionIntent={onExpansionIntent}
							truncated={truncated}
							mode={mode}
							onOpenPath={onOpenPath}
							projectId={projectId}
						/>
					)}
				</StabilityBoundary>
				<TranscriptAttachments attachments={attachments} sessionId={sessionId} />
				{role === "user" && statusLabel ? (
					<div className="text-xs text-muted-foreground" aria-live="polite" data-testid="user-delivery-status">
						{statusLabel}
					</div>
				) : null}
				{role === "assistant" && durationLabel ? (
					<div className="text-xs text-muted-foreground" data-testid="assistant-duration">
						本次耗时：{durationLabel}
					</div>
				) : null}
			</MessageContent>
			{((role === "user" && (text || attachments.length > 0)) || (role === "assistant" && text)) ? (
				<MessageActionBar
					text={fullText ?? text}
					readText={readFullText}
					role={role}
					visible={role === "user" || showCopy}
					onEdit={role === "user" ? onEdit : undefined}
					onRemove={role === "user" ? onRemove : undefined}
				/>
			) : null}
		</Message>
	);
});

function ExpandableAssistantText({
	text,
	fullText,
	readFullText,
	onExpansionIntent,
	truncated,
	mode,
	onOpenPath,
	projectId,
}: {
	text: string;
	fullText?: string;
	readFullText: () => Promise<string>;
	onExpansionIntent?: () => void;
	truncated?: boolean;
	mode: "static" | "streaming";
	onOpenPath: WorkbenchActions["openResource"];
	projectId?: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const [loadedText, setLoadedText] = useState(fullText);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const displayText = expanded ? loadedText ?? text : text;
	return (
		<div className="min-w-0">
			<MessageResponse
				mode={mode}
				parseIncompleteMarkdown
				linkSafety={{ enabled: true }}
				controls={{ code: { copy: true, download: true }, table: { copy: true, download: true } }}
				onOpenPath={(path) => void onOpenPath(path)}
				projectId={projectId}
			>
				{displayText || " "}
			</MessageResponse>
			{truncated ? (
				<button
					type="button"
					className="mt-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
					disabled={loading}
					onClick={() => {
						onExpansionIntent?.();
						if (expanded) { setExpanded(false); return; }
						setLoading(true);
						setError(undefined);
						void readFullText().then((value) => {
							onExpansionIntent?.();
							setLoadedText(value);
							setExpanded(true);
						}).catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
							.finally(() => setLoading(false));
					}}
				>
					{loading ? "正在读取全文" : expanded ? "收起全文" : "展开全文"}
				</button>
			) : null}
			{error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
		</div>
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
		<Attachments variant="inline">
			{attachments.map((attachment) => {
				if (attachment.mediaType.startsWith("image/")) {
					const hasPreviewUrl = Boolean(attachment.url);
					return (
						<ResourceImage
							key={attachment.id}
							src={hasPreviewUrl ? attachment.url : undefined}
							sessionId={hasPreviewUrl ? undefined : sessionId}
							contentRef={hasPreviewUrl ? undefined : attachment.id}
							alt={attachment.filename}
							className="size-24 shrink-0"
							buttonClassName="!size-full !min-h-0"
							imageClassName="!size-full !object-cover"
						/>
					);
				}
				return (
					<Attachment
						key={attachment.id}
						data={{
							id: attachment.id,
							type: "file",
							filename: attachment.filename,
							mediaType: attachment.mediaType,
							url: attachment.url,
						}}
					>
						<AttachmentPreview />
						<AttachmentInfo showMediaType />
					</Attachment>
				);
			})}
		</Attachments>
	);
}

async function copyTextToClipboard(text: string): Promise<void> {
	const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
	if (clipboard?.writeText) {
		try {
			await clipboard.writeText(text);
			return;
		} catch {
			// Clipboard API 失败时继续使用兼容回退。
		}
	}
	copyTextWithSelection(text);
}

function copyTextWithSelection(text: string): void {
	if (typeof document === "undefined" || !document.body) throw new Error("当前浏览器不支持复制");
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "true");
	textarea.style.position = "fixed";
	textarea.style.top = "0";
	textarea.style.left = "0";
	textarea.style.width = "1px";
	textarea.style.height = "1px";
	textarea.style.padding = "0";
	textarea.style.border = "0";
	textarea.style.opacity = "0";
	textarea.style.pointerEvents = "none";
	document.body.append(textarea);
	try {
		textarea.focus();
		textarea.select();
		if (!document.execCommand("copy")) throw new Error("当前浏览器不支持复制");
	} finally {
		textarea.remove();
	}
}

function MessageActionBar({
	text,
	readText,
	role,
	visible,
	onEdit,
	onRemove,
}: {
	text: string;
	readText: () => Promise<string>;
	role: "user" | "assistant";
	visible: boolean;
	onEdit?: () => void;
	onRemove?: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState<string>();
	const [tooltipOpen, setTooltipOpen] = useState(false);
	const timeoutRef = useRef(0);
	const label = role === "user" ? "复制" : "复制回复";

	useEffect(() => {
		setCopied(false);
		setTooltipOpen(false);
		window.clearTimeout(timeoutRef.current);
	}, [text, visible]);
	useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

	const copy = async () => {
		try {
			setCopyError(undefined);
			await copyTextToClipboard(await readText());
			setCopied(true);
			window.clearTimeout(timeoutRef.current);
			timeoutRef.current = window.setTimeout(() => setCopied(false), 1600);
		} catch (error) {
			setCopied(false);
			setCopyError(error instanceof Error ? error.message : String(error));
		}
	};
	return (
		<MessageActions
			className={cn(
				visible ? "mobile-hover-action opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100" : "hidden",
				role === "user" && "self-end",
			)}
		>
			{onEdit ? (
				<MessageAction label="编辑 Prompt" tooltip="编辑 Prompt" onClick={onEdit}>
					<Pencil className="size-4" />
				</MessageAction>
			) : null}
			{onRemove ? (
				<MessageAction label="删除排队消息" tooltip="删除排队消息" onClick={onRemove}>
					<Trash2 className="size-4" />
				</MessageAction>
			) : null}
			{text ? <MessageAction
				label={label}
				tooltip={label}
				tooltipOpen={tooltipOpen}
				onTooltipOpenChange={setTooltipOpen}
				disabled={!visible}
				onClick={() => void copy()}
			>
				{copied ? <Check className="size-4" /> : <Clipboard className="size-4" />}
			</MessageAction> : null}
			{copyError ? <span className="text-xs text-destructive" role="alert">{copyError}</span> : null}
		</MessageActions>
	);
}
