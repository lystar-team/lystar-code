import { LoaderCircle, Sparkles } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { toLiveToolViewModel } from "../../adapters/live-tool-view-model.ts";
import { toSessionItemViewModel } from "../../adapters/session-view-model";
import { type LiveCompactionState } from "../../state/compaction-state";
import { shouldJoinToolBatch } from "../../state/tool-batching";
import type { LiveTurnItem, WorkbenchState } from "../../state/use-workbench";
import { CompactionCard } from "./compaction-card";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "../ai-elements/conversation";
import { ToolBatch, toolBatchSummaryLabel, type ToolBatchTool } from "../ai-elements/tool-batch";
import { Button } from "../ui/button";
import { ACTIVE_OPERATION_STATUSES } from "./constants";
import { ThinkingBlock } from "./live-turn";
import { AgentErrorCard, TranscriptItemView, TranscriptMessageView } from "./transcript";
import { DEFAULT_TRANSCRIPT_GAP, VirtualizedTranscript } from "./virtualized-transcript";
import type { WorkbenchActions } from "./types";

type MessageRenderItem = {
	kind: "message";
	key: string;
	live: boolean;
	role: "user" | "assistant" | "system";
	text: string;
	attachments: Array<{ id: string; filename: string; mediaType: string; url: string }>;
	sources: string[];
	copyVisible: boolean;
};
type ThinkingRenderItem = { kind: "thinking"; key: string; text: string };
type TranscriptItemRenderItem = { kind: "item"; key: string; item: WorkbenchState["transcript"][number] };
type TranscriptBatchRenderItem = { kind: "tool-batch"; key: string; tools: ToolBatchTool[] };
type ActivityBoundaryRenderItem = { kind: "activity-boundary"; key: string };
type TranscriptToolStackRenderItem = {
	kind: "tool-stack";
	key: string;
	live: boolean;
	batches: TranscriptBatchRenderItem[];
};
type CompactionRenderItem = {
	kind: "compaction";
	key: string;
	live: boolean;
	state?: LiveCompactionState;
	text?: string;
	tokensBefore?: number;
};
type ConversationRenderItem =
	| MessageRenderItem
	| ThinkingRenderItem
	| TranscriptItemRenderItem
	| TranscriptToolStackRenderItem
	| CompactionRenderItem;
type RawRenderItem =
	| MessageRenderItem
	| TranscriptItemRenderItem
	| TranscriptBatchRenderItem
	| ActivityBoundaryRenderItem
	| CompactionRenderItem;

const HISTORY_LOAD_THRESHOLD = 240;
const HISTORY_LOAD_RESET_DISTANCE = 480;

type ToolIndex = {
	callIds: ReadonlySet<string>;
	results: ReadonlyMap<string, ToolBatchTool>;
	statuses: ReadonlyMap<string, "success" | "error">;
};

