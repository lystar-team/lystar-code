import {
	ArrowDownIcon,
	CheckCircle2,
	ChevronDownIcon,
	CircleX,
	LoaderCircle,
	Sparkles,
	WrenchIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkbenchState } from "../../state/use-workbench";
import { CompactionCard } from "./compaction-card";
import { Composer } from "./composer";
import { Conversation, ConversationContent, ConversationEmptyState } from "../ai-elements/conversation";
import { ToolBatch, toolBatchSummaryLabel, type ToolBatchTool } from "../ai-elements/tool-batch";
import {
	appendLiveRenderItems,
	buildConversationRenderItems,
	buildPersistedRenderItems,
	type AgentStepChildRenderItem,
	type AgentStepRenderItem,
	type CompactionRenderItem,
	type ConversationContentRenderItem,
	type ConversationRenderItem,
	type MessageRenderItem,
	type TranscriptToolStackRenderItem,
} from "./conversation-render-model";
export { appendLiveRenderItems, buildConversationRenderItems, buildPersistedRenderItems };
import { ConversationRenderPipeline } from "./conversation-render-pipeline";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { GsapCollapsibleContent } from "../ui/gsap-collapsible-content";
import { GsapReveal } from "../ui/gsap-reveal";
import { ACTIVE_OPERATION_STATUSES } from "./constants";
import { activeThinkingText, ThinkingBlock } from "./live-turn";
import { AgentErrorCard, TranscriptItemView, TranscriptMessageView } from "./transcript";
import { PrependAnchoredConversationTranscript } from "./prepend-anchored-transcript";
import { DEFAULT_TRANSCRIPT_GAP } from "./virtualized-transcript";
import type { PromptEditRequest, WorkbenchActions } from "./types";
import { HISTORY_LOAD_THRESHOLD, useConversationScroll } from "./use-conversation-scroll";
import { useConversationExpansion } from "./use-conversation-expansion";
export { shouldLoadEarlierHistory } from "./use-conversation-scroll";
export { initialToolStackPresentation } from "./use-conversation-expansion";
import { formatElapsedDuration } from "./conversation-format";
import { LiveElapsedHeader } from "./live-elapsed-header";
import { HookActivityGroup } from "./hook-activity-group";
import { ExtensionEntryGroup } from "./extension-entry-group";
export { formatElapsedDuration } from "./conversation-format";
export { LiveElapsedHeader } from "./live-elapsed-header";

export type ConversationState = {
	sessionId?: string;
	currentProjectId?: string;
	loading: boolean;
	connected: boolean;
	sessionReady: boolean;
	readOnly: boolean;
	session?: Pick<NonNullable<WorkbenchState["session"]>, "activity">;
	sessionError?: string;
	transcript: WorkbenchState["transcript"];
	agentSteps: WorkbenchState["agentSteps"];
	transcriptPageLoaded: boolean;
	transcriptLoading: boolean;
	transcriptError?: string;
	previousCursor?: string;
	hasMorePrevious: boolean;
	loadingEarlier: boolean;
	pendingUserPrompts: WorkbenchState["pendingUserPrompts"];
	queuedUserPrompts: WorkbenchState["queuedUserPrompts"];
	promptSendTimes: WorkbenchState["promptSendTimes"];
	promptScrollRequest?: number;
	currentOperation?: WorkbenchState["currentOperation"];
	liveTools: WorkbenchState["liveTools"];
	liveSteps: WorkbenchState["liveSteps"];
	liveTurnItems: WorkbenchState["liveTurnItems"];
	liveCompaction?: WorkbenchState["liveCompaction"];
	liveTurnId: number;
	settledTurns?: WorkbenchState["settledTurns"];
};

export type ConversationActions = Pick<WorkbenchActions, "openResource" | "queueAction" | "showToast" | "loadEarlier"> & {
	selectSession?: WorkbenchActions["selectSession"];
	loadTranscript?: WorkbenchActions["loadTranscript"];
	openSubagent?: WorkbenchActions["openSubagent"];
	/** 主会话提供的 sessionDetail 缓存可用会话，用于在渲染前裁剪渲染缓存。 */
	retainedSessionDetailIds?: () => ReadonlySet<string>;
};


