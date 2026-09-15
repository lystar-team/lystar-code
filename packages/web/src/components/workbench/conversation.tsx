import { ArrowDownIcon, ChevronDownIcon, LoaderCircle, Sparkles, WrenchIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { toLiveToolViewModel } from "../../adapters/live-tool-view-model.ts";
import { toSessionItemViewModel } from "../../adapters/session-view-model";
import { type LiveCompactionState } from "../../state/compaction-state";
import { shouldJoinToolBatch, skillNameFromTool } from "../../state/tool-batching";
import type { LiveTurnItem, WorkbenchState } from "../../state/use-workbench";
import { canSendPrompt, hasActiveSessionWork } from "../../state/chat-lifecycle";
import type { PromptAttachmentPreview } from "../../types";
import { CompactionCard } from "./compaction-card";
import { Conversation, ConversationContent, ConversationEmptyState } from "../ai-elements/conversation";
import { ToolBatch, toolBatchSummaryLabel, type ToolBatchTool } from "../ai-elements/tool-batch";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { GsapCollapsibleContent } from "../ui/gsap-collapsible-content";
import { GsapReveal } from "../ui/gsap-reveal";
import { ACTIVE_OPERATION_STATUSES } from "./constants";
import { latestThinkingLine, ThinkingBlock } from "./live-turn";
import { AgentErrorCard, TranscriptItemView, TranscriptMessageView } from "./transcript";
import {
	DEFAULT_TRANSCRIPT_GAP,
	shouldFollowTranscriptResize,
	VirtualizedConversationTranscript,
} from "./virtualized-transcript";
import type { PromptEditRequest, WorkbenchActions } from "./types";

type MessageRenderItem = {
	kind: "message";
	key: string;
	entryId?: string;
	live: boolean;
	role: "user" | "assistant" | "system";
	text: string;
	timestamp?: string;
	durationLabel?: string;
	attachments: PromptAttachmentPreview[];
	sources: string[];
	copyVisible: boolean;
	editable: boolean;
};
type ThinkingRenderItem = { kind: "thinking"; key: string; text: string };
type TranscriptItemRenderItem = { kind: "item"; key: string; item: WorkbenchState["transcript"][number] };
type TranscriptBatchRenderItem = { kind: "tool-batch"; key: string; tools: ToolBatchTool[] };
type ActivityBoundaryRenderItem = { kind: "activity-boundary"; key: string };
type ResultBoundaryRenderItem = { kind: "result-boundary"; key: string };
type TranscriptToolStackRenderItem = {
	kind: "tool-stack";
	key: string;
	live: boolean;
	collapseForResult: boolean;
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
type ConversationContentRenderItem =
	| MessageRenderItem
	| ThinkingRenderItem
	| TranscriptItemRenderItem
	| TranscriptToolStackRenderItem
	| CompactionRenderItem;
type WorkProcessRenderItem = {
	kind: "work-process";
	key: string;
	items: ConversationContentRenderItem[];
};
type ConversationRenderItem = ConversationContentRenderItem | WorkProcessRenderItem | ResultBoundaryRenderItem;
type RawRenderItem =
	| MessageRenderItem
	| TranscriptItemRenderItem
	| TranscriptBatchRenderItem
	| ActivityBoundaryRenderItem
	| CompactionRenderItem;

const HISTORY_LOAD_THRESHOLD = 240;
const HISTORY_LOAD_RESET_DISTANCE = 480;

export function formatElapsedDuration(durationMs: number): string | undefined {
	if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;
	const totalMinutes = Math.max(1, Math.floor(durationMs / 60_000));
	const totalHours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (totalHours === 0) return `${totalMinutes}分钟`;
	const paddedMinutes = String(minutes).padStart(2, "0");
	if (totalHours < 24) return `${totalHours}小时${paddedMinutes}分钟`;
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return `${days}天${String(hours).padStart(2, "0")}小时${paddedMinutes}分钟`;
}

function elapsedDurationLabel(startTimestamp?: string, endTimestamp?: string): string | undefined {
	if (!startTimestamp || !endTimestamp) return undefined;
	const start = Date.parse(startTimestamp);
	const end = Date.parse(endTimestamp);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
	return formatElapsedDuration(end - start);
}

type InitialTranscriptDisplayState = "ready" | "loading" | "error";

export function initialTranscriptDisplayState(
	state: Pick<WorkbenchState, "transcriptPageLoaded" | "transcriptLoading" | "transcriptError">,
): InitialTranscriptDisplayState {
	if (state.transcriptPageLoaded) return "ready";
	if (state.transcriptLoading) return "loading";
	return state.transcriptError ? "error" : "ready";
}

type ToolIndex = {
	callIds: ReadonlySet<string>;
	results: ReadonlyMap<string, ToolBatchTool>;
	statuses: ReadonlyMap<string, "success" | "error">;
};

function isWebSearchTranscriptItem(entry: ConversationRenderItem): boolean {
	return entry.kind === "item" && entry.item.view?.type === "web_search";
}

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
		return (
			candidate?.id === tool.id &&
			candidate.name === tool.name &&
			candidate.summary === tool.summary &&
			candidate.state === tool.state &&
			candidate.detail === tool.detail &&
			candidate.inputPreview === tool.inputPreview &&
			toolSourcesEqual(tool.sources, candidate.sources) &&
			candidate.images === tool.images &&
			candidate.diff === tool.diff
		);
	});
}

