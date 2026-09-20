import { gsap } from "gsap";
import {
	ArrowDownIcon,
	CheckCircle2,
	ChevronDownIcon,
	CircleX,
	LoaderCircle,
	Sparkles,
	WrenchIcon,
} from "lucide-react";
import type { AgentStep } from "@lystar/code-web-protocol";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { toLiveToolViewModel } from "../../adapters/live-tool-view-model.ts";
import { toSessionItemViewModel } from "../../adapters/session-view-model";
import { type LiveCompactionState } from "../../state/compaction-state";
import { shouldJoinToolBatch, skillNameFromTool } from "../../state/tool-batching";
import type { LiveTurnItem, WorkbenchState } from "../../state/use-workbench";
import type { PromptAttachmentPreview } from "../../types";
import { CompactionCard } from "./compaction-card";
import { Conversation, ConversationContent, ConversationEmptyState } from "../ai-elements/conversation";
import { ToolBatch, toolBatchSummaryLabel, type ToolBatchTool } from "../ai-elements/tool-batch";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { GsapCollapsibleContent } from "../ui/gsap-collapsible-content";
import { GsapReveal } from "../ui/gsap-reveal";
import { ACTIVE_OPERATION_STATUSES } from "./constants";
import { activeThinkingText, ThinkingBlock } from "./live-turn";
import { AgentErrorCard, TranscriptItemView, TranscriptMessageView } from "./transcript";
import { PrependAnchoredConversationTranscript } from "./prepend-anchored-transcript";
import { type ConversationTranscriptScrollState, DEFAULT_TRANSCRIPT_GAP } from "./virtualized-transcript";
import type { PromptEditRequest, WorkbenchActions } from "./types";

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
};

export type ConversationActions = Pick<WorkbenchActions, "openResource" | "queueAction" | "showToast" | "loadEarlier"> & {
	selectSession?: WorkbenchActions["selectSession"];
	loadTranscript?: WorkbenchActions["loadTranscript"];
	openSubagent?: WorkbenchActions["openSubagent"];
};

type MessageRenderItem = {
	kind: "message";
	key: string;
	entryId?: string;
	live: boolean;
	role: "user" | "assistant" | "system";
	text: string;
	timestamp?: string;
	sentAt?: number;
	durationLabel?: string;
	statusLabel?: string;
	queueId?: string;
	attachments: PromptAttachmentPreview[];
	sources: string[];
	copyVisible: boolean;
	editable: boolean;
};
type TranscriptItemRenderItem = { kind: "item"; key: string; item: WorkbenchState["transcript"][number] };
type TranscriptBatchRenderItem = {
	kind: "tool-batch";
	key: string;
	entryId?: string;
	tools: ToolBatchTool[];
	stepId?: string;
};
type ActivityBoundaryRenderItem = { kind: "activity-boundary"; key: string };
type AgentStepAnchorRenderItem = { kind: "agent-step-anchor"; key: string; step: AgentStep };
type ResultBoundaryRenderItem = { kind: "result-boundary"; key: string };
type TranscriptToolStackRenderItem = {
	kind: "tool-stack";
	key: string;
	live: boolean;
	collapseForResult: boolean;
	stepId?: string;
	batches: TranscriptBatchRenderItem[];
};
type CompactionRenderItem = {
	kind: "compaction";
	key: string;
	entryId?: string;
	timestamp?: string;
	live: boolean;
	state?: LiveCompactionState;
	text?: string;
	tokensBefore?: number;
};
type AgentStepChildRenderItem = MessageRenderItem | TranscriptToolStackRenderItem | CompactionRenderItem;
type AgentStepRenderItem = {
	kind: "agent-step";
	key: string;
	live: boolean;
	step: AgentStep;
	items: AgentStepChildRenderItem[];
};
type ConversationContentRenderItem =
	| MessageRenderItem
	| TranscriptItemRenderItem
	| TranscriptToolStackRenderItem
	| AgentStepRenderItem
	| CompactionRenderItem;
type WorkProcessRenderItem = {
	kind: "work-process";
	key: string;
	items: ConversationContentRenderItem[];
};
type LiveElapsedRenderItem = { kind: "live-elapsed"; key: string; startedAt: number };
type ConversationRenderItem =
	| ConversationContentRenderItem
	| WorkProcessRenderItem
	| ResultBoundaryRenderItem
	| LiveElapsedRenderItem;
type RawRenderItem =
	| MessageRenderItem
	| TranscriptItemRenderItem
	| TranscriptBatchRenderItem
	| ActivityBoundaryRenderItem
	| AgentStepAnchorRenderItem
	| CompactionRenderItem;

const HISTORY_LOAD_THRESHOLD = 240;
const CONVERSATION_RENDER_CACHE_LIMIT = 8;
const SESSION_SCROLL_CACHE_LIMIT = 8;
const EMPTY_LIVE_STEPS = Object.freeze({}) as WorkbenchState["liveSteps"];

type ConversationRenderCacheEntry = {
	transcript: WorkbenchState["transcript"];
	pendingUserPrompts: WorkbenchState["pendingUserPrompts"];
	promptSendTimes: WorkbenchState["promptSendTimes"];
	liveTools: WorkbenchState["liveTools"];
	liveTurnItems: WorkbenchState["liveTurnItems"];
	liveCompaction: WorkbenchState["liveCompaction"];
	liveTurnId: number;
	liveSteps: WorkbenchState["liveSteps"];
	responseActive: boolean;
	canEditPrompts: boolean;
	toolIndex: ToolIndex;
	renderItems: ConversationRenderItem[];
};

