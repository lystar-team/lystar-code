import { ArrowDownIcon, LoaderCircle, Sparkles } from "lucide-react";
import { type ReactNode, memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { WorkbenchState } from "../../state/use-workbench";
import { CompactionCard } from "./compaction-card";
import { Composer, composerStateEqual } from "./composer";
import { Conversation, ConversationContent, ConversationEmptyState } from "../ai-elements/conversation";
import { ToolBatch, ToolActivityGroup, ToolActivityRow, toolBatchActivityPresentation, toolBatchSummaryLabel, type ToolBatchTool } from "../ai-elements/tool-batch";
import {
	appendLiveRenderItems,
	buildConversationRenderItems,
	buildPersistedRenderItems,
	type CompactionRenderItem,
	type ConversationContentRenderItem,
	type ConversationRenderItem,
	type MessageRenderItem,
	type ThinkingRenderItem,
	type TranscriptToolStackRenderItem,
} from "./conversation-render-model";
export { appendLiveRenderItems, buildConversationRenderItems, buildPersistedRenderItems };
import { ConversationRenderPipeline } from "./conversation-render-pipeline";
import { Button } from "../ui/button";
import { GsapReveal } from "../ui/gsap-reveal";
import { ACTIVE_OPERATION_STATUSES } from "./constants";
import { activeThinkingBlock, ThinkingBlock } from "./live-turn";
import { AgentErrorCard, TranscriptItemView, TranscriptMessageView } from "./transcript";
import { ConversationList, type ConversationGroupLayout } from "./conversation-list";
import { buildConversationListModel, DEFAULT_TRANSCRIPT_GAP, type ConversationListContent } from "./conversation-list-model";
import { ConversationGroup } from "./conversation-group";
import { useConversationHistory } from "./use-conversation-history";
import type { PromptEditRequest, WorkbenchActions } from "./types";
import { useConversationScroll } from "./use-conversation-scroll";
import { useConversationExpansion } from "./use-conversation-expansion";
import { useConversationGroupTransitions } from "./use-conversation-group-transitions";
export { shouldLoadEarlierHistory } from "./use-conversation-history";
export { initialToolStackPresentation } from "./use-conversation-expansion";
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
	session?: Pick<NonNullable<WorkbenchState["session"]>, "activity" | "execution">;
	sessionError?: string;
	transcript: WorkbenchState["transcript"];
	transcriptGeneration?: string;
	agentSteps: WorkbenchState["agentSteps"];
	transcriptPageLoaded: boolean;
	transcriptLoading: boolean;
	transcriptError?: string;
	displayedResultRevision?: number;
	projects?: WorkbenchState["projects"];
	previousCursor?: string;
	hasMorePrevious: boolean;
	loadingEarlier: boolean;
	pendingUserPrompts: WorkbenchState["pendingUserPrompts"];
	queuedUserPrompts: WorkbenchState["queuedUserPrompts"];
	promptSendTimes: WorkbenchState["promptSendTimes"];
	runtimeClock?: WorkbenchState["runtimeClock"];
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
	markSessionResultRead?: WorkbenchActions["markSessionResultRead"];
	openSubagent?: WorkbenchActions["openSubagent"];
	/** 主会话提供的 sessionDetail 缓存可用会话，用于在渲染前裁剪渲染缓存。 */
	retainedSessionDetailIds?: () => ReadonlySet<string>;
};


const EMPTY_LIVE_STEPS = Object.freeze({}) as WorkbenchState["liveSteps"];


type InitialTranscriptDisplayState = "ready" | "loading" | "error";

export function initialTranscriptDisplayState(
	state: Pick<WorkbenchState, "transcriptPageLoaded" | "transcriptLoading" | "transcriptError">,
): InitialTranscriptDisplayState {
	if (state.transcriptPageLoaded) return "ready";
	if (state.transcriptLoading) return "loading";
	return state.transcriptError ? "error" : "ready";
}