const EMPTY_LIVE_STEPS = Object.freeze({}) as WorkbenchState["liveSteps"];

function AgentStepContent({
	entry,
	open,
	onOpenChange,
	renderItem,
}: {
	entry: AgentStepRenderItem;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	renderItem: (entry: AgentStepChildRenderItem) => ReactNode;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (entry.step.status !== "running") return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [entry.step.startedAt, entry.step.status]);
	const duration = formatElapsedDuration(
		(entry.step.endedAt ?? now - (entry.clientClockOffsetMs ?? 0)) - entry.step.startedAt,
	);
	const StatusIcon =
		entry.step.status === "running" ? LoaderCircle : entry.step.status === "completed" ? CheckCircle2 : CircleX;

	return (
		<Collapsible className="group/agent-step min-w-0 w-full" onOpenChange={onOpenChange} open={open}>
			<CollapsibleTrigger asChild>
				<button
					aria-label={`${entry.step.title}，${open ? "收起" : "展开"}`}
					className={`flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
						open ? "sticky top-0 z-[5] bg-background" : ""
					}`}
					data-transcript-anchor-key={!open || entry.items.length === 0 ? entry.key : undefined}
					data-transcript-resize-anchor
					type="button"
				>
					<StatusIcon
						className={`size-4 shrink-0 ${
							entry.step.status === "running"
								? "animate-spin text-muted-foreground"
								: entry.step.status === "completed"
									? "text-emerald-600 dark:text-emerald-500"
									: "text-muted-foreground"
						}`}
					/>
					<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{entry.step.title}</span>
					{duration ? <span className="shrink-0 text-xs text-muted-foreground">{duration}</span> : null}
					<ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/agent-step:rotate-180" />
				</button>
			</CollapsibleTrigger>
			<GsapCollapsibleContent open={open} className="pt-1" data-transcript-resize-anchor>
				<div className="ml-[7px] grid min-w-0 gap-0 border-l border-border/60 pl-4">
					{entry.items.map((item) => (
						<div
							className={item.kind === "message" ? "min-w-0 py-2" : "min-w-0"}
							data-transcript-anchor-key={open ? item.key : undefined}
							key={item.key}
						>
							{renderItem(item)}
						</div>
					))}
				</div>
			</GsapCollapsibleContent>
		</Collapsible>
	);
}

type InitialTranscriptDisplayState = "ready" | "loading" | "error";

export function initialTranscriptDisplayState(
	state: Pick<WorkbenchState, "transcriptPageLoaded" | "transcriptLoading" | "transcriptError">,
): InitialTranscriptDisplayState {
	if (state.transcriptPageLoaded) return "ready";
	if (state.transcriptLoading) return "loading";
	return state.transcriptError ? "error" : "ready";
}

function isActivityRow(entry: ConversationRenderItem): boolean {
	if (entry.kind === "tool-stack" || entry.kind === "agent-step" || entry.kind === "compaction" || entry.kind === "extension-group") return true;
	if (entry.kind !== "item") return false;
	switch (entry.item.view?.type) {
		case "tool_call":
		case "tool_result":
		case "web_search":
		case "extension_entry":
		case "extension_activity":
		case "bash":
			return true;
		default:
			return false;
	}
}

export function activityRowGap(previous: ConversationRenderItem, current: ConversationRenderItem): number {
	return isActivityRow(previous) && isActivityRow(current) ? 0 : DEFAULT_TRANSCRIPT_GAP;
}

function attachmentListsEqual(
	previous: MessageRenderItem["attachments"],
	next: MessageRenderItem["attachments"],
): boolean {
	if (previous === next) return true;
	if (previous.length !== next.length) return false;
	return previous.every((attachment, index) => {
		const candidate = next[index];
		return (
			candidate?.id === attachment.id &&
			candidate.filename === attachment.filename &&
			candidate.mediaType === attachment.mediaType &&
			candidate.url === attachment.url
		);
	});
}

