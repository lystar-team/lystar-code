import { CircleHelp } from "lucide-react";
import { memo } from "react";
import { type TranscriptToolViewModel, toSessionItemViewModel } from "../../adapters/session-view-model";
import type { WorkbenchState } from "../../state/use-workbench";
import { MessageResponse } from "../ai-elements/message";
import { Task, TaskContent, TaskTrigger } from "../ai-elements/task";
import { CompactionSummaryCard } from "./compaction-card";
import { ToolBatch, type ToolBatchTool } from "../ai-elements/tool-batch";
import { Button } from "../ui/button";
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
		return <ExtensionEntryCard customType={viewModel.customType} details={viewModel.details} />;
	}
	if (viewModel.kind === "extension_activity") {
		return <ExtensionActivityCard activity={viewModel} />;
	}
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

function ExtensionEntryCard({ customType, details }: { customType: string; details?: string }) {
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