type PersistedToolBatchKind = "read" | "skill" | "generated-image" | "image" | "search" | "action";

function persistedToolBatchKind(batch: TranscriptBatchRenderItem): PersistedToolBatchKind {
	if (batch.tools.length > 0 && batch.tools.every((tool) => Boolean(skillNameFromTool(tool)))) return "skill";
	if (batch.tools.length > 0 && batch.tools.every((tool) => tool.name === "web_search")) return "search";
	if (batch.tools.length > 0 && batch.tools.every((tool) => tool.name === "image_gen")) return "generated-image";
	if (batch.tools.length > 0 && batch.tools.every((tool) => tool.name === "read" && Boolean(tool.images?.length))) return "image";
	if (batch.tools.length > 0 && batch.tools.every((tool) => tool.name === "read")) return "read";
	return "action";
}

function conversationRenderItemEqual(previous: ConversationRenderItem, next: ConversationRenderItem): boolean {
	if (previous.kind !== next.kind || previous.key !== next.key) return false;
	if (previous.kind === "message" && next.kind === "message") {
		return (
			previous.live === next.live &&
			previous.entryId === next.entryId &&
			previous.role === next.role &&
			previous.text === next.text &&
			previous.durationLabel === next.durationLabel &&
			previous.copyVisible === next.copyVisible &&
			previous.editable === next.editable &&
			previous.sources.join("\u0000") === next.sources.join("\u0000") &&
			attachmentListsEqual(previous.attachments, next.attachments)
		);
	}
	if (previous.kind === "thinking" && next.kind === "thinking") return previous.text === next.text;
	if (previous.kind === "tool-stack" && next.kind === "tool-stack") {
		return (
			previous.live === next.live &&
			previous.collapseForResult === next.collapseForResult &&
			previous.batches.length === next.batches.length &&
			previous.batches.every((batch, index) => {
				const candidate = next.batches[index];
				return candidate?.key === batch.key && toolBatchToolsEqual(batch.tools, candidate.tools);
			})
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
	if (previous.kind === "compaction" && next.kind === "compaction") {
		return previous.live
			? next.live && previous.state === next.state
			: !next.live && previous.text === next.text && previous.tokensBefore === next.tokensBefore;
	}
	return previous.kind === "item" && next.kind === "item" && previous.item === next.item;
}

function groupPersistedToolBatches(rendered: Array<RawRenderItem>): ConversationContentRenderItem[] {
	const grouped: ConversationContentRenderItem[] = [];
	let previousToolStack: TranscriptToolStackRenderItem | undefined;
	let previousToolBatchKind: PersistedToolBatchKind | undefined;
	for (const entry of rendered) {
		if (entry.kind === "activity-boundary") {
			previousToolStack = undefined;
			previousToolBatchKind = undefined;
			continue;
		}
		if (entry.kind === "tool-batch") {
			const toolBatchKind = persistedToolBatchKind(entry);
			if (previousToolStack && previousToolBatchKind === toolBatchKind && toolBatchKind !== "skill") {
				previousToolStack.batches.push(entry);
			} else {
				previousToolStack = {
				kind: "tool-stack",
				key: `tool-stack:${entry.key}`,
				live: false,
				collapseForResult: false,
				batches: [entry],
			};
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
	pendingUserPrompts: WorkbenchState["pendingUserPrompts"] = [],
): ConversationContentRenderItem[] {
	const rendered: Array<RawRenderItem> = [];
	let batchTools: ToolBatchTool[] = [];
	let batchKey = "";
	let batchEntryId: string | undefined;

	const pendingAtIndex = new Map<number, WorkbenchState["pendingUserPrompts"]>();
	for (const prompt of pendingUserPrompts) {
		let insertIndex = prompt.afterEntryId ? items.length : 0;
		if (prompt.afterEntryId) {
			for (let index = items.length - 1; index >= 0; index--) {
				if (items[index]?.entryId === prompt.afterEntryId) {
					insertIndex = index + 1;
					break;
				}
			}
		}
		const prompts = pendingAtIndex.get(insertIndex) ?? [];
		prompts.push(prompt);
		pendingAtIndex.set(insertIndex, prompts);
	}

	const flushBatch = () => {
		if (batchTools.length > 0) {
			rendered.push({ kind: "tool-batch", key: batchKey, tools: batchTools });
			batchTools = [];
			batchKey = "";
			batchEntryId = undefined;
		}
	};
	const appendPendingPrompts = (index: number) => {
		const prompts = pendingAtIndex.get(index);
		if (!prompts?.length) return;
		flushBatch();
		for (const prompt of prompts) {
			rendered.push({
				kind: "message",
				key: prompt.id,
				live: false,
				role: "user",
				text: prompt.text,
				attachments: prompt.attachments,
				sources: [],
				copyVisible: false,
				editable: false,
			});
		}
	};

	for (let index = 0; index <= items.length; index++) {
		appendPendingPrompts(index);
		if (index === items.length) break;
		const item = items[index]!;
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
				entryId: item.entryId,
				live: false,
				role: viewModel.role,
				text: viewModel.text,
				timestamp: viewModel.timestamp,
				attachments: viewModel.attachments,
				sources: viewModel.sources,
				copyVisible: false,
				editable: false,
			});
			continue;
		}
		if (viewModel.kind === "tools" && item.view?.type === "web_search") {
			flushBatch();
			const searchTool = viewModel.tools[0];
			if (searchTool) {
				rendered.push({
					kind: "tool-batch",
					key: `web-search:${item.renderId}:${searchTool.id}`,
					tools: [searchTool],
				});
			}
			continue;
		}
		if (viewModel.kind === "tools" && item.view?.type === "tool_call") {
			for (const tool of viewModel.tools) {
				const result = toolIndex.results.get(tool.id);
				const resolvedTool = result
					? { ...tool, ...result, summary: tool.name === "image_gen" ? result.summary || tool.summary : tool.summary || result.summary }
					: tool;
				const previous = batchTools.at(-1);
				if (!previous || batchEntryId !== item.entryId || !shouldJoinToolBatch(previous, resolvedTool)) {
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
	rendered: ConversationContentRenderItem[],
	liveItems: readonly LiveTurnItem[],
	liveTools: WorkbenchState["liveTools"],
	committedToolCallIds: ReadonlySet<string>,
	liveCompaction: LiveCompactionState | undefined,
	liveTurnId: number,
): ConversationContentRenderItem[] {
	const next = [...rendered];
	for (const item of liveItems) {
		if (item.kind === "thinking") {
			const text = item.parts.join("");
			if (!latestThinkingLine(item.parts) || next.some((entry) => entry.key === item.id)) continue;
			next.push({ kind: "thinking", key: item.id, text });
			continue;
		}
		if (item.kind === "text") {
			const text = item.parts.join("");
			if (!text.trim() || next.some((entry) => entry.key === item.id)) continue;
			next.push({
				kind: "message",
				key: item.id,
				live: true,
				role: "assistant",
				text,
				attachments: [],
				sources: [],
				copyVisible: false,
				editable: false,
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
			collapseForResult: false,
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

function markCompletedTurnResult(
	turn: ConversationContentRenderItem[],
	completed: boolean,
): ConversationRenderItem[] {
	const userMessage = turn[0];
	if (!completed || userMessage?.kind !== "message" || userMessage.role !== "user") return turn;
	let finalMessageIndex = -1;
	for (let index = turn.length - 1; index >= 0; index--) {
		const entry = turn[index];
		if (entry?.kind === "message" && entry.role === "assistant" && entry.text) {
			finalMessageIndex = index;
			break;
		}
	}
	if (finalMessageIndex < 0) return turn;
	const finalMessage = turn[finalMessageIndex];
	if (!finalMessage || finalMessage.kind !== "message") return turn;
	const durationLabel = elapsedDurationLabel(userMessage.timestamp, finalMessage.timestamp);
	const completedTurn = durationLabel
		? turn.map((entry, index) => (index === finalMessageIndex ? { ...entry, durationLabel } : entry))
		: turn;
	if (finalMessageIndex <= 1) return completedTurn;
	const processItems = completedTurn.slice(1, finalMessageIndex);
	if (completedTurn.slice(finalMessageIndex + 1).some((entry) => entry.kind === "tool-stack")) return completedTurn;
	const completedFinalMessage = completedTurn[finalMessageIndex];
	if (!completedFinalMessage || completedFinalMessage.kind !== "message") return completedTurn;

	const workProcessItems = processItems.map((entry) =>
		entry.kind === "tool-stack" ? { ...entry, collapseForResult: true } : entry,
	);
	const completedItems: ConversationRenderItem[] = [
		userMessage,
		{
			kind: "work-process",
			key: `work-process:${completedFinalMessage.key}:0`,
			items: workProcessItems,
		},
	];
	completedItems.push(
		{ kind: "result-boundary", key: `result-boundary:${completedFinalMessage.key}` },
		completedFinalMessage,
		...completedTurn.slice(finalMessageIndex + 1),
	);
	return completedItems;
}

function markCompletedTurnResults(
	rendered: ConversationContentRenderItem[],
	responseActive: boolean,
): ConversationRenderItem[] {
	const next: ConversationRenderItem[] = [];
	let turn: ConversationContentRenderItem[] = [];
	for (const entry of rendered) {
		if (entry.kind === "message" && entry.role === "user") {
			if (turn.length) next.push(...markCompletedTurnResult(turn, true));
			turn = [entry];
		} else if (turn.length) {
			turn.push(entry);
		} else {
			next.push(entry);
		}
	}
	if (turn.length) next.push(...markCompletedTurnResult(turn, !responseActive));
	return next;
}

export function buildConversationRenderItems(
	persistedItems: ConversationContentRenderItem[],
	liveItems: readonly LiveTurnItem[],
	liveTools: WorkbenchState["liveTools"],
	committedToolCallIds: ReadonlySet<string>,
	liveCompaction: LiveCompactionState | undefined,
	liveTurnId: number,
	responseActive: boolean,
	canEditPrompts = false,
): ConversationRenderItem[] {
	const withLive = appendLiveRenderItems(
		persistedItems,
		liveItems,
		liveTools,
		committedToolCallIds,
		liveCompaction,
		liveTurnId,
	);
	for (let index = 0; index < withLive.length; index++) {
		const entry = withLive[index];
		if (entry?.kind !== "message" || entry.role !== "user") continue;
		const editable = canEditPrompts && Boolean(entry.entryId);
		if (entry.editable !== editable) withLive[index] = { ...entry, editable };
	}
	if (!responseActive) {
		for (let index = withLive.length - 1; index >= 0; index--) {
			const entry = withLive[index];
			if (entry?.kind !== "message" || entry.role !== "assistant" || !entry.text) continue;
			withLive[index] = { ...entry, copyVisible: true };
			break;
		}
	}
	return markCompletedTurnResults(withLive, responseActive);
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
	onEditPrompt,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	sessionTitleText: string;
	onEditPrompt: (request: PromptEditRequest) => void;
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
	const canEditPrompts = canSendPrompt(state) && !hasActiveSessionWork(state) && state.queuedUserPrompts.length === 0;
	const persistedRenderItems = useMemo(
		() => buildPersistedRenderItems(state.transcript, toolIndex, state.pendingUserPrompts),
		[state.pendingUserPrompts, state.transcript, toolIndex],
	);
	const renderItems = useMemo(
		() =>
			buildConversationRenderItems(
				persistedRenderItems,
				state.liveTurnItems,
				state.liveTools,
				toolIndex.callIds,
				state.liveCompaction,
				state.liveTurnId,
				responseActive,
				canEditPrompts,
			),
		[
			persistedRenderItems,
			state.liveCompaction,
			state.liveTools,
			state.liveTurnId,
			state.liveTurnItems,
			toolIndex.callIds,
			responseActive,
			canEditPrompts,
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
	onEditPrompt,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	sessionTitleText: string;
	renderItems: ConversationRenderItem[];
	toolStatuses: ReadonlyMap<string, "success" | "error">;
	onEditPrompt: (request: PromptEditRequest) => void;
}) {
	const responseActive = isConversationResponseActive(state);
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const scrollRef = useRef<HTMLElement | null>(null);
	const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const [followOutput, setFollowOutput] = useState<false | "auto">(false);
	const promptScrollRequestRef = useRef(state.promptScrollRequest);
	const promptFollowRef = useRef(false);
	const bottomFollowRef = useRef(true);
	const lastUserScrollAtRef = useRef(Number.NEGATIVE_INFINITY);
	const scrollToBottom = useCallback(() => {
		virtuosoRef.current?.scrollToIndex({ align: "end", behavior: "auto", index: "LAST" });
	}, []);
	const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
		setIsAtBottom(atBottom);
		if (atBottom) {
			bottomFollowRef.current = true;
			promptFollowRef.current = true;
			setFollowOutput("auto");
		}
	}, []);
	const handleScrollerRef = useCallback((element: HTMLElement | null) => {
		scrollRef.current = element;
		setScrollElement(element);
	}, []);
	const handleUserScrollAway = useCallback(() => {
		lastUserScrollAtRef.current = performance.now();
		bottomFollowRef.current = false;
		promptFollowRef.current = false;
		setFollowOutput(false);
		setIsAtBottom(false);
	}, []);
	const handleTotalListHeightChanged = useCallback(() => {
		if (!shouldFollowTranscriptResize(bottomFollowRef.current, lastUserScrollAtRef.current, performance.now()))
			return;
		scrollToBottom();
	}, [scrollToBottom]);

	const loadEarlier = useCallback(() => actions.loadEarlier(), [actions.loadEarlier]);
	const loadEarlierRef = useRef(loadEarlier);
	loadEarlierRef.current = loadEarlier;
	const historyLoadBlockedRef = useRef(false);

	useLayoutEffect(() => {
		if (promptScrollRequestRef.current === state.promptScrollRequest) return;
		promptScrollRequestRef.current = state.promptScrollRequest;
		promptFollowRef.current = true;
		setFollowOutput("auto");
		scrollToBottom();
	}, [scrollToBottom, state.promptScrollRequest]);

	useLayoutEffect(() => {
		if (!state.hasMorePrevious) return;
		const scroller = scrollElement;
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
	}, [actions.showToast, scrollElement, state.hasMorePrevious, state.loadingEarlier]);

	useEffect(() => {
		if (!promptFollowRef.current || responseActive) return;
		const frame = window.requestAnimationFrame(() => {
			promptFollowRef.current = false;
			setFollowOutput(false);
		});
		return () => window.cancelAnimationFrame(frame);
	}, [responseActive]);

	const openResource = actions.openResource;
	const [expandedWorkProcesses, setExpandedWorkProcesses] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	const [expandedToolBatches, setExpandedToolBatches] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	const [expandedToolRows, setExpandedToolRows] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	useEffect(() => {
		setExpandedWorkProcesses(new Map());
		setExpandedToolBatches(new Map());
		setExpandedToolRows(new Map());
		promptFollowRef.current = true;
		bottomFollowRef.current = true;
		lastUserScrollAtRef.current = Number.NEGATIVE_INFINITY;
		setIsAtBottom(true);
		setFollowOutput("auto");
	}, [state.sessionId]);
	const updateExpandedWorkProcess = useCallback((key: string, open: boolean) => {
		setExpandedWorkProcesses((current) => {
			if ((current.get(key) ?? false) === open) return current;
			const next = new Map(current);
			if (open) next.set(key, true);
			else next.delete(key);
			return next;
		});
	}, []);
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
	const renderStateRef = useRef({ sessionId: state.sessionId, projectId: state.currentProjectId, toolStatuses });
	renderStateRef.current = { sessionId: state.sessionId, projectId: state.currentProjectId, toolStatuses };
	const renderConversationContentItem = useCallback(
		(entry: ConversationContentRenderItem) => {
			const current = renderStateRef.current;
			if (entry.kind === "message") {
				const editRequest =
					entry.role === "user" && entry.editable && entry.entryId && current.sessionId
						? {
								sessionId: current.sessionId,
								entryId: entry.entryId,
								text: entry.text,
								attachments: entry.attachments,
							}
						: undefined;
				const message = (
					<TranscriptMessageView
						role={entry.role}
						text={entry.text}
						durationLabel={entry.durationLabel}
						attachments={entry.attachments}
						sources={entry.sources}
						showCopy={entry.copyVisible}
						sessionId={current.sessionId}
						projectId={current.projectId}
						onOpenPath={openResource}
						onEdit={editRequest ? () => onEditPrompt(editRequest) : undefined}
						mode={entry.live ? "streaming" : "static"}
					/>
				);
				return entry.role === "user" && entry.key.startsWith("optimistic-user:") ? (
					<GsapReveal animationKey={entry.key} className="w-full" distance={18} duration={0.34}>
						{message}
					</GsapReveal>
				) : (
					message
				);
			}
			if (entry.kind === "thinking") return <ThinkingBlock text={entry.text} />;
			if (entry.kind === "tool-stack") {
				const tools = entry.batches.flatMap((batch) => batch.tools);
				const allToolsCompleted = tools.length > 0 && tools.every(isToolComplete);
				const controlCollapsedState = entry.collapseForResult;
				const groupedActivityTools =
					tools.length > 1 &&
					(tools.every((tool) => tool.name === "read" && !tool.images?.length) ||
						tools.every((tool) => tool.name === "bash" && !tool.images?.length) ||
						tools.every((tool) =>
							tool.name === "edit" || tool.name === "write" || tool.name === "apply_patch",
						));
				if (!allToolsCompleted && !groupedActivityTools) {
					return (
						<div className="tool-batch-stack">
							{tools.map((tool) => (
								<ToolBatch
									key={tool.id}
									className="tool-batch-render-item"
									tools={[tool]}
									initialOpen={false}
									open={controlCollapsedState ? expandedToolRows.get(tool.id) ?? false : undefined}
									onOpenChange={
										controlCollapsedState ? (open) => updateExpandedToolRow(tool.id, open) : undefined
									}
									sessionId={current.sessionId}
									onOpenPath={(path) => void openResource(path)}
								/>
							))}
						</div>
					);
				}
				const standaloneSearchTools = tools.length > 0 && tools.every((tool) => tool.name === "web_search");
				if (standaloneSearchTools) {
					return (
						<div className="tool-batch-stack">
							{tools.map((tool) => (
								<ToolBatch
									key={tool.id}
									className="tool-batch-render-item"
									tools={[tool]}
									initialOpen={false}
									open={controlCollapsedState ? expandedToolRows.get(tool.id) ?? false : undefined}
									onOpenChange={
										controlCollapsedState ? (open) => updateExpandedToolRow(tool.id, open) : undefined
									}
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
						open={controlCollapsedState ? expandedToolBatches.get(entry.key) ?? false : undefined}
						onOpenChange={
							controlCollapsedState ? (open) => updateExpandedToolBatch(entry.key, open) : undefined
						}
						toolOpen={controlCollapsedState ? expandedToolRows : undefined}
						onToolOpenChange={controlCollapsedState ? updateExpandedToolRow : undefined}
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
					projectId={current.projectId}
				/>
			);
		},
		[
			expandedToolBatches,
			expandedToolRows,
			onEditPrompt,
			openResource,
			updateExpandedToolBatch,
			updateExpandedToolRow,
		],
	);
	const renderConversationItem = useCallback(
		(entry: ConversationRenderItem) => {
			if (entry.kind === "result-boundary") {
				return (
					<div
						aria-label="工作过程与最终结果分界"
						className="w-full border-t border-border/50"
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
								data-transcript-resize-anchor
								type="button"
							>
								<WrenchIcon className="size-4 shrink-0" />
								<span className="min-w-0 flex-1 text-[13px]">工作过程</span>
								<ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=open]/work-process:rotate-180" />
							</button>
						</CollapsibleTrigger>
						<GsapCollapsibleContent open={open} className="pt-2" data-transcript-resize-anchor>
							<div className="grid min-w-0 gap-3">
								{entry.items.map((item) => (
									<div className="min-w-0" key={item.key}>
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
				: entry.kind === "work-process" ||
						entry.kind === "tool-stack" ||
						entry.kind === "compaction" ||
						entry.kind === "thinking" ||
						isWebSearchTranscriptItem(entry)
					? 32
					: 80,
		[],
	);

	const transcriptGap = useCallback(
		(previous: ConversationRenderItem, current: ConversationRenderItem) => {
			if (current.kind === "result-boundary") return 8;
			if (previous.kind === "result-boundary") return DEFAULT_TRANSCRIPT_GAP;
			return (previous.kind === "tool-stack" && current.kind === "tool-stack") ||
				(isWebSearchTranscriptItem(previous) && isWebSearchTranscriptItem(current))
				? 0
				: DEFAULT_TRANSCRIPT_GAP;
		},
		[],
	);

	const historyStatus = state.loadingEarlier ? (
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
				<VirtualizedConversationTranscript
					items={renderItems}
					getKey={transcriptItemKey}
					estimateHeight={estimateTranscriptItemHeight}
					gap={transcriptGap}
					header={historyStatus}
					renderItem={renderConversationItem}
					isItemEqual={conversationRenderItemEqual}
					atBottomStateChange={handleAtBottomStateChange}
					followOutput={followOutput}
					onScrollerRef={handleScrollerRef}
					onTotalListHeightChanged={handleTotalListHeightChanged}
					onUserScrollAway={handleUserScrollAway}
					sessionKey={state.sessionId ?? "empty"}
					virtuosoRef={virtuosoRef}
				/>
				{!isAtBottom ? (
					<Button
						aria-label="回到最新消息"
						className="absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted"
						onClick={() => {
							bottomFollowRef.current = true;
							promptFollowRef.current = true;
							setFollowOutput("auto");
							scrollToBottom();
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
					onRetry={state.sessionId ? () => void actions.selectSession(state.sessionId!) : undefined}
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
					onRetry={() => void actions.loadTranscript()}
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