function toolSourcesEqual(
	previous: readonly { url: string; title?: string }[] | undefined,
	next: readonly { url: string; title?: string }[] | undefined,
): boolean {
	if (previous === next) return true;
	if (!previous || !next || previous.length !== next.length) return !previous?.length && !next?.length;
	return previous.every((source, index) => {
		const candidate = next[index];
		return candidate?.url === source.url && candidate.title === source.title;
	});
}

function toolBatchToolsEqual(previous: readonly ToolBatchTool[], next: readonly ToolBatchTool[]): boolean {
	if (previous === next) return true;
	if (previous.length !== next.length) return false;
	return previous.every((tool, index) => {
		const candidate = next[index];
		const streamingImageGeneration =
			candidate?.name === "image_gen" &&
			tool.name === "image_gen" &&
			(candidate.state === "input-available" || candidate.state === "input-queued") &&
			(tool.state === "input-available" || tool.state === "input-queued");
		return (
			candidate?.id === tool.id &&
			candidate.name === tool.name &&
			candidate.summary === tool.summary &&
			candidate.state === tool.state &&
			(streamingImageGeneration || candidate.detail === tool.detail) &&
			JSON.stringify(candidate.subagents) === JSON.stringify(tool.subagents) &&
			candidate.inputPreview === tool.inputPreview &&
			candidate.preparing === tool.preparing &&
			JSON.stringify(tool.webSearch) === JSON.stringify(candidate.webSearch) &&
			toolSourcesEqual(tool.sources ?? tool.webSearch?.sources, candidate.sources ?? candidate.webSearch?.sources) &&
			candidate.images === tool.images &&
			candidate.diff === tool.diff
		);
	});
}

function conversationRenderItemEqual(previous: ConversationRenderItem, next: ConversationRenderItem): boolean {
	if (previous.kind !== next.kind || previous.key !== next.key) return false;
	if (previous.kind === "message" && next.kind === "message") {
		return (
			previous.live === next.live &&
			previous.entryId === next.entryId &&
			previous.role === next.role &&
			previous.text === next.text &&
			previous.fullText === next.fullText &&
			previous.contentRef === next.contentRef &&
			previous.durationLabel === next.durationLabel &&
			previous.statusLabel === next.statusLabel &&
			previous.queueId === next.queueId &&
			previous.copyVisible === next.copyVisible &&
			previous.editable === next.editable &&
			previous.editing === next.editing &&
			previous.sources.join("\u0000") === next.sources.join("\u0000") &&
			attachmentListsEqual(previous.attachments, next.attachments)
		);
	}
	if (previous.kind === "tool-stack" && next.kind === "tool-stack") {
		return (
			previous.live === next.live &&
			previous.stepId === next.stepId &&
			previous.collapseForResult === next.collapseForResult &&
			previous.batches.length === next.batches.length &&
			previous.batches.every((batch, index) => {
				const candidate = next.batches[index];
				return candidate?.key === batch.key && toolBatchToolsEqual(batch.tools, candidate.tools);
			})
		);
	}
	if (previous.kind === "agent-step" && next.kind === "agent-step") {
		return (
			previous.live === next.live &&
			previous.clientClockOffsetMs === next.clientClockOffsetMs &&
			previous.step === next.step &&
			previous.items.length === next.items.length &&
			previous.items.every((item, index) => {
				const candidate = next.items[index];
				return candidate !== undefined && conversationRenderItemEqual(item, candidate);
			})
		);
	}
	if ((previous.kind === "hook-group" && next.kind === "hook-group") ||
		(previous.kind === "extension-group" && next.kind === "extension-group")) {
		return (
			previous.items.length === next.items.length &&
			previous.items.every((item, index) => item.item === next.items[index]?.item)
		);
	}
	if (previous.kind === "work-process" && next.kind === "work-process") {
		return (
			previous.items.length === next.items.length &&
			previous.items.every((item, index) => {
				const candidate = next.items[index];
				return candidate !== undefined && conversationRenderItemEqual(item, candidate);
			})
		);
	}
	if (previous.kind === "result-boundary" && next.kind === "result-boundary") return true;
	if (previous.kind === "live-elapsed" && next.kind === "live-elapsed") return previous.startedAt === next.startedAt;
	if (previous.kind === "compaction" && next.kind === "compaction") {
		return previous.live
			? next.live && previous.state === next.state
			: !next.live && previous.text === next.text && previous.tokensBefore === next.tokensBefore;
	}
	return previous.kind === "item" && next.kind === "item" && previous.item === next.item;
}

