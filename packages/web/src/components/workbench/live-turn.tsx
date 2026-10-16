import { Brain, Check, ChevronDown, Clipboard } from "lucide-react";
import { Marked } from "marked";
import { useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { readTranscriptText } from "../../adapters/transcript-content";
import type { LiveTurnItem } from "../../state/use-workbench";
import { MessageResponse } from "../ai-elements/message";
import { Shimmer } from "../ai-elements/shimmer";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { GsapCollapsibleContent } from "../ui/gsap-collapsible-content";
import { copyTextToClipboard } from "./transcript-message";

const thinkingMarkdown = new Marked();

export function firstThinkingLine(parts: readonly string[]): string {
	let line = "";
	let complete = false;
	for (const part of parts) {
		let offset = 0;
		while (offset < part.length) {
			const newline = part.indexOf("\n", offset);
			line += part.slice(offset, Math.min(newline < 0 ? part.length : newline, offset + 2048 - line.length));
			if (newline < 0 || line.length >= 2048) break;
			if (line.trim()) { complete = true; break; }
			line = "";
			offset = newline + 1;
		}
		if (complete || line.length >= 2048) break;
	}
	const plain: string[] = [];
	thinkingMarkdown.walkTokens(thinkingMarkdown.lexer(line.slice(0, 2048)), (token) => {
		if (!("tokens" in token && token.tokens?.length) && ["text", "escape", "code", "codespan"].includes(token.type) && "text" in token && typeof token.text === "string") {
			plain.push(token.text);
		}
	});
	return plain.join("").trim().replace(/^[*_`]+|[*_`]+$/gu, "");
}

export function activeThinkingBlock(items: readonly LiveTurnItem[]): Extract<LiveTurnItem, { kind: "thinking" }> | undefined {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (!item || item.kind === "user") continue;
		return item.kind === "thinking" ? item : undefined;
	}
	return undefined;
}

export function activeThinkingText(items: readonly LiveTurnItem[]): string {
	return firstThinkingLine(activeThinkingBlock(items)?.parts ?? []);
}

export function ThinkingBlock({
	text,
	isStreaming = false,
	open = false,
	onOpenChange,
	contentRef,
	sessionId,
	projectId,
	onOpenPath,
}: {
	text: string;
	isStreaming?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	contentRef?: string;
	sessionId?: string;
	projectId?: string;
	onOpenPath?: (path: string) => void;
}) {
	const preview = useMemo(() => firstThinkingLine([text]), [text]);
	const [fullContent, setFullContent] = useState<{ reference: string; text: string }>();
	const [readError, setReadError] = useState<string>();
	const [copyError, setCopyError] = useState<string>();
	const [retry, setRetry] = useState(0);
	const [copied, setCopied] = useState(false);
	const loadedText = fullContent?.reference === contentRef ? fullContent?.text : undefined;
	const displayText = loadedText ?? text;
	const loading = Boolean(open && contentRef && loadedText === undefined && !readError);
	const reducedMotion = useReducedMotion();

	useEffect(() => {
		if (!open || !contentRef || loadedText !== undefined) return;
		if (!sessionId) {
			setReadError("无法确认思考内容所属的会话");
			return;
		}
		let disposed = false;
		setReadError(undefined);
		void readTranscriptText(sessionId, contentRef).then((value) => {
			if (!disposed) setFullContent({ reference: contentRef, text: value });
		}).catch((reason: unknown) => {
			if (!disposed) setReadError(`读取完整思考内容失败：${reason instanceof Error ? reason.message : String(reason)}`);
		});
		return () => { disposed = true; };
	}, [contentRef, loadedText, open, retry, sessionId]);
	useEffect(() => {
		if (!copied) return;
		const timeout = window.setTimeout(() => setCopied(false), 1600);
		return () => window.clearTimeout(timeout);
	}, [copied]);

	const label = preview || (isStreaming ? "思考中" : "思考内容");
	return (
		<Collapsible open={open} onOpenChange={onOpenChange} className="group/thinking min-w-0 w-full max-w-full" data-thinking-block>
			<CollapsibleTrigger asChild>
				<button
					type="button"
					disabled={!text.trim()}
					aria-label={text.trim() ? `${label}，${open ? "收起" : "展开"}思考内容` : label}
					aria-busy={isStreaming}
					className="flex min-h-7 w-full min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[13px]! leading-5! text-muted-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-100"
					data-transcript-resize-anchor
				>
					<Brain className="size-4 shrink-0" aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate" title={label}>
						{isStreaming && !reducedMotion ? <Shimmer as="span" className="block min-w-0 max-w-full truncate text-[13px] font-normal leading-5">{label}</Shimmer> : label}
					</span>
					{text.trim() ? <ChevronDown className="size-4 shrink-0 transition-transform group-data-[state=open]/thinking:rotate-180" aria-hidden="true" /> : null}
				</button>
			</CollapsibleTrigger>
			<GsapCollapsibleContent open={open} className="is-assistant min-w-0 max-w-full pl-6 pt-1" data-transcript-resize-anchor>
				<MessageResponse
					className="min-w-0 max-w-full break-words text-[13px]! leading-5! [overflow-wrap:anywhere] [&_:is(h1,h2,h3,h4,h5,h6)]:text-[13px]! [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:text-[13px]! [&_table]:max-w-full"
					mode={isStreaming ? "streaming" : "static"}
					parseIncompleteMarkdown
					onOpenPath={onOpenPath}
					projectId={projectId}
				>
					{displayText}
				</MessageResponse>
				{loading ? <p className="py-1 text-xs text-muted-foreground" role="status">正在读取完整思考内容</p> : null}
				{readError ? <div className="flex flex-wrap items-center gap-2 py-1 text-xs text-destructive" role="alert">
					<span>{readError}</span>
					{contentRef ? <button type="button" className="underline" onClick={() => setRetry((value) => value + 1)}>重试</button> : null}
				</div> : null}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-8 gap-1.5 px-1 text-[13px]! font-normal leading-5! text-muted-foreground"
					disabled={loading || Boolean(contentRef && loadedText === undefined)}
					onClick={() => {
						setCopyError(undefined);
						void copyTextToClipboard(displayText).then(() => setCopied(true)).catch((reason: unknown) => {
							setCopyError(`复制失败：${reason instanceof Error ? reason.message : String(reason)}`);
						});
					}}
				>
					{copied ? <Check className="size-4" /> : <Clipboard className="size-4" />}
					{copied ? "已复制" : "复制"}
				</Button>
				{copyError ? <p className="text-xs text-destructive" role="alert">{copyError}</p> : null}
			</GsapCollapsibleContent>
		</Collapsible>
	);
}