function isToolComplete(tool: ToolBatchTool): boolean {
	return (
		tool.state === "output-available" ||
		tool.state === "output-error" ||
		tool.state === "output-cancelled" ||
		tool.state === "output-interrupted"
	);
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

function toolBatchToolsEqual(previous: readonly ToolBatchTool[], next: readonly ToolBatchTool[]): boolean {
	if (previous === next) return true;
	if (previous.length !== next.length) return false;
	return previous.every((tool, index) => {
		const candidate = next[index];
		return (
			candidate?.id === tool.id &&
			candidate.name === tool.name &&
			candidate.summary === tool.summary &&
			candidate.state === tool.state &&
			candidate.detail === tool.detail &&
			candidate.inputPreview === tool.inputPreview &&
			candidate.images === tool.images &&
			candidate.diff === tool.diff
		);
	});
}

function persistedToolBatchKind(batch: TranscriptBatchRenderItem): "read" | "image" | "action" {
	if (batch.tools.length > 0 && batch.tools.every((tool) => tool.name === "read" && Boolean(tool.images?.length))) return "image";
	if (batch.tools.length > 0 && batch.tools.every((tool) => tool.name === "read")) return "read";
	return "action";
}

function conversationRenderItemEqual(previous: ConversationRenderItem, next: ConversationRenderItem): boolean {
	if (previous.kind !== next.kind || previous.key !== next.key) return false;
	if (previous.kind === "message" && next.kind === "message") {
		return (
			previous.live === next.live &&
			previous.role === next.role &&
			previous.text === next.text &&
			previous.copyVisible === next.copyVisible &&
			previous.sources.join("\u0000") === next.sources.join("\u0000") &&
			attachmentListsEqual(previous.attachments, next.attachments)
		);
	}
	if (previous.kind === "thinking" && next.kind === "thinking") return previous.text === next.text;
	if (previous.kind === "tool-stack" && next.kind === "tool-stack") {
		return (
			previous.live === next.live &&
			previous.batches.length === next.batches.length &&
			previous.batches.every((batch, index) => {
				const candidate = next.batches[index];
				return candidate?.key === batch.key && toolBatchToolsEqual(batch.tools, candidate.tools);
			})
		);
	}
	if (previous.kind === "compaction" && next.kind === "compaction") {
		return previous.live
			? next.live && previous.state === next.state
			: !next.live && previous.text === next.text && previous.tokensBefore === next.tokensBefore;
	}
	return previous.kind === "item" && next.kind === "item" && previous.item === next.item;
}

function groupPersistedToolBatches(rendered: Array<RawRenderItem>): ConversationRenderItem[] {
	const grouped: ConversationRenderItem[] = [];
	let previousToolStack: TranscriptToolStackRenderItem | undefined;
	let previousToolBatchKind: "read" | "image" | "action" | undefined;
	for (const entry of rendered) {
		if (entry.kind === "activity-boundary") {
			previousToolStack = undefined;
			previousToolBatchKind = undefined;
			continue;
		}
		if (entry.kind === "tool-batch") {
			const toolBatchKind = persistedToolBatchKind(entry);
			if (previousToolStack && previousToolBatchKind === toolBatchKind) {
				previousToolStack.batches.push(entry);
			} else {
				previousToolStack = { kind: "tool-stack", key: `tool-stack:${entry.key}`, live: false, batches: [entry] };
				grouped.push(previousToolStack);
			}
			previousToolBatchKind = toolBatchKind;
			continue;
		}
		grouped.push(entry);
		previousToolStack = undefined;
		previousToolBatchKind = undefined;
	}
	return grouped;
}

export function buildPersistedRenderItems(
	items: WorkbenchState["transcript"],
	toolIndex: ToolIndex,
): ConversationRenderItem[] {
	const rendered: Array<RawRenderItem> = [];
	let batchTools: ToolBatchTool[] = [];
	let batchKey = "";
	let batchEntryId: string | undefined;

	const flushBatch = () => {
		if (batchTools.length > 0) {
			rendered.push({ kind: "tool-batch", key: batchKey, tools: batchTools });
			batchTools = [];
			batchKey = "";
			batchEntryId = undefined;
		}
	};

	for (const item of items) {
		const viewModel = toSessionItemViewModel(item, toolIndex.statuses);
		if (viewModel.kind === "reasoning") {
			flushBatch();
			rendered.push({ kind: "activity-boundary", key: `activity-boundary:${item.renderId}` });
			continue;
		}
		if (viewModel.kind === "message") {
			flushBatch();
			rendered.push({
				kind: "message",
				key: item.renderId,
				live: false,
				role: viewModel.role,
				text: viewModel.text,
				attachments: viewModel.attachments,
				sources: viewModel.sources,
				copyVisible: false,
			});
			continue;
		}
		if (viewModel.kind === "tools" && item.view?.type === "tool_call") {
			for (const tool of viewModel.tools) {
				const result = toolIndex.results.get(tool.id);
				const resolvedTool = result
					? { ...tool, ...result, summary: tool.summary || result.summary }
					: tool;
				const previous = batchTools.at(-1);
				if (!previous || batchEntryId !== item.entryId || !shouldJoinToolBatch(previous.name, resolvedTool.name)) {
					flushBatch();
					batchEntryId = item.entryId;
					batchKey = `tool-batch:${item.renderId}:${resolvedTool.id}`;
				}
				batchTools.push(resolvedTool);
			}
			continue;
		}
		if (viewModel.kind === "tools" && item.view?.type === "tool_result") {
			if (toolIndex.callIds.has(item.view.callId)) continue;
			flushBatch();
			rendered.push({ kind: "item", key: item.renderId, item });
			continue;
		}
		flushBatch();
		if (viewModel.kind === "summary" && (viewModel.variant === "compaction" || viewModel.title === "上下文压缩")) {
			rendered.push({
				kind: "compaction",
				key: item.renderId,
				live: false,
				text: viewModel.text,
				tokensBefore: viewModel.tokensBefore,
			});
		} else {
			rendered.push({ kind: "item", key: item.renderId, item });
		}
	}
	flushBatch();
	return groupPersistedToolBatches(rendered);
}

export function appendLiveRenderItems(
	rendered: ConversationRenderItem[],
	liveItems: readonly LiveTurnItem[],
	liveTools: WorkbenchState["liveTools"],
	committedToolCallIds: ReadonlySet<string>,
	liveCompaction: LiveCompactionState | undefined,
	liveTurnId: number,
): ConversationRenderItem[] {
	const next = [...rendered];
	for (const item of liveItems) {
		if (item.kind === "thinking") {
			if (!item.parts.length || next.some((entry) => entry.key === item.id)) continue;
			next.push({ kind: "thinking", key: item.id, text: item.parts.join("") });
			continue;
		}
		if (item.kind === "text") {
			if (!item.parts.length || next.some((entry) => entry.key === item.id)) continue;
			next.push({
				kind: "message",
				key: item.id,
				live: true,
				role: "assistant",
				text: item.parts.join(""),
				attachments: [],
				sources: [],
				copyVisible: false,
			});
			continue;
		}
		if (item.kind !== "tools") continue;
		const tools = item.toolIds.flatMap((toolId) => {
			const tool = liveTools[toolId];
			if (!tool || committedToolCallIds.has(toolId)) return [];
			return [toLiveToolViewModel(tool)];
		});
		if (!tools.length) continue;
		const batchKey = `tool-batch:${item.id}:${tools[0]?.id ?? item.batchId}`;
		if (next.some((entry) => entry.key === `tool-stack:${batchKey}`)) continue;
		next.push({
			kind: "tool-stack",
			key: `tool-stack:${batchKey}`,
			live: true,
			batches: [{ kind: "tool-batch", key: batchKey, tools }],
		});
	}
	if (liveCompaction) {
		const key = `live-compaction:${liveTurnId}`;
		const existingIndex = next.findIndex((entry) => entry.kind === "compaction" && entry.key === key);
		if (existingIndex >= 0 && next[existingIndex]?.kind === "compaction") {
			next[existingIndex] = { ...next[existingIndex], live: true, state: liveCompaction };
		} else {
			next.push({ kind: "compaction", key, live: true, state: liveCompaction });
		}
	}
	return next;
}

export function buildConversationRenderItems(
	persistedItems: ConversationRenderItem[],
	pendingUserPrompts: WorkbenchState["pendingUserPrompts"],
	liveItems: readonly LiveTurnItem[],
	liveTools: WorkbenchState["liveTools"],
	committedToolCallIds: ReadonlySet<string>,
	liveCompaction: LiveCompactionState | undefined,
	liveTurnId: number,
	responseActive: boolean,
): ConversationRenderItem[] {
	const next = [...persistedItems];
	for (const prompt of pendingUserPrompts) {
		next.push({
			kind: "message",
			key: prompt.id,
			live: false,
			role: "user",
			text: prompt.text,
			attachments: [],
			sources: [],
			copyVisible: false,
		});
	}
	const withLive = appendLiveRenderItems(
		next,
		liveItems,
		liveTools,
		committedToolCallIds,
		liveCompaction,
		liveTurnId,
	);
	if (responseActive) return withLive;
	for (let index = withLive.length - 1; index >= 0; index--) {
		const entry = withLive[index];
		if (entry?.kind !== "message" || entry.role !== "assistant" || !entry.text) continue;
		withLive[index] = { ...entry, copyVisible: true };
		break;
	}
	return withLive;
}

function isConversationResponseActive(state: WorkbenchState): boolean {
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
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	sessionTitleText: string;
}) {
	const persistedToolIndex = useMemo(() => {
		const callIds = new Set<string>();
		const results = new Map<string, ToolBatchTool>();
		const statuses = new Map<string, "success" | "error">();
		for (const item of state.transcript) {
			if (item.view?.type === "tool_call") {
				for (const call of item.view.calls) callIds.add(call.id);
			}
			if (item.view?.type === "tool_result") {
				const tool: ToolBatchTool = {
					id: item.view.callId,
					name: item.view.name,
					summary: item.view.summary,
					state: item.view.status === "success" ? "output-available" : "output-error",
					detail: item.view.detail,
					images: item.view.images,
					diff: item.view.diff,
				};
				results.set(item.view.callId, tool);
				statuses.set(item.view.callId, item.view.status);
			}
		}
		return { callIds, results, statuses };
	}, [state.transcript]);
	const toolIndex = useMemo(() => {
		let results: Map<string, ToolBatchTool> | undefined;
		for (const tool of Object.values(state.liveTools)) {
			if (!persistedToolIndex.callIds.has(tool.id)) continue;
			const persisted = (results ?? persistedToolIndex.results).get(tool.id);
			if (!persisted || tool.state === "cancelled" || tool.state === "interrupted") {
				results ??= new Map(persistedToolIndex.results);
				const live = toLiveToolViewModel(tool);
				results.set(tool.id, { ...persisted, ...live, images: persisted?.images });
			}
		}
		return results ? { ...persistedToolIndex, results } : persistedToolIndex;
	}, [persistedToolIndex, state.liveTools]);
	const responseActive = isConversationResponseActive(state);
	const persistedRenderItems = useMemo(
		() => buildPersistedRenderItems(state.transcript, toolIndex),
		[state.transcript, toolIndex],
	);
	const renderItems = useMemo(
		() =>
			buildConversationRenderItems(
				persistedRenderItems,
				state.pendingUserPrompts,
				state.liveTurnItems,
				state.liveTools,
				toolIndex.callIds,
				state.liveCompaction,
				state.liveTurnId,
				responseActive,
			),
		[
			persistedRenderItems,
			state.liveCompaction,
			state.liveTools,
			state.liveTurnId,
			state.liveTurnItems,
			state.pendingUserPrompts,
			toolIndex.callIds,
			responseActive,
		],
	);

	return (
		<>
			<Conversation key={state.sessionId ?? "empty"} className="min-h-0 flex-1">
				<ConversationBody
					state={state}
					actions={actions}
					sessionTitleText={sessionTitleText}
					renderItems={renderItems}
					toolStatuses={toolIndex.statuses}
				/>
				<ConversationScrollButton aria-label="回到最新消息" />
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
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	sessionTitleText: string;
	renderItems: ConversationRenderItem[];
	toolStatuses: ReadonlyMap<string, "success" | "error">;
}) {
	const { scrollRef, scrollToBottom, isAtBottom, escapedFromLock } = useStickToBottomContext();
	const pendingScrollRef = useRef<{ top: number; height: number } | undefined>(undefined);
	const promptScrollRequestRef = useRef(state.promptScrollRequest);
	const promptFollowRef = useRef(false);
	const promptFollowPendingRef = useRef(false);
	const isAtBottomRef = useRef(isAtBottom);
	isAtBottomRef.current = isAtBottom;
	const shouldAutoCollapseTools = useCallback(() => isAtBottomRef.current, []);

	const loadEarlier = useCallback(async () => {
		const scroller = scrollRef.current;
		if (scroller) pendingScrollRef.current = { top: scroller.scrollTop, height: scroller.scrollHeight };
		try {
			await actions.loadEarlier();
		} catch (error) {
			pendingScrollRef.current = undefined;
			throw error;
		}
	}, [actions.loadEarlier, scrollRef]);
	const loadEarlierRef = useRef(loadEarlier);
	loadEarlierRef.current = loadEarlier;
	const historyLoadBlockedRef = useRef(false);
	const initialSessionScrollRef = useRef<string | undefined>(undefined);

	useLayoutEffect(() => {
		if (!state.sessionId) {
			initialSessionScrollRef.current = undefined;
			return;
		}
		if (!state.transcriptPageLoaded && !renderItems.length) return;
		if (initialSessionScrollRef.current === state.sessionId) return;
		initialSessionScrollRef.current = state.sessionId;
		pendingScrollRef.current = undefined;
		promptFollowRef.current = false;
		promptFollowPendingRef.current = false;
		const frame = window.requestAnimationFrame(() => {
			void scrollToBottom({ animation: "instant" });
		});
		return () => window.cancelAnimationFrame(frame);
	}, [renderItems.length, scrollToBottom, state.sessionId, state.transcriptPageLoaded]);

	useLayoutEffect(() => {
		if (promptScrollRequestRef.current === state.promptScrollRequest) return;
		promptScrollRequestRef.current = state.promptScrollRequest;
		promptFollowRef.current = true;
		promptFollowPendingRef.current = true;
		pendingScrollRef.current = undefined;
		void scrollToBottom({ animation: "instant" });
	}, [scrollToBottom, state.promptScrollRequest]);

	useLayoutEffect(() => {
		if (!state.hasMorePrevious) return;
		const scroller = scrollRef.current;
		if (!scroller) return;
		let frame: number | undefined;
		const checkTopBoundary = () => {
			frame = undefined;
			if (scroller.scrollTop > HISTORY_LOAD_RESET_DISTANCE) {
				historyLoadBlockedRef.current = false;
				return;
			}
			if (
				scroller.scrollTop > HISTORY_LOAD_THRESHOLD ||
				state.loadingEarlier ||
				historyLoadBlockedRef.current
			)
				return;
			historyLoadBlockedRef.current = true;
			void loadEarlierRef.current().then(
				() => {
					historyLoadBlockedRef.current = false;
				},
				(error: unknown) => {
					actions.showToast(error instanceof Error ? error.message : String(error));
				},
			);
		};
		const scheduleCheck = () => {
			if (frame !== undefined) return;
			frame = window.requestAnimationFrame(checkTopBoundary);
		};
		scroller.addEventListener("scroll", scheduleCheck, { passive: true });
		return () => {
			scroller.removeEventListener("scroll", scheduleCheck);
			if (frame !== undefined) window.cancelAnimationFrame(frame);
		};
	}, [actions.showToast, scrollRef, state.hasMorePrevious, state.loadingEarlier]);

	useLayoutEffect(() => {
		if (!promptFollowRef.current) return;
		if (promptFollowPendingRef.current) {
			promptFollowPendingRef.current = false;
			void scrollToBottom({ animation: "instant" });
			return;
		}
		if (escapedFromLock && !isAtBottom) {
			promptFollowRef.current = false;
			return;
		}
		void scrollToBottom({ animation: "instant" });
	}, [escapedFromLock, isAtBottom, renderItems, scrollToBottom]);

	const responseActive = isConversationResponseActive(state);
	useEffect(() => {
		if (!promptFollowRef.current || responseActive) return;
		const frame = window.requestAnimationFrame(() => {
			promptFollowRef.current = false;
			promptFollowPendingRef.current = false;
		});
		return () => window.cancelAnimationFrame(frame);
	}, [responseActive]);

	useLayoutEffect(() => {
		if (state.loadingEarlier || !pendingScrollRef.current) return;
		const frame = window.requestAnimationFrame(() => {
			const scroller = scrollRef.current;
			const pending = pendingScrollRef.current;
			if (scroller && pending) scroller.scrollTop = pending.top + (scroller.scrollHeight - pending.height);
			pendingScrollRef.current = undefined;
		});
		return () => window.cancelAnimationFrame(frame);
	}, [scrollRef, state.loadingEarlier]);

	const openResource = actions.openResource;
	const [expandedToolBatches, setExpandedToolBatches] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	const [expandedToolRows, setExpandedToolRows] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	const updateExpandedToolBatch = useCallback((key: string, open: boolean) => {
		setExpandedToolBatches((current) => {
			if ((current.get(key) ?? false) === open) return current;
			const next = new Map(current);
			if (open) next.set(key, true);
			else next.delete(key);
			return next;
		});
	}, []);
	const updateExpandedToolRow = useCallback((toolId: string, open: boolean) => {
		setExpandedToolRows((current) => {
			if ((current.get(toolId) ?? false) === open) return current;
			const next = new Map(current);
			if (open) next.set(toolId, true);
			else next.delete(toolId);
			return next;
		});
	}, []);
	const renderStateRef = useRef({ sessionId: state.sessionId, toolStatuses });
	renderStateRef.current = { sessionId: state.sessionId, toolStatuses };
	const renderConversationItem = useCallback(
		(entry: ConversationRenderItem) => {
			const current = renderStateRef.current;
			if (entry.kind === "message") {
				return (
					<TranscriptMessageView
						role={entry.role}
						text={entry.text}
						attachments={entry.attachments}
						sources={entry.sources}
						showCopy={entry.copyVisible}
						sessionId={current.sessionId}
						onOpenPath={openResource}
						mode={entry.live ? "streaming" : "static"}
					/>
				);
			}
			if (entry.kind === "thinking") return <ThinkingBlock text={entry.text} />;
			if (entry.kind === "tool-stack") {
				const tools = entry.batches.flatMap((batch) => batch.tools);
				const allToolsCompleted = tools.length > 0 && tools.every(isToolComplete);
				if (!allToolsCompleted) {
					return (
						<div className="tool-batch-stack">
							{tools.map((tool) => (
								<ToolBatch
									key={tool.id}
									className="tool-batch-render-item"
									tools={[tool]}
									initialOpen={false}
									autoCollapseWhenComplete={shouldAutoCollapseTools}
									sessionId={current.sessionId}
									onOpenPath={(path) => void openResource(path)}
								/>
							))}
						</div>
					);
				}
				const standaloneReadTools =
					tools.length > 0 && tools.every((tool) => tool.name === "read" && !tool.images?.length);
				if (standaloneReadTools) {
					return (
						<div className="tool-batch-stack">
							{tools.map((tool) => (
								<ToolBatch
									key={tool.id}
									className="tool-batch-render-item"
									tools={[tool]}
									initialOpen={false}
									autoCollapseWhenComplete={shouldAutoCollapseTools}
									sessionId={current.sessionId}
									onOpenPath={(path) => void openResource(path)}
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
						initialOpen={false}
						open={entry.live ? undefined : expandedToolBatches.get(entry.key) ?? false}
						onOpenChange={entry.live ? undefined : (open) => updateExpandedToolBatch(entry.key, open)}
						toolOpen={entry.live ? undefined : expandedToolRows}
						onToolOpenChange={entry.live ? undefined : updateExpandedToolRow}
						autoCollapseWhenComplete={shouldAutoCollapseTools}
						sessionId={current.sessionId}
						onOpenPath={(path) => void openResource(path)}
					/>
				);
			}
			if (entry.kind === "compaction") {
				return (
					<CompactionCard
						state={entry.live ? entry.state : undefined}
						text={entry.live ? undefined : entry.text}
						tokensBefore={entry.live ? undefined : entry.tokensBefore}
						onOpenPath={openResource}
					/>
				);
			}
			return (
				<TranscriptItemView
					item={entry.item}
					showCopy={false}
					toolStatuses={current.toolStatuses}
					onOpenPath={openResource}
					sessionId={current.sessionId}
				/>
			);
		},
		[
			expandedToolBatches,
			expandedToolRows,
			openResource,
			shouldAutoCollapseTools,
			updateExpandedToolBatch,
			updateExpandedToolRow,
		],
	);
	const transcriptItemKey = useCallback((entry: ConversationRenderItem) => entry.key, []);
	const estimateTranscriptItemHeight = useCallback(
		(entry: ConversationRenderItem) =>
			(entry.kind === "tool-stack" || entry.kind === "compaction" || entry.kind === "thinking" ? 32 : 80),
		[],
	);

	return (
		<ConversationContent className="conversation-content mx-auto w-full max-w-[var(--conversation-width)] gap-3 px-5 py-10 sm:px-10 sm:py-12">
			{state.loadingEarlier ? (
				<div className="mx-auto flex items-center gap-2 py-2 text-sm text-muted-foreground" aria-live="polite" aria-busy="true">
					<LoaderCircle className="size-4 animate-spin" />
					正在加载更早消息
				</div>
			) : state.hasMorePrevious && state.transcriptError ? (
				<Button
					className="mx-auto"
					size="sm"
					variant="outline"
					disabled={state.loadingEarlier}
					onClick={() => {
						historyLoadBlockedRef.current = false;
						void loadEarlier().catch((error: unknown) => {
							actions.showToast(error instanceof Error ? error.message : String(error));
						});
					}}
				>
					重新加载更早消息
				</Button>
			) : null}
			{state.loading ? (
				<div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" aria-live="polite" aria-busy="true">
					<LoaderCircle className="size-4 animate-spin" />
					正在加载项目与会话
				</div>
			) : state.sessionError ? (
				<AgentErrorCard
					title="会话信息加载失败"
					message={state.sessionError}
					onRetry={state.sessionId ? () => void actions.selectSession(state.sessionId!) : undefined}
				/>
			) : state.transcriptLoading && !state.transcript.length && !renderItems.length ? (
				<div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" aria-live="polite" aria-busy="true">
					<LoaderCircle className="size-4 animate-spin" />
					正在加载会话记录
				</div>
			) : state.transcriptError && !state.transcript.length && !renderItems.length ? (
				<AgentErrorCard title="会话记录加载失败" message={state.transcriptError} onRetry={() => void actions.loadTranscript()} />
			) : renderItems.length ? (
				<VirtualizedTranscript
					items={renderItems}
					getKey={transcriptItemKey}
					estimateHeight={estimateTranscriptItemHeight}
					gap={(previous, current) =>
						previous.kind === "tool-stack" && current.kind === "tool-stack" ? 0 : DEFAULT_TRANSCRIPT_GAP
					}
					renderItem={renderConversationItem}
					isItemEqual={conversationRenderItemEqual}
					scrollRef={scrollRef}
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