function isConversationResponseActive(state: ConversationState): boolean {
	return Boolean(
		state.liveTurnItems.length ||
		state.session?.activity === "running" ||
		state.session?.activity === "waiting_for_input" ||
		(state.currentOperation && ACTIVE_OPERATION_STATUSES.has(state.currentOperation.status)),
	);
}

export function ConversationView({
	state,
	actions,
	sessionTitleText,
	onEditPrompt,
	editRequest,
	editorState,
	editorActions,
	onCancelEdit,
	onEditComplete,
	allowPromptEditing = true,
}: {
	state: ConversationState;
	actions: ConversationActions;
	sessionTitleText: string;
	onEditPrompt: (request: PromptEditRequest) => void;
	editRequest?: PromptEditRequest;
	editorState?: WorkbenchState;
	editorActions?: WorkbenchActions;
	onCancelEdit?: () => void;
	onEditComplete?: () => void;
	allowPromptEditing?: boolean;
}) {
	const responseActive = isConversationResponseActive(state);
	const canEditPrompts =
		allowPromptEditing &&
		state.connected &&
		state.sessionReady &&
		!state.readOnly &&
		!responseActive &&
		state.queuedUserPrompts.length === 0;
	const liveSteps = responseActive ? state.liveSteps : EMPTY_LIVE_STEPS;
	const editingEntryId = editRequest?.sessionId === state.sessionId ? editRequest?.entryId : undefined;
	const pipelineRef = useRef<ConversationRenderPipeline | null>(null);
	if (!pipelineRef.current) pipelineRef.current = new ConversationRenderPipeline();
	const pipeline = pipelineRef.current;
	const retainedSessionDetailIds = actions.retainedSessionDetailIds;
	if (retainedSessionDetailIds) pipeline.prune(retainedSessionDetailIds());
	// 实时「已处理」每次跳动回报的秒数，按发送时刻归档，回合结束时供下方「本次耗时」复用。
	const observedElapsedRef = useRef(new Map<number, number>());
	const recordLiveElapsed = useCallback((sentAt: number, seconds: number) => {
		const observed = observedElapsedRef.current;
		observed.delete(sentAt);
		observed.set(sentAt, seconds * 1_000);
		while (observed.size > 64) {
			const oldest = observed.keys().next().value;
			if (oldest === undefined) break;
			observed.delete(oldest);
		}
	}, []);
	const resolveObservedElapsed = useCallback((sentAt: number) => observedElapsedRef.current.get(sentAt), []);
	useEffect(() => {
		observedElapsedRef.current.clear();
	}, [state.sessionId]);
	const { toolIndex, renderItems } = useMemo(
		() =>
			pipeline.render({
				sessionId: state.sessionId,
				transcript: state.transcript,
				agentSteps: state.agentSteps,
				pendingUserPrompts: state.pendingUserPrompts,
				promptSendTimes: state.promptSendTimes,
				liveTools: state.liveTools,
				liveSteps,
				liveTurnItems: state.liveTurnItems,
				liveCompaction: state.liveCompaction,
				liveTurnId: state.liveTurnId,
				responseActive,
				canEditPrompts,
				editingEntryId,
				settledTurns: state.settledTurns,
				observedElapsed: resolveObservedElapsed,
			}),
		[
			canEditPrompts,
			editingEntryId,
			liveSteps,
			pipeline,
			resolveObservedElapsed,
			responseActive,
			state.agentSteps,
			state.liveCompaction,
			state.liveTools,
			state.liveTurnId,
			state.liveTurnItems,
			state.pendingUserPrompts,
			state.promptSendTimes,
			state.sessionId,
			state.settledTurns,
			state.transcript,
		],
	);

	return (
		<>
			<Conversation className="min-h-0 flex-1">
				<ConversationBody
					state={state}
					actions={actions}
					sessionTitleText={sessionTitleText}
					renderItems={renderItems}
					toolStatuses={toolIndex.statuses}
					liveElapsedChange={recordLiveElapsed}
					onEditPrompt={onEditPrompt}
					editRequest={editRequest}
					editorState={editorState}
					editorActions={editorActions}
					onCancelEdit={onCancelEdit}
					onEditComplete={onEditComplete}
				/>
			</Conversation>
		</>
	);
}