function isActivityRow(entry: ConversationRenderItem): boolean {
	if (entry.kind === "thinking" || entry.kind === "tool-stack" || entry.kind === "agent-step" || entry.kind === "compaction" || entry.kind === "extension-group") return true;
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
			candidate.codemode === tool.codemode &&
			candidate.progress === tool.progress &&
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

type ConversationToolRowProps = {
	tool: ToolBatchTool;
	initialOpen: boolean;
	sessionId?: string;
	onOpenChange: (toolId: string, open: boolean) => void;
	onOpenPath: ConversationActions["openResource"];
	onOpenSubagent?: ConversationActions["openSubagent"];
	onOpenSession?: ConversationActions["selectSession"];
};

const ConversationToolRow = memo(
	function ConversationToolRow({ tool, initialOpen, sessionId, onOpenChange, onOpenPath, onOpenSubagent, onOpenSession }: ConversationToolRowProps) {
		const tools = useMemo(() => [tool], [tool]);
		const handleOpenChange = useCallback((open: boolean) => onOpenChange(tool.id, open), [onOpenChange, tool.id]);
		return <ToolBatch
			className="tool-batch-render-item"
			tools={tools}
			initialOpen={initialOpen}
			onOpenChange={handleOpenChange}
			sessionId={sessionId}
			onOpenPath={onOpenPath}
			onOpenSubagent={onOpenSubagent}
			onOpenSession={onOpenSession}
		/>;
	},
	(previous, next) => previous.initialOpen === next.initialOpen && previous.sessionId === next.sessionId &&
		previous.onOpenChange === next.onOpenChange && previous.onOpenPath === next.onOpenPath &&
		previous.onOpenSubagent === next.onOpenSubagent && previous.onOpenSession === next.onOpenSession &&
		toolBatchToolsEqual([previous.tool], [next.tool]),
);
function conversationRenderItemEqual(previous: ConversationListContent, next: ConversationListContent): boolean {
	if (previous.kind !== next.kind || previous.key !== next.key) return false;
	if (previous.kind === "tool-activity-row" && next.kind === "tool-activity-row") return toolBatchToolsEqual([previous.tool], [next.tool]);
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
	if (previous.kind === "thinking" && next.kind === "thinking") {
		return previous.text === next.text && previous.streaming === next.streaming && previous.contentRef === next.contentRef;
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

type ConversationViewProps = {
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
};

const CONVERSATION_STATE_FIELDS = {
	sessionId: true, currentProjectId: true, loading: true, connected: true, sessionReady: true, readOnly: true,
	session: true, sessionError: true, transcript: true, transcriptGeneration: true, agentSteps: true,
	transcriptPageLoaded: true, transcriptLoading: true, transcriptError: true, displayedResultRevision: true,
	previousCursor: true, hasMorePrevious: true, loadingEarlier: true, pendingUserPrompts: true,
	queuedUserPrompts: true, promptSendTimes: true, runtimeClock: true, promptScrollRequest: true,
	currentOperation: true, liveTools: true, liveSteps: true, liveTurnItems: true, liveCompaction: true,
	liveTurnId: true, settledTurns: true,
} satisfies Record<Exclude<keyof ConversationState, "projects">, true>;

function selectedSessionResultVersion(state: ConversationState): number | undefined {
	for (const project of state.projects ?? []) {
		const session = project.sessions.find((candidate) => candidate.id === state.sessionId);
		if (session) return session.result?.version;
	}
	return undefined;
}

function conversationPropsEqual(previous: ConversationViewProps, next: ConversationViewProps): boolean {
	if (previous.editorState !== next.editorState &&
		(!previous.editorState || !next.editorState || !composerStateEqual(previous.editorState, next.editorState))) return false;
	if (previous.actions !== next.actions || previous.sessionTitleText !== next.sessionTitleText ||
		previous.onEditPrompt !== next.onEditPrompt || previous.editRequest !== next.editRequest ||
		previous.editorActions !== next.editorActions || previous.onCancelEdit !== next.onCancelEdit ||
		previous.onEditComplete !== next.onEditComplete || previous.allowPromptEditing !== next.allowPromptEditing) return false;
	if (!(Object.keys(CONVERSATION_STATE_FIELDS) as Array<keyof typeof CONVERSATION_STATE_FIELDS>)
		.every((key) => previous.state[key] === next.state[key])) return false;
	return previous.state.projects === next.state.projects ||
		selectedSessionResultVersion(previous.state) === selectedSessionResultVersion(next.state);
}

export const ConversationView = memo(function ConversationView({
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
}: ConversationViewProps) {
	const responseActive = isConversationResponseActive(state);
	const thinkingActive = responseActive && state.session?.execution?.phase === "thinking";
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
				thinkingActive,
				canEditPrompts,
				editingEntryId,
				settledTurns: state.settledTurns,
				runtimeClock: state.runtimeClock,
			}),
		[
			canEditPrompts,
			editingEntryId,
			liveSteps,
			pipeline,
			state.runtimeClock,
			responseActive,
			thinkingActive,
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
}, conversationPropsEqual);

function ConversationBody({
	state,
	actions,
	sessionTitleText,
	renderItems,
	toolStatuses,
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
	onEditPrompt: (request: PromptEditRequest) => void;
	editRequest?: PromptEditRequest;
	editorState?: WorkbenchState;
	editorActions?: WorkbenchActions;
	onCancelEdit?: () => void;
	onEditComplete?: () => void;
}) {
	const responseActive = isConversationResponseActive(state);
	const waitingForThinking = responseActive && state.session?.execution?.phase === "thinking" && !activeThinkingBlock(state.liveTurnItems);
	const openResource = actions.openResource;
	const sessionKey = JSON.stringify([state.sessionId ?? "empty", state.transcriptGeneration ?? null]);
	const { retainedGroups, changeGroup, finishCollapse, syncGroups } = useConversationGroupTransitions(sessionKey);
	const {
		expandedWorkProcesses, expandedAgentSteps, expandedThinking, expandedToolBatches, expandedToolRows,
		getToolStackPresentation, updateExpandedWorkProcess, updateExpandedAgentStep,
		updateExpandedThinking, updateExpandedToolBatch, updateExpandedToolRow,
	} = useConversationExpansion(sessionKey);
	const {
		following, isAtBottom, initialSnapshot, handleListRef, handleSnapshot, handleAtBottomStateChange,
		pauseFollowing: pauseFollowOutput, resumeFollowing, handleReturnToBottom,
	} = useConversationScroll({ sessionKey, promptScrollRequest: state.promptScrollRequest });
	const { requestEarlierHistory, handleAtTopStateChange, handleUserScrollUp, handleUserScrollDown } = useConversationHistory({
		sessionKey, hasMorePrevious: state.hasMorePrevious, loadingEarlier: state.loadingEarlier,
		previousCursor: state.previousCursor, transcriptError: state.transcriptError,
		loadEarlier: actions.loadEarlier, showToast: actions.showToast,
	});
	const resultVersion = selectedSessionResultVersion(state);
	useEffect(() => {
		if (!actions.markSessionResultRead || !state.sessionId || state.displayedResultRevision === undefined ||
			!state.connected || !state.sessionReady || !state.transcriptPageLoaded || state.transcriptLoading ||
			state.transcriptError || state.sessionError || responseActive || !isAtBottom) return;
		let frame: number | undefined;
		const acknowledge = () => {
			if (document.visibilityState !== "visible") return;
			if (frame !== undefined) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				void actions.markSessionResultRead!(state.sessionId!, state.displayedResultRevision!).catch((error: unknown) =>
					actions.showToast(`保存查看状态失败：${error instanceof Error ? error.message : String(error)}`, "error"));
			});
		};
		acknowledge();
		document.addEventListener("visibilitychange", acknowledge);
		return () => {
			if (frame !== undefined) cancelAnimationFrame(frame);
			document.removeEventListener("visibilitychange", acknowledge);
		};
	}, [actions.markSessionResultRead, actions.showToast, state.sessionId, state.displayedResultRevision, state.connected,
		state.sessionReady, state.transcriptPageLoaded, state.transcriptLoading, state.transcriptError, state.sessionError, responseActive, isAtBottom, resultVersion]);
	const renderStateRef = useRef({ sessionId: state.sessionId, projectId: state.currentProjectId, toolStatuses });
	renderStateRef.current = { sessionId: state.sessionId, projectId: state.currentProjectId, toolStatuses };
	const openSubagent = actions.openSubagent;
	const openSession = actions.selectSession;
	const renderToolStack = useCallback(
		(entry: TranscriptToolStackRenderItem) => {
			const current = renderStateRef.current;
			const tools = entry.batches.flatMap((batch) => batch.tools);
			const presentation = getToolStackPresentation(entry.key, tools);
			if (presentation === "rows") {
				return (
					<div className="tool-batch-stack">
						{tools.map((tool) => (
							<ConversationToolRow
								key={tool.id}
								tool={tool}
								initialOpen={expandedToolRows.get(tool.id) ?? false}
								onOpenChange={updateExpandedToolRow}
								sessionId={current.sessionId}
								onOpenPath={openResource}
								onOpenSubagent={openSubagent}
								onOpenSession={openSession}
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
					onOpenSession={openSession}
				/>
			);
		},
		[
			expandedToolBatches,
			expandedToolRows,
			getToolStackPresentation,
			openResource,
			openSubagent,
			openSession,
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
										actions.showToast(error instanceof Error ? error.message : String(error), "error");
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
	const renderThinking = useCallback(
		(entry: ThinkingRenderItem) => <ThinkingBlock
			text={entry.text}
			isStreaming={entry.streaming}
			open={expandedThinking.get(entry.key) ?? false}
			onOpenChange={(open) => updateExpandedThinking(entry.key, open)}
			contentRef={entry.contentRef}
			sessionId={renderStateRef.current.sessionId}
			projectId={renderStateRef.current.projectId}
			onOpenPath={openResource}
		/>,
		[expandedThinking, openResource, updateExpandedThinking],
	);
	const renderConversationContentItem = useCallback(
		(entry: ConversationContentRenderItem) => {
			if (entry.kind === "agent-step") return null;
			if (entry.kind === "hook-group") return <HookActivityGroup entry={entry} />;
			if (entry.kind === "extension-group") return renderExtensionGroup(entry);
			const content =
				entry.kind === "thinking" ? renderThinking(entry) : entry.kind === "message" ? (
					renderMessage(entry)
				) : entry.kind === "tool-stack" ? (
					renderToolStack(entry)
				) : entry.kind === "compaction" ? (
					renderCompaction(entry)
				) : (
					renderTranscriptItem(entry)
				);
			return (
				<div className="min-w-0">
					{content}
				</div>
			);
		},
		[
			renderCompaction,
			renderExtensionGroup,
			renderMessage,
			renderThinking,
			renderToolStack,
			renderTranscriptItem,
		],
	);
	const renderConversationItem = useCallback(
		(entry: ConversationListContent) => {
			if (entry.kind === "tool-activity-row") return <ToolActivityRow
				tool={entry.tool} sessionId={renderStateRef.current.sessionId} onOpenPath={openResource}
				initialOpen={expandedToolRows.get(entry.tool.id) ?? false}
				onOpenChange={(open) => updateExpandedToolRow(entry.tool.id, open)}
			/>;
			if (entry.kind === "live-elapsed") {
				return (
					<LiveElapsedHeader
						key={entry.key}
						startedAt={entry.startedAt}
					/>
				);
			}
			if (entry.kind === "result-boundary") {
				return (
					<div
						aria-label="工作过程与最终结果分界"
						className="w-full border-t border-border/50"
						role="separator"
					/>
				);
			}
			if (entry.kind === "work-process") return null;
			return renderConversationContentItem(entry);
		},
		[expandedToolRows, openResource, renderConversationContentItem, updateExpandedToolRow],
	);
	const renderGroup = useCallback((layout: ConversationGroupLayout) => {
		const entry = layout.entry;
		if (entry.kind === "tool-stack") return <ToolActivityGroup
			tools={entry.batches.flatMap((batch) => batch.tools)} kind={entry.activityKind}
			open={layout.open} onOpenChange={(open) => { changeGroup(entry.key, open); updateExpandedToolBatch(entry.key, open); }}
			onCollapseComplete={() => finishCollapse(entry.key)}
			className="tool-batch-render-item" sessionId={renderStateRef.current.sessionId}
			headerProps={{ ref: layout.headerRef, "data-index": layout.headerIndex, "data-conversation-row": entry.key }}
			padding={layout.padding}
		>{layout.children}</ToolActivityGroup>;
		return <ConversationGroup {...layout} entry={entry} onOpenChange={(open) => {
			changeGroup(entry.key, open);
			if (entry.kind === "agent-step") updateExpandedAgentStep(entry.key, open);
			else updateExpandedWorkProcess(entry.key, open);
		}} onCollapseComplete={() => finishCollapse(entry.key)} />;
	}, [changeGroup, finishCollapse, updateExpandedAgentStep, updateExpandedToolBatch, updateExpandedWorkProcess]);

	const transcriptGap = useCallback(
		(previous: ConversationRenderItem, current: ConversationRenderItem) => {
			if (current.kind === "result-boundary") return 8;
			if (previous.kind === "result-boundary") return DEFAULT_TRANSCRIPT_GAP;
			return activityRowGap(previous, current);
		},
		[],
	);
	const listModel = useMemo(() => buildConversationListModel(renderItems, {
		expandedAgentSteps, expandedWorkProcesses, expandedThinking, expandedToolBatches, retainedGroups,
		toolPresentation: getToolStackPresentation,
		toolActivityPresentation: (entry) => toolBatchActivityPresentation(entry.batches.flatMap((batch) => batch.tools)),
		gap: transcriptGap,
	}), [expandedAgentSteps, expandedWorkProcesses, expandedThinking, expandedToolBatches, getToolStackPresentation, renderItems, retainedGroups, transcriptGap]);
	syncGroups(listModel.nodes);
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
				<ConversationList
					key={sessionKey}
					model={listModel}
					sessionKey={sessionKey}
					following={following}
					initialSnapshot={initialSnapshot}
					header={historyStatus}
					footer={waitingForThinking ? <ThinkingBlock text="" isStreaming /> : null}
					renderContent={renderConversationItem}
					isItemEqual={conversationRenderItemEqual}
					renderGroup={renderGroup}
					onListRef={handleListRef}
					onSnapshot={handleSnapshot}
					onAtBottom={handleAtBottomStateChange}
					onAtTop={handleAtTopStateChange}
					onPause={pauseFollowOutput}
					onResume={resumeFollowing}
					onUp={handleUserScrollUp}
					onDown={handleUserScrollDown}
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