export function formatElapsedDuration(durationMs: number): string | undefined {
	if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;
	const totalSeconds = Math.floor(durationMs / 1000);
	if (totalSeconds < 60) return `${totalSeconds}秒`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const secondsLabel = seconds > 0 ? `${String(seconds).padStart(2, "0")}秒` : "";
	const totalHours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (totalHours === 0) return `${totalMinutes}分钟${secondsLabel}`;
	const paddedMinutes = String(minutes).padStart(2, "0");
	if (totalHours < 24) return `${totalHours}小时${paddedMinutes}分钟${secondsLabel}`;
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return `${days}天${String(hours).padStart(2, "0")}小时${paddedMinutes}分钟${secondsLabel}`;
}

/**
 * 回合处理中的实时耗时行，回合结束后由最终回复下方的“本次耗时”接手。
 * 计时起点是用户按下发送的时刻。
 */
export function LiveElapsedHeader({
	startedAt,
	onElapsedChange,
}: {
	startedAt: number;
	/** 每次跳动后回报当前显示的秒数，让回合结束时下方数字与用户看到的最后一个数字一致。 */
	onElapsedChange?: (startedAt: number, seconds: number) => void;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [startedAt]);
	const elapsedMs = Math.max(0, now - startedAt);
	const seconds = Math.floor(elapsedMs / 1_000);
	useEffect(() => {
		onElapsedChange?.(startedAt, seconds);
	}, [onElapsedChange, seconds, startedAt]);
	const label = formatElapsedDuration(elapsedMs);
	return (
		<div className="w-full" data-testid="live-elapsed">
			<div className="pb-2 text-xs text-muted-foreground">{label ? `已处理 ${label}` : "已处理"}</div>
			<div
				aria-label="已处理耗时与回复分界"
				className="w-full border-t border-border/50"
				role="separator"
			/>
		</div>
	);
}

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
	const duration = formatElapsedDuration((entry.step.endedAt ?? now) - entry.step.startedAt);
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