function ConversationBody({
	state,
	actions,
	sessionTitleText,
	renderItems,
	toolStatuses,
	liveElapsedChange,
	onEditPrompt,
	editRequest,
	editorState,
	editorActions,
	onCancelEdit,
	onEditComplete,
}: {
	state: ConversationState;
	actions: ConversationActions;
	sessionTitleText: string;
	renderItems: ConversationRenderItem[];
	toolStatuses: ReadonlyMap<string, "success" | "error">;
	liveElapsedChange: (sentAt: number, seconds: number) => void;
	onEditPrompt: (request: PromptEditRequest) => void;
	editRequest?: PromptEditRequest;
	editorState?: WorkbenchState;
	editorActions?: WorkbenchActions;
	onCancelEdit?: () => void;
	onEditComplete?: () => void;
}) {
	const responseActive = isConversationResponseActive(state);
	const thinkingText = activeThinkingText(state.liveTurnItems);
	const openResource = actions.openResource;
	const {
		expandedWorkProcesses,
		expandedAgentSteps,
		expandedToolBatches,
		expandedToolRows,
		getToolStackPresentation,
		resetExpandedState,
		updateExpandedWorkProcess,
		updateExpandedAgentStep,
		updateExpandedToolBatch,
		updateExpandedToolRow,
	} = useConversationExpansion();
	const {
		followOutput,
		handleAtBottomStateChange,
		handleAtTopStateChange,
		handleReturnToBottom,
		handleScrollStateCapture,
		handleTranscriptScrollerRef,
		handleUserScrollAway,
		handleUserScrollDown,
		handleUserScrollUp,
		handleVirtuosoRef,
		pauseFollowOutput,
		isAtBottom,
		requestEarlierHistory,
		scrollState,
	} = useConversationScroll({
		sessionId: state.sessionId,
		promptScrollRequest: state.promptScrollRequest,
		hasMorePrevious: state.hasMorePrevious,
		loadingEarlier: state.loadingEarlier,
		previousCursor: state.previousCursor,
		transcriptError: state.transcriptError,
		responseActive,
		loadEarlier: actions.loadEarlier,
		showToast: actions.showToast,
		resetExpandedState,
	});
	const renderStateRef = useRef({ sessionId: state.sessionId, projectId: state.currentProjectId, toolStatuses });
	renderStateRef.current = { sessionId: state.sessionId, projectId: state.currentProjectId, toolStatuses };
	const openSubagent = actions.openSubagent;
	const renderToolStack = useCallback(
		(entry: TranscriptToolStackRenderItem) => {
			const current = renderStateRef.current;
			const tools = entry.batches.flatMap((batch) => batch.tools);
			const presentation = getToolStackPresentation(entry.key, tools);
			if (presentation === "rows") {
				return (
					<div className="tool-batch-stack">
						{tools.map((tool) => (
							<ToolBatch
								key={tool.id}
								className="tool-batch-render-item"
								tools={[tool]}
								initialOpen={expandedToolRows.get(tool.id) ?? false}
								onOpenChange={(open) => updateExpandedToolRow(tool.id, open)}
								sessionId={current.sessionId}
								onOpenPath={(path) => void openResource(path)}
								onOpenSubagent={openSubagent}
							/>
						))}
					</div>
				);
			}
			return (
				<ToolBatch
					key={entry.key}
					className="tool-batch-render-item"
					tools={tools}
					summaryLabel={tools.length > 1 ? toolBatchSummaryLabel(tools) : undefined}
					initialOpen={expandedToolBatches.get(entry.key) ?? false}
					onOpenChange={(open) => updateExpandedToolBatch(entry.key, open)}
					initialToolOpen={expandedToolRows}
					onToolOpenChange={updateExpandedToolRow}
					sessionId={current.sessionId}
					onOpenPath={(path) => void openResource(path)}
					onOpenSubagent={openSubagent}
				/>
			);
		},
		[
			expandedToolBatches,
			expandedToolRows,
			getToolStackPresentation,
			openResource,
			openSubagent,
			updateExpandedToolBatch,
			updateExpandedToolRow,
		],
	);
	const renderMessage = useCallback(
		(entry: MessageRenderItem) => {
			const current = renderStateRef.current;
			const editRequest =
				entry.role === "user" && entry.editable && entry.entryId && current.sessionId
					? {
							sessionId: current.sessionId,
							entryId: entry.entryId,
							text: entry.text,
							attachments: entry.attachments,
						}
					: undefined;
			if (entry.editing && editRequest && editorState && editorActions && onCancelEdit && onEditComplete) {
				return (
					<Composer
						key={`${editRequest.sessionId}:${editRequest.entryId}`}
						state={editorState}
						actions={editorActions}
						editRequest={editRequest}
						inline
						onCancelEdit={onCancelEdit}
						onEditComplete={onEditComplete}
					/>
				);
			}
			const message = (
				<TranscriptMessageView
					role={entry.role}
					text={entry.text}
					fullText={entry.fullText}
					contentRef={entry.contentRef}
					onExpansionIntent={pauseFollowOutput}
					truncated={entry.truncated}
					durationLabel={entry.durationLabel}
					statusLabel={entry.statusLabel}
					attachments={entry.attachments}
					sources={entry.sources}
					showCopy={entry.copyVisible}
					sessionId={current.sessionId}
					projectId={current.projectId}
					onOpenPath={openResource}
					onEdit={editRequest ? () => onEditPrompt(editRequest) : undefined}
					onRemove={
						entry.queueId
							? () => {
									void actions.queueAction(entry.queueId!, "remove").catch((error: unknown) => {
										actions.showToast(error instanceof Error ? error.message : String(error));
									});
								}
							: undefined
					}
					mode={entry.live ? "streaming" : "static"}
				/>
			);
			return entry.role === "user" && entry.key.startsWith("optimistic-user:") ? (
				<GsapReveal animationKey={entry.key} className="w-full" distance={18} duration={0.28}>
					{message}
				</GsapReveal>
			) : (
				message
			);
		},
		[
			actions.queueAction,
			actions.showToast,
			editRequest,
			editorActions,
			editorState,
			onCancelEdit,
			onEditComplete,
			onEditPrompt,
			openResource,
			pauseFollowOutput,
		],
	);
	const renderCompaction = useCallback(
		(entry: CompactionRenderItem) => (
			<CompactionCard
				state={entry.live ? entry.state : undefined}
				text={entry.live ? undefined : entry.text}
				tokensBefore={entry.live ? undefined : entry.tokensBefore}
				onOpenPath={openResource}
			/>
		),
		[openResource],
	);
	const renderTranscriptItem = useCallback(
		(entry: Extract<ConversationContentRenderItem, { kind: "item" }>) => {
			const current = renderStateRef.current;
			return <TranscriptItemView
				item={entry.item}
				showCopy={false}
				toolStatuses={current.toolStatuses}
				onOpenPath={openResource}
				sessionId={current.sessionId}
				projectId={current.projectId}
			/>;
		},
		[openResource],
	);
	const renderExtensionGroup = useCallback(
		(entry: Extract<ConversationContentRenderItem, { kind: "extension-group" }>) => <ExtensionEntryGroup
			entry={entry}
			initialOpen={expandedToolBatches.get(entry.key) ?? false}
			onOpenChange={(open) => updateExpandedToolBatch(entry.key, open)}
			renderItem={renderTranscriptItem}
		/>,
		[expandedToolBatches, renderTranscriptItem, updateExpandedToolBatch],
	);
	const renderAgentStepItem = useCallback(
		(entry: AgentStepChildRenderItem) => {
			return <div className="min-w-0" data-transcript-anchor-key={entry.key}>
				{entry.kind === "message" ? renderMessage(entry) : entry.kind === "tool-stack" ? renderToolStack(entry) :
					entry.kind === "compaction" ? renderCompaction(entry) : entry.kind === "extension-group" ? renderExtensionGroup(entry) : renderTranscriptItem(entry)}
			</div>;
		},
		[renderCompaction, renderExtensionGroup, renderMessage, renderToolStack, renderTranscriptItem],
	);
	const renderConversationContentItem = useCallback(
		(entry: ConversationContentRenderItem) => {
			if (entry.kind === "agent-step") {
				const open = expandedAgentSteps.get(entry.key) ?? entry.step.status === "running";
				return (
					<AgentStepContent
						entry={entry}
						onOpenChange={(nextOpen) => updateExpandedAgentStep(entry.key, nextOpen)}
						open={open}
						renderItem={renderAgentStepItem}
					/>
				);
			}
			if (entry.kind === "hook-group") return <HookActivityGroup entry={entry} />;
			if (entry.kind === "extension-group") return renderExtensionGroup(entry);
			const content =
				entry.kind === "message" ? (
					renderMessage(entry)
				) : entry.kind === "tool-stack" ? (
					renderToolStack(entry)
				) : entry.kind === "compaction" ? (
					renderCompaction(entry)
				) : (
					renderTranscriptItem(entry)
				);
			return (
				<div className="min-w-0" data-transcript-anchor-key={entry.key}>
					{content}
				</div>
			);
		},
		[
			expandedAgentSteps,
			renderAgentStepItem,
			renderCompaction,
			renderExtensionGroup,
			renderMessage,
			renderToolStack,
			renderTranscriptItem,
			updateExpandedAgentStep,
		],
	);
	const renderConversationItem = useCallback(
		(entry: ConversationRenderItem) => {
			if (entry.kind === "live-elapsed") {
				return (
					<LiveElapsedHeader
						key={entry.key}
						startedAt={entry.startedAt}
						onElapsedChange={liveElapsedChange}
					/>
				);
			}
			if (entry.kind === "result-boundary") {
				return (
					<div
						aria-label="工作过程与最终结果分界"
						className="w-full border-t border-border/50"
						data-transcript-anchor-key={entry.key}
						role="separator"
					/>
				);
			}
			if (entry.kind === "work-process") {
				const open = expandedWorkProcesses.get(entry.key) ?? false;
				return (
					<Collapsible
						className="group/work-process min-w-0 w-full"
						onOpenChange={(nextOpen) => updateExpandedWorkProcess(entry.key, nextOpen)}
						open={open}
					>
						<CollapsibleTrigger asChild>
							<button
								aria-label={`工作过程，${open ? "收起" : "展开"}`}
								className="flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								data-transcript-anchor-key={!open || entry.items.length === 0 ? entry.key : undefined}
								data-transcript-resize-anchor
								type="button"
							>
								<WrenchIcon className="size-4 shrink-0" />
								<span className="min-w-0 flex-1 text-[13px]">工作过程</span>
								<ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=open]/work-process:rotate-180" />
							</button>
						</CollapsibleTrigger>
						<GsapCollapsibleContent open={open} className="pt-2" data-transcript-resize-anchor>
							<div className="grid min-w-0">
								{entry.items.map((item, index) => (
									<div
										className="min-w-0"
										key={item.key}
										style={index > 0 ? { marginTop: activityRowGap(entry.items[index - 1]!, item) } : undefined}
									>
										{renderConversationContentItem(item)}
									</div>
								))}
							</div>
						</GsapCollapsibleContent>
					</Collapsible>
				);
			}
			return renderConversationContentItem(entry);
		},
		[expandedWorkProcesses, renderConversationContentItem, updateExpandedWorkProcess],
	);
	const transcriptItemKey = useCallback((entry: ConversationRenderItem) => entry.key, []);
	const estimateTranscriptItemHeight = useCallback(
		(entry: ConversationRenderItem) =>
			entry.kind === "result-boundary"
				? 1
				: entry.kind === "live-elapsed"
					? 32
				: entry.kind === "work-process" || entry.kind === "hook-group" || isActivityRow(entry)
					? 32
					: 80,
		[],
	);

	const transcriptGap = useCallback(
		(previous: ConversationRenderItem, current: ConversationRenderItem) => {
			if (current.kind === "result-boundary") return 8;
			if (previous.kind === "result-boundary") return DEFAULT_TRANSCRIPT_GAP;
			return activityRowGap(previous, current);
		},
		[],
	);

	const historyStatus = state.loadingEarlier ? (
		<div className="mx-auto flex items-center gap-2 py-2 text-sm text-muted-foreground" aria-live="polite" aria-busy="true">
			<LoaderCircle className="size-4 animate-spin" />
			正在加载更早消息
		</div>
	) : state.hasMorePrevious && state.transcriptError ? (
		<Button className="mx-auto" size="sm" variant="outline" onClick={() => requestEarlierHistory(true)}>
			重新加载更早消息
		</Button>
	) : null;
	const initialTranscriptState = initialTranscriptDisplayState(state);
	const showTranscript =
		!state.loading &&
		!state.sessionError &&
		initialTranscriptState === "ready" &&
		renderItems.length > 0;

	if (showTranscript) {
		return (
			<>
				<PrependAnchoredConversationTranscript
					items={renderItems}
					getKey={transcriptItemKey}
					estimateHeight={estimateTranscriptItemHeight}
					footer={
						<div className="grid gap-3">
							<ThinkingBlock text={thinkingText} />
						</div>
					}
					gap={transcriptGap}
					header={historyStatus}
					renderItem={renderConversationItem}
					isItemEqual={conversationRenderItemEqual}
					atBottomStateChange={handleAtBottomStateChange}
					atTopStateChange={handleAtTopStateChange}
					atTopThreshold={HISTORY_LOAD_THRESHOLD}
					followOutput={followOutput}
					scrollState={scrollState}
					onScrollStateCapture={handleScrollStateCapture}
					onScrollerRef={handleTranscriptScrollerRef}
					onUserScrollAway={handleUserScrollAway}
					onUserScrollDown={handleUserScrollDown}
					onUserScrollUp={handleUserScrollUp}
					onExpansionIntent={pauseFollowOutput}
					sessionKey={state.sessionId ?? "empty"}
					virtuosoRef={handleVirtuosoRef}
				/>
				{!isAtBottom ? (
					<Button
						aria-label="回到最新消息"
						className="absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted"
						onClick={() => {
							handleReturnToBottom();
						}}
						size="icon"
						type="button"
						variant="outline"
					>
						<ArrowDownIcon className="size-4" />
					</Button>
				) : null}
			</>
		);
	}

	return (
		<ConversationContent className="conversation-content mx-auto w-full max-w-[var(--conversation-width)] gap-3 px-5 py-10 sm:px-10 sm:py-12">
			{historyStatus}
			{state.loading ? (
				<div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" aria-live="polite" aria-busy="true">
					<LoaderCircle className="size-4 animate-spin" />
					正在加载项目与会话
				</div>
			) : state.sessionError ? (
				<AgentErrorCard
					title="会话信息加载失败"
					message={state.sessionError}
					onRetry={
						state.sessionId && actions.selectSession
							? () => void actions.selectSession?.(state.sessionId!)
							: undefined
					}
				/>
			) : initialTranscriptState === "loading" ? (
				<div className="mx-auto grid w-full max-w-3xl gap-4 py-4" aria-live="polite" aria-busy="true">
					<div className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
						<LoaderCircle className="size-4 animate-spin" />
						正在加载会话记录
					</div>
					{["72%", "58%", "81%", "46%"].map((width, index) => (
						<div
							key={width}
							className={
								index % 2 === 0
									? "h-14 animate-pulse rounded-2xl bg-muted/35"
									: "ml-auto h-12 animate-pulse rounded-2xl bg-muted/35"
							}
							style={{ width }}
						/>
					))}
				</div>
			) : initialTranscriptState === "error" ? (
				<AgentErrorCard
					title="会话记录加载失败"
					message={state.transcriptError ?? "无法读取会话记录"}
					onRetry={actions.loadTranscript ? () => void actions.loadTranscript?.() : undefined}
				/>
			) : (
				<ConversationEmptyState
					className="min-h-[56vh]"
					icon={<Sparkles className="size-6" />}
					title={state.session ? sessionTitleText : "选择一个会话"}
					description={state.session ? "从底部输入任务，运行进展会显示在这里。" : "从左侧选择会话或新建会话。"}
				/>
			)}
		</ConversationContent>
	);
}
