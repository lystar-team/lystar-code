import { ChevronDown, CircleAlert, CircleHelp, Info, TriangleAlert, Wrench } from "lucide-react";
import { memo, useState } from "react";
import { type SessionItemViewModel, type TranscriptToolViewModel, toSessionItemViewModel } from "../../adapters/session-view-model";
import type { WorkbenchState } from "../../state/use-workbench";
import { MessageResponse } from "../ai-elements/message";
import { Task, TaskContent, TaskTrigger } from "../ai-elements/task";
import { CompactionSummaryCard } from "./compaction-card";
import { ToolBatch, type ToolBatchTool } from "../ai-elements/tool-batch";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { GsapCollapsibleContent } from "../ui/gsap-collapsible-content";
import type { WorkbenchActions } from "./types";
import { CodeBlockView } from "./code-block-view";
import { ExtensionActivityCard } from "./extension-activity-card";
import { TranscriptMessageView } from "./transcript-message";

export { CodeBlockView, TranscriptMessageView };

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
	if (viewModel.kind === "extension_entry") {
		if (viewModel.notification) {
			const notification = viewModel.notification;
			const presentation = {
				info: { icon: Info, label: "扩展提示", className: "text-muted-foreground" },
				warning: { icon: TriangleAlert, label: "扩展警告", className: "text-[var(--warning)]" },
				error: { icon: CircleAlert, label: "扩展错误", className: "text-destructive" },
			}[notification.type];
			const Icon = presentation.icon;
			return (
				<div className={`flex min-w-0 items-start gap-2 py-1 text-sm ${presentation.className}`}>
					<Icon className="mt-0.5 size-4 shrink-0" aria-label={presentation.label} />
					<p className="min-w-0 whitespace-pre-wrap break-words">{notification.message}</p>
				</div>
			);
		}
		return <ExtensionEntryCard entry={viewModel} entryId={item.entryId} sessionId={sessionId} projectId={projectId} onOpenPath={onOpenPath} />;
	}
	if (viewModel.kind === "extension_activity") {
		return <ExtensionActivityCard activity={viewModel} />;
	}
	if (viewModel.kind === "message") {
		return (
			<TranscriptMessageView
				role={viewModel.role}
				text={viewModel.text}
				fullText={viewModel.fullText}
				contentRef={viewModel.contentRef}
				truncated={viewModel.truncated}
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
				<MessageResponse
					mode="static"
					onOpenPath={(path) => void onOpenPath(path)}
					projectId={projectId}
				>
					{viewModel.text}
				</MessageResponse>
			</TaskContent>
		</Task>
	);
});

function ExtensionEntryCard({ entry, entryId, sessionId, projectId, onOpenPath }: {
	entry: Extract<SessionItemViewModel, { kind: "extension_entry" }>;
	entryId: string;
	sessionId?: string;
	projectId?: string;
	onOpenPath: WorkbenchActions["openResource"];
}) {
	const [open, setOpen] = useState(false);
	const { customType, details, input, timestamp } = entry;
	if (input) {
		const sentAt = new Date(timestamp);
		const timeLabel = sentAt.toLocaleTimeString("zh-CN", { hour12: false });
		return (
			<Collapsible className="group/extension-input min-w-0" open={open} onOpenChange={setOpen} data-testid="extension-input-card">
				<CollapsibleTrigger asChild>
					<button
						type="button"
						aria-label={`扩展输入：${customType}，${timeLabel}，${open ? "收起" : "展开"}`}
						className="flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<Wrench className="size-4 shrink-0" />
						<span className="min-w-0 flex-1 truncate text-[13px]" title={customType}>扩展输入：{customType}</span>
						<time className="shrink-0 text-xs tabular-nums" dateTime={timestamp} title={sentAt.toLocaleString("zh-CN")}>{timeLabel}</time>
						<ChevronDown className="size-4 shrink-0 transition-transform group-data-[state=open]/extension-input:rotate-180" />
					</button>
				</CollapsibleTrigger>
				<GsapCollapsibleContent open={open} className="min-w-0 pl-5 pt-1" data-transcript-resize-anchor>
					<TranscriptMessageView
						role="system"
						text={input.text}
						contentRef={input.contentRef}
						truncated={Boolean(input.contentRef)}
						attachments={[
							...(input.images ?? []).map((image, index) => ({ id: image.contentRef, filename: image.alt || `图片 ${index + 1}`, mediaType: image.mimeType, url: "" })),
							...(input.files ?? []).map((file, index) => ({ id: `${entryId}:file:${index}`, filename: file.filename, mediaType: file.mimeType, url: "" })),
						]}
						showCopy={false}
						sessionId={sessionId}
						projectId={projectId}
						onOpenPath={onOpenPath}
					/>
				</GsapCollapsibleContent>
			</Collapsible>
		);
	}
	const tool: ToolBatchTool = {
		id: `extension-entry:${customType}`,
		name: customType,
		summary: customType,
		state: "output-available",
		...(details ? { detail: details } : {}),
	};

	return (
		<div className="extension-entry-card min-w-0" data-testid="extension-entry-card">
			<ToolBatch tools={[tool]} />
		</div>
	);
}