export function shouldLoadEarlierHistory(
	atTop: boolean,
	state: Pick<WorkbenchState, "hasMorePrevious" | "loadingEarlier" | "previousCursor" | "transcriptError">,
): boolean {
	return (
		atTop &&
		state.hasMorePrevious &&
		Boolean(state.previousCursor) &&
		!state.loadingEarlier &&
		!state.transcriptError
	);
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

type ToolStackPresentation = "rows" | "group";

export function initialToolStackPresentation(tools: readonly ToolBatchTool[]): ToolStackPresentation {
	const groupableActivity =
		tools.length > 1 &&
		(tools.every((tool) => tool.name === "read" && !tool.images?.length) ||
			tools.every((tool) => tool.name === "bash" && !tool.images?.length) ||
			tools.every((tool) => tool.name === "edit" || tool.name === "write" || tool.name === "apply_patch"));
	return groupableActivity && tools.every(isToolComplete) ? "group" : "rows";
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
			(streamingImageGeneration || candidate.summary === tool.summary) &&
			candidate.state === tool.state &&
			(streamingImageGeneration || candidate.detail === tool.detail) &&
			JSON.stringify(candidate.subagents) === JSON.stringify(tool.subagents) &&
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
			previous.statusLabel === next.statusLabel &&
			previous.queueId === next.queueId &&
			previous.copyVisible === next.copyVisible &&
			previous.editable === next.editable &&
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
			previous.step === next.step &&
			previous.items.length === next.items.length &&
			previous.items.every((item, index) => {
				const candidate = next.items[index];
				return candidate !== undefined && conversationRenderItemEqual(item, candidate);
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
	if (previous.kind === "live-elapsed" && next.kind === "live-elapsed") return previous.startedAt === next.startedAt;
	if (previous.kind === "compaction" && next.kind === "compaction") {
		return previous.live
			? next.live && previous.state === next.state
			: !next.live && previous.text === next.text && previous.tokensBefore === next.tokensBefore;
	}
	return previous.kind === "item" && next.kind === "item" && previous.item === next.item;
}

type GroupedPersistedRenderItem = ConversationContentRenderItem | AgentStepAnchorRenderItem;

function groupPersistedToolBatches(rendered: Array<RawRenderItem>): GroupedPersistedRenderItem[] {
	const grouped: GroupedPersistedRenderItem[] = [];
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
			if (
				previousToolStack &&
				previousToolStack.stepId === entry.stepId &&
				previousToolBatchKind === toolBatchKind &&
				toolBatchKind !== "skill"
			) {
				previousToolStack.batches.push(entry);
			} else {
				previousToolStack = {
				kind: "tool-stack",
				key: `tool-stack:${entry.key}`,
				live: false,
				collapseForResult: false,
				stepId: entry.stepId,
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

function groupAgentSteps(
	items: GroupedPersistedRenderItem[],
	steps: ReadonlyMap<string, AgentStep>,
): ConversationContentRenderItem[] {
	const grouped: ConversationContentRenderItem[] = [];
	const renderedSteps = new Map<string, AgentStepRenderItem>();
	const stepIdByToolCallId = new Map<string, string>();
	const stepIdByMessageEntryId = new Map<string, string>();
	const stepsByStartedAt = [...steps.values()].sort((left, right) => right.startedAt - left.startedAt);
	for (const step of steps.values()) {
		for (const toolCallId of step.toolCallIds) stepIdByToolCallId.set(toolCallId, step.id);
		for (const messageEntryId of step.messageEntryIds ?? []) stepIdByMessageEntryId.set(messageEntryId, step.id);
	}
	const stepIdAtTimestamp = (timestamp: string | undefined): string | undefined => {
		if (!timestamp) return undefined;
		const occurredAt = Date.parse(timestamp);
		if (!Number.isFinite(occurredAt)) return undefined;
		return stepsByStartedAt.find(
			(step) => occurredAt >= step.startedAt && (step.endedAt === undefined || occurredAt <= step.endedAt),
		)?.id;
	};
	const ensureStep = (stepId: string, fallback?: AgentStep): AgentStepRenderItem | undefined => {
		const step = steps.get(stepId) ?? fallback;
		if (!step) return undefined;
		const existing = renderedSteps.get(stepId);
		if (existing) {
			existing.step = step;
			return existing;
		}
		const entry: AgentStepRenderItem = {
			kind: "agent-step",
			key: `agent-step:${stepId}`,
			live: false,
			step,
			items: [],
		};
		renderedSteps.set(stepId, entry);
		grouped.push(entry);
		return entry;
	};
	for (const item of items) {
		if (item.kind === "agent-step-anchor") {
			ensureStep(item.step.id, item.step);
			continue;
		}
		if (item.kind === "compaction") {
			const stepId = stepIdAtTimestamp(item.timestamp);
			if (stepId) {
				const step = ensureStep(stepId);
				if (step && !step.items.some((candidate) => candidate.key === item.key)) {
					step.items.push(item);
					continue;
				}
			}
		}
		if (item.kind === "message" && item.entryId) {
			const explicitStepId = stepIdByMessageEntryId.get(item.entryId);
			const stepId = explicitStepId ?? (item.role === "user" ? stepIdAtTimestamp(item.timestamp) : undefined);
			if (stepId) {
				const step = ensureStep(stepId);
				if (step && !step.items.some((candidate) => candidate.key === item.key)) {
					step.items.push(item);
					continue;
				}
			}
		}
		if (item.kind === "tool-stack") {
			const inferredStepIds = new Set(
				item.batches.flatMap((batch) =>
					batch.tools.flatMap((tool) => {
						const stepId = stepIdByToolCallId.get(tool.id);
						return stepId ? [stepId] : [];
					}),
				),
			);
			const inferredMessageStepIds = new Set(
				item.batches.flatMap((batch) => {
					const stepId = batch.entryId ? stepIdByMessageEntryId.get(batch.entryId) : undefined;
					return stepId ? [stepId] : [];
				}),
			);
			const inferredStepId = inferredStepIds.size === 1 ? inferredStepIds.values().next().value : undefined;
			const inferredMessageStepId =
				inferredMessageStepIds.size === 1 ? inferredMessageStepIds.values().next().value : undefined;
			const stepId = item.stepId ?? inferredStepId ?? inferredMessageStepId;
			if (stepId) {
				const step = ensureStep(stepId);
				const stepItem = item.stepId ? item : { ...item, stepId };
				if (step && !step.items.some((candidate) => candidate.key === item.key)) step.items.push(stepItem);
				else if (!step) grouped.push(item);
				continue;
			}
		}
		grouped.push(item);
	}
	return grouped;
}

export function buildPersistedRenderItems(
	items: WorkbenchState["transcript"],
	toolIndex: ToolIndex,
	pendingUserPrompts: WorkbenchState["pendingUserPrompts"] = [],
	promptSendTimes: WorkbenchState["promptSendTimes"] = {},
): ConversationContentRenderItem[] {
	const rendered: Array<RawRenderItem> = [];
	let batchTools: ToolBatchTool[] = [];
	let batchKey = "";
	let batchEntryId: string | undefined;
	let batchStepId: string | undefined;
	const latestSteps = new Map<string, { entryId: string; step: AgentStep }>();
	for (const item of items) {
		if (item.view?.type === "agent_step") latestSteps.set(item.view.step.id, { entryId: item.entryId, step: item.view.step });
	}

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
			rendered.push({ kind: "tool-batch", key: batchKey, tools: batchTools, stepId: batchStepId });
			batchTools = [];
			batchKey = "";
			batchEntryId = undefined;
			batchStepId = undefined;
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
				sentAt: prompt.sentAt,
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
		if (item.view?.type === "agent_step") {
			flushBatch();
			const latest = latestSteps.get(item.view.step.id);
			if (latest?.entryId === item.entryId) {
				rendered.push({ kind: "agent-step-anchor", key: item.renderId, step: latest.step });
			}
			continue;
		}
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
				sentAt: promptSendTimes[item.entryId],
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
					entryId: item.entryId,
					tools: [searchTool],
				});
			}
			continue;
		}
		if (viewModel.kind === "tools" && item.view?.type === "tool_call") {
			for (const tool of viewModel.tools) {
				const stepId = item.view.calls.find((call) => call.id === tool.id)?.stepId;
				const result = toolIndex.results.get(tool.id);
				const resolvedTool = result
					? { ...tool, ...result, summary: tool.name === "image_gen" ? result.summary || tool.summary : tool.summary || result.summary }
					: tool;
				const previous = batchTools.at(-1);
				if (
					!previous ||
					batchEntryId !== item.entryId ||
					batchStepId !== stepId ||
					!shouldJoinToolBatch(previous, resolvedTool)
				) {
					flushBatch();
					batchEntryId = item.entryId;
					batchStepId = stepId;
					batchKey = `tool-batch:${item.renderId}:${resolvedTool.id}`;
				}
				batchTools.push(resolvedTool);
			}
			continue;
		}
		if (viewModel.kind === "tools" && item.view?.type === "tool_result") {
			if (toolIndex.callIds.has(item.view.callId)) continue;
			flushBatch();
			const resultTool = viewModel.tools[0];
			if (resultTool) {
				rendered.push({
					kind: "tool-batch",
					key: `tool-result:${item.renderId}:${resultTool.id}`,
					entryId: item.entryId,
					tools: [resultTool],
					stepId: item.view.stepId,
				});
			}
			continue;
		}
		flushBatch();
		if (viewModel.kind === "summary" && (viewModel.variant === "compaction" || viewModel.title === "上下文压缩")) {
			rendered.push({
				kind: "compaction",
				key: item.renderId,
				entryId: item.entryId,
				timestamp: item.timestamp,
				live: false,
				text: viewModel.text,
				tokensBefore: viewModel.tokensBefore,
			});
		} else {
			rendered.push({ kind: "item", key: item.renderId, item });
		}
	}
	flushBatch();
	return groupAgentSteps(
		groupPersistedToolBatches(rendered),
		new Map([...latestSteps].map(([stepId, value]) => [stepId, value.step])),
	);
}

export function appendLiveRenderItems(
	rendered: ConversationContentRenderItem[],
	liveItems: readonly LiveTurnItem[],
	liveTools: WorkbenchState["liveTools"],
	committedToolCallIds: ReadonlySet<string>,
	liveCompaction: LiveCompactionState | undefined,
	liveTurnId: number,
	liveSteps: WorkbenchState["liveSteps"] = {},
): ConversationContentRenderItem[] {
	const next = [...rendered];
	const stepIdByToolCallId = new Map<string, string>();
	const runningSteps = Object.values(liveSteps).filter((step) => step.status === "running");
	const runningStepId = runningSteps.length === 1 ? runningSteps[0]?.id : undefined;
	for (const step of Object.values(liveSteps)) {
		for (const toolCallId of step.toolCallIds) stepIdByToolCallId.set(toolCallId, step.id);
	}
	const hasRenderItemKey = (key: string) =>
		next.some((entry) => entry.key === key || (entry.kind === "agent-step" && entry.items.some((item) => item.key === key)));
	const appendStepItem = (stepId: string, item: AgentStepChildRenderItem): boolean => {
		const step = liveSteps[stepId];
		if (!step) return false;
		const key = `agent-step:${stepId}`;
		const existing = next.find((entry): entry is AgentStepRenderItem => entry.kind === "agent-step" && entry.key === key);
		if (existing) {
			existing.live = true;
			existing.step = step;
			if (!existing.items.some((candidate) => candidate.key === item.key)) existing.items.push(item);
		} else {
			next.push({ kind: "agent-step", key, live: true, step, items: [item] });
		}
		return true;
	};
	for (const item of liveItems) {
		if (item.kind === "user") {
			if (hasRenderItemKey(item.id)) continue;
			const message: MessageRenderItem = {
				kind: "message",
				key: item.id,
				live: false,
				role: "user",
				text: item.displayText,
				sentAt: item.sentAt,
				statusLabel: item.status === "queued" ? "已发出 · 等待当前步骤结束" : "已发出 · Agent 正在处理",
				queueId: item.status === "queued" ? item.queueId : undefined,
				attachments: item.attachments,
				sources: [],
				copyVisible: false,
				editable: false,
			};
			const stepId = item.stepId ?? runningStepId;
			if (!stepId || !appendStepItem(stepId, message)) next.push(message);
			continue;
		}
		if (item.kind === "thinking") continue;
		if (item.kind === "text") {
			const text = item.parts.join("");
			if (!text.trim() || hasRenderItemKey(item.id)) continue;
			const message: MessageRenderItem = {
				kind: "message",
				key: item.id,
				live: true,
				role: "assistant",
				text,
				attachments: [],
				sources: [],
				copyVisible: false,
				editable: false,
			};
			if (!item.stepId || !appendStepItem(item.stepId, message)) next.push(message);
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
		const candidateStepIds = new Set(
			tools.flatMap((tool) => {
				const stepId = tool.stepId ?? stepIdByToolCallId.get(tool.id);
				return stepId ? [stepId] : [];
			}),
		);
		const explicitStepId = candidateStepIds.size === 1 ? candidateStepIds.values().next().value : undefined;
		const pendingStepId =
			candidateStepIds.size === 0 &&
			runningStepId &&
			tools.every((tool) => tool.state === "input-available" || tool.state === "input-queued")
				? runningStepId
				: undefined;
		const stepId = explicitStepId ?? pendingStepId;
		const toolsWithStep = stepId
			? tools.map((tool) => (tool.stepId ? tool : { ...tool, stepId }))
			: tools;
		const stack: TranscriptToolStackRenderItem = {
			kind: "tool-stack",
			key: `tool-stack:${batchKey}`,
			live: true,
			collapseForResult: false,
			stepId,
			batches: [{ kind: "tool-batch", key: batchKey, tools: toolsWithStep, stepId }],
		};
		if (!stepId || !appendStepItem(stepId, stack)) next.push(stack);
	}
	for (const step of Object.values(liveSteps)) {
		const key = `agent-step:${step.id}`;
		const existing = next.find((entry): entry is AgentStepRenderItem => entry.kind === "agent-step" && entry.key === key);
		if (existing) {
			existing.live = true;
			existing.step = step;
		} else {
			next.push({ kind: "agent-step", key, live: true, step, items: [] });
		}
	}
	if (liveCompaction) {
		const key = `live-compaction:${liveTurnId}`;
		const existingIndex = next.findIndex((entry) => entry.kind === "compaction" && entry.key === key);
		if (existingIndex >= 0 && next[existingIndex]?.kind === "compaction") {
			next[existingIndex] = { ...next[existingIndex], live: true, state: liveCompaction };
		} else if (!hasRenderItemKey(key)) {
			const compaction: CompactionRenderItem = { kind: "compaction", key, live: true, state: liveCompaction };
			if (!runningStepId || !appendStepItem(runningStepId, compaction)) next.push(compaction);
		}
	}
	return next;
}

function messageStartedAt(message: MessageRenderItem): number | undefined {
	if (message.sentAt !== undefined) return message.sentAt;
	if (!message.timestamp) return undefined;
	const parsed = Date.parse(message.timestamp);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 回合结束后位于最终回复下方的耗时。
 * 优先用客户端亲眼看到的实时值，保证与上方「已处理」完全一致；
 * 其次从用户消息的发送时刻算到末条文本回复，历史回合回退到会话时间戳。
 */
function completedTurnDurationLabel(
	userMessage: MessageRenderItem | undefined,
	finalMessage: MessageRenderItem,
	observedElapsed?: (sentAt: number) => number | undefined,
): string | undefined {
	if (!userMessage) return undefined;
	const observed = userMessage.sentAt === undefined ? undefined : observedElapsed?.(userMessage.sentAt);
	if (observed !== undefined) return formatElapsedDuration(observed);
	const start = messageStartedAt(userMessage);
	const end = finalMessage.timestamp ? Date.parse(finalMessage.timestamp) : Number.NaN;
	if (start === undefined || !Number.isFinite(end) || end < start) return undefined;
	return formatElapsedDuration(end - start);
}

function markCompletedTurnResult(
	turn: ConversationContentRenderItem[],
	completed: boolean,
	observedElapsed?: (sentAt: number) => number | undefined,
): ConversationRenderItem[] {
	const firstEntry = turn[0];
	const userMessage =
		firstEntry?.kind === "message" && firstEntry.role === "user" ? firstEntry : undefined;
	if (!completed) {
		const startedAt = userMessage ? messageStartedAt(userMessage) : undefined;
		if (!userMessage || startedAt === undefined) return turn;
		return [
			userMessage,
			{ kind: "live-elapsed", key: `live-elapsed:${userMessage.key}`, startedAt },
			...turn.slice(1),
		];
	}
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
	const durationLabel = completedTurnDurationLabel(userMessage, finalMessage, observedElapsed);
	const completedTurn = durationLabel
		? turn.map((entry, index) => (index === finalMessageIndex ? { ...entry, durationLabel } : entry))
		: turn;
	const processStartIndex = userMessage ? 1 : 0;
	if (finalMessageIndex <= processStartIndex) return completedTurn;
	const processItems = completedTurn.slice(processStartIndex, finalMessageIndex);
	if (completedTurn.slice(finalMessageIndex + 1).some((entry) => entry.kind === "tool-stack")) return completedTurn;
	const completedFinalMessage = completedTurn[finalMessageIndex];
	if (!completedFinalMessage || completedFinalMessage.kind !== "message") return completedTurn;

	const workProcessItems = processItems.map((entry) =>
		entry.kind === "tool-stack" ? { ...entry, collapseForResult: true } : entry,
	);
	const completedItems: ConversationRenderItem[] = [];
	if (userMessage) completedItems.push(userMessage);
	completedItems.push(
		{
			kind: "work-process",
			key: `work-process:${completedFinalMessage.key}:0`,
			items: workProcessItems,
		},
		{ kind: "result-boundary", key: `result-boundary:${completedFinalMessage.key}` },
		completedFinalMessage,
		...completedTurn.slice(finalMessageIndex + 1),
	);
	return completedItems;
}

function markCompletedTurnResults(
	rendered: ConversationContentRenderItem[],
	responseActive: boolean,
	observedElapsed?: (sentAt: number) => number | undefined,
): ConversationRenderItem[] {
	const next: ConversationRenderItem[] = [];
	let turn: ConversationContentRenderItem[] = [];
	for (const entry of rendered) {
		if (entry.kind === "message" && entry.role === "user") {
			if (turn.length) next.push(...markCompletedTurnResult(turn, true, observedElapsed));
			turn = [entry];
		} else {
			turn.push(entry);
		}
	}
	if (turn.length) next.push(...markCompletedTurnResult(turn, !responseActive, observedElapsed));
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
	liveSteps: WorkbenchState["liveSteps"] = {},
	observedElapsed?: (sentAt: number) => number | undefined,
): ConversationRenderItem[] {
	const withLive = appendLiveRenderItems(
		persistedItems,
		liveItems,
		liveTools,
		committedToolCallIds,
		liveCompaction,
		liveTurnId,
		liveSteps,
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
	return markCompletedTurnResults(withLive, responseActive, observedElapsed);
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
	allowPromptEditing = true,
}: {
	state: ConversationState;
	actions: ConversationActions;
	sessionTitleText: string;
	onEditPrompt: (request: PromptEditRequest) => void;
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
	const renderCacheRef = useRef(new Map<string, ConversationRenderCacheEntry>());
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
	const { toolIndex, renderItems } = useMemo(() => {
		const cacheKey = state.sessionId ?? "empty";
		const cached = renderCacheRef.current.get(cacheKey);
		if (
			cached?.transcript === state.transcript &&
			cached.pendingUserPrompts === state.pendingUserPrompts &&
			cached.promptSendTimes === state.promptSendTimes &&
			cached.liveTools === state.liveTools &&
			cached.liveTurnItems === state.liveTurnItems &&
			cached.liveCompaction === state.liveCompaction &&
			cached.liveTurnId === state.liveTurnId &&
			cached.liveSteps === liveSteps &&
			cached.responseActive === responseActive &&
			cached.canEditPrompts === canEditPrompts
		) {
			renderCacheRef.current.delete(cacheKey);
			renderCacheRef.current.set(cacheKey, cached);
			return cached;
		}

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
		const persistedToolIndex: ToolIndex = { callIds, results, statuses };
		let liveResults: Map<string, ToolBatchTool> | undefined;
		for (const tool of Object.values(state.liveTools)) {
			if (!persistedToolIndex.callIds.has(tool.id)) continue;
			const persisted = (liveResults ?? persistedToolIndex.results).get(tool.id);
			if (!persisted || tool.state === "cancelled" || tool.state === "interrupted") {
				liveResults ??= new Map(persistedToolIndex.results);
				const live = toLiveToolViewModel(tool);
				liveResults.set(tool.id, { ...persisted, ...live, images: persisted?.images });
			}
		}
		const toolIndex = liveResults ? { ...persistedToolIndex, results: liveResults } : persistedToolIndex;
		const persistedRenderItems = buildPersistedRenderItems(
			state.transcript,
			toolIndex,
			state.pendingUserPrompts,
			state.promptSendTimes,
		);
		const renderItems = buildConversationRenderItems(
			persistedRenderItems,
			state.liveTurnItems,
			state.liveTools,
			toolIndex.callIds,
			state.liveCompaction,
			state.liveTurnId,
			responseActive,
			canEditPrompts,
			liveSteps,
			resolveObservedElapsed,
		);
		const entry: ConversationRenderCacheEntry = {
			transcript: state.transcript,
			pendingUserPrompts: state.pendingUserPrompts,
			promptSendTimes: state.promptSendTimes,
			liveTools: state.liveTools,
			liveTurnItems: state.liveTurnItems,
			liveCompaction: state.liveCompaction,
			liveTurnId: state.liveTurnId,
			liveSteps,
			responseActive,
			canEditPrompts,
			toolIndex,
			renderItems,
		};
		renderCacheRef.current.delete(cacheKey);
		renderCacheRef.current.set(cacheKey, entry);
		while (renderCacheRef.current.size > CONVERSATION_RENDER_CACHE_LIMIT) {
			const oldest = renderCacheRef.current.keys().next().value;
			if (oldest === undefined) break;
			renderCacheRef.current.delete(oldest);
		}
		return entry;
	}, [
		canEditPrompts,
		liveSteps,
		resolveObservedElapsed,
		responseActive,
		state.liveCompaction,
		state.liveTools,
		state.liveTurnId,
		state.liveTurnItems,
		state.pendingUserPrompts,
		state.promptSendTimes,
		state.sessionId,
		state.transcript,
	]);

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
}: {
	state: ConversationState;
	actions: ConversationActions;
	sessionTitleText: string;
	renderItems: ConversationRenderItem[];
	toolStatuses: ReadonlyMap<string, "success" | "error">;
	liveElapsedChange: (sentAt: number, seconds: number) => void;
	onEditPrompt: (request: PromptEditRequest) => void;
}) {
	const responseActive = isConversationResponseActive(state);
	const thinkingText = activeThinkingText(state.liveTurnItems);
	const virtuosoRef = useRef<VirtuosoHandle | null>(null);
	const transcriptScrollerRef = useRef<HTMLElement | null>(null);
	const scrollToBottomTweenRef = useRef<gsap.core.Tween | null>(null);
	const scrollToBottomSettleTimerRef = useRef<number>();
	const sessionScrollStatesRef = useRef(new Map<string, ConversationTranscriptScrollState>());
	const activeSessionIdRef = useRef(state.sessionId);
	activeSessionIdRef.current = state.sessionId;
	const [isAtBottom, setIsAtBottom] = useState(true);
	const [isAtTop, setIsAtTop] = useState(false);
	const [followOutput, setFollowOutput] = useState<false | "auto">(false);
	const promptScrollRequestRef = useRef(state.promptScrollRequest);
	const promptFollowRef = useRef(false);
	const handleVirtuosoRef = useCallback((handle: VirtuosoHandle | null) => {
		virtuosoRef.current = handle;
	}, []);
	const handleTranscriptScrollerRef = useCallback((element: HTMLElement | null) => {
		transcriptScrollerRef.current = element;
	}, []);
	const scrollToBottom = useCallback(() => {
		virtuosoRef.current?.scrollToIndex({ align: "end", behavior: "auto", index: "LAST" });
	}, []);
	const animateScrollToBottom = useCallback(() => {
		const scroller = transcriptScrollerRef.current;
		scrollToBottomTweenRef.current?.kill();
		scrollToBottomTweenRef.current = null;
		if (scrollToBottomSettleTimerRef.current !== undefined) {
			window.clearTimeout(scrollToBottomSettleTimerRef.current);
			scrollToBottomSettleTimerRef.current = undefined;
		}
		if (!scroller) {
			setFollowOutput("auto");
			scrollToBottom();
			return;
		}
		let stableFrames = 0;
		let previousMaxScrollTop = -1;
		const settleAtBottom = () => {
			const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
			const heightStable = Math.abs(maxScrollTop - previousMaxScrollTop) < 0.5;
			const alreadyAtBottom = Math.abs(maxScrollTop - scroller.scrollTop) < 0.5;
			stableFrames = heightStable && alreadyAtBottom ? stableFrames + 1 : 0;
			previousMaxScrollTop = maxScrollTop;
			scroller.scrollTop = maxScrollTop;
			if (stableFrames >= 4) {
				scrollToBottomSettleTimerRef.current = undefined;
				scrollToBottomTweenRef.current = null;
				setFollowOutput("auto");
				return;
			}
			scrollToBottomSettleTimerRef.current = window.setTimeout(settleAtBottom, 50);
		};
		const reduceMotion =
			typeof window !== "undefined" &&
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
		if (reduceMotion || Math.abs(maxScrollTop - scroller.scrollTop) < 1) {
			settleAtBottom();
			return;
		}
		setFollowOutput(false);
		const progress = { value: 0 };
		const startScrollTop = scroller.scrollTop;
		const tween = gsap.to(progress, {
			duration: 0.5,
			ease: "power2.out",
			overwrite: "auto",
			value: 1,
			onUpdate: () => {
				const currentMaxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
				scroller.scrollTop = startScrollTop + (currentMaxScrollTop - startScrollTop) * progress.value;
			},
			onInterrupt: () => {
				if (scrollToBottomTweenRef.current === tween) scrollToBottomTweenRef.current = null;
			},
		});
		scrollToBottomTweenRef.current = tween;
		scrollToBottomSettleTimerRef.current = window.setTimeout(settleAtBottom, 500);
	}, [scrollToBottom]);
	const handleScrollStateCapture = useCallback(
		(sessionId: string, scrollState: ConversationTranscriptScrollState) => {
			if (sessionId !== activeSessionIdRef.current) return;
			const states = sessionScrollStatesRef.current;
			states.delete(sessionId);
			states.set(sessionId, scrollState);
			while (states.size > SESSION_SCROLL_CACHE_LIMIT) {
				const oldest = states.keys().next().value;
				if (oldest === undefined) break;
				states.delete(oldest);
			}
		},
		[],
	);
	const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
		setIsAtBottom(atBottom);
		if (atBottom) {
			promptFollowRef.current = true;
			setFollowOutput("auto");
		}
	}, []);
	const handleUserScrollAway = useCallback(() => {
		scrollToBottomTweenRef.current?.kill();
		scrollToBottomTweenRef.current = null;
		if (scrollToBottomSettleTimerRef.current !== undefined) {
			window.clearTimeout(scrollToBottomSettleTimerRef.current);
			scrollToBottomSettleTimerRef.current = undefined;
		}
		promptFollowRef.current = false;
		setFollowOutput(false);
		setIsAtBottom(false);
	}, []);
	const requestEarlierHistory = useCallback(() => {
		void actions.loadEarlier().catch((error: unknown) => {
			if (activeSessionIdRef.current === state.sessionId)
				actions.showToast(error instanceof Error ? error.message : String(error));
		});
	}, [actions.loadEarlier, actions.showToast, state.sessionId]);

	useEffect(() => {
		if (!shouldLoadEarlierHistory(isAtTop, state)) return;
		requestEarlierHistory();
	}, [
		isAtTop,
		requestEarlierHistory,
		state.hasMorePrevious,
		state.loadingEarlier,
		state.previousCursor,
		state.transcriptError,
	]);

	useLayoutEffect(() => {
		if (promptScrollRequestRef.current === state.promptScrollRequest) return;
		promptScrollRequestRef.current = state.promptScrollRequest;
		promptFollowRef.current = true;
		setFollowOutput("auto");
		scrollToBottom();
	}, [scrollToBottom, state.promptScrollRequest]);

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
	const [expandedAgentSteps, setExpandedAgentSteps] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	const [expandedToolBatches, setExpandedToolBatches] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	const [expandedToolRows, setExpandedToolRows] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	const toolStackPresentationsRef = useRef(new Map<string, ToolStackPresentation>());
	useLayoutEffect(() => {
		scrollToBottomTweenRef.current?.kill();
		scrollToBottomTweenRef.current = null;
		if (scrollToBottomSettleTimerRef.current !== undefined) {
			window.clearTimeout(scrollToBottomSettleTimerRef.current);
			scrollToBottomSettleTimerRef.current = undefined;
		}
		const sessionId = state.sessionId;
		const savedScroll = sessionId ? sessionScrollStatesRef.current.get(sessionId) : undefined;
		const atBottom = savedScroll?.atBottom ?? true;
		setExpandedWorkProcesses(new Map());
		setExpandedAgentSteps(new Map());
		setExpandedToolBatches(new Map());
		setExpandedToolRows(new Map());
		toolStackPresentationsRef.current.clear();
		promptFollowRef.current = atBottom;
		setIsAtBottom(atBottom);
		setIsAtTop(false);
		setFollowOutput(atBottom ? "auto" : false);
		const frame = window.requestAnimationFrame(() => {
			if (!savedScroll || savedScroll.atBottom) scrollToBottom();
		});
		return () => {
			window.cancelAnimationFrame(frame);
			scrollToBottomTweenRef.current?.kill();
			scrollToBottomTweenRef.current = null;
			if (scrollToBottomSettleTimerRef.current !== undefined) {
				window.clearTimeout(scrollToBottomSettleTimerRef.current);
				scrollToBottomSettleTimerRef.current = undefined;
			}
		};
	}, [scrollToBottom, state.sessionId]);
	const updateExpandedWorkProcess = useCallback((key: string, open: boolean) => {
		setExpandedWorkProcesses((current) => {
			if ((current.get(key) ?? false) === open) return current;
			const next = new Map(current);
			if (open) next.set(key, true);
			else next.delete(key);
			return next;
		});
	}, []);
	const updateExpandedAgentStep = useCallback((key: string, open: boolean) => {
		setExpandedAgentSteps((current) => {
			if (current.get(key) === open) return current;
			const next = new Map(current);
			next.set(key, open);
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
	const openSubagent = actions.openSubagent;
	const renderToolStack = useCallback(
		(entry: TranscriptToolStackRenderItem) => {
			const current = renderStateRef.current;
			const tools = entry.batches.flatMap((batch) => batch.tools);
			const controlCollapsedState = entry.collapseForResult;
			let presentation = toolStackPresentationsRef.current.get(entry.key);
			if (!presentation) {
				presentation = initialToolStackPresentation(tools);
				toolStackPresentationsRef.current.set(entry.key, presentation);
			}
			if (presentation === "rows") {
				return (
					<div className="tool-batch-stack">
						{tools.map((tool) => (
							<ToolBatch
								key={tool.id}
								className="tool-batch-render-item"
								tools={[tool]}
								initialOpen={false}
								open={controlCollapsedState ? expandedToolRows.get(tool.id) ?? false : undefined}
								onOpenChange={controlCollapsedState ? (open) => updateExpandedToolRow(tool.id, open) : undefined}
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
					initialOpen={false}
					open={controlCollapsedState ? expandedToolBatches.get(entry.key) ?? false : undefined}
					onOpenChange={controlCollapsedState ? (open) => updateExpandedToolBatch(entry.key, open) : undefined}
					toolOpen={controlCollapsedState ? expandedToolRows : undefined}
					onToolOpenChange={controlCollapsedState ? updateExpandedToolRow : undefined}
					sessionId={current.sessionId}
					onOpenPath={(path) => void openResource(path)}
					onOpenSubagent={openSubagent}
				/>
			);
		},
		[
			expandedToolBatches,
			expandedToolRows,
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
			const message = (
				<TranscriptMessageView
					role={entry.role}
					text={entry.text}
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
		[actions.queueAction, actions.showToast, onEditPrompt, openResource],
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
	const renderAgentStepItem = useCallback(
		(entry: AgentStepChildRenderItem) => {
			if (entry.kind === "message") return renderMessage(entry);
			if (entry.kind === "tool-stack") return renderToolStack(entry);
			return renderCompaction(entry);
		},
		[renderCompaction, renderMessage, renderToolStack],
	);
	const renderConversationContentItem = useCallback(
		(entry: ConversationContentRenderItem) => {
			const current = renderStateRef.current;
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
			const content =
				entry.kind === "message" ? (
					renderMessage(entry)
				) : entry.kind === "tool-stack" ? (
					renderToolStack(entry)
				) : entry.kind === "compaction" ? (
					renderCompaction(entry)
				) : (
					<TranscriptItemView
						item={entry.item}
						showCopy={false}
						toolStatuses={current.toolStatuses}
						onOpenPath={openResource}
						sessionId={current.sessionId}
						projectId={current.projectId}
					/>
				);
			return (
				<div className="min-w-0" data-transcript-anchor-key={entry.key}>
					{content}
				</div>
			);
		},
		[
			expandedAgentSteps,
			liveElapsedChange,
			openResource,
			renderAgentStepItem,
			renderCompaction,
			renderMessage,
			renderToolStack,
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
				: entry.kind === "live-elapsed"
					? 32
					: entry.kind === "work-process" ||
						entry.kind === "agent-step" ||
						entry.kind === "tool-stack" ||
						entry.kind === "compaction" ||
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
				onClick={requestEarlierHistory}
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
				<PrependAnchoredConversationTranscript
					items={renderItems}
					loadingEarlier={state.loadingEarlier}
					getKey={transcriptItemKey}
					estimateHeight={estimateTranscriptItemHeight}
					footer={<ThinkingBlock text={thinkingText} />}
					gap={transcriptGap}
					header={historyStatus}
					renderItem={renderConversationItem}
					isItemEqual={conversationRenderItemEqual}
					atBottomStateChange={handleAtBottomStateChange}
					atTopStateChange={setIsAtTop}
					atTopThreshold={HISTORY_LOAD_THRESHOLD}
					followOutput={followOutput}
					scrollState={
						state.sessionId ? sessionScrollStatesRef.current.get(state.sessionId) : undefined
					}
					onScrollStateCapture={handleScrollStateCapture}
					onScrollerRef={handleTranscriptScrollerRef}
					onUserScrollAway={handleUserScrollAway}
					sessionKey={state.sessionId ?? "empty"}
					virtuosoRef={handleVirtuosoRef}
				/>
				{!isAtBottom ? (
					<Button
						aria-label="回到最新消息"
						className="absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted"
						onClick={() => {
							promptFollowRef.current = true;
							animateScrollToBottom();
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
