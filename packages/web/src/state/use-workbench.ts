import {
	createUuid,
	type GitBranches,
	type GitCommit,
	type GitDiff,
	type GitHistory,
	type GitMutation,
	type AgentStep,
	type GitStatus,
	type SessionProgress,
	type ToolActivity,
	type ToolActivityState,
	type ToolDiff,
} from "@lystar/code-web-protocol";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UnauthorizedError, webApi } from "../adapters/host-protocol/api.ts";
import { isAbsoluteResourcePath } from "../lib/resource-path.ts";
import type {
	FileResponse,
	GatewayEvent,
	HarnessImportResultResponse,
	HarnessImportsResponse,
	HostInstructionsResponse,
	ProjectGroup,
	ProjectInstruction,
	ProjectSkillsResponse,
	ProjectTreeResponse,
	PromptAttachment,
	PromptAttachmentPreview,
	ProductBranding,
	QueuedUserPrompt,
	SecuritySettingsResponse,
	SubagentConfig,
	SubagentConfigsResponse,
	SubagentSnapshot,
	SystemPermissionsResponse,
	UiRequestEvent,
	WebLease,
	WebModelProviderInput,
	WebOperation,
	WebProject,
	WebProviderModelInput,
	WebThinkingLevel,
	WebSessionSnapshot,
	WebSessionSummary,
	WebTranscriptItem,
} from "../types.ts";
import {
	applyPromptAccepted,
	canSendPrompt,
	committedToolCallIds,
	hasActiveSessionSnapshot,
	hasActiveSessionWork,
	promptDisplayText,
	type PendingUserPrompt,
	matchPendingUserPrompts,
	reconcileCommittedTurn,
	reconcilePendingUserPrompts,
	reconcileQueuedUserPromptCounts,
	removeQueuedUserPrompt,
	removeQueuedUserPromptByText,
	submitPromptWithFollowUpFallback,
} from "./chat-lifecycle.ts";
import {
	type LiveCompactionState,
	reconcileCompactionState,
	restoreCompactionState,
	updateCompactionState,
} from "./compaction-state.ts";
import {
	connectionStateAfterHostUpdate,
	connectionStateAfterSessionSubscription,
	offlineConnectionState,
	reconnectDelayMs,
	reconnectingConnectionState,
} from "./connection-recovery.ts";
import { readLastSession, saveLastSession } from "./session-persistence.ts";
import {
	bootstrapLeaseForSession,
	isOlderSessionSnapshot,
	isSameSessionSnapshot,
	isTranscriptResponseObsolete,
	mergeOperationSnapshots,
	needsTranscriptRefreshForCommit,
	replaceSessionOperationSnapshots,
	runtimeHistoryChanged,
} from "./session-sync.ts";
import { mergeWebSearchSummary, shouldJoinLiveToolBatch } from "./tool-batching.ts";
import {
	mergeTranscriptEntries,
	mergeTranscriptPage,
	transcriptRenderIdOverrides,
	type WorkbenchTranscriptItem,
} from "./transcript-state.ts";

const TRANSCRIPT_PAGE_SIZE = 120;
const MAX_HANDLED_NOTIFY_IDS = 256;

function browserNetworkOnline(): boolean {
	return typeof navigator === "undefined" || navigator.onLine !== false;
}

export type InspectorMode = "runs" | "files" | "tree" | "git" | "subagent";
export type ComposerMode = "prompt" | "steer" | "follow-up";
export type ThemeMode = "system" | "light" | "dark";
export type SettingsTab =
	| "appearance"
	| "system"
	| "instructions"
	| "skills"
	| "models"
	| "subagents"
	| "imports"
	| "diagnostics"
	| "permissions"
	| "security"
	| "about";

export interface LiveTool {
	id: string;
	name: string;
	batchId: string;
	summary: string;
	state: ToolActivityState;
	result?: string;
	status: "running" | "success" | "error";
	stepId?: string;
	inputPreview?: boolean;
	diff?: ToolDiff;
}

export type LiveTurnItem =
	| { id: string; kind: "text"; parts: readonly string[]; turnId: number; stepId?: string }
	| { id: string; kind: "thinking"; parts: readonly string[]; turnId: number; stepId?: string }
	| { id: string; kind: "tools"; turnId: number; batchId: string; toolIds: string[] }
	| {
			id: string;
			kind: "user";
			turnId: number;
			queueId: string;
			text: string;
			displayText: string;
			attachments: PromptAttachmentPreview[];
			afterEntryId?: string;
			stepId?: string;
			sentAt?: number;
			status: "queued" | "processing";
	  };

type LiveTextProgress = Extract<SessionProgress, { type: "assistant_delta" | "thinking_delta" }>;
type PendingTextProgress = { selection: number; sessionId: string; progress: LiveTextProgress };
type SessionSubscriptionResult = "ready" | "gap" | "timeout" | "closed";
type SessionSubscriptionWaiter = {
	resolve: (result: SessionSubscriptionResult) => void;
	timeoutId: number;
};

function appendLiveTextBlock(
	items: LiveTurnItem[],
	kind: "text" | "thinking",
	text: string,
	id: string,
	turnId: number,
	stepId?: string,
): LiveTurnItem[] {
	if (!text) return items;
	const last = items.at(-1);
	if (last?.kind === kind && last.turnId === turnId && last.stepId === stepId)
		return [...items.slice(0, -1), { ...last, parts: [...last.parts, text] }];
	return [...items, { id, kind, parts: [text], turnId, ...(stepId ? { stepId } : {}) }];
}

function appendLiveToolBlock(
	items: LiveTurnItem[],
	batchId: string,
	toolCallId: string,
	id: string,
	turnId: number,
): LiveTurnItem[] {
	const last = items.at(-1);
	if (last?.kind === "tools" && last.turnId === turnId && last.batchId === batchId) {
		if (last.toolIds.includes(toolCallId)) return items;
		return [...items.slice(0, -1), { ...last, toolIds: [...last.toolIds, toolCallId] }];
	}
	return [...items, { id, kind: "tools", turnId, batchId, toolIds: [toolCallId] }];
}

function runningAgentStepId(steps: Readonly<Record<string, AgentStep>>): string | undefined {
	const runningSteps = Object.values(steps).filter((step) => step.status === "running");
	return runningSteps.length === 1 ? runningSteps[0]?.id : undefined;
}

function appendLiveUserPrompt(
	items: LiveTurnItem[],
	prompt: QueuedUserPrompt,
	turnId: number,
	afterEntryId: string | undefined,
	stepId?: string,
): LiveTurnItem[] {
	const id = `optimistic-user:${prompt.id}`;
	if (items.some((item) => item.id === id)) return items;
	return [
		...items,
		{
			id,
			kind: "user",
			turnId,
			queueId: prompt.id,
			text: prompt.text,
			displayText: prompt.displayText,
			attachments: prompt.attachments,
			afterEntryId,
			sentAt: Date.now(),
			...(stepId ? { stepId } : {}),
			status: "queued",
		},
	];
}

function removeLiveUserPrompt(items: LiveTurnItem[], queueId: string): LiveTurnItem[] {
	return items.filter((item) => item.kind !== "user" || item.queueId !== queueId);
}

function markLiveUserPromptProcessing(items: LiveTurnItem[], queueId: string | undefined, text: string): LiveTurnItem[] {
	let matched = false;
	return items.map((item) => {
		if (matched || item.kind !== "user" || item.status === "processing") return item;
		if (queueId ? item.queueId !== queueId : item.text !== text) return item;
		matched = true;
		return { ...item, status: "processing" };
	});
}

/** 记住每个已落盘用户消息对应的客户端发送时刻。 */
function withPromptSendTimes(
	current: WorkbenchState,
	transcript: readonly WebTranscriptItem[],
): Record<string, number> {
	const matches = matchPendingUserPrompts(current.pendingUserPrompts, transcript);
	if (matches.length === 0) return current.promptSendTimes;
	let next: Record<string, number> | undefined;
	for (const match of matches) {
		if (match.prompt.sentAt === undefined) continue;
		next ??= { ...current.promptSendTimes };
		next[match.entryId] = match.prompt.sentAt;
	}
	return next ?? current.promptSendTimes;
}

function reconcileLiveUserPrompts(items: LiveTurnItem[], transcript: readonly WebTranscriptItem[]): LiveTurnItem[] {
	const liveUsers = items.filter((item): item is Extract<LiveTurnItem, { kind: "user" }> => item.kind === "user");
	if (!liveUsers.length) return items;
	const remainingIds = new Set(
		reconcilePendingUserPrompts(
			liveUsers.map((item) => ({
				id: item.id,
				text: item.text,
				attachments: item.attachments,
				afterEntryId: item.afterEntryId,
				queueId: item.queueId,
			})),
			transcript,
		).map((item) => item.id),
	);
	return items.filter((item) => item.kind !== "user" || remainingIds.has(item.id));
}

function mergeToolDiff(previous: ToolDiff | undefined, next: ToolDiff | undefined): ToolDiff | undefined {
	if (!next) return previous;
	if (!previous) return next;

	return {
		files: next.files.map((file, index) => {
			const previousFile = file.path
				? previous.files.find((candidate) => candidate.path === file.path)
				: previous.files[index];
			return {
				...(previousFile ?? {}),
				...file,
				...(file.path === undefined && previousFile?.path ? { path: previousFile.path } : {}),
			};
		}),
	};
}

function toolActivityStatus(state: ToolActivityState): LiveTool["status"] {
	return state === "success"
		? "success"
		: state === "error" || state === "cancelled" || state === "interrupted"
			? "error"
			: "running";
}

function toolActivityLabel(activity: ToolActivity): string {
	switch (activity.state) {
		case "preparing":
			return `准备 ${activity.name}`;
		case "queued":
			return `${activity.name} 已排队`;
		case "running":
			return `正在执行 ${activity.name}`;
		case "success":
			return `${activity.name} 已完成`;
		case "error":
			return `${activity.name} 执行失败`;
		case "cancelled":
			return `${activity.name} 已取消`;
		case "interrupted":
			return `${activity.name} 已中断`;
	}
}

function liveToolFromActivity(activity: ToolActivity, previous: LiveTool | undefined, batchId: string): LiveTool {
	const terminal =
		activity.state === "success" ||
		activity.state === "error" ||
		activity.state === "cancelled" ||
		activity.state === "interrupted";
	return {
		id: activity.toolCallId,
		name: activity.name,
		batchId,
		summary:
			activity.name === "web_search"
				? mergeWebSearchSummary(previous?.summary, activity.summary)
				: activity.summary || previous?.summary || activity.name,
		state: activity.state,
		status: toolActivityStatus(activity.state),
		stepId: activity.stepId ?? previous?.stepId,
		inputPreview: activity.inputPreview,
		result: activity.output ?? activity.progress ?? activity.error ?? previous?.result,
		...(terminal ? { diff: activity.diff } : { diff: mergeToolDiff(previous?.diff, activity.diff) }),
	};
}

function nextLiveToolBatchId(
	current: WorkbenchState,
	toolName: string,
	toolSummary: string,
	stepId: string | undefined,
	turnId: number,
	fallback: string,
): string {
	const last = current.liveTurnItems.at(-1);
	if (last?.kind !== "tools" || last.turnId !== turnId) return fallback;
	const previousToolId = last.toolIds.at(-1);
	const previousTool = previousToolId ? current.liveTools[previousToolId] : undefined;
	if (previousTool?.stepId !== stepId) return fallback;
	return shouldJoinLiveToolBatch(previousTool, { name: toolName, summary: toolSummary }, last?.turnId, turnId)
		? last.batchId
		: fallback;
}

function applyToolActivityState(current: WorkbenchState, activity: ToolActivity): WorkbenchState {
	if (
		current.toolActivityEpoch === activity.activityEpoch &&
		(current.toolActivityRevision ?? -1) >= activity.revision
	) {
		return current;
	}
	const newEpoch = current.toolActivityEpoch !== activity.activityEpoch;
	const liveTools = newEpoch ? {} : current.liveTools;
	const previous = liveTools[activity.toolCallId];
	const batchId =
		previous?.batchId ??
		nextLiveToolBatchId(
			current,
			activity.name,
			activity.summary,
			activity.stepId,
			current.liveTurnId,
			`live-tool-batch:${activity.activityEpoch}:${activity.toolCallId}`,
		);
	return {
		...current,
		toolActivityEpoch: activity.activityEpoch,
		toolActivityRevision: activity.revision,
		liveTools: {
			...liveTools,
			[activity.toolCallId]: liveToolFromActivity(activity, previous, batchId),
		},
		liveTurnItems: previous
			? current.liveTurnItems
			: appendLiveToolBlock(
					newEpoch ? current.liveTurnItems.filter((item) => item.kind !== "tools") : current.liveTurnItems,
					batchId,
					activity.toolCallId,
					`live-tools:${activity.activityEpoch}:${activity.toolCallId}`,
					current.liveTurnId,
				),
		statusText: toolActivityLabel(activity),
	};
}

function restoreToolActivities(current: WorkbenchState, snapshot: WebSessionSnapshot): WorkbenchState {
	if (!snapshot.toolActivityEpoch || snapshot.toolActivityRevision === undefined) return current;
	if (
		current.toolActivityEpoch === snapshot.toolActivityEpoch &&
		(current.toolActivityRevision ?? -1) >= snapshot.toolActivityRevision
	) {
		return current;
	}
	let next: WorkbenchState = {
		...current,
		toolActivityEpoch: snapshot.toolActivityEpoch,
		toolActivityRevision: snapshot.toolActivityRevision,
		liveTools: {},
		liveTurnItems: current.liveTurnItems.filter((item) => item.kind !== "tools"),
	};
	for (const activity of snapshot.toolActivities ?? []) {
		const batchId = nextLiveToolBatchId(
			next,
			activity.name,
			activity.summary,
			activity.stepId,
			next.liveTurnId,
			`live-tool-batch:${activity.activityEpoch}:${activity.toolCallId}`,
		);
		next = {
			...next,
			liveTools: {
				...next.liveTools,
				[activity.toolCallId]: liveToolFromActivity(activity, undefined, batchId),
			},
			liveTurnItems: appendLiveToolBlock(
				next.liveTurnItems,
				batchId,
				activity.toolCallId,
				`live-tools:${activity.activityEpoch}:${activity.toolCallId}`,
				next.liveTurnId,
			),
		};
	}
	const persisted = committedToolCallIds(next.transcript);
	return {
		...next,
		liveTurnItems: next.liveTurnItems.flatMap((item): LiveTurnItem[] => {
			if (item.kind !== "tools") return [item];
			const toolIds = item.toolIds.filter((id) => !persisted.has(id));
			return toolIds.length ? [{ ...item, toolIds }] : [];
		}),
	};
}

function queuedPromptsFromSnapshot(
	snapshot: WebSessionSnapshot,
	fallback: readonly QueuedUserPrompt[],
): QueuedUserPrompt[] {
	const reconciled = reconcileQueuedUserPromptCounts(
		fallback,
		snapshot.queuedSteerCount ?? 0,
		snapshot.queuedFollowUpCount,
	);
	if (snapshot.queuedFollowUpMessages !== undefined) {
		const steering = reconciled.filter((prompt) => prompt.delivery === "steer");
		const fallbackById = new Map(fallback.map((prompt) => [prompt.id, prompt]));
		const followUp = snapshot.queuedFollowUpMessages.map(({ id, text }) => {
			const previous = fallbackById.get(id);
			return {
				id,
				text,
				displayText: previous?.displayText || promptDisplayText(text) || "附件消息",
				delivery: "follow-up" as const,
				attachments: previous?.attachments ?? [],
			};
		});
		return [...steering, ...followUp];
	}
	return reconciled;
}

export function restoreRuntimeActivities(current: WorkbenchState, snapshot: WebSessionSnapshot): WorkbenchState {
	const queuedUserPrompts = queuedPromptsFromSnapshot(snapshot, current.queuedUserPrompts ?? []);
	const queuedPromptIds = new Set(queuedUserPrompts.map((prompt) => prompt.id));
	const liveTurnItems = current.liveTurnItems.map((item) =>
		item.kind === "user" && item.status === "queued" && !queuedPromptIds.has(item.queueId)
			? { ...item, status: "processing" as const }
			: item,
	);
	const liveSteps = snapshot.activeStep
		? { [snapshot.activeStep.id]: snapshot.activeStep }
		: hasActiveSessionSnapshot(snapshot)
			? Object.fromEntries(Object.entries(current.liveSteps ?? {}).filter(([, step]) => step.status !== "running"))
			: {};
	const next = {
		...current,
		queuedUserPrompts,
		liveSteps,
		liveTurnItems,
		pendingUserPrompts: (current.pendingUserPrompts ?? []).filter(
			(prompt) => !prompt.queueId || !queuedPromptIds.has(prompt.queueId),
		),
		liveCompaction: restoreCompactionState(current.liveCompaction, snapshot.phase, current.transcript),
		...(hasActiveSessionSnapshot(snapshot) ? {} : { liveTurnActive: false }),
	};
	return restoreToolActivities(next, snapshot);
}

interface GitFileDiffStats {
	additions: number;
	deletions: number;
}

export function gitFileStatsKey(repositoryPath: string, path: string): string {
	return `${repositoryPath}\0${path}`;
}

export interface WorkbenchState {
	loading: boolean;
	networkOnline: boolean;
	connected: boolean;
	reconnecting: boolean;
	connectionError: string;
	authRequired: boolean;
	projects: WebProject[];
	projectGroups: ProjectGroup[];
	currentProjectId?: string;
	sessionId?: string;
	session?: WebSessionSnapshot;
	sessionError?: string;
	transcript: WorkbenchTranscriptItem[];
	transcriptPageLoaded: boolean;
	transcriptLoading: boolean;
	transcriptError?: string;
	transcriptGeneration?: string;
	transcriptRevision?: number;
	transcriptLeafId?: string | null;
	previousCursor?: string;
	toolActivityEpoch?: string;
	toolActivityRevision?: number;
	hasMorePrevious: boolean;
	loadingEarlier: boolean;
	lease?: { leaseId: string; leaseGeneration: number; createdAt: number; updatedAt: number };
	readOnly: boolean;
	sessionReady: boolean;
	pendingUserPrompts: PendingUserPrompt[];
	/** 已落盘用户消息 entryId → 客户端按下发送的时刻，使「已处理」和「本次耗时」同一起点。 */
	promptSendTimes: Record<string, number>;
	queuedUserPrompts: QueuedUserPrompt[];
	currentOperation?: WebOperation;
	operations: WebOperation[];
	liveTools: Record<string, LiveTool>;
	liveSteps: Record<string, AgentStep>;
	liveTurnItems: LiveTurnItem[];
	liveTurnId: number;
	liveTurnStartRevision?: number;
	liveTurnActive?: boolean;
	liveCompaction?: LiveCompactionState;
	promptScrollRequest?: number;
	unreadSessionIds: Record<string, true>;
	statusText: string;
	pendingUiRequests: UiRequestEvent[];
	inspectorOpen: boolean;
	inspectorMode: InspectorMode;
	gitStatus?: GitStatus;
	gitBranches?: GitBranches;
	gitHistory?: GitHistory;
	gitCommit?: GitCommit;
	gitFileStats: Record<string, GitFileDiffStats>;
	gitDiff?: GitDiff;
	gitLoading: boolean;
	gitBranchesLoading: boolean;
	gitHistoryLoading: boolean;
	gitCommitLoading: boolean;
	gitDiffLoading: boolean;
	gitOperation?: GitMutation["type"];
	gitCredentialAuthorizationMessage?: string;
	fileTree?: ProjectTreeResponse;
	fileTreeRootPath?: string;
	fileTreeCache: Record<string, ProjectTreeResponse>;
	fileTreeLoading: boolean;
	filePath?: string;
	fileContent?: FileResponse;
	fileError?: string;
	fileLoading: boolean;
	sessionTree: Array<{
		id: string;
		parentId: string | null;
		kind: string;
		label?: string;
		timestamp: string;
		preview: string;
		isLeaf: boolean;
		depth: number;
	}>;
	sessionTreeLoading: boolean;
	directoryListing?: {
		path: string;
		parent?: string;
		home: string;
		entries: Array<{ name: string; path: string; hidden: boolean; kind?: "directory" | "file" }>;
	};
	directoryLoading: boolean;
	settingsOpen: boolean;
	settingsTab: SettingsTab;
	branding: ProductBranding;
	brandingSaving: boolean;
	brandingError?: string;
	securitySettings?: SecuritySettingsResponse;
	securitySettingsLoading: boolean;
	securitySettingsSaving: boolean;
	securitySettingsError?: string;
	skills: ProjectSkillsResponse["skills"];
	skillDiagnostics: unknown;
	skillsLoading: boolean;
	skillsError?: string;
	skillUpdatingPath?: string;
	hostInstructions: ProjectInstruction[];
	hostInstructionsLoading: boolean;
	hostInstructionsError?: string;
	hostInstructionSaving: boolean;
	harnessImports?: HarnessImportsResponse;
	harnessImportsLoading: boolean;
	harnessImportsError?: string;
	harnessImporting: boolean;
	harnessImportResult?: HarnessImportResultResponse;
	subagentConfigs: SubagentConfig[];
	subagentConfigsLoading: boolean;
	subagentConfigsSaving: boolean;
	subagentConfigsError?: string;
	modelOptions: Array<{
		provider: string;
		id: string;
		name: string;
		reasoning: boolean;
		contextWindow: number;
		supportedThinkingLevels: string[];
	}>;
	modelOptionProviders: Array<{
		id: string;
		name: string;
		builtIn: boolean;
	}>;
	modelCatalogRevision: number;
	models: Array<{
		provider: string;
		id: string;
		name: string;
		api: string;
		reasoning: boolean;
		input: ("text" | "image")[];
		contextWindow: number;
		maxTokens: number;
		thinkingLevelMap?: Partial<
			Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra", string | null>
		>;
		capabilitiesPending?: boolean;
		hasOverrides?: boolean;
		supportedThinkingLevels: string[];
		authenticated: boolean;
		authMethods: string[];
		authSource?: string;
	}>;
	providers: Array<{
		id: string;
		name: string;
		api?: string;
		baseUrl?: string;
		authenticated: boolean;
		authMethods: string[];
		authSource?: string;
		modelCount: number;
		builtIn: boolean;
		custom: boolean;
		hasCustomConfig: boolean;
		disabledModels: string[];
		catalogProvider?: string;
	}>;
	hiddenModelProviders: string[];
	modelSettingsLoading: boolean;
	modelSettingsError?: string;
	about?: Record<string, unknown>;
	diagnostics?: Record<string, unknown>;
	projectTrust?: { cwd: string; trusted: boolean | null; reason: string; resourceRisk: boolean };
	toast?: string;
	theme: ThemeMode;
	composerMode: ComposerMode;
	subagents: SubagentSnapshot[];
	subagentsLoading: boolean;
	subagentsError?: string;
	selectedSubagentId?: string;
	subagentViews: Record<string, SubagentConversationState>;
}

export interface SubagentConversationState {
	snapshot: SubagentSnapshot;
	transcript: WorkbenchTranscriptItem[];
	transcriptPageLoaded: boolean;
	transcriptLoading: boolean;
	transcriptError?: string;
	transcriptGeneration?: string;
	transcriptRevision?: number;
	transcriptLeafId?: string | null;
	previousCursor?: string;
	hasMorePrevious: boolean;
	loadingEarlier: boolean;
	toolActivityEpoch?: string;
	toolActivityRevision?: number;
	liveTools: Record<string, LiveTool>;
	liveSteps: Record<string, AgentStep>;
	liveTurnItems: LiveTurnItem[];
	liveTurnId: number;
	liveTurnStartRevision?: number;
	liveTurnActive?: boolean;
	liveCompaction?: LiveCompactionState;
	statusText: string;
}

export function createSubagentConversationState(snapshot: SubagentSnapshot): SubagentConversationState {
	return {
		snapshot,
		transcript: [],
		transcriptPageLoaded: false,
		transcriptLoading: false,
		hasMorePrevious: false,
		loadingEarlier: false,
		liveTools: {},
		liveSteps: {},
		liveTurnItems: [],
		liveTurnId: 0,
		liveTurnActive: snapshot.state === "queued" || snapshot.state === "running" || snapshot.state === "waiting",
		statusText: snapshot.currentAction ?? "",
	};
}

export function mergeSubagentSnapshots(
	current: readonly SubagentSnapshot[],
	incoming: readonly SubagentSnapshot[],
): SubagentSnapshot[] {
	const byAgent = new Map(current.map((snapshot) => [snapshot.agentId, snapshot]));
	for (const snapshot of incoming) {
		const previous = byAgent.get(snapshot.agentId);
		if (!previous || snapshot.runId !== previous.runId || snapshot.updatedAt >= previous.updatedAt)
			byAgent.set(snapshot.agentId, snapshot);
	}
	return [...byAgent.values()].sort(
		(left, right) =>
			right.updatedAt - left.updatedAt ||
			left.runId.localeCompare(right.runId) ||
			left.agentId.localeCompare(right.agentId),
	);
}

function subagentToolBatchId(
	current: SubagentConversationState,
	name: string,
	summary: string,
	stepId: string | undefined,
	fallback: string,
): string {
	const last = current.liveTurnItems.at(-1);
	if (last?.kind !== "tools" || last.turnId !== current.liveTurnId) return fallback;
	const previousTool = current.liveTools[last.toolIds.at(-1) ?? ""];
	if (previousTool?.stepId !== stepId) return fallback;
	return shouldJoinLiveToolBatch(previousTool, { name, summary }, last.turnId, current.liveTurnId)
		? last.batchId
		: fallback;
}

export function applySubagentProgress(
	current: SubagentConversationState,
	progress: SessionProgress,
	nextLiveItemId: () => string,
	nextLiveToolId: () => string,
): SubagentConversationState {
	switch (progress.type) {
		case "assistant_delta":
			return {
				...current,
				liveTurnActive: true,
				liveTurnItems: appendLiveTextBlock(
					current.liveTurnItems,
					"text",
					progress.text,
					nextLiveItemId(),
					current.liveTurnId,
					progress.stepId,
				),
				statusText: "正在生成回复",
			};
		case "thinking_delta":
			return {
				...current,
				liveTurnActive: true,
				liveTurnItems: appendLiveTextBlock(
					current.liveTurnItems,
					"thinking",
					progress.text,
					nextLiveItemId(),
					current.liveTurnId,
					progress.stepId,
				),
				statusText: "正在思考",
			};
		case "user_message": {
				if (current.liveTurnItems.some((item) => item.kind === "user" && item.text === progress.text)) return current;
				const id = nextLiveItemId();
				return {
					...current,
					liveTurnItems: [
						...current.liveTurnItems,
						{
							id,
							kind: "user",
							turnId: current.liveTurnId,
							queueId: id,
							text: progress.text,
							displayText: progress.text || "附件消息",
							attachments: [],
							status: "processing",
						},
					],
					statusText: "正在处理",
				};
			}
		case "agent_step":
			return {
				...current,
				liveTurnActive: true,
				liveSteps: { ...current.liveSteps, [progress.step.id]: progress.step },
				statusText: progress.step.status === "running" ? progress.step.title : current.statusText,
			};
		case "tool_state": {
				if (
					current.toolActivityEpoch === progress.activity.activityEpoch &&
					(current.toolActivityRevision ?? -1) >= progress.activity.revision
				)
					return current;
				const newEpoch = current.toolActivityEpoch !== progress.activity.activityEpoch;
				const liveTools = newEpoch ? {} : current.liveTools;
				const previous = liveTools[progress.activity.toolCallId];
				const batchId =
					previous?.batchId ??
					subagentToolBatchId(
						{ ...current, liveTools },
						progress.activity.name,
						progress.activity.summary,
						progress.activity.stepId,
						`subagent-tool:${nextLiveToolId()}`,
					);
				return {
					...current,
					toolActivityEpoch: progress.activity.activityEpoch,
					toolActivityRevision: progress.activity.revision,
					liveTools: {
						...liveTools,
						[progress.activity.toolCallId]: liveToolFromActivity(progress.activity, previous, batchId),
					},
					liveTurnItems: previous
						? current.liveTurnItems
						: appendLiveToolBlock(
								newEpoch ? current.liveTurnItems.filter((item) => item.kind !== "tools") : current.liveTurnItems,
								batchId,
								progress.activity.toolCallId,
								nextLiveItemId(),
								current.liveTurnId,
							),
					statusText: toolActivityLabel(progress.activity),
				};
			}
		case "tool_start":
		case "tool_update":
		case "tool_end": {
			const previous = current.liveTools[progress.toolCallId];
			if (progress.type === "tool_update" && previous && previous.status !== "running") return current;
			const summary =
				progress.name === "web_search"
					? mergeWebSearchSummary(previous?.summary, progress.summary)
					: progress.summary || previous?.summary || "正在执行";
			const batchId =
				previous?.batchId ??
				subagentToolBatchId(current, progress.name, summary, progress.stepId, `subagent-tool:${nextLiveToolId()}`);
			const status = progress.type === "tool_end" ? progress.status : "running";
			return {
				...current,
				liveTools: {
					...current.liveTools,
					[progress.toolCallId]: {
						id: progress.toolCallId,
						name: progress.name,
						batchId,
						summary,
						state: status === "success" ? "success" : status === "error" ? "error" : "running",
						status,
						stepId: progress.stepId ?? previous?.stepId,
						result: progress.summary,
						diff: mergeToolDiff(previous?.diff, progress.diff),
					},
				},
				liveTurnItems: previous
					? current.liveTurnItems
					: appendLiveToolBlock(
							current.liveTurnItems,
							batchId,
							progress.toolCallId,
							nextLiveItemId(),
							current.liveTurnId,
						),
				statusText: progress.type === "tool_end" ? `${progress.name} 已完成` : `正在执行 ${progress.name}`,
			};
		}
		case "queue_update":
			return {
				...current,
				statusText:
					progress.steeringCount + progress.followUpCount > 0
						? `队列中 ${progress.steeringCount + progress.followUpCount} 项`
						: "正在处理",
			};
		case "phase":
			return {
				...current,
				liveTurnId: progress.phase === "turn" ? current.liveTurnId + 1 : current.liveTurnId,
				liveTurnActive:
					progress.phase === "turn"
						? true
						: progress.phase === "idle" || progress.phase === "interrupted"
							? false
							: current.liveTurnActive,
				liveTurnItems:
					progress.phase === "turn"
						? current.liveTurnItems.filter((item) => item.kind === "user")
						: current.liveTurnItems,
				liveSteps: progress.phase === "turn" ? {} : current.liveSteps,
				liveTurnStartRevision: progress.phase === "turn" ? current.transcriptRevision : current.liveTurnStartRevision,
				statusText:
					progress.phase === "idle"
						? ""
						: progress.phase === "waiting_for_input"
							? "等待输入"
							: progress.phase === "compaction"
								? "正在整理上下文"
								: "正在处理",
			};
		case "compaction":
			return {
				...current,
				liveCompaction: updateCompactionState(current.liveCompaction, progress, current.transcript),
				statusText: progress.status === "running" ? "正在整理上下文" : progress.status === "completed" ? "上下文已整理" : "上下文整理已停止",
			};
		case "retry":
			return {
				...current,
				liveCompaction: updateCompactionState(current.liveCompaction, progress, current.transcript),
				statusText: progress.status === "running" ? "正在重试" : progress.status === "waiting" ? "等待重试" : "重试完成",
			};
		case "bash":
			return { ...current, statusText: "正在运行命令" };
		case "status":
			return { ...current, statusText: progress.status };
		case "usage":
			return current;
	}
}

type SessionDetailCache = Pick<
	WorkbenchState,
	| "session"
	| "transcript"
	| "transcriptPageLoaded"
	| "transcriptGeneration"
	| "transcriptRevision"
	| "transcriptLeafId"
	| "previousCursor"
	| "toolActivityEpoch"
	| "toolActivityRevision"
	| "hasMorePrevious"
	| "loadingEarlier"
	| "liveTools"
	| "liveSteps"
	| "liveTurnItems"
	| "liveTurnId"
	| "liveTurnStartRevision"
	| "liveTurnActive"
	| "liveCompaction"
	| "pendingUserPrompts"
	| "promptSendTimes"
	| "queuedUserPrompts"
	| "statusText"
>;

function sessionDetailCacheFromState(state: WorkbenchState): SessionDetailCache {
	return {
		session: state.session,
		transcript: state.transcript,
		transcriptPageLoaded: state.transcriptPageLoaded,
		transcriptGeneration: state.transcriptGeneration,
		transcriptRevision: state.transcriptRevision,
		transcriptLeafId: state.transcriptLeafId,
		previousCursor: state.previousCursor,
		toolActivityEpoch: state.toolActivityEpoch,
		toolActivityRevision: state.toolActivityRevision,
		hasMorePrevious: state.hasMorePrevious,
		loadingEarlier: state.loadingEarlier,
		liveTools: state.liveTools,
		liveSteps: state.liveSteps,
		liveTurnItems: state.liveTurnItems,
		liveTurnId: state.liveTurnId,
		liveTurnStartRevision: state.liveTurnStartRevision,
		liveTurnActive: state.liveTurnActive,
		liveCompaction: state.liveCompaction,
		pendingUserPrompts: state.pendingUserPrompts,
		promptSendTimes: state.promptSendTimes,
		queuedUserPrompts: state.queuedUserPrompts,
		statusText: state.statusText,
	};
}

const SESSION_DETAIL_CACHE_LIMIT = 8;
const SESSION_DETAIL_CACHE_BYTES_LIMIT = 24 * 1024 * 1024;

type CachedSessionDetail = {
	detail: SessionDetailCache;
	bytes: number;
};

function approximateValueBytes(value: unknown, seen = new WeakSet<object>(), depth = 0): number {
	if (typeof value === "string") return value.length * 2;
	if (typeof value === "number" || typeof value === "bigint") return 8;
	if (typeof value === "boolean") return 4;
	if (!value || typeof value !== "object") return 0;
	if (seen.has(value) || depth > 12) return 0;
	seen.add(value);
	if (Array.isArray(value)) {
		return 24 + value.reduce((total, item) => total + approximateValueBytes(item, seen, depth + 1), 0);
	}
	let bytes = 48;
	for (const [key, item] of Object.entries(value)) {
		bytes += key.length * 2 + approximateValueBytes(item, seen, depth + 1);
	}
	return bytes;
}

function cacheSessionDetail(
	cache: Map<string, CachedSessionDetail>,
	sessionId: string,
	detail: SessionDetailCache,
): void {
	cache.delete(sessionId);
	const entry = { detail, bytes: approximateValueBytes(detail) };
	cache.set(sessionId, entry);
	let totalBytes = [...cache.values()].reduce((total, current) => total + current.bytes, 0);
	while (cache.size > SESSION_DETAIL_CACHE_LIMIT || totalBytes > SESSION_DETAIL_CACHE_BYTES_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		const removed = cache.get(oldest);
		cache.delete(oldest);
		totalBytes -= removed?.bytes ?? 0;
	}
}

function readCachedSessionDetail(
	cache: Map<string, CachedSessionDetail>,
	sessionId: string,
): SessionDetailCache | undefined {
	const entry = cache.get(sessionId);
	if (!entry) return undefined;
	cache.delete(sessionId);
	cache.set(sessionId, entry);
	return entry.detail;
}

const THEME_KEY = "lystar.web.theme";
const MODEL_PROVIDER_VISIBILITY_KEY = "lystar.web.model-provider-visibility.v2";
const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "waiting_for_input"]);
const TERMINAL_OPERATION_STATUSES = new Set(["completed", "failed", "aborted", "interrupted"]);

function savedTheme(): ThemeMode {
	if (typeof window === "undefined") return "system";
	const value = window.localStorage.getItem(THEME_KEY);
	return value === "light" || value === "dark" ? value : "system";
}

type ModelProviderVisibilityOverrides = Record<string, boolean>;
type ModelProviderVisibilityProvider = Pick<WorkbenchState["providers"][number], "id" | "authenticated">;

function savedModelProviderVisibilityOverrides(): ModelProviderVisibilityOverrides {
	if (typeof window === "undefined") return {};
	try {
		const value: unknown = JSON.parse(window.localStorage.getItem(MODEL_PROVIDER_VISIBILITY_KEY) ?? "{}");
		if (Array.isArray(value)) {
			const overrides: ModelProviderVisibilityOverrides = {};
			for (const providerId of value) {
				if (typeof providerId === "string") overrides[providerId] = false;
			}
			return overrides;
		}
		if (!value || typeof value !== "object") return {};
		const overrides: ModelProviderVisibilityOverrides = {};
		for (const [providerId, visible] of Object.entries(value)) {
			if (typeof visible === "boolean") overrides[providerId] = visible;
		}
		return overrides;
	} catch {
		return {};
	}
}

function savedHiddenModelProviders(): string[] {
	return Object.entries(savedModelProviderVisibilityOverrides())
		.filter(([, visible]) => !visible)
		.map(([providerId]) => providerId);
}

export function resolveHiddenModelProviders(
	providers: readonly ModelProviderVisibilityProvider[],
	overrides: Readonly<ModelProviderVisibilityOverrides>,
): string[] {
	return providers
		.filter(({ id, authenticated }) => overrides[id] === false || (overrides[id] === undefined && !authenticated))
		.map(({ id }) => id);
}

function applyTheme(theme: ThemeMode): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.theme = theme === "system" ? "" : theme;
	window.localStorage.setItem(THEME_KEY, theme);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const GIT_KEYCHAIN_AUTHORIZATION_MARKER = "LYSTAR_GIT_KEYCHAIN_AUTHORIZATION_REQUIRED";
const GIT_KEYCHAIN_AUTHORIZATION_MESSAGE =
	"Git 需要访问这台 Mac 的登录钥匙串，本次后台操作已停止。请在运行 LYStar Code Web 的 Mac 本机终端执行 lc web permissions setup，在终端隐藏输入一次登录钥匙串密码完成批量授权，完成后回到 Web 重试。";

export function gitCredentialAuthorizationMessageFromSystemPermissions(
	permissions: SystemPermissionsResponse,
): string | undefined {
	if (!permissions.supported) return undefined;
	const keychain = permissions.permissions.find((permission) => permission.id === "keychain");
	if (keychain?.state !== "required") return undefined;
	return keychain.message || GIT_KEYCHAIN_AUTHORIZATION_MESSAGE;
}

export function gitCredentialAuthorizationMessage(value: unknown): string | undefined {
	const candidate = value && typeof value === "object" ? (value as { code?: unknown; message?: unknown }) : undefined;
	const code = typeof candidate?.code === "string" ? candidate.code : undefined;
	const message =
		typeof candidate?.message === "string"
			? candidate.message
			: typeof value === "string"
				? value
				: value instanceof Error
					? value.message
					: "";
	if (
		code !== "git_credentials_required" &&
		!message.includes(GIT_KEYCHAIN_AUTHORIZATION_MARKER) &&
		!(/Git|git/u.test(message) && /钥匙串|keychain/iu.test(message) && message.includes("lc web permissions setup"))
	)
		return undefined;
	return code === "git_credentials_required" && message.trim() ? message.trim() : GIT_KEYCHAIN_AUTHORIZATION_MESSAGE;
}

function hasMeaningfulSessionFirstMessage(value: string): boolean {
	const normalized = value.trim();
	return normalized.length > 0 && normalized !== "未命名会话";
}

export function sessionTitle(session: WebSessionSummary | WebSessionSnapshot | undefined): string {
	if (!session) return "未命名会话";
	return (
		("name" in session && session.name?.trim()) ||
		("firstMessage" in session && session.firstMessage.trim()) ||
		"未命名会话"
	);
}

function eventIsObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function operationForSession(operations: WebOperation[], sessionId: string | undefined): WebOperation | undefined {
	if (!sessionId) return undefined;
	let latest: WebOperation | undefined;
	for (const operation of operations) {
		if (operation.sessionId !== sessionId || !ACTIVE_OPERATION_STATUSES.has(operation.status)) continue;
		if (!latest || operation.updatedAt > latest.updatedAt) latest = operation;
	}
	return latest;
}

function operationForSessionSnapshot(
	operations: WebOperation[],
	snapshot: WebSessionSnapshot | undefined,
): WebOperation | undefined {
	return snapshot && hasActiveSessionSnapshot(snapshot) ? operationForSession(operations, snapshot.id) : undefined;
}

export function mergeSessionSummaries(
	current: readonly WebSessionSummary[],
	incoming: readonly WebSessionSummary[],
): WebSessionSummary[] {
	const currentById = new Map(current.map((session) => [session.id, session]));
	return incoming.map((next) => {
		const previous = currentById.get(next.id);
		const preservedName = !Object.hasOwn(next, "name") && previous?.name?.trim() ? { name: previous.name } : {};
		const preservedFirstMessage =
			previous &&
			hasMeaningfulSessionFirstMessage(previous.firstMessage) &&
			!hasMeaningfulSessionFirstMessage(next.firstMessage)
				? { firstMessage: previous.firstMessage }
				: {};
		return { ...next, ...preservedName, ...preservedFirstMessage };
	});
}

function updateSessionSummaryName(projects: WebProject[], sessionId: string, name: string | undefined): WebProject[] {
	const normalizedName = name?.trim();
	for (let projectIndex = 0; projectIndex < projects.length; projectIndex++) {
		const project = projects[projectIndex];
		const sessionIndex = project.sessions.findIndex((session) => session.id === sessionId);
		if (sessionIndex < 0) continue;
		const session = project.sessions[sessionIndex];
		const currentName = session.name?.trim();
		if (currentName === normalizedName && (normalizedName !== undefined || !Object.hasOwn(session, "name"))) {
			return projects;
		}
		const { name: _name, ...withoutName } = session;
		const nextSession = normalizedName ? { ...withoutName, name: normalizedName } : withoutName;
		const sessions = [...project.sessions];
		sessions[sessionIndex] = nextSession;
		const next = [...projects];
		next[projectIndex] = { ...project, sessions };
		return next;
	}
	return projects;
}

export function updateSessionSummaryFirstMessage(
	projects: WebProject[],
	sessionId: string,
	firstMessage: string,
): WebProject[] {
	const normalizedMessage = firstMessage.trim();
	if (!normalizedMessage) return projects;
	for (let projectIndex = 0; projectIndex < projects.length; projectIndex++) {
		const project = projects[projectIndex];
		const sessionIndex = project.sessions.findIndex((session) => session.id === sessionId);
		if (sessionIndex < 0) continue;
		const session = project.sessions[sessionIndex];
		if (hasMeaningfulSessionFirstMessage(session.firstMessage)) return projects;
		const sessions = [...project.sessions];
		sessions[sessionIndex] = {
			...session,
			firstMessage: normalizedMessage,
			messageCount: Math.max(session.messageCount, 1),
		};
		const next = [...projects];
		next[projectIndex] = { ...project, sessions };
		return next;
	}
	return projects;
}

function mergeProjectSessions(current: readonly WebProject[], incoming: readonly WebProject[]): WebProject[] {
	const currentById = new Map(current.map((project) => [project.id, project]));
	return incoming.map((project) => {
		const previous = currentById.get(project.id);
		return previous ? { ...project, sessions: mergeSessionSummaries(previous.sessions, project.sessions) } : project;
	});
}

function updateSessionActivity(
	projects: WebProject[],
	sessionId: string,
	activity: WebSessionSummary["activity"],
	operationUpdatedAt?: number,
): WebProject[] {
	for (let projectIndex = 0; projectIndex < projects.length; projectIndex++) {
		const project = projects[projectIndex];
		const sessionIndex = project.sessions.findIndex((session) => session.id === sessionId);
		if (sessionIndex < 0) continue;
		const session = project.sessions[sessionIndex];
		if (
			session.activity === activity &&
			(operationUpdatedAt === undefined || session.operationUpdatedAt === operationUpdatedAt)
		) {
			return projects;
		}
		const sessions = [...project.sessions];
		sessions[sessionIndex] = {
			...session,
			activity,
			...(operationUpdatedAt === undefined ? {} : { operationUpdatedAt }),
		};
		const next = [...projects];
		next[projectIndex] = { ...project, sessions };
		return next;
	}
	return projects;
}

function sessionActivityFromProgress(progress: SessionProgress): "running" | "waiting_for_input" | "idle" | undefined {
	switch (progress.type) {
		case "phase":
			return progress.phase === "waiting_for_input"
				? "waiting_for_input"
				: progress.phase === "idle"
					? "idle"
					: "running";
		case "compaction":
			return progress.status === "running" || progress.status === "waiting_retry" ? "running" : undefined;
		case "retry":
			return progress.status === "running" || progress.status === "waiting" ? "running" : undefined;
		case "assistant_delta":
		case "thinking_delta":
		case "agent_step":
		case "tool_start":
		case "tool_update":
		case "tool_end":
		case "user_message":
		case "bash":
			return "running";
		case "tool_state":
			return progress.activity.state === "success" ||
				progress.activity.state === "error" ||
				progress.activity.state === "cancelled" ||
				progress.activity.state === "interrupted"
				? undefined
				: "running";
		case "queue_update":
		case "status":
		case "usage":
			return undefined;
	}
}

export function gitCredentialAuthorizationMessageFromProgress(progress: SessionProgress): string | undefined {
	if (progress.type === "tool_state" && progress.activity.state === "error") {
		return gitCredentialAuthorizationMessage(progress.activity.error);
	}
	if (progress.type === "tool_end" && progress.status === "error") {
		return gitCredentialAuthorizationMessage(progress.summary);
	}
	return undefined;
}

export function transcriptText(item: WebTranscriptItem): string {
	return item.view && "text" in item.view ? item.view.text : "";
}

function changedFilePaths(progress: SessionProgress): string[] {
	if (progress.type === "tool_end" && progress.status === "success") {
		return progress.diff?.files.flatMap((file) => (file.path ? [file.path] : [])) ?? [];
	}
	if (progress.type === "tool_state" && progress.activity.state === "success") {
		return progress.activity.diff?.files.flatMap((file) => (file.path ? [file.path] : [])) ?? [];
	}
	return [];
}

function normalizedProjectFilePath(projectPath: string, input: string): string | undefined {
	const normalizedRoot = projectPath.replaceAll("\\", "/").replace(/\/$/u, "");
	let normalized = input.replaceAll("\\", "/").replace(/^\.\//u, "");
	if (normalized === normalizedRoot) return undefined;
	if (normalized.startsWith(`${normalizedRoot}/`)) normalized = normalized.slice(normalizedRoot.length + 1);
	if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) return undefined;
	return normalized;
}

function parentProjectPath(path: string): string {
	const separator = path.lastIndexOf("/");
	return separator < 0 ? "" : path.slice(0, separator);
}

function sameGitStatus(left: GitStatus | undefined, right: GitStatus): boolean {
	return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function sameProjectTree(left: ProjectTreeResponse | undefined, right: ProjectTreeResponse): boolean {
	return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function hasLiveTurnContent(state: Pick<WorkbenchState, "liveTools" | "liveSteps" | "liveTurnItems">): boolean {
	return Boolean(Object.keys(state.liveTools).length || Object.keys(state.liveSteps).length || state.liveTurnItems.length);
}

function shouldClearLiveTurn(state: WorkbenchState): boolean {
	return state.liveTurnActive === false && hasLiveTurnContent(state);
}

function shouldRefreshCompletedTurn(state: WorkbenchState): boolean {
	return !state.transcriptPageLoaded || Boolean(state.liveTurnItems.length);
}

export function projectInspectorStateForSelection(
	currentProjectId: string | undefined,
	nextProjectId: string | undefined,
): Partial<
	Pick<
		WorkbenchState,
		| "fileTree"
		| "fileTreeRootPath"
		| "fileTreeCache"
		| "fileTreeLoading"
		| "gitStatus"
		| "gitBranches"
		| "gitHistory"
		| "gitCommit"
		| "gitFileStats"
		| "gitDiff"
		| "gitLoading"
		| "gitBranchesLoading"
		| "gitHistoryLoading"
		| "gitCommitLoading"
		| "gitDiffLoading"
		| "gitOperation"
		| "filePath"
		| "fileContent"
		| "fileError"
		| "fileLoading"
	>
> {
	if (!nextProjectId || currentProjectId === nextProjectId) return {};
	return {
		fileTree: undefined,
		fileTreeRootPath: undefined,
		fileTreeCache: {},
		fileTreeLoading: false,
		gitStatus: undefined,
		gitBranches: undefined,
		gitHistory: undefined,
		gitCommit: undefined,
		gitFileStats: {},
		gitDiff: undefined,
		gitLoading: false,
		gitBranchesLoading: false,
		gitHistoryLoading: false,
		gitCommitLoading: false,
		gitDiffLoading: false,
		gitOperation: undefined,
		fileContent: undefined,
		fileError: undefined,
		fileLoading: false,
	};
}

function initialState(): WorkbenchState {
	return {
		loading: false,
		networkOnline: browserNetworkOnline(),
		connected: false,
		reconnecting: false,
		connectionError: "",
		authRequired: !webApi.hasToken(),
		projects: [],
		projectGroups: [],
		sessionError: undefined,
		transcript: [],
		transcriptPageLoaded: false,
		transcriptLoading: false,
		transcriptError: undefined,
		transcriptGeneration: undefined,
		transcriptRevision: undefined,
		transcriptLeafId: undefined,
		hasMorePrevious: false,
		loadingEarlier: false,
		readOnly: false,
		sessionReady: false,
		pendingUserPrompts: [],
		promptSendTimes: {},
		queuedUserPrompts: [],
		operations: [],
		liveTools: {},
		liveSteps: {},
		liveTurnItems: [],
		liveCompaction: undefined,
		liveTurnId: 0,
		unreadSessionIds: {},
		gitFileStats: {},
		statusText: "",
		pendingUiRequests: [],
		inspectorOpen: typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches,
		inspectorMode: "files",
		gitLoading: false,
		gitBranchesLoading: false,
		gitHistoryLoading: false,
		gitCommitLoading: false,
		gitDiffLoading: false,
		gitCredentialAuthorizationMessage: undefined,
		fileTreeLoading: false,
		fileTreeRootPath: undefined,
		fileTreeCache: {},
		fileError: undefined,
		fileLoading: false,
		sessionTree: [],
		sessionTreeLoading: false,
		directoryLoading: false,
		settingsOpen: false,
		settingsTab: "appearance",
		branding: { name: "LYStar Code" },
		brandingSaving: false,
		brandingError: undefined,
		securitySettings: undefined,
		securitySettingsLoading: false,
		securitySettingsSaving: false,
		securitySettingsError: undefined,
		skills: [],
		skillDiagnostics: undefined,
		skillsLoading: false,
		hostInstructions: [],
		hostInstructionsLoading: false,
		hostInstructionSaving: false,
		harnessImportsLoading: false,
		harnessImporting: false,
		subagentConfigs: [],
		subagentConfigsLoading: false,
		subagentConfigsSaving: false,
		subagents: [],
		subagentsLoading: false,
		subagentViews: {},
		modelOptions: [],
		modelOptionProviders: [],
		modelCatalogRevision: 0,
		models: [],
		providers: [],
		hiddenModelProviders: savedHiddenModelProviders(),
		modelSettingsLoading: false,
		theme: savedTheme(),
		composerMode: "prompt",
	};
}

export function useWorkbench() {
	const [state, setState] = useState<WorkbenchState>(() => initialState());
	const stateRef = useRef(state);
	stateRef.current = state;
	const mountedRef = useRef(true);
	const socketRef = useRef<WebSocket | undefined>(undefined);
	const streamGenerationRef = useRef(0);
	const reconnectTimerRef = useRef<number | undefined>(undefined);
	const reconnectAttemptRef = useRef(0);
	const bootstrapLoadedRef = useRef(false);
	const transcriptTimerRef = useRef<number | undefined>(undefined);
	const transcriptRefreshPendingRef = useRef<string | undefined>(undefined);
	const liveToolBatchRef = useRef(0);
	const liveTurnItemRef = useRef(0);
	const pendingTextProgressRef = useRef<PendingTextProgress[]>([]);
	const pendingTextFrameRef = useRef<number | undefined>(undefined);
	const pendingTextTimeoutRef = useRef<number | undefined>(undefined);
	const transcriptRequestRef = useRef(0);
	const subagentRequestRef = useRef(0);
	const subagentTranscriptRequestRef = useRef(new Map<string, number>());
	const subagentTranscriptTimerRef = useRef(new Map<string, number>());
	const fileRequestRef = useRef(0);
	const directoryRequestRef = useRef(0);
	const fileMetadataPromisesRef = useRef(new Map<string, Promise<void>>());
	const projectTreeRefreshPromisesRef = useRef(new Map<string, Promise<void>>());
	const modelOptionsPromiseRef = useRef<Promise<void>>();
	const modelSettingsPromiseRef = useRef<Promise<void>>();
	const gitDiffRequestRef = useRef(0);
	const gitStatusRequestRef = useRef(0);
	const gitBranchesRequestRef = useRef(0);
	const gitHistoryRequestRef = useRef(0);
	const gitCommitRequestRef = useRef(0);
	const gitStatusPromiseRef = useRef<Promise<void>>();
	const gitStatsRepositoryRef = useRef(new Set<string>());
	const projectTreeGenerationRef = useRef(0);
	const sessionTreeRequestRef = useRef(0);
	const pendingUserPromptRef = useRef(0);
	const projectRefreshRef = useRef(new Map<string, { promise: Promise<void>; rerun: boolean }>());
	const toastTimerRef = useRef<number | undefined>(undefined);
	const handledNotifyIdsRef = useRef(new Set<string>());
	const selectionRef = useRef(0);
	const selectionInFlightRef = useRef<string | undefined>(undefined);
	const sessionDetailCacheRef = useRef(new Map<string, CachedSessionDetail>());
	const sessionDetailSeqRef = useRef(new Map<string, number>());
	const sessionSubscriptionWaitersRef = useRef(new Map<string, Set<SessionSubscriptionWaiter>>());
	const initializePromiseRef = useRef<Promise<void> | undefined>(undefined);
	const initializeRef = useRef<() => Promise<void>>(async () => {});
	const resumeConnectionRef = useRef<() => void>(() => {});
	const runtimeRecoverySessionRef = useRef<string | undefined>(undefined);
	const selectSessionRef = useRef<(sessionId: string) => Promise<void>>(async () => {});
	const loadSessionTreeRef = useRef<() => Promise<void>>(async () => {});
	const loadProjectTrustRef = useRef<() => Promise<void>>(async () => {});
	const loadProjectTreeRef = useRef<(path?: string) => Promise<void>>(async () => {});
	const loadGitStatusRef = useRef<(silent?: boolean) => Promise<void>>(async () => {});
	const loadGitBranchesRef = useRef<(repositoryPath?: string) => Promise<void>>(async () => {});
	const loadGitHistoryRef = useRef<(repositoryPath?: string) => Promise<void>>(async () => {});
	const refreshProjectFilesRef = useRef<(paths: readonly string[]) => Promise<void>>(async () => {});
	const refreshModelOptionsRef = useRef<() => Promise<void>>(async () => {});
	const refreshModelSettingsRef = useRef<() => Promise<void>>(async () => {});

	const updateState = useCallback((update: WorkbenchState | ((current: WorkbenchState) => WorkbenchState)) => {
		const next = typeof update === "function" ? update(stateRef.current) : update;
		stateRef.current = next;
		setState(next);
		return next;
	}, []);
	const transitionState = useCallback(
		(update: WorkbenchState | ((current: WorkbenchState) => WorkbenchState)) => {
			startTransition(() => {
				updateState(update);
			});
		},
		[updateState],
	);

	const currentProject = useMemo(
		() => state.projects.find((project) => project.id === state.currentProjectId),
		[state.currentProjectId, state.projects],
	);
	const currentSessions = useMemo(() => currentProject?.sessions ?? [], [currentProject]);
	const currentSessionSummary = useMemo(
		() => currentSessions.find((session) => session.id === state.sessionId),
		[currentSessions, state.sessionId],
	);
	const hasActiveOperation = useMemo(
		() => Boolean(state.currentOperation && ACTIVE_OPERATION_STATUSES.has(state.currentOperation.status)),
		[state.currentOperation],
	);
	const orderedProjects = useMemo(
		() =>
			state.projects
				.filter((project) => !project.archived)
				.slice()
				.sort((left, right) => Number(right.pinned) - Number(left.pinned)),
		[state.projects],
	);

	const showToast = useCallback(
		(message: string) => {
			updateState((current) => ({ ...current, toast: message }));
			if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
			toastTimerRef.current = window.setTimeout(
				() => updateState((current) => ({ ...current, toast: undefined })),
				4200,
			);
		},
		[updateState],
	);

	const applyBootstrap = useCallback(
		(data: {
			projects: WebProject[];
			projectGroups: ProjectGroup[];
			capabilities: readonly string[];
			connection: { connected: boolean; host: string; productVersion?: string };
			pendingUiRequests: UiRequestEvent[];
			operations: WebOperation[];
			leases?: Array<{ sessionId: string; lease: WebLease }>;
		}) => {
			bootstrapLoadedRef.current = true;
			const next = updateState((current) => {
				const nextLease = bootstrapLeaseForSession(current.sessionId, current.lease, data.leases ?? []);
				const operations = mergeOperationSnapshots(current.operations, data.operations);
				const projects = mergeProjectSessions(current.projects, data.projects);
				const connection = connectionStateAfterHostUpdate(
					current,
					data.connection.connected,
					Boolean(current.sessionId),
					browserNetworkOnline(),
				);
				return {
					...current,
					projects: current.session
						? updateSessionSummaryName(projects, current.sessionId!, current.session.name)
						: projects,
					projectGroups: data.projectGroups ?? [],
					operations,
					pendingUiRequests: data.pendingUiRequests,
					...connection,
					authRequired: false,
					lease: nextLease,
					readOnly: current.sessionId ? nextLease === undefined : current.readOnly,
					sessionReady: current.sessionId ? current.sessionReady && connection.connected : false,
					currentProjectId:
						current.currentProjectId && data.projects.some((project) => project.id === current.currentProjectId)
							? current.currentProjectId
							: undefined,
					currentOperation: operationForSessionSnapshot(operations, current.session),
				};
			});
			if (next.connected && !next.reconnecting) reconnectAttemptRef.current = 0;
		},
		[updateState],
	);

	const refreshBootstrap = useCallback(async () => {
		applyBootstrap(await webApi.bootstrap());
	}, [applyBootstrap]);

	const refreshProjectSessions = useCallback(
		async (projectId: string) => {
			const currentRefresh = projectRefreshRef.current.get(projectId);
			if (currentRefresh) {
				currentRefresh.rerun = true;
				await currentRefresh.promise;
				return;
			}
			const refreshState = { promise: Promise.resolve(), rerun: false };
			const run = async () => {
				do {
					refreshState.rerun = false;
					const result = await webApi.projectSessions(projectId);
					updateState((current) => {
						const projects = current.projects.map((project) =>
							project.id === projectId
								? { ...project, sessions: mergeSessionSummaries(project.sessions, result.sessions) }
								: project,
						);
						const sessionStillExists = result.sessions.some((session) => session.id === current.sessionId);
						return {
							...current,
							projects,
							...(projectId === current.currentProjectId && !sessionStillExists
								? {
										sessionId: undefined,
										session: undefined,
										lease: undefined,
										transcript: [],
										transcriptPageLoaded: false,
										transcriptLoading: false,
										transcriptError: undefined,
										sessionError: undefined,
										transcriptGeneration: undefined,
										transcriptRevision: undefined,
										transcriptLeafId: undefined,
										previousCursor: undefined,
										hasMorePrevious: false,
										liveTools: {},
										liveTurnItems: [],
										liveTurnActive: false,
										pendingUserPrompts: [],
										queuedUserPrompts: [],
										liveCompaction: undefined,
										currentOperation: undefined,
										statusText: "",
									}
								: {}),
						};
					});
				} while (refreshState.rerun);
			};
			refreshState.promise = run();
			projectRefreshRef.current.set(projectId, refreshState);
			try {
				await refreshState.promise;
			} finally {
				if (projectRefreshRef.current.get(projectId) === refreshState) projectRefreshRef.current.delete(projectId);
			}
		},
		[updateState],
	);

	const loadTranscript = useCallback(
		async (sessionId = stateRef.current.sessionId, cursor?: string, deferCommit = false) => {
			if (!sessionId) return;
			const requestedHistory = {
				generation: stateRef.current.transcriptGeneration,
				leafId: stateRef.current.transcriptLeafId,
			};
			const requestId = ++transcriptRequestRef.current;
			if (!cursor && (!stateRef.current.transcriptPageLoaded || stateRef.current.transcriptError)) {
				updateState((current) =>
					current.sessionId === sessionId
						? { ...current, transcriptLoading: true, transcriptError: undefined }
						: current,
				);
			}
			try {
				const result = await webApi.transcript(sessionId, { cursor, limit: TRANSCRIPT_PAGE_SIZE });
				if (requestId !== transcriptRequestRef.current || stateRef.current.sessionId !== sessionId) return;
				(deferCommit && !cursor ? transitionState : updateState)((current) => {
					const resultMatchesCurrentHistory =
						current.transcriptGeneration === undefined ||
						current.transcriptGeneration === result.transcriptGeneration;
					const currentHistoryChangedSinceRequest = isTranscriptResponseObsolete(
						requestedHistory,
						{
							generation: current.transcriptGeneration,
							leafId: current.transcriptLeafId,
						},
						result,
					);
					const sameHistory =
						resultMatchesCurrentHistory &&
						!(
							current.transcriptPageLoaded &&
							current.transcriptGeneration === undefined &&
							current.transcript.length > 0
						);
					const staleRevision =
						current.transcriptGeneration === result.transcriptGeneration &&
						current.transcriptRevision !== undefined &&
						current.transcriptRevision > result.transcriptRevision;
					if (currentHistoryChangedSinceRequest)
						return cursor ? current : { ...current, transcriptLoading: false };
					if (cursor && !sameHistory) return current;
					if (staleRevision && !cursor) {
						return cursor
							? current
							: {
									...current,
									transcriptLoading: false,
									...(shouldClearLiveTurn(current) ? { liveTools: {}, liveTurnItems: [] } : {}),
								};
					}
					if (
						!cursor &&
						sameHistory &&
						current.transcriptPageLoaded &&
						current.transcriptRevision === result.transcriptRevision &&
						!shouldClearLiveTurn(current)
					) {
						const pendingUserPrompts = reconcilePendingUserPrompts(current.pendingUserPrompts, current.transcript);
						const liveTurnItems = reconcileLiveUserPrompts(current.liveTurnItems, current.transcript);
						if (
							pendingUserPrompts.length === current.pendingUserPrompts.length &&
							liveTurnItems.length === current.liveTurnItems.length
						)
							return current.transcriptLoading ? { ...current, transcriptLoading: false } : current;
						return {
							...current,
							transcriptLoading: false,
							pendingUserPrompts,
							promptSendTimes: withPromptSendTimes(current, current.transcript),
							liveTurnItems,
						};
					}
					const renderIdOverrides =
						!cursor && sameHistory
							? transcriptRenderIdOverrides(
									current.liveTurnItems,
									current.liveCompaction ? `live-compaction:${current.liveTurnId}` : undefined,
									result.items,
								)
							: undefined;
					const transcriptWindow = mergeTranscriptPage(
						current,
						result,
						Boolean(cursor),
						sameHistory,
						renderIdOverrides,
					);
					const pendingUserPrompts = cursor
						? current.pendingUserPrompts
						: reconcilePendingUserPrompts(current.pendingUserPrompts, transcriptWindow.transcript);
					const promptSendTimes = cursor
						? current.promptSendTimes
						: withPromptSendTimes(current, transcriptWindow.transcript);
					const completedTurnSynced = !cursor && shouldClearLiveTurn(current);
					const knownIds = new Set(current.transcript.map((item) => item.entryId));
					const next =
						!cursor && sameHistory
							? reconcileCommittedTurn(
									current,
									result.items.filter((item) => !knownIds.has(item.entryId)),
									result.transcriptRevision,
								)
							: current;
					const updated = {
						...next,
						...transcriptWindow,
						transcriptLoading: false,
						transcriptError: undefined,
						pendingUserPrompts,
						promptSendTimes,
						liveTurnItems: cursor
							? next.liveTurnItems
							: reconcileLiveUserPrompts(next.liveTurnItems, transcriptWindow.transcript),
						transcriptGeneration: result.transcriptGeneration,
						transcriptRevision: sameHistory
							? Math.max(current.transcriptRevision ?? 0, result.transcriptRevision)
							: result.transcriptRevision,
						transcriptLeafId: cursor ? current.transcriptLeafId : result.leafId,
						...(completedTurnSynced ? { liveTools: {}, liveSteps: {}, liveTurnItems: [] } : {}),
					};
					return {
						...updated,
						liveCompaction: reconcileCompactionState(updated.liveCompaction, updated.transcript),
					};
				});
			} catch (error) {
				if (requestId === transcriptRequestRef.current && stateRef.current.sessionId === sessionId) {
					updateState((current) => ({
						...current,
						transcriptLoading: false,
						transcriptError: errorMessage(error),
					}));
				}
				throw error;
			}
		},
		[transitionState, updateState],
	);

	const loadSessionOperations = useCallback(
		async (sessionId: string) => {
			const result = await webApi.operations(sessionId);
			updateState((current) => {
				if (current.sessionId !== sessionId) return current;
				const operations = replaceSessionOperationSnapshots(current.operations, sessionId, result.operations);
				return {
					...current,
					operations,
					currentOperation: operationForSessionSnapshot(operations, current.session),
				};
			});
		},
		[updateState],
	);

	const loadSessionSnapshot = useCallback(
		async (sessionId: string) => {
			const snapshot = (await webApi.session(sessionId)).session;
			updateState((current) => {
				if (current.sessionId !== sessionId || isOlderSessionSnapshot(current.session, snapshot)) return current;
				const next: WorkbenchState = {
					...current,
					projects: updateSessionActivity(
						updateSessionSummaryName(current.projects, sessionId, snapshot.name),
						sessionId,
						snapshot.activity,
					),
					session: snapshot,
					readOnly: snapshot.writeAccess !== "owned",
					currentOperation: operationForSessionSnapshot(current.operations, snapshot),
				};
				return restoreRuntimeActivities(next, snapshot);
			});
		},
		[updateState],
	);

	const loadSubagents = useCallback(
		async (sessionId = stateRef.current.sessionId) => {
			if (!sessionId) return;
			const requestId = ++subagentRequestRef.current;
			updateState((current) =>
				current.sessionId === sessionId
					? { ...current, subagentsLoading: true, subagentsError: undefined }
					: current,
			);
			try {
				const result = await webApi.subagents(sessionId);
				if (requestId !== subagentRequestRef.current || stateRef.current.sessionId !== sessionId) return;
				updateState((current) => {
					const subagents = mergeSubagentSnapshots([], result.subagents);
					const subagentViews = { ...current.subagentViews };
					for (const snapshot of subagents) {
						const previous = subagentViews[snapshot.agentId];
						subagentViews[snapshot.agentId] = previous
							? {
									...previous,
									snapshot:
										snapshot.updatedAt >= previous.snapshot.updatedAt ? snapshot : previous.snapshot,
							  }
							: createSubagentConversationState(snapshot);
					}
					return { ...current, subagents, subagentsLoading: false, subagentsError: undefined, subagentViews };
				});
			} catch (error) {
				if (requestId !== subagentRequestRef.current || stateRef.current.sessionId !== sessionId) return;
				updateState((current) =>
					current.sessionId === sessionId
						? { ...current, subagentsLoading: false, subagentsError: errorMessage(error) }
						: current,
				);
				throw error;
			}
		},
		[updateState],
	);

	const loadSubagentTranscript = useCallback(
		async (agentId: string, sessionId = stateRef.current.sessionId, cursor?: string) => {
			if (!sessionId) return;
			const key = `${sessionId}:${agentId}`;
			const requestId = (subagentTranscriptRequestRef.current.get(key) ?? 0) + 1;
			subagentTranscriptRequestRef.current.set(key, requestId);
			const existing = stateRef.current.subagentViews[agentId];
			if (!existing) return;
			updateState((current) => {
				if (current.sessionId !== sessionId) return current;
				const view = current.subagentViews[agentId];
				if (!view) return current;
				return {
					...current,
					subagentViews: {
						...current.subagentViews,
						[agentId]: {
							...view,
							transcriptLoading: !cursor,
							loadingEarlier: Boolean(cursor),
							transcriptError: undefined,
						},
					},
				};
			});
			try {
				const result = await webApi.subagentTranscript(sessionId, agentId, {
					...(cursor ? { cursor } : {}),
					limit: TRANSCRIPT_PAGE_SIZE,
				});
				if (
					subagentTranscriptRequestRef.current.get(key) !== requestId ||
					stateRef.current.sessionId !== sessionId
				)
					return;
				updateState((current) => {
					if (current.sessionId !== sessionId) return current;
					const view = current.subagentViews[agentId];
					if (!view) return current;
					const sameHistory =
						view.transcriptGeneration === undefined || view.transcriptGeneration === result.transcriptGeneration;
					const transcriptWindow = mergeTranscriptPage(view, result, Boolean(cursor), sameHistory);
					const updated: SubagentConversationState = {
						...view,
						...transcriptWindow,
						transcriptLoading: false,
						loadingEarlier: false,
						transcriptError: undefined,
						transcriptGeneration: result.transcriptGeneration,
						transcriptRevision: sameHistory
							? Math.max(view.transcriptRevision ?? 0, result.transcriptRevision)
							: result.transcriptRevision,
						transcriptLeafId: cursor ? view.transcriptLeafId : result.leafId,
						...(sameHistory
							? {}
							: {
									liveTools: {},
									liveSteps: {},
									liveTurnItems: [],
									liveCompaction: undefined,
							  }),
					};
					return {
						...current,
						subagentViews: {
							...current.subagentViews,
							[agentId]: {
								...updated,
								liveCompaction: reconcileCompactionState(updated.liveCompaction, updated.transcript),
							},
						},
					};
				});
			} catch (error) {
				if (
					subagentTranscriptRequestRef.current.get(key) === requestId &&
					stateRef.current.sessionId === sessionId
				) {
					updateState((current) => {
						const view = current.subagentViews[agentId];
						return current.sessionId !== sessionId || !view
							? current
							: {
									...current,
									subagentViews: {
										...current.subagentViews,
										[agentId]: {
											...view,
											transcriptLoading: false,
											loadingEarlier: false,
											transcriptError: errorMessage(error),
										},
									},
							  };
					});
				}
				throw error;
			}
		},
		[updateState],
	);

	const loadEarlierSubagent = useCallback(
		async (agentId: string) => {
			const sessionId = stateRef.current.sessionId;
			const view = stateRef.current.subagentViews[agentId];
			if (!sessionId || !view || view.loadingEarlier || !view.hasMorePrevious || !view.previousCursor) return;
			await loadSubagentTranscript(agentId, sessionId, view.previousCursor);
		},
		[loadSubagentTranscript],
	);

	const scheduleSubagentTranscriptRefresh = useCallback(
		(agentId: string, sessionId = stateRef.current.sessionId) => {
			if (!sessionId) return;
			const key = `${sessionId}:${agentId}`;
			const previous = subagentTranscriptTimerRef.current.get(key);
			if (previous !== undefined) window.clearTimeout(previous);
			const timer = window.setTimeout(() => {
				subagentTranscriptTimerRef.current.delete(key);
				void loadSubagentTranscript(agentId, sessionId).catch(() => {});
			}, 140);
			subagentTranscriptTimerRef.current.set(key, timer);
		},
		[loadSubagentTranscript],
	);

	const loadSubagent = useCallback(
		async (agentId: string, sessionId = stateRef.current.sessionId) => {
			if (!sessionId) return;
			try {
				const details = await webApi.subagent(sessionId, agentId);
				const snapshot = details.live && details.transcript
					? {
							...details.transcript,
							...details.live,
							session: details.live.session ?? details.transcript.session,
					  }
					: details.live ?? details.transcript;
				if (!snapshot) throw new Error("未找到属于当前会话的 Subagent");
				if (stateRef.current.sessionId !== sessionId) return;
				updateState((current) => {
					const previous = current.subagentViews[agentId];
					const view = previous ?? createSubagentConversationState(snapshot);
					return {
						...current,
						subagents: mergeSubagentSnapshots(current.subagents, [snapshot]),
						subagentViews: {
							...current.subagentViews,
							[agentId]: {
								...view,
								snapshot:
									snapshot.updatedAt >= view.snapshot.updatedAt ? snapshot : view.snapshot,
							},
						},
					};
				});
				if (snapshot.session) await loadSubagentTranscript(agentId, sessionId);
			} catch (error) {
				updateState((current) =>
					current.sessionId === sessionId
						? {
								...current,
								subagentsError: errorMessage(error),
							}
						: current,
				);
				throw error;
			}
		},
		[loadSubagentTranscript, updateState],
	);

	const scheduleTranscriptRefresh = useCallback(
		(sessionId = stateRef.current.sessionId) => {
			if (!sessionId) return;
			if (stateRef.current.loadingEarlier) {
				transcriptRefreshPendingRef.current = sessionId;
				return;
			}
			if (transcriptTimerRef.current) window.clearTimeout(transcriptTimerRef.current);
			transcriptTimerRef.current = window.setTimeout(() => {
				transcriptTimerRef.current = undefined;
				if (stateRef.current.loadingEarlier) {
					transcriptRefreshPendingRef.current = sessionId;
					return;
				}
				void loadTranscript(sessionId).catch((error) => showToast(errorMessage(error)));
			}, 140);
		},
		[loadTranscript, showToast],
	);

	const cancelScheduledTranscriptRefresh = useCallback((sessionId: string) => {
		if (stateRef.current.sessionId !== sessionId) return;
		if (transcriptTimerRef.current) {
			window.clearTimeout(transcriptTimerRef.current);
			transcriptTimerRef.current = undefined;
		}
		if (transcriptRefreshPendingRef.current === sessionId) transcriptRefreshPendingRef.current = undefined;
	}, []);

	const applyProgressNow = useCallback(
		(progress: SessionProgress) => {
			const gitAuthorizationMessage = gitCredentialAuthorizationMessageFromProgress(progress);
			updateState((current) => {
				if (gitAuthorizationMessage) current = { ...current, gitCredentialAuthorizationMessage: gitAuthorizationMessage };
				const activity = sessionActivityFromProgress(progress);
				if (current.session && activity && current.session.activity !== activity) {
					current = { ...current, session: { ...current.session, activity } };
				}
				switch (progress.type) {
					case "assistant_delta":
						return {
							...current,
							liveTurnActive: true,
							liveTurnItems: appendLiveTextBlock(
								current.liveTurnItems,
								"text",
								progress.text,
								`live-turn:${liveTurnItemRef.current++}`,
								current.liveTurnId,
								progress.stepId,
							),
							statusText: "正在生成回复",
						};
					case "thinking_delta":
						return {
							...current,
							liveTurnActive: true,
							liveTurnItems: appendLiveTextBlock(
								current.liveTurnItems,
								"thinking",
								progress.text,
								`live-thinking:${liveTurnItemRef.current++}`,
								current.liveTurnId,
								progress.stepId,
							),
							statusText: "正在思考",
						};
					case "user_message":
						return {
							...current,
							queuedUserPrompts: progress.queueId
								? removeQueuedUserPrompt(current.queuedUserPrompts, progress.queueId)
								: removeQueuedUserPromptByText(current.queuedUserPrompts, progress.text),
							liveTurnItems: markLiveUserPromptProcessing(
								current.liveTurnItems,
								progress.queueId,
								progress.text,
							),
							statusText: "正在处理",
						};
					case "agent_step":
						return {
							...current,
							liveTurnActive: true,
							liveSteps: { ...current.liveSteps, [progress.step.id]: progress.step },
							statusText: progress.step.status === "running" ? progress.step.title : current.statusText,
						};
					case "tool_state":
						return applyToolActivityState(current, progress.activity);
					case "tool_start": {
						const previous = current.liveTools[progress.toolCallId];
						const summary =
							progress.name === "web_search"
								? mergeWebSearchSummary(previous?.summary, progress.summary)
								: progress.summary ?? previous?.summary ?? "正在执行";
						const batchId =
							previous?.batchId ??
							nextLiveToolBatchId(
								current,
								progress.name,
								summary,
								progress.stepId,
								current.liveTurnId,
								`live-tool-batch:${liveToolBatchRef.current++}`,
							);
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[progress.toolCallId]: {
									id: progress.toolCallId,
									name: progress.name,
									batchId,
									summary,
									state: "running",
									status: "running",
									stepId: progress.stepId ?? previous?.stepId,
									diff: mergeToolDiff(previous?.diff, progress.diff),
								},
							},
							liveTurnItems: previous
								? current.liveTurnItems
								: appendLiveToolBlock(
										current.liveTurnItems,
										batchId,
										progress.toolCallId,
										`live-tools:${liveTurnItemRef.current++}`,
										current.liveTurnId,
									),
							statusText: `正在执行 ${progress.name}`,
						};
					}
					case "tool_update": {
						const previous = current.liveTools[progress.toolCallId];
						if (previous && previous.status !== "running") return current;
						const summary =
							progress.name === "web_search"
								? mergeWebSearchSummary(previous?.summary, progress.summary)
								: progress.summary || previous?.summary || "正在执行";
						const batchId =
							previous?.batchId ??
							nextLiveToolBatchId(
								current,
								progress.name,
								summary,
								progress.stepId,
								current.liveTurnId,
								`live-tool-batch:${liveToolBatchRef.current++}`,
							);
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[progress.toolCallId]: {
									id: progress.toolCallId,
									name: progress.name,
									batchId,
									summary,
									state: "running",
									result: progress.summary,
									status: "running",
									stepId: progress.stepId ?? previous?.stepId,
									diff: mergeToolDiff(previous?.diff, progress.diff),
								},
							},
							liveTurnItems: previous
								? current.liveTurnItems
								: appendLiveToolBlock(
										current.liveTurnItems,
										batchId,
										progress.toolCallId,
										`live-tools:${liveTurnItemRef.current++}`,
										current.liveTurnId,
									),
						};
					}
					case "tool_end": {
						const previous = current.liveTools[progress.toolCallId];
						const summary =
							progress.name === "web_search"
								? mergeWebSearchSummary(previous?.summary, progress.summary)
								: previous?.summary ?? progress.summary;
						const batchId =
							previous?.batchId ??
							nextLiveToolBatchId(
								current,
								progress.name,
								summary,
								progress.stepId,
								current.liveTurnId,
								`live-tool-batch:${liveToolBatchRef.current++}`,
							);
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[progress.toolCallId]: {
									id: progress.toolCallId,
									name: progress.name,
									batchId,
									summary,
									state: progress.status === "success" ? "success" : "error",
									result: progress.summary,
									status: progress.status,
									stepId: progress.stepId ?? previous?.stepId,
									diff: mergeToolDiff(previous?.diff, progress.diff),
								},
							},
							liveTurnItems: previous
								? current.liveTurnItems
								: appendLiveToolBlock(
										current.liveTurnItems,
										batchId,
										progress.toolCallId,
										`live-tools:${liveTurnItemRef.current++}`,
										current.liveTurnId,
									),
							statusText: progress.status === "error" ? `${progress.name} 执行失败` : `${progress.name} 已完成`,
						};
					}
					case "queue_update": {
						const queuedUserPrompts = reconcileQueuedUserPromptCounts(
							current.queuedUserPrompts,
							progress.steeringCount,
							progress.followUpCount,
						);
						const queuedPromptIds = new Set(queuedUserPrompts.map((prompt) => prompt.id));
						return {
							...current,
							queuedUserPrompts,
							liveTurnItems: current.liveTurnItems.map((item) =>
								item.kind === "user" && item.status === "queued" && !queuedPromptIds.has(item.queueId)
									? { ...item, status: "processing" as const }
									: item,
							),
							statusText:
								progress.steeringCount + progress.followUpCount > 0
									? `队列中 ${progress.steeringCount + progress.followUpCount} 项`
									: "正在处理",
						};
					}
					case "phase": {
						const liveCompaction =
							progress.phase === "compaction"
								? restoreCompactionState(current.liveCompaction, progress.phase, current.transcript)
								: progress.phase === "idle" && current.liveCompaction?.status === "running"
									? { ...current.liveCompaction, status: "completed" as const, retry: undefined }
									: current.liveCompaction;
						return {
							...current,
							liveCompaction,
							liveTurnId: progress.phase === "turn" ? current.liveTurnId + 1 : current.liveTurnId,
							...(progress.phase === "turn"
								? {
										liveTurnStartRevision: current.transcriptRevision,
										liveTurnActive: true,
										liveTurnItems: current.liveTurnItems.filter((item) => item.kind === "user"),
										liveSteps: {},
									}
								: progress.phase === "idle" || progress.phase === "interrupted"
									? { liveTurnActive: false }
									: {}),
							statusText:
								progress.phase === "idle"
									? ""
									: progress.phase === "waiting_for_input"
										? "等待输入"
										: progress.phase === "compaction"
											? "正在整理上下文"
											: "正在处理",
						};
					}
					case "compaction": {
						const liveCompaction = updateCompactionState(current.liveCompaction, progress, current.transcript);
						return {
							...current,
							liveCompaction,
							statusText:
								progress.status === "running"
									? "正在整理上下文"
									: progress.status === "completed"
										? "上下文已整理"
										: progress.status === "failed"
											? "上下文整理失败"
											: progress.status === "waiting_retry"
												? "等待重试摘要"
												: "上下文整理已停止",
						};
					}
					case "retry": {
						const liveCompaction = updateCompactionState(current.liveCompaction, progress, current.transcript);
						return {
							...current,
							liveCompaction,
							statusText:
								progress.status === "running"
									? "正在重试"
									: progress.status === "failed"
										? "重试失败"
										: progress.status === "completed"
											? "重试完成"
											: "等待重试",
						};
					}
					case "bash":
						return { ...current, statusText: "正在运行命令" };
					case "status":
						return { ...current, statusText: progress.status };
					case "usage":
						return current;
				}
			});
		},
		[updateState],
	);

	const flushPendingTextProgress = useCallback(() => {
		if (pendingTextFrameRef.current !== undefined) {
			window.cancelAnimationFrame(pendingTextFrameRef.current);
			pendingTextFrameRef.current = undefined;
		}
		if (pendingTextTimeoutRef.current !== undefined) {
			window.clearTimeout(pendingTextTimeoutRef.current);
			pendingTextTimeoutRef.current = undefined;
		}
		const pending = pendingTextProgressRef.current;
		pendingTextProgressRef.current = [];
		const selection = selectionRef.current;
		const sessionId = stateRef.current.sessionId;
		let batch: LiveTextProgress | undefined;
		for (const entry of pending) {
			if (entry.selection !== selection || entry.sessionId !== sessionId) continue;
			const progress = entry.progress;
			if (batch && batch.type === progress.type && batch.stepId === progress.stepId) {
				batch = { ...batch, text: batch.text + progress.text };
				continue;
			}
			if (batch) applyProgressNow(batch);
			batch = progress;
		}
		if (batch) applyProgressNow(batch);
	}, [applyProgressNow]);

	const applyProgress = useCallback(
		(progress: SessionProgress, sessionId: string) => {
			if (progress.type === "assistant_delta" || progress.type === "thinking_delta") {
				const selection = selectionRef.current;
				const pending = pendingTextProgressRef.current;
				const previous = pending.at(-1);
				if (
					previous?.selection === selection &&
					previous.sessionId === sessionId &&
					previous.progress.type === progress.type &&
					previous.progress.stepId === progress.stepId
				) {
					pending[pending.length - 1] = {
						selection,
						sessionId,
						progress: { ...progress, text: previous.progress.text + progress.text },
					};
				} else {
					pending.push({ selection, sessionId, progress });
				}
				if (pendingTextFrameRef.current === undefined && pendingTextTimeoutRef.current === undefined) {
					if (document.visibilityState === "hidden") {
						pendingTextTimeoutRef.current = window.setTimeout(flushPendingTextProgress, 32);
					} else {
						pendingTextFrameRef.current = window.requestAnimationFrame(flushPendingTextProgress);
					}
				}
				return;
			}
			flushPendingTextProgress();
			applyProgressNow(progress);
		},
		[applyProgressNow, flushPendingTextProgress],
	);

	const settleSessionSubscriptionWaiters = useCallback((result: SessionSubscriptionResult): void => {
		for (const waiters of [...sessionSubscriptionWaitersRef.current.values()]) {
			for (const waiter of [...waiters]) waiter.resolve(result);
		}
		sessionSubscriptionWaitersRef.current.clear();
	}, []);

	const subscribeSessionAndWait = useCallback((sessionId: string): Promise<SessionSubscriptionResult> => {
		const socket = socketRef.current;
		if (!socket || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING))
			return Promise.resolve("timeout");
		return new Promise((resolve) => {
			const waiters = sessionSubscriptionWaitersRef.current.get(sessionId) ?? new Set<SessionSubscriptionWaiter>();
			const shouldSubscribe = waiters.size === 0;
			let waiter: SessionSubscriptionWaiter;
			waiter = {
				timeoutId: 0,
				resolve: (result) => {
					window.clearTimeout(waiter.timeoutId);
					waiters.delete(waiter);
					if (!waiters.size) sessionSubscriptionWaitersRef.current.delete(sessionId);
					resolve(result);
				},
			};
			waiter.timeoutId = window.setTimeout(() => waiter.resolve("timeout"), 1500);
			waiters.add(waiter);
			sessionSubscriptionWaitersRef.current.set(sessionId, waiters);
			if (shouldSubscribe) webApi.subscribeSession(socket, sessionId, sessionDetailSeqRef.current.get(sessionId));
		});
	}, []);

	const completeSessionSubscription = useCallback(
		async (sessionId: string, result: SessionSubscriptionResult): Promise<boolean> => {
			if (result === "closed") return false;
			if (result === "timeout") {
				const socket = socketRef.current;
				if (
					stateRef.current.sessionId === sessionId &&
					!stateRef.current.sessionReady &&
					socket?.readyState === WebSocket.OPEN
				)
					socket.close(4002, "会话订阅确认超时");
				return false;
			}
			if (result === "gap") {
				await Promise.all([
					loadSessionSnapshot(sessionId),
					loadSessionOperations(sessionId),
					loadTranscript(sessionId),
				]);
			}
			if (stateRef.current.sessionId === sessionId) {
				const next = updateState((current) => ({
					...current,
					...connectionStateAfterSessionSubscription(current, browserNetworkOnline()),
				}));
				if (next.connected && !next.reconnecting) reconnectAttemptRef.current = 0;
			}
			return true;
		},
		[loadSessionOperations, loadSessionSnapshot, loadTranscript, updateState],
	);

	const restoreSelectedSessionSubscription = useCallback(
		(sessionId: string): void => {
			if (sessionSubscriptionWaitersRef.current.has(sessionId)) return;
			void subscribeSessionAndWait(sessionId)
				.then(async (result) => {
					const ready = await completeSessionSubscription(sessionId, result);
					if (ready && result !== "gap" && stateRef.current.sessionId === sessionId) {
						void Promise.all([
							loadSessionSnapshot(sessionId),
							loadSessionOperations(sessionId),
							loadTranscript(sessionId),
							loadSubagents(sessionId),
						]).catch((error) => showToast(errorMessage(error)));
					}
				})
				.catch((error) => {
					showToast(errorMessage(error));
					socketRef.current?.close(4002, "会话状态恢复失败");
				});
		},
		[
			completeSessionSubscription,
			loadSessionOperations,
			loadSessionSnapshot,
			loadSubagents,
			loadTranscript,
			showToast,
			subscribeSessionAndWait,
		],
	);

	const handleEvent = useCallback(
		(event: GatewayEvent) => {
			if (event.type === "session_subscription") {
				const selected = stateRef.current.sessionId === event.sessionId;
				if (selected) sessionDetailSeqRef.current.set(event.sessionId, event.seq);
				const waiters = sessionSubscriptionWaitersRef.current.get(event.sessionId);
				if (waiters) {
					for (const waiter of [...waiters]) waiter.resolve(event.gap ? "gap" : "ready");
				}
				if (selected) {
					const next = updateState((current) =>
						event.gap
							? { ...current, sessionReady: false }
							: {
									...current,
									...connectionStateAfterSessionSubscription(current, browserNetworkOnline()),
								},
					);
					if (next.connected && !next.reconnecting) reconnectAttemptRef.current = 0;
				}
				if (event.gap && selected && selectionInFlightRef.current !== event.sessionId)
					void completeSessionSubscription(event.sessionId, "gap").catch((error) => {
						showToast(errorMessage(error));
						socketRef.current?.close(4002, "会话断档恢复失败");
					});
				return;
			}
			const sequenceSessionId =
				"sessionId" in event
					? event.sessionId
					: event.type === "operation_updated"
						? event.operation.sessionId
						: undefined;
			if (
				sequenceSessionId &&
				sequenceSessionId === stateRef.current.sessionId &&
				"seq" in event &&
				typeof event.seq === "number"
			) {
				const previousSeq = sessionDetailSeqRef.current.get(sequenceSessionId);
				if (previousSeq !== undefined && event.seq <= previousSeq) return;
				sessionDetailSeqRef.current.set(sequenceSessionId, event.seq);
			}
			if (event.type === "session_stream") {
				if (event.sessionId !== stateRef.current.sessionId) return;
				updateState((current) => {
					const retained = current.liveTurnItems.filter((item) => item.kind === "tools" || item.kind === "user");
					const tools = retained.filter((item) => item.kind === "tools");
					let items: LiveTurnItem[] = retained;
					if (event.thinking)
						items = appendLiveTextBlock(
							items,
							"thinking",
							event.thinking,
							`restored-thinking:${liveTurnItemRef.current++}`,
							current.liveTurnId,
							event.stepId,
						);
					if (event.text)
						items = appendLiveTextBlock(
							items,
							"text",
							event.text,
							`restored-text:${liveTurnItemRef.current++}`,
							current.liveTurnId,
							event.stepId,
						);
					return {
						...current,
						liveTurnItems: items,
						liveTurnActive: Boolean(event.text || event.thinking || tools.length),
					};
				});
				return;
			}
			if (event.type === "bootstrap") {
				applyBootstrap(event.data);
				return;
			}
			if (event.type === "connection_state") {
				const current = stateRef.current;
				const sessionId = current.sessionId;
				const shouldRestoreSubscription = event.connected && Boolean(sessionId) && !current.sessionReady;
				const next = updateState((value) => {
					const connection = connectionStateAfterHostUpdate(
						value,
						event.connected,
						Boolean(value.sessionId),
						browserNetworkOnline(),
						event.message,
					);
					return {
						...value,
						...connection,
						...(event.connected
							? {}
							: { lease: undefined, readOnly: Boolean(value.sessionId), sessionReady: false }),
					};
				});
				if (event.connected && !sessionId && next.connected) reconnectAttemptRef.current = 0;
				if (shouldRestoreSubscription && sessionId) restoreSelectedSessionSubscription(sessionId);
				return;
			}
			if (event.type === "session_lease") {
				updateState((current) =>
					current.sessionId === event.sessionId
						? { ...current, lease: event.lease, readOnly: false }
						: current,
				);
				return;
			}
			if (event.type === "model_catalog_changed") {
				if (event.revision === stateRef.current.modelCatalogRevision) return;
				void refreshModelOptionsRef.current().catch((error) => showToast(errorMessage(error)));
				if (stateRef.current.settingsOpen && stateRef.current.settingsTab === "models") {
					void refreshModelSettingsRef.current().catch((error) => showToast(errorMessage(error)));
				}
				return;
			}
			if (event.type === "project_files_changed") {
				if (event.projectId === stateRef.current.currentProjectId) {
					void refreshProjectFilesRef.current(event.paths).catch(() => {});
				}
				return;
			}
			if (event.type === "sessions_changed") {
				if (event.projectId) {
					void refreshProjectSessions(event.projectId).catch((error) => showToast(errorMessage(error)));
				} else {
					void refreshBootstrap().catch((error) => showToast(errorMessage(error)));
				}
				return;
			}
			if (event.type === "session_summary") {
				updateState((current) => {
					if (event.sessionId === current.sessionId) return current;
					const previous = current.projects
						.flatMap((project) => project.sessions)
						.find((session) => session.id === event.sessionId);
					const wasRunning =
						previous?.activity === "running" ||
						previous?.activity === "waiting_for_input" ||
						current.operations.some(
							(operation) =>
								operation.sessionId === event.sessionId && ACTIVE_OPERATION_STATUSES.has(operation.status),
						);
					const unreadSessionIds = { ...current.unreadSessionIds };
					const terminal = TERMINAL_OPERATION_STATUSES.has(event.activity);
					if ((terminal || (event.activity === "idle" && wasRunning)) && event.sessionId !== current.sessionId)
						unreadSessionIds[event.sessionId] = true;
					else if (event.activity !== "idle") delete unreadSessionIds[event.sessionId];
					const projects = Object.hasOwn(event, "name")
						? updateSessionSummaryName(current.projects, event.sessionId, event.name)
						: current.projects;
					return {
						...current,
						projects: updateSessionActivity(projects, event.sessionId, event.activity, event.operationUpdatedAt),
						unreadSessionIds,
					};
				});
				return;
			}
			if (event.type === "session_snapshot") {
				const current = stateRef.current;
				const selected = event.sessionId === current.sessionId;
				const snapshotActive = hasActiveSessionSnapshot(event.snapshot);
				const shouldSettleSelectedSession = selected && !snapshotActive && hasActiveSessionWork(current);
				if (
					selected &&
					(isOlderSessionSnapshot(current.session, event.snapshot) ||
						(isSameSessionSnapshot(current.session, event.snapshot) && !shouldSettleSelectedSession))
				)
					return;
				if (selected && !snapshotActive) flushPendingTextProgress();
				if (event.sessionId !== current.sessionId) {
					const summary = current.projects
						.flatMap((project) => project.sessions)
						.find((session) => session.id === event.sessionId);
					if (summary?.activity === event.snapshot.activity && summary.name === event.snapshot.name) return;
				}
				updateState((current) => {
					const projects = updateSessionActivity(
						updateSessionSummaryName(current.projects, event.sessionId, event.snapshot.name),
						event.sessionId,
						event.snapshot.activity,
					);
					if (event.sessionId !== current.sessionId) return { ...current, projects };
					const historyChanged =
						runtimeHistoryChanged(current.session, event.snapshot) ||
						(event.snapshot.transcriptRevision >= (current.transcriptRevision ?? 0) &&
							event.snapshot.leafId !== current.transcriptLeafId &&
							current.transcript.some((item) => item.entryId === event.snapshot.leafId) &&
							current.transcript.at(-1)?.entryId !== event.snapshot.leafId);
					const next: WorkbenchState = {
						...current,
						projects,
						session: event.snapshot,
						readOnly: event.snapshot.writeAccess !== "owned",
						currentOperation: operationForSessionSnapshot(current.operations, event.snapshot),
						transcriptGeneration: current.transcriptGeneration,
						transcriptRevision: current.transcriptRevision,
						transcriptLeafId: current.transcriptLeafId,
						...(historyChanged
							? {
									// 历史换代时保留当前窗口，等新 Transcript 返回后再整体替换，避免界面短暂空白。
									transcriptGeneration: undefined,
									transcriptRevision: undefined,
									transcriptLeafId: event.snapshot.leafId,
									previousCursor: undefined,
									hasMorePrevious: false,
									liveTools: {},
									liveSteps: {},
									liveTurnItems: [],
								}
							: {}),
					};
					return restoreRuntimeActivities(next, event.snapshot);
				});
				if (
					event.sessionId === stateRef.current.sessionId &&
					(event.snapshot.transcriptRevision > (stateRef.current.transcriptRevision ?? -1) ||
						!stateRef.current.transcriptPageLoaded)
				)
					scheduleTranscriptRefresh(event.sessionId);
				return;
			}
			if (event.type === "session_removed") {
				sessionDetailCacheRef.current.delete(event.sessionId);
				sessionDetailSeqRef.current.delete(event.sessionId);
				updateState((current) => {
					const unreadSessionIds = { ...current.unreadSessionIds };
					delete unreadSessionIds[event.sessionId];
					return event.sessionId === current.sessionId
						? {
								...current,
								unreadSessionIds,
								sessionId: undefined,
								session: undefined,
								lease: undefined,
								sessionReady: false,
								pendingUserPrompts: [],
								queuedUserPrompts: [],
								transcript: [],
								transcriptPageLoaded: false,
								transcriptLoading: false,
								transcriptError: undefined,
								sessionError: undefined,
								transcriptGeneration: undefined,
								transcriptRevision: undefined,
								transcriptLeafId: undefined,
								previousCursor: undefined,
								hasMorePrevious: false,
								liveTools: {},
								liveSteps: {},
								liveTurnItems: [],
								liveTurnActive: false,
								liveCompaction: undefined,
								subagents: [],
								subagentsLoading: false,
								subagentsError: undefined,
								selectedSubagentId: undefined,
								subagentViews: {},
								currentOperation: undefined,
								statusText: "",
							}
						: { ...current, unreadSessionIds };
				});
				void refreshBootstrap();
				return;
			}
			if (event.type === "transcript_changed" || event.type === "transcript_committed") {
				if (event.sessionId !== stateRef.current.sessionId) return;
				if (event.type === "transcript_changed") {
					scheduleTranscriptRefresh(event.sessionId);
					return;
				}
				const refreshNeeded = needsTranscriptRefreshForCommit(
					{
						pageLoaded: stateRef.current.transcriptPageLoaded,
						revision: stateRef.current.transcriptRevision,
						runtimeGeneration: stateRef.current.session?.transcriptGeneration,
					},
					event,
				);
				updateState((current) => {
					if (current.sessionId !== event.sessionId) return current;
					const sameHistory =
						current.session === undefined || current.session.transcriptGeneration === event.transcriptGeneration;
					if (!sameHistory) return current;
					const stale = event.toRevision < (current.transcriptRevision ?? 0);
					const renderIdOverrides = transcriptRenderIdOverrides(
						current.liveTurnItems,
						current.liveCompaction ? `live-compaction:${current.liveTurnId}` : undefined,
						event.items,
					);
					const next = !stale ? reconcileCommittedTurn(current, event.items, event.toRevision) : current;
					const transcript = stale
						? current.transcript
						: mergeTranscriptEntries(current.transcript, event.items, false, renderIdOverrides);
					const updated = {
						...next,
						transcript,
						transcriptPageLoaded: current.transcriptPageLoaded,
						previousCursor: current.previousCursor,
						hasMorePrevious: current.hasMorePrevious,
						pendingUserPrompts: reconcilePendingUserPrompts(current.pendingUserPrompts, transcript),
						promptSendTimes: withPromptSendTimes(current, transcript),
						liveTurnItems: reconcileLiveUserPrompts(next.liveTurnItems, transcript),
						transcriptGeneration: current.transcriptGeneration,
						transcriptRevision: stale ? current.transcriptRevision : event.toRevision,
					};
					return {
						...updated,
						liveCompaction: reconcileCompactionState(updated.liveCompaction, updated.transcript),
					};
				});
				if (refreshNeeded) scheduleTranscriptRefresh(event.sessionId);
				else cancelScheduledTranscriptRefresh(event.sessionId);
				return;
			}
			if (event.type === "subagent_updated") {
				if (event.sessionId !== stateRef.current.sessionId) return;
				const snapshot = event.snapshot;
				updateState((current) => {
					const previous = current.subagentViews[snapshot.agentId];
					const base = previous ?? createSubagentConversationState(snapshot);
					const snapshotIsNew =
						snapshot.runId !== base.snapshot.runId || snapshot.updatedAt >= base.snapshot.updatedAt;
					let view = snapshotIsNew ? { ...base, snapshot } : base;
					for (const progress of event.progress ?? []) {
						view = applySubagentProgress(
							view,
							progress,
							() => `subagent-item:${liveTurnItemRef.current++}`,
							() => `subagent-batch:${liveToolBatchRef.current++}`,
						);
					}
					if (snapshot.state !== "queued" && snapshot.state !== "running" && snapshot.state !== "waiting") {
						view = { ...view, liveTurnActive: false };
					}
					if (snapshot.currentAction) view = { ...view, statusText: snapshot.currentAction };
					return {
						...current,
						subagents: mergeSubagentSnapshots(current.subagents, [snapshot]),
						subagentViews: { ...current.subagentViews, [snapshot.agentId]: view },
					};
				});
				if (stateRef.current.selectedSubagentId === snapshot.agentId) {
					scheduleSubagentTranscriptRefresh(snapshot.agentId, event.sessionId);
				}
				return;
			}
			if (event.type === "session_progress") {
				const activity = sessionActivityFromProgress(event.progress);
				if (activity) {
					updateState((current) => {
						const previous = current.projects
							.flatMap((project) => project.sessions)
							.find((session) => session.id === event.sessionId);
						const wasRunning =
							previous?.activity === "running" ||
							previous?.activity === "waiting_for_input" ||
							current.operations.some(
								(operation) =>
									operation.sessionId === event.sessionId && ACTIVE_OPERATION_STATUSES.has(operation.status),
							);
						let unreadSessionIds = current.unreadSessionIds;
						if (
							activity === "idle" &&
							event.sessionId !== current.sessionId &&
							wasRunning &&
							!unreadSessionIds[event.sessionId]
						) {
							unreadSessionIds = { ...unreadSessionIds, [event.sessionId]: true };
						} else if (
							(activity !== "idle" || event.sessionId === current.sessionId) &&
							unreadSessionIds[event.sessionId]
						) {
							unreadSessionIds = { ...unreadSessionIds };
							delete unreadSessionIds[event.sessionId];
						}
						const projects = updateSessionActivity(current.projects, event.sessionId, activity);
						return projects === current.projects && unreadSessionIds === current.unreadSessionIds
							? current
							: { ...current, projects, unreadSessionIds };
					});
				}
				if (event.sessionId === stateRef.current.sessionId) {
					applyProgress(event.progress, event.sessionId);
					const changedPaths = changedFilePaths(event.progress);
					if (changedPaths.length > 0) void refreshProjectFilesRef.current(changedPaths).catch(() => {});
					if (
						event.progress.type === "phase" &&
						["idle", "interrupted"].includes(event.progress.phase) &&
						shouldRefreshCompletedTurn(stateRef.current)
					)
						scheduleTranscriptRefresh(event.sessionId);
				}
				return;
			}
			if (event.type === "operation_updated") {
				const operationSessionId = event.operation.sessionId;
				const operationIsActive = ACTIVE_OPERATION_STATUSES.has(event.operation.status);
				const operationIsTerminal = TERMINAL_OPERATION_STATUSES.has(event.operation.status);
				if (operationIsTerminal && operationSessionId === stateRef.current.sessionId) flushPendingTextProgress();
				updateState((current) => {
					const index = current.operations.findIndex(
						(operation) => operation.operationId === event.operation.operationId,
					);
					const operations =
						index === -1
							? [...current.operations, event.operation]
							: current.operations.map((operation, operationIndex) =>
									operationIndex === index ? event.operation : operation,
								);
					const selected = operationSessionId === current.sessionId;
					const terminalActivity =
						event.operation.status === "completed" ||
						event.operation.status === "failed" ||
						event.operation.status === "aborted" ||
						event.operation.status === "interrupted"
							? event.operation.status
							: undefined;
					const activity = operationSessionId
						? operationIsActive
							? event.operation.status === "waiting_for_input"
								? ("waiting_for_input" as const)
								: ("running" as const)
							: terminalActivity
						: undefined;
					const unreadSessionIds = { ...current.unreadSessionIds };
					if (operationSessionId) {
						if (operationIsActive || operationSessionId === current.sessionId)
							delete unreadSessionIds[operationSessionId];
						else if (operationIsTerminal) unreadSessionIds[operationSessionId] = true;
					}
					return {
						...current,
						projects:
							operationSessionId && activity
								? updateSessionActivity(
										current.projects,
										operationSessionId,
										activity,
										event.operation.updatedAt,
									)
								: current.projects,
						operations,
						unreadSessionIds,
						...(selected ? { currentOperation: event.operation } : {}),
						...(selected &&
						operationIsTerminal &&
						["prompt", "compact", "run_bash"].includes(event.operation.type)
							? { liveTurnActive: false }
							: {}),
						...(selected &&
						event.operation.status === "completed" &&
						["prompt", "compact", "run_bash"].includes(event.operation.type)
							? { statusText: "" }
							: {}),
						...(selected &&
						(event.operation.status === "failed" ||
							event.operation.status === "aborted" ||
							event.operation.status === "interrupted")
							? {
									statusText:
										event.operation.error ??
										(event.operation.status === "aborted" ? "任务已取消" : "任务已停止"),
								}
							: {}),
					};
				});
				if (operationSessionId === stateRef.current.sessionId || !operationSessionId) {
					if (operationIsTerminal && shouldRefreshCompletedTurn(stateRef.current))
						scheduleTranscriptRefresh(operationSessionId ?? stateRef.current.sessionId);
				}
				return;
			}
			if (event.type === "ui_request") {
				if (event.kind === "notify") {
					if (handledNotifyIdsRef.current.has(event.id)) return;
					handledNotifyIdsRef.current.add(event.id);
					if (handledNotifyIdsRef.current.size > MAX_HANDLED_NOTIFY_IDS) {
						const oldestId = handledNotifyIdsRef.current.values().next().value;
						if (oldestId !== undefined) handledNotifyIdsRef.current.delete(oldestId);
					}
					const payload = eventIsObject(event.payload) ? event.payload : undefined;
					const message =
						typeof payload?.message === "string"
							? payload.message.trim()
							: typeof payload?.text === "string"
								? payload.text.trim()
								: event.title.trim();
					if (message) showToast(message);
					return;
				}
				updateState((current) =>
					current.pendingUiRequests.some((request) => request.id === event.id)
						? current
						: { ...current, pendingUiRequests: [...current.pendingUiRequests, event] },
				);
			}
		},
		[
			applyBootstrap,
			applyProgress,
			cancelScheduledTranscriptRefresh,
			completeSessionSubscription,
			refreshBootstrap,
			flushPendingTextProgress,
			loadTranscript,
			refreshProjectSessions,
			scheduleSubagentTranscriptRefresh,
			restoreSelectedSessionSubscription,
			scheduleTranscriptRefresh,
			showToast,
			updateState,
		],
	);

	const scheduleReconnect = useCallback(() => {
		if (
			reconnectTimerRef.current ||
			!mountedRef.current ||
			!webApi.hasToken() ||
			!browserNetworkOnline()
		)
			return;
		const attempt = reconnectAttemptRef.current;
		reconnectAttemptRef.current += 1;
		reconnectTimerRef.current = window.setTimeout(() => {
			reconnectTimerRef.current = undefined;
			if (mountedRef.current) resumeConnectionRef.current();
		}, reconnectDelayMs(attempt));
	}, []);

	const connectStream = useCallback(() => {
		if (!browserNetworkOnline()) {
			settleSessionSubscriptionWaiters("closed");
			updateState((current) => ({
				...current,
				...offlineConnectionState(),
				lease: undefined,
				readOnly: Boolean(current.sessionId),
				sessionReady: false,
			}));
			return;
		}
		const generation = streamGenerationRef.current + 1;
		streamGenerationRef.current = generation;
		if (reconnectTimerRef.current) {
			window.clearTimeout(reconnectTimerRef.current);
			reconnectTimerRef.current = undefined;
		}
		settleSessionSubscriptionWaiters("closed");
		const previous = socketRef.current;
		socketRef.current = undefined;
		if (previous && previous.readyState !== WebSocket.CLOSED) previous.close();

		updateState((current) => ({
			...current,
			...reconnectingConnectionState(),
			...(current.sessionId ? { sessionReady: false } : {}),
		}));
		let socket: WebSocket;
		socket = webApi.connect(
			(event) => {
				if (streamGenerationRef.current !== generation || socketRef.current !== socket) return;
				handleEvent(event);
			},
			() => {
				if (streamGenerationRef.current !== generation || socketRef.current !== socket) return;
				socketRef.current = undefined;
				settleSessionSubscriptionWaiters("closed");
				if (!mountedRef.current) return;
				const networkOnline = browserNetworkOnline();
				updateState((current) => ({
					...current,
					...(networkOnline
						? reconnectingConnectionState("Web Host 连接已断开，正在重连")
						: offlineConnectionState()),
					lease: undefined,
					readOnly: Boolean(current.sessionId),
					sessionReady: false,
				}));
				if (networkOnline) scheduleReconnect();
			},
		);
		const subscribeSelectedState = () => {
			const { currentProjectId, sessionId } = stateRef.current;
			if (currentProjectId) webApi.subscribeProject(socket, currentProjectId);
			if (sessionId) restoreSelectedSessionSubscription(sessionId);
		};
		socket.addEventListener("open", subscribeSelectedState, { once: true });
		socketRef.current = socket;
		if (socket.readyState === WebSocket.OPEN) subscribeSelectedState();
	}, [
		handleEvent,
		restoreSelectedSessionSubscription,
		scheduleReconnect,
		settleSessionSubscriptionWaiters,
		updateState,
	]);

	const refreshModelOptions = useCallback((): Promise<void> => {
		const pending = modelOptionsPromiseRef.current;
		if (pending) return pending;
		const run = (async () => {
			const visibilityOverrides = savedModelProviderVisibilityOverrides();
			const result = await webApi.modelOptions(
				Object.entries(visibilityOverrides).flatMap(([provider, visible]) => (visible ? [provider] : [])),
			);
			updateState((current) => {
				const visibilityProviders = current.providers.length
					? current.providers
					: result.providers.map((provider) => ({ ...provider, authenticated: true }));
				return {
					...current,
					modelOptions: result.models,
					modelOptionProviders: result.providers,
					modelCatalogRevision: result.revision,
					hiddenModelProviders: resolveHiddenModelProviders(visibilityProviders, visibilityOverrides),
				};
			});
		})();
		const tracked = run.finally(() => {
			if (modelOptionsPromiseRef.current === tracked) modelOptionsPromiseRef.current = undefined;
		});
		modelOptionsPromiseRef.current = tracked;
		return tracked;
	}, [updateState]);

	const refreshModelSettings = useCallback((): Promise<void> => {
		const pending = modelSettingsPromiseRef.current;
		if (pending) return pending;
		updateState((current) => ({ ...current, modelSettingsLoading: true, modelSettingsError: undefined }));
		const run = (async () => {
			try {
				const result = await webApi.models();
				const visibilityOverrides = savedModelProviderVisibilityOverrides();
				updateState((current) => {
					const hiddenModelProviders = resolveHiddenModelProviders(result.providers, visibilityOverrides);
					return {
						...current,
						models: result.models,
						providers: result.providers,
						modelCatalogRevision: result.revision,
						hiddenModelProviders,
						modelSettingsLoading: false,
					};
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				updateState((current) => ({ ...current, modelSettingsLoading: false, modelSettingsError: message }));
				throw error;
			}
		})();
		const tracked = run.finally(() => {
			if (modelSettingsPromiseRef.current === tracked) modelSettingsPromiseRef.current = undefined;
		});
		modelSettingsPromiseRef.current = tracked;
		return tracked;
	}, [updateState]);

	const refreshBranding = useCallback(async () => {
		try {
			const branding = await webApi.branding();
			updateState((current) => ({ ...current, branding }));
		} catch {
			// 品牌读取失败时保留内置品牌，不阻断登录和工作台启动。
		}
	}, [updateState]);

	const refreshGitCredentialAuthorization = useCallback(async () => {
		try {
			const message = gitCredentialAuthorizationMessageFromSystemPermissions(await webApi.systemPermissions());
			if (message) updateState((current) => ({ ...current, gitCredentialAuthorizationMessage: message }));
		} catch {
			// 系统授权状态读取失败不阻断工作台启动；Git 操作仍会在执行前返回结构化错误。
		}
	}, [updateState]);

	const initialize = useCallback((): Promise<void> => {
		const existing = initializePromiseRef.current;
		if (existing) return existing;
		const promise = (async () => {
			void refreshBranding();
			if (!webApi.hasToken()) {
				updateState((current) => ({ ...current, authRequired: true, loading: false }));
				return;
			}
			const networkOnline = browserNetworkOnline();
			if (!networkOnline) {
				updateState((current) => ({ ...current, ...offlineConnectionState(), loading: false }));
				return;
			}
			updateState((current) => ({
				...current,
				...reconnectingConnectionState(),
				loading: !current.transcriptPageLoaded,
			}));
			try {
				const data = await webApi.bootstrap();
				applyBootstrap(data);
				connectStream();
				void refreshGitCredentialAuthorization();
				void refreshModelOptions().catch(() => undefined);
				const lastSession = readLastSession();
				const lastSessionProject = lastSession
					? data.projects.find(
							(project) =>
								!project.archived &&
								project.id === lastSession.projectId &&
								project.sessions.some((session) => session.id === lastSession.sessionId),
						)
					: undefined;
				const firstProject =
					data.projects.find((project) => project.id === stateRef.current.currentProjectId && !project.archived) ??
					lastSessionProject ??
					data.projects
						.filter((project) => !project.archived)
						.slice()
						.sort((left, right) => Number(right.pinned) - Number(left.pinned))[0];
				if (firstProject) {
					updateState((current) => ({ ...current, currentProjectId: firstProject.id }));
					const socket = socketRef.current;
					if (socket) webApi.subscribeProject(socket, firstProject.id);
					await loadProjectTreeRef.current();
					const sessions =
						stateRef.current.projects.find((project) => project.id === firstProject.id)?.sessions ??
						firstProject.sessions;
					const rememberedSession =
						firstProject.id === lastSessionProject?.id
							? sessions.find((session) => session.id === lastSession?.sessionId)
							: undefined;
					const firstSession =
						sessions.find((session) => session.id === stateRef.current.sessionId) ??
						rememberedSession ??
						sessions[0];
					if (firstSession) await selectSessionRef.current(firstSession.id);
				}
			} catch (error) {
				if (error instanceof UnauthorizedError) {
					bootstrapLoadedRef.current = false;
					reconnectAttemptRef.current = 0;
					webApi.clearToken();
					updateState((current) => ({
						...current,
						authRequired: true,
						connected: false,
						reconnecting: false,
					}));
				} else {
					const online = browserNetworkOnline();
					const message = errorMessage(error);
					updateState((current) => ({
						...current,
						...(online ? reconnectingConnectionState(message) : offlineConnectionState()),
						lease: undefined,
						readOnly: Boolean(current.sessionId),
						sessionReady: false,
					}));
					if (online) scheduleReconnect();
				}
			} finally {
				updateState((current) => ({ ...current, loading: false }));
			}
		})();
		const tracked = promise.finally(() => {
			if (initializePromiseRef.current === tracked) initializePromiseRef.current = undefined;
		});
		initializePromiseRef.current = tracked;
		return tracked;
	}, [
		applyBootstrap,
		connectStream,
		refreshBranding,
		refreshGitCredentialAuthorization,
		refreshModelOptions,
		scheduleReconnect,
		updateState,
	]);
	initializeRef.current = initialize;

	const resumeConnection = useCallback(() => {
		if (!mountedRef.current || !webApi.hasToken() || !browserNetworkOnline()) return;
		if (reconnectTimerRef.current) {
			window.clearTimeout(reconnectTimerRef.current);
			reconnectTimerRef.current = undefined;
		}
		const socket = socketRef.current;
		if (socket && socket.readyState !== WebSocket.CLOSED) return;
		if (bootstrapLoadedRef.current) {
			connectStream();
			return;
		}
		void initializeRef.current();
	}, [connectStream]);
	resumeConnectionRef.current = resumeConnection;

	const submitToken = useCallback(
		async (token: string) => {
			bootstrapLoadedRef.current = false;
			reconnectAttemptRef.current = 0;
			webApi.setToken(token);
			await initialize();
		},
		[initialize],
	);

	const signOut = useCallback(() => {
		streamGenerationRef.current += 1;
		bootstrapLoadedRef.current = false;
		reconnectAttemptRef.current = 0;
		settleSessionSubscriptionWaiters("closed");
		if (reconnectTimerRef.current) {
			window.clearTimeout(reconnectTimerRef.current);
			reconnectTimerRef.current = undefined;
		}
		socketRef.current?.close();
		socketRef.current = undefined;
		webApi.clearToken();
		sessionDetailCacheRef.current.clear();
		sessionDetailSeqRef.current.clear();
		updateState(() => ({
			...initialState(),
			authRequired: true,
			connected: false,
			projects: [],
		}));
	}, [settleSessionSubscriptionWaiters, updateState]);

	const selectSession = useCallback(
		async (sessionId: string) => {
			if (selectionInFlightRef.current === sessionId) return;
			const currentSelection = stateRef.current;
			if (
				currentSelection.sessionId === sessionId &&
				currentSelection.session &&
				currentSelection.lease &&
				!currentSelection.transcriptLoading &&
				!currentSelection.sessionError &&
				!currentSelection.transcriptError &&
				currentSelection.sessionReady
			)
				return;
			selectionInFlightRef.current = sessionId;
			const request = ++selectionRef.current;
			const previous = stateRef.current;
			const selectedProjectId = previous.projects.find((project) =>
				project.sessions.some((session) => session.id === sessionId),
			)?.id;
			const projectChanged = selectedProjectId !== undefined && selectedProjectId !== previous.currentProjectId;
			const sessionChanged = previous.sessionId !== sessionId;
			if (projectChanged) {
				fileRequestRef.current++;
				fileMetadataPromisesRef.current.clear();
				projectTreeRefreshPromisesRef.current.clear();
				gitStatusPromiseRef.current = undefined;
				gitStatusRequestRef.current++;
				gitBranchesRequestRef.current++;
				gitHistoryRequestRef.current++;
				gitCommitRequestRef.current++;
				gitDiffRequestRef.current++;
				gitStatsRepositoryRef.current.clear();
				projectTreeGenerationRef.current++;
			}
			if (sessionChanged) sessionTreeRequestRef.current++;
			if (previous.sessionId && previous.sessionId !== sessionId) {
				cacheSessionDetail(
					sessionDetailCacheRef.current,
					previous.sessionId,
					sessionDetailCacheFromState(previous),
				);
			}
			const cached = readCachedSessionDetail(sessionDetailCacheRef.current, sessionId);
			const socket = socketRef.current;
			if (socket && selectedProjectId) {
				if (previous.currentProjectId && previous.currentProjectId !== selectedProjectId) {
					webApi.unsubscribeProject(socket, previous.currentProjectId);
				}
				webApi.subscribeProject(socket, selectedProjectId);
			}
			if (transcriptTimerRef.current) {
				window.clearTimeout(transcriptTimerRef.current);
				transcriptTimerRef.current = undefined;
			}
			transcriptRefreshPendingRef.current = undefined;
			transcriptRequestRef.current++;
			(cached?.transcriptPageLoaded ? transitionState : updateState)((current) => ({
				...current,
				...projectInspectorStateForSelection(previous.currentProjectId, selectedProjectId),
				...(selectedProjectId ? { currentProjectId: selectedProjectId } : {}),
				sessionId,
				session: cached?.session,
				sessionError: undefined,
				lease: undefined,
				readOnly: true,
				sessionReady: false,
				transcriptLoading: !cached?.transcriptPageLoaded,
				transcriptError: undefined,
				...(cached
					? cached
					: current.sessionId !== sessionId
						? {
								transcript: [],
								transcriptPageLoaded: false,
								transcriptGeneration: undefined,
								transcriptRevision: undefined,
								transcriptLeafId: undefined,
								previousCursor: undefined,
								hasMorePrevious: false,
								loadingEarlier: false,
								liveTools: {},
								liveSteps: {},
								liveTurnItems: [],
								liveTurnActive: undefined,
											liveTurnStartRevision: undefined,
											subagents: [],
											subagentsLoading: false,
											subagentsError: undefined,
											selectedSubagentId: undefined,
											subagentViews: {},
										}
								: {}),
				pendingUserPrompts:
					current.sessionId === sessionId ? current.pendingUserPrompts : (cached?.pendingUserPrompts ?? []),
				queuedUserPrompts:
					current.sessionId === sessionId ? current.queuedUserPrompts : (cached?.queuedUserPrompts ?? []),
				unreadSessionIds: Object.fromEntries(
					Object.entries(current.unreadSessionIds).filter(([id]) => id !== sessionId),
				) as Record<string, true>,
				statusText: cached ? "正在同步会话" : "正在打开会话",
				currentOperation: operationForSessionSnapshot(current.operations, cached?.session),
				liveCompaction: cached?.liveCompaction,
				...(sessionChanged
					? {
							subagents: [],
							subagentsLoading: false,
							subagentsError: undefined,
							selectedSubagentId: undefined,
							subagentViews: {},
					  }
					: {}),
				sessionTree: sessionChanged ? [] : current.sessionTree,
				sessionTreeLoading: sessionChanged ? false : current.sessionTreeLoading,
			}));
			if (socket && previous.sessionId && previous.sessionId !== sessionId)
				webApi.unsubscribeSession(socket, previous.sessionId);
							const subscriptionPromise = socket
								? subscribeSessionAndWait(sessionId)
								: Promise.resolve<SessionSubscriptionResult>("timeout");
			if (
				previous.sessionId &&
				previous.sessionId !== sessionId &&
				!ACTIVE_OPERATION_STATUSES.has(previous.currentOperation?.status ?? "")
			) {
				void webApi.release(previous.sessionId).catch(() => {});
			}
			const transcriptPromise = loadTranscript(sessionId, undefined, true);
			const subagentsPromise = loadSubagents(sessionId);
			void transcriptPromise.catch(() => {});
			void subagentsPromise.catch(() => {});
			if (projectChanged && previous.inspectorOpen) {
				const projectReviewRefresh =
					previous.inspectorMode === "git"
						? loadGitStatusRef.current()
						: previous.inspectorMode === "files"
							? loadProjectTreeRef.current()
							: Promise.resolve();
				void projectReviewRefresh.catch((error) => showToast(errorMessage(error)));
			}
			try {
				const controlled = await webApi.control(sessionId);
				if (request !== selectionRef.current) {
					if (selectionInFlightRef.current === sessionId) selectionInFlightRef.current = undefined;
					return;
				}
				updateState((current) => {
					if (isOlderSessionSnapshot(current.session, controlled.snapshot))
						return { ...current, lease: controlled.lease, sessionError: undefined };
					const next: WorkbenchState = {
						...current,
						projects: updateSessionActivity(
							updateSessionSummaryName(current.projects, sessionId, controlled.snapshot.name),
							sessionId,
							controlled.snapshot.activity,
						),
						lease: controlled.lease,
						session: controlled.snapshot,
						transcriptGeneration: current.transcriptGeneration,
						transcriptRevision: current.transcriptRevision,
						transcriptLeafId: current.transcriptLeafId,
						sessionError: undefined,
						readOnly: controlled.owned === false,
						currentOperation: operationForSessionSnapshot(current.operations, controlled.snapshot),
					};
					return restoreRuntimeActivities(next, controlled.snapshot);
				});
			} catch (error) {
				try {
					const snapshot = (await webApi.session(sessionId)).session;
					if (request !== selectionRef.current) {
						if (selectionInFlightRef.current === sessionId) selectionInFlightRef.current = undefined;
						return;
					}
					updateState((current) => {
						const next: WorkbenchState = {
							...current,
							projects: updateSessionActivity(
								updateSessionSummaryName(current.projects, sessionId, snapshot.name),
								sessionId,
								snapshot.activity,
							),
							session: snapshot,
							transcriptGeneration: current.transcriptGeneration,
							transcriptRevision: current.transcriptRevision,
							transcriptLeafId: current.transcriptLeafId,
							sessionError: undefined,
							readOnly: true,
							currentOperation: operationForSessionSnapshot(current.operations, snapshot),
						};
						return restoreRuntimeActivities(next, snapshot);
					});
					showToast(errorMessage(error));
				} catch (snapshotError) {
					if (request !== selectionRef.current) {
						if (selectionInFlightRef.current === sessionId) selectionInFlightRef.current = undefined;
						return;
					}
					const message = errorMessage(snapshotError);
					updateState((current) => ({
						...current,
						session: undefined,
						lease: undefined,
						readOnly: true,
						transcriptLoading: false,
						sessionError: message,
						statusText: "",
					}));
					showToast(message);
					if (selectionInFlightRef.current === sessionId) selectionInFlightRef.current = undefined;
					return;
				}
			}
			if (request !== selectionRef.current) {
				if (selectionInFlightRef.current === sessionId) selectionInFlightRef.current = undefined;
				return;
			}
			try {
				await transcriptPromise;
			} catch (error) {
				showToast(errorMessage(error));
			}
			const subscriptionResult = await subscriptionPromise;
			if (request !== selectionRef.current) {
				if (selectionInFlightRef.current === sessionId) selectionInFlightRef.current = undefined;
				return;
			}
			let subscriptionReady = false;
			try {
				subscriptionReady = await completeSessionSubscription(sessionId, subscriptionResult);
				if (subscriptionResult !== "gap") await loadSessionOperations(sessionId);
			} catch (error) {
				showToast(errorMessage(error));
				socketRef.current?.close(4002, "会话状态对账失败");
			}
			const supplementalLoads = [loadProjectTrustRef.current()];
			if (stateRef.current.inspectorMode === "tree") supplementalLoads.push(loadSessionTreeRef.current());
			void Promise.allSettled(supplementalLoads);
			updateState((current) =>
				current.sessionId === sessionId
					? { ...current, statusText: "", sessionReady: current.sessionReady || subscriptionReady }
					: current,
			);
			if (selectionInFlightRef.current === sessionId) selectionInFlightRef.current = undefined;
		},
		[
			completeSessionSubscription,
			loadSessionOperations,
			loadSubagents,
			loadTranscript,
			showToast,
			subscribeSessionAndWait,
			transitionState,
			updateState,
		],
	);

	const selectProject = useCallback(
		async (projectId: string) => {
			const request = ++selectionRef.current;
			const previous = stateRef.current;
			const projectChanged = projectId !== previous.currentProjectId;
			const socket = socketRef.current;
			if (socket) {
				if (previous.currentProjectId && previous.currentProjectId !== projectId) {
					webApi.unsubscribeProject(socket, previous.currentProjectId);
				}
				webApi.subscribeProject(socket, projectId);
			}
			if (projectChanged) {
				fileRequestRef.current++;
				fileMetadataPromisesRef.current.clear();
				projectTreeRefreshPromisesRef.current.clear();
				gitStatusPromiseRef.current = undefined;
				gitStatusRequestRef.current++;
				gitBranchesRequestRef.current++;
				gitHistoryRequestRef.current++;
				gitCommitRequestRef.current++;
				gitDiffRequestRef.current++;
				gitStatsRepositoryRef.current.clear();
				projectTreeGenerationRef.current++;
				sessionTreeRequestRef.current++;
			}
			if (previous.sessionId) {
				cacheSessionDetail(
					sessionDetailCacheRef.current,
					previous.sessionId,
					sessionDetailCacheFromState(previous),
				);
				if (socketRef.current) webApi.unsubscribeSession(socketRef.current, previous.sessionId);
			}
			if (previous.sessionId && !ACTIVE_OPERATION_STATUSES.has(previous.currentOperation?.status ?? "")) {
				void webApi.release(previous.sessionId).catch(() => {});
			}
			updateState((current) => ({
				...current,
				...projectInspectorStateForSelection(previous.currentProjectId, projectId),
				currentProjectId: projectId,
				fileTree: undefined,
				fileTreeRootPath: undefined,
				fileTreeCache: {},
				sessionId: undefined,
				session: undefined,
				sessionError: undefined,
				lease: undefined,
				readOnly: false,
				sessionReady: false,
				pendingUserPrompts: [],
				queuedUserPrompts: [],
				transcript: [],
				transcriptPageLoaded: false,
				transcriptLoading: false,
				transcriptError: undefined,
				transcriptGeneration: undefined,
				transcriptRevision: undefined,
				transcriptLeafId: undefined,
				previousCursor: undefined,
				hasMorePrevious: false,
				currentOperation: undefined,
				liveTurnActive: false,
				liveTurnStartRevision: undefined,
				liveTools: {},
				liveSteps: {},
							liveTurnItems: [],
							liveCompaction: undefined,
							subagents: [],
							subagentsLoading: false,
							subagentsError: undefined,
							selectedSubagentId: undefined,
							subagentViews: {},
							sessionTree: [],
				sessionTreeLoading: false,
			}));
			try {
				await refreshProjectSessions(projectId);
			} catch (error) {
				showToast(errorMessage(error));
			}
			if (request !== selectionRef.current) return;
			await loadProjectTreeRef.current();
			if (stateRef.current.inspectorOpen && stateRef.current.inspectorMode === "git")
				await loadGitStatusRef.current();
		},
		[refreshProjectSessions, updateState, showToast],
	);

	const loadEarlier = useCallback(async () => {
		const current = stateRef.current;
		if (!current.sessionId || !current.previousCursor || current.loadingEarlier) return;
		const sessionId = current.sessionId;
		updateState((value) => ({ ...value, loadingEarlier: true }));
		try {
			await loadTranscript(sessionId, current.previousCursor);
		} finally {
			updateState((value) => (value.sessionId === sessionId ? { ...value, loadingEarlier: false } : value));
			if (transcriptRefreshPendingRef.current === sessionId) {
				transcriptRefreshPendingRef.current = undefined;
				scheduleTranscriptRefresh(sessionId);
			}
		}
	}, [loadTranscript, scheduleTranscriptRefresh, updateState]);

	const createSession = useCallback(async () => {
		const projectId = stateRef.current.currentProjectId;
		if (!projectId) return;
		const selectionRequest = selectionRef.current;
		const result = await webApi.createSession(projectId);
		if (selectionRef.current !== selectionRequest || stateRef.current.currentProjectId !== projectId) {
			await webApi.release(result.session.id).catch(() => {});
			return;
		}
		selectionRef.current++;
		const previousSessionId = stateRef.current.sessionId;
		const socket = socketRef.current;
		if (socket && previousSessionId && previousSessionId !== result.session.id)
			webApi.unsubscribeSession(socket, previousSessionId);
		updateState((current) => ({
			...current,
			projects: current.projects.map((project) =>
				project.id === projectId
					? {
							...project,
							sessions: [
								{
									...result.session,
									firstMessage: "",
									messageCount: 0,
								},
								...project.sessions.filter((session) => session.id !== result.session.id),
							],
						}
					: project,
			),
			sessionId: result.session.id,
			session: result.session,
			sessionError: undefined,
			lease: result.lease,
			readOnly: false,
			sessionReady: false,
			pendingUserPrompts: [],
			queuedUserPrompts: [],
			transcript: [],
			transcriptPageLoaded: false,
			transcriptLoading: false,
			transcriptError: undefined,
			transcriptGeneration: undefined,
			transcriptRevision: undefined,
			transcriptLeafId: undefined,
			previousCursor: undefined,
			hasMorePrevious: false,
			currentOperation: undefined,
			statusText: "",
			liveTurnActive: false,
			liveTurnStartRevision: undefined,
			liveTools: {},
			liveTurnItems: [],
			liveCompaction: undefined,
		}));
		const subscriptionResult = await subscribeSessionAndWait(result.session.id);
		await completeSessionSubscription(result.session.id, subscriptionResult).catch((error) =>
			showToast(errorMessage(error)),
		);
	}, [completeSessionSubscription, showToast, subscribeSessionAndWait, updateState]);

	const sendMessage = useCallback(
		async (
			text: string,
			mode: ComposerMode = stateRef.current.composerMode,
			attachments?: PromptAttachment[],
			attachmentPreviews?: PromptAttachmentPreview[],
			displayText?: string,
		) => {
			const current = stateRef.current;
			if (!current.sessionId || !canSendPrompt(current)) return;
			if (hasActiveSessionWork(current) && mode === "prompt") mode = "follow-up";
			const value = text.trim();
			const fallbackDisplayText = attachmentPreviews?.length
				? `附件：${attachmentPreviews.map((attachment) => attachment.filename).join("、")}`
				: undefined;
			const visibleValue = displayText?.trim() || promptDisplayText(value) || fallbackDisplayText || value;
			if (!value) return;
			const queueId = createUuid();
			const queuedPrompt: QueuedUserPrompt | undefined =
				mode === "steer" || mode === "follow-up"
					? {
							id: queueId,
							text: value,
							displayText: visibleValue,
							delivery: mode,
							attachments: attachmentPreviews ?? [],
						}
					: undefined;
			const optimisticPrompt: PendingUserPrompt | undefined =
				mode === "prompt"
					? {
							id: `optimistic-user:${pendingUserPromptRef.current++}`,
							text: visibleValue,
							attachments: attachmentPreviews ?? [],
							afterEntryId: current.transcript.at(-1)?.entryId,
							queueId,
							sentAt: Date.now(),
						}
					: undefined;
			if (optimisticPrompt || queuedPrompt)
				updateState((next) =>
					next.sessionId === current.sessionId
						? {
								...next,
								...(optimisticPrompt
									? { pendingUserPrompts: [...next.pendingUserPrompts, optimisticPrompt] }
									: {}),
								...(queuedPrompt ? { queuedUserPrompts: [...next.queuedUserPrompts, queuedPrompt] } : {}),
								...(queuedPrompt?.delivery === "steer"
									? {
											liveTurnItems: appendLiveUserPrompt(
												next.liveTurnItems,
												queuedPrompt,
												next.liveTurnId,
												next.transcript.at(-1)?.entryId,
												runningAgentStepId(next.liveSteps),
											),
										}
									: {}),
								...(optimisticPrompt || queuedPrompt?.delivery === "steer"
									? { promptScrollRequest: (next.promptScrollRequest ?? 0) + 1 }
									: {}),
							}
						: next,
				);
			try {
				const { result, submittedMode } = await submitPromptWithFollowUpFallback(mode, (candidateMode) =>
					webApi.prompt(current.sessionId!, value, candidateMode, attachments, queueId),
				);
				updateState((next) => {
					if (next.sessionId !== current.sessionId) return next;
					const accepted = applyPromptAccepted(next, current.sessionId!, result.operation);
					const acceptedAsFollowUp =
						submittedMode === "follow-up" || result.operation?.type === "follow_up";
					const optimisticStillPending = Boolean(
						optimisticPrompt && accepted.pendingUserPrompts.some((prompt) => prompt.id === optimisticPrompt.id),
					);
					const pendingUserPrompts = reconcilePendingUserPrompts(accepted.pendingUserPrompts, accepted.transcript);
					const convertedQueuedPrompt =
						acceptedAsFollowUp && !queuedPrompt && queueId && optimisticStillPending
							? {
									id: queueId,
									text: value,
									displayText: visibleValue,
									delivery: "follow-up" as const,
									attachments: attachmentPreviews ?? [],
								}
							: undefined;
					const queuedUserPrompts = convertedQueuedPrompt
						? accepted.queuedUserPrompts.some((prompt) => prompt.id === convertedQueuedPrompt.id)
							? accepted.queuedUserPrompts.map((prompt) =>
									prompt.id === convertedQueuedPrompt.id ? convertedQueuedPrompt : prompt,
								)
							: [...accepted.queuedUserPrompts, convertedQueuedPrompt]
						: accepted.queuedUserPrompts;
					return {
						...accepted,
						pendingUserPrompts:
							acceptedAsFollowUp && optimisticPrompt
								? pendingUserPrompts.filter((prompt) => prompt.id !== optimisticPrompt.id)
								: pendingUserPrompts,
						promptSendTimes: withPromptSendTimes(accepted, accepted.transcript),
						queuedUserPrompts,
						projects: acceptedAsFollowUp
							? accepted.projects
							: updateSessionSummaryFirstMessage(accepted.projects, current.sessionId!, visibleValue),
					};
				});
			} catch (error) {
				if (optimisticPrompt || queuedPrompt)
					updateState((next) =>
						next.sessionId === current.sessionId
							? {
									...next,
									...(optimisticPrompt
										? {
												pendingUserPrompts: next.pendingUserPrompts.filter(
													(prompt) => prompt.id !== optimisticPrompt.id,
												),
											}
										: {}),
									...(queuedPrompt
										? {
												queuedUserPrompts: removeQueuedUserPrompt(next.queuedUserPrompts, queuedPrompt.id),
												liveTurnItems: removeLiveUserPrompt(next.liveTurnItems, queuedPrompt.id),
											}
										: {}),
								}
							: next,
					);
				throw error;
			}
		},
		[updateState],
	);

	const queueAction = useCallback(
		async (queueId: string, action: "remove" | "steer") => {
			const current = stateRef.current;
			if (!current.sessionId || !canSendPrompt(current)) return;
			const promptIndex = current.queuedUserPrompts.findIndex((prompt) => prompt.id === queueId);
			const prompt = promptIndex >= 0 ? current.queuedUserPrompts[promptIndex] : undefined;
			const livePromptIndex = current.liveTurnItems.findIndex(
				(item) => item.kind === "user" && item.queueId === queueId,
			);
			const livePrompt = livePromptIndex >= 0 ? current.liveTurnItems[livePromptIndex] : undefined;
			if (prompt) {
				updateState((next) => {
					if (next.sessionId !== current.sessionId) return next;
					const steeringPrompt = action === "steer" ? { ...prompt, delivery: "steer" as const } : undefined;
					return {
						...next,
						queuedUserPrompts:
							action === "remove"
								? removeQueuedUserPrompt(next.queuedUserPrompts, queueId)
								: next.queuedUserPrompts.map((candidate) =>
										candidate.id === queueId ? steeringPrompt! : candidate,
									),
						liveTurnItems:
							action === "remove"
								? removeLiveUserPrompt(next.liveTurnItems, queueId)
								: appendLiveUserPrompt(
										next.liveTurnItems,
									steeringPrompt!,
									next.liveTurnId,
									next.transcript.at(-1)?.entryId,
									runningAgentStepId(next.liveSteps),
								),
						...(action === "steer" && !livePrompt
							? { promptScrollRequest: (next.promptScrollRequest ?? 0) + 1 }
							: {}),
					};
				});
			}
			try {
				await webApi.queueAction(current.sessionId, queueId, action);
			} catch (error) {
				if (prompt) {
					updateState((next) => {
						if (next.sessionId !== current.sessionId) return next;
						let queuedUserPrompts = next.queuedUserPrompts;
						const existingIndex = queuedUserPrompts.findIndex((candidate) => candidate.id === queueId);
						if (existingIndex >= 0) {
							queuedUserPrompts = queuedUserPrompts.map((candidate) =>
								candidate.id === queueId ? prompt : candidate,
							);
						} else {
							queuedUserPrompts = [...queuedUserPrompts];
							queuedUserPrompts.splice(Math.min(promptIndex, queuedUserPrompts.length), 0, prompt);
						}
						let liveTurnItems = removeLiveUserPrompt(next.liveTurnItems, queueId);
						if (livePrompt) {
							liveTurnItems = [...liveTurnItems];
							liveTurnItems.splice(Math.min(livePromptIndex, liveTurnItems.length), 0, livePrompt);
						}
						return { ...next, queuedUserPrompts, liveTurnItems };
					});
				}
				throw error;
			}
		},
		[updateState],
	);

	const abort = useCallback(async () => {
		const current = stateRef.current;
		if (!current.sessionId) return;
		await webApi.abort(current.sessionId, current.currentOperation?.operationId);
	}, []);

	const renameSession = useCallback(
		async (sessionId: string, name: string) => {
			const current = stateRef.current;
			let temporaryLease = false;
			try {
				if (current.sessionId !== sessionId || !current.lease || current.readOnly) {
					const controlled = await webApi.control(sessionId);
					if (!controlled.owned) {
						showToast("当前会话暂时无法修改");
						return;
					}
					temporaryLease = current.sessionId !== sessionId;
					if (current.sessionId === sessionId) {
						updateState((next) => ({
							...next,
							projects: updateSessionSummaryName(next.projects, sessionId, controlled.snapshot.name),
							session: controlled.snapshot,
							lease: controlled.lease,
							readOnly: false,
						}));
					}
				}
				const result = await webApi.renameSession(sessionId, name);
				updateState((next) => ({
					...next,
					projects: updateSessionSummaryName(next.projects, sessionId, result.session.name),
					...(next.sessionId === sessionId ? { session: result.session } : {}),
				}));
				if (current.currentProjectId) await refreshProjectSessions(current.currentProjectId);
			} catch (error) {
				showToast(errorMessage(error));
			} finally {
				if (temporaryLease) await webApi.release(sessionId).catch(() => {});
			}
		},
		[refreshProjectSessions, showToast, updateState],
	);

	const setSessionPinned = useCallback(
		async (sessionId: string, pinned: boolean) => {
			const current = stateRef.current;
			const project = current.projects.find((candidate) =>
				candidate.sessions.some((session) => session.id === sessionId),
			);
			if (!project) return;
			try {
				const result = await webApi.setSessionPinned(project.id, sessionId, pinned);
				updateState((next) => ({
					...next,
					projects: next.projects.map((candidate) =>
						candidate.id === result.project.id ? result.project : candidate,
					),
				}));
			} catch (error) {
				showToast(errorMessage(error));
			}
		},
		[showToast, updateState],
	);

	const deleteSessions = useCallback(
		async (sessionIds: string[]): Promise<string[]> => {
			const ids = [...new Set(sessionIds)];
			if (ids.length === 0) return [];
			try {
				const result = await webApi.deleteSessions(ids);
				const deletedIds = result.deletedIds;
				const deleted = new Set(deletedIds);
				if (deleted.size > 0) {
					const current = stateRef.current;
					const currentSessionDeleted = Boolean(current.sessionId && deleted.has(current.sessionId));
					const currentProject = current.projects.find((project) => project.id === current.currentProjectId);
					const nextSessionId = currentProject?.sessions.find((session) => !deleted.has(session.id))?.id;
					for (const sessionId of deleted) {
						sessionDetailCacheRef.current.delete(sessionId);
						sessionDetailSeqRef.current.delete(sessionId);
					}
					updateState((next) => {
						const projects = next.projects.map((project) => ({
							...project,
							sessions: project.sessions.filter((session) => !deleted.has(session.id)),
						}));
						if (!next.sessionId || !deleted.has(next.sessionId)) return { ...next, projects };
						return {
							...next,
							projects,
							sessionId: nextSessionId,
							session: undefined,
							lease: undefined,
							readOnly: false,
							sessionReady: false,
							pendingUserPrompts: [],
							queuedUserPrompts: [],
							transcript: [],
							transcriptPageLoaded: false,
							transcriptLoading: false,
							transcriptError: undefined,
							transcriptGeneration: undefined,
							transcriptRevision: undefined,
							transcriptLeafId: undefined,
							previousCursor: undefined,
							hasMorePrevious: false,
							currentOperation: undefined,
							liveTurnActive: false,
							liveTurnStartRevision: undefined,
							liveTools: {},
							liveSteps: {},
							liveTurnItems: [],
							statusText: "",
							unreadSessionIds: Object.fromEntries(
								Object.entries(next.unreadSessionIds).filter(([id]) => !deleted.has(id)),
							) as Record<string, true>,
						};
					});
					if (currentSessionDeleted) {
						if (nextSessionId) await selectSession(nextSessionId);
						else await loadProjectTreeRef.current();
					}
				}
				if (result.failures.length === 1) showToast(result.failures[0]!.message);
				else if (result.failures.length > 1) {
					showToast(`${result.failures.length} 个会话删除失败：${result.failures[0]!.message}`);
				}
				return deletedIds;
			} catch (error) {
				showToast(errorMessage(error));
				return [];
			}
		},
		[selectSession, showToast, updateState],
	);

	const deleteSession = useCallback(
		async (sessionId: string): Promise<boolean> => (await deleteSessions([sessionId])).includes(sessionId),
		[deleteSessions],
	);

	const fork = useCallback(
		async (entryId: string) => {
			const current = stateRef.current;
			if (!current.sessionId || current.readOnly) return;
			const oldSessionId = current.sessionId;
			const selectionRequest = selectionRef.current;
			const result = await webApi.fork(oldSessionId, entryId);
			if (selectionRef.current !== selectionRequest || stateRef.current.sessionId !== oldSessionId) {
				await webApi.release(result.session.id).catch(() => {});
				return;
			}
			selectionRef.current++;
			const socket = socketRef.current;
			if (socket && oldSessionId !== result.session.id) webApi.unsubscribeSession(socket, oldSessionId);
			updateState((next) => ({
				...next,
				sessionId: result.session.id,
				session: result.session,
				lease: result.lease,
				readOnly: false,
				sessionReady: false,
				pendingUserPrompts: [],
				queuedUserPrompts: [],
				transcript: [],
				transcriptPageLoaded: false,
				transcriptLoading: true,
				transcriptError: undefined,
				sessionError: undefined,
				transcriptGeneration: undefined,
				transcriptRevision: undefined,
				transcriptLeafId: undefined,
				previousCursor: undefined,
				hasMorePrevious: false,
				currentOperation: undefined,
				liveTurnActive: false,
				liveTurnStartRevision: undefined,
				liveTools: {},
				liveSteps: {},
				liveTurnItems: [],
				liveCompaction: undefined,
			}));
			if (current.currentProjectId) await refreshProjectSessions(current.currentProjectId);
			if (socket && oldSessionId !== result.session.id) {
				const subscriptionResult = await subscribeSessionAndWait(result.session.id);
				await completeSessionSubscription(result.session.id, subscriptionResult);
			}
			await loadTranscript(result.session.id);
			await loadSessionTreeRef.current();
			if (oldSessionId !== result.session.id) showToast("已创建新的会话分支");
		},
		[
			completeSessionSubscription,
			loadTranscript,
			refreshProjectSessions,
			showToast,
			subscribeSessionAndWait,
			updateState,
		],
	);

	const reloadResources = useCallback(async () => {
		const { sessionId, currentProjectId, readOnly } = stateRef.current;
		if (!sessionId || readOnly) throw new Error("当前会话不可写");
		showToast("正在重新加载会话资源…");
		const result = await webApi.reloadResources(sessionId);
		if (stateRef.current.sessionId !== sessionId) return;
		updateState((current) => ({ ...current, session: result.session }));
		try {
			const [instructions, skills] = await Promise.all([
				webApi.hostInstructions(),
				currentProjectId ? webApi.projectSkills(currentProjectId) : undefined,
			]);
			if (stateRef.current.sessionId !== sessionId) return;
			updateState((current) => ({
				...current,
				hostInstructions: instructions.instructions,
				hostInstructionsError: undefined,
				...(skills ? { skills: skills.skills, skillDiagnostics: skills.diagnostics, skillsError: undefined } : {}),
			}));
			showToast("会话资源已重新加载，后续消息使用更新后的 AGENTS.md 和 Skill");
		} catch (error) {
			showToast(`会话资源已重新加载，但资源列表刷新失败：${errorMessage(error)}`);
		}
	}, [showToast, updateState]);

	const compact = useCallback(
		async (customInstructions?: string) => {
			const current = stateRef.current;
			if (!current.sessionId || current.readOnly) return;
			const result = await webApi.compact(current.sessionId, customInstructions);
			updateState((next) =>
				next.sessionId === current.sessionId && result.operation.sessionId === current.sessionId
					? { ...next, currentOperation: result.operation }
					: next,
			);
		},
		[updateState],
	);

	const exportSession = useCallback(async () => {
		const current = stateRef.current;
		if (!current.sessionId || current.readOnly) return;
		const result = await webApi.exportSession(current.sessionId);
		showToast(`会话已导出：${result.path.split(/[\\/]/).at(-1) ?? "文件"}`);
	}, [showToast]);

	const ensureSessionControl = useCallback(
		async (sessionId: string): Promise<boolean> => {
			const current = stateRef.current;
			if (current.sessionId !== sessionId) return false;
			if (!current.readOnly && current.lease) return true;
			try {
				const controlled = await webApi.control(sessionId);
				if (stateRef.current.sessionId !== sessionId) return false;
				updateState((next) => {
					const updated: WorkbenchState = {
						...next,
						projects: updateSessionSummaryName(next.projects, sessionId, controlled.snapshot.name),
						lease: controlled.lease,
						session: controlled.snapshot,
						readOnly: controlled.owned === false,
						currentOperation: operationForSessionSnapshot(next.operations, controlled.snapshot),
					};
					return restoreRuntimeActivities(updated, controlled.snapshot);
				});
				if (controlled.owned) return true;
				showToast("当前会话暂时无法修改");
				return false;
			} catch (error) {
				showToast(errorMessage(error));
				return false;
			}
		},
		[showToast, updateState],
	);

	const updateModel = useCallback(
		async (provider: string, id: string) => {
			const sessionId = stateRef.current.sessionId;
			if (!sessionId || !(await ensureSessionControl(sessionId))) return;
			if (stateRef.current.sessionId !== sessionId) return;
			try {
				const result = await webApi.model(sessionId, provider, id);
				if (stateRef.current.sessionId !== sessionId) return;
				updateState((next) => ({
					...next,
					session: result.session,
					readOnly: result.session.writeAccess !== "owned",
				}));
			} catch (error) {
				showToast(errorMessage(error));
			}
		},
		[ensureSessionControl, showToast, updateState],
	);

	const updateThinking = useCallback(
		async (level: string) => {
			const sessionId = stateRef.current.sessionId;
			if (!sessionId || !(await ensureSessionControl(sessionId))) return;
			if (stateRef.current.sessionId !== sessionId) return;
			try {
				const result = await webApi.thinking(sessionId, level);
				if (stateRef.current.sessionId !== sessionId) return;
				updateState((next) => ({
					...next,
					session: result.session,
					readOnly: result.session.writeAccess !== "owned",
				}));
			} catch (error) {
				showToast(errorMessage(error));
			}
		},
		[ensureSessionControl, showToast, updateState],
	);

	const loadGitStatus = useCallback(
		(silent = false): Promise<void> => {
			const pending = gitStatusPromiseRef.current;
			if (pending) return pending;
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return Promise.resolve();
			const requestId = ++gitStatusRequestRef.current;
			gitStatsRepositoryRef.current.clear();
			if (!silent) updateState((current) => ({ ...current, gitLoading: true }));
			const run = (async () => {
				try {
					const result = await webApi.gitStatus(projectId, !silent);
					if (requestId !== gitStatusRequestRef.current || stateRef.current.currentProjectId !== projectId) return;
					updateState((current) =>
						sameGitStatus(current.gitStatus, result)
							? current
							: { ...current, gitStatus: result, gitFileStats: {} },
					);
				} finally {
					if (!silent && requestId === gitStatusRequestRef.current) {
						updateState((current) => ({ ...current, gitLoading: false }));
					}
				}
			})();
			const tracked = run.finally(() => {
				if (gitStatusPromiseRef.current === tracked) gitStatusPromiseRef.current = undefined;
			});
			gitStatusPromiseRef.current = tracked;
			return tracked;
		},
		[updateState],
	);

	const loadGitRepositoryStats = useCallback(
		async (repositoryPath = "") => {
			const projectId = stateRef.current.currentProjectId;
			const status = stateRef.current.gitStatus;
			if (!projectId || !status) return;
			const repositories = status.repositories?.length
				? status.repositories
				: [{ ...status, path: "", kind: "root" as const }];
			const repository = repositories.find((item) => item.path === repositoryPath);
			if (!repository) return;
			const cacheKey = `${projectId}\0${repository.path}`;
			if (gitStatsRepositoryRef.current.has(cacheKey)) return;
			gitStatsRepositoryRef.current.add(cacheKey);
			try {
				const result = await webApi.gitStats(projectId, repository.path || undefined);
				if (stateRef.current.currentProjectId !== projectId || stateRef.current.gitStatus !== status) {
					gitStatsRepositoryRef.current.delete(cacheKey);
					return;
				}
				const stats: Record<string, GitFileDiffStats> = {};
				for (const file of result.files) {
					const key = gitFileStatsKey(repository.path, file.path);
					const current = stats[key] ?? { additions: 0, deletions: 0 };
					stats[key] = {
						additions: current.additions + file.additions,
						deletions: current.deletions + file.deletions,
					};
				}
				updateState((current) => ({
					...current,
					gitFileStats: { ...current.gitFileStats, ...stats },
				}));
			} catch {
				gitStatsRepositoryRef.current.delete(cacheKey);
			}
		},
		[updateState],
	);

	const loadGitBranches = useCallback(
		async (repositoryPath = "") => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			const requestId = ++gitBranchesRequestRef.current;
			updateState((current) => ({ ...current, gitBranchesLoading: true }));
			try {
				const result = await webApi.gitBranches(projectId, repositoryPath || undefined);
				if (requestId !== gitBranchesRequestRef.current || stateRef.current.currentProjectId !== projectId) return;
				updateState((current) => ({ ...current, gitBranches: result }));
			} finally {
				if (requestId === gitBranchesRequestRef.current)
					updateState((current) => ({ ...current, gitBranchesLoading: false }));
			}
		},
		[updateState],
	);

	const loadGitHistory = useCallback(
		async (repositoryPath = "", offset = 0, append = false) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			const requestId = ++gitHistoryRequestRef.current;
			updateState((current) => ({ ...current, gitHistoryLoading: true }));
			try {
				const result = await webApi.gitHistory(projectId, offset, 50, repositoryPath || undefined);
				if (requestId !== gitHistoryRequestRef.current || stateRef.current.currentProjectId !== projectId) return;
				updateState((current) => {
					const previous =
						append && current.gitHistory?.repositoryPath === result.repositoryPath
							? current.gitHistory.commits
							: [];
					const seen = new Set(previous.map((commit) => commit.hash));
					return {
						...current,
						gitHistory: {
							...result,
							commits: [...previous, ...result.commits.filter((commit) => !seen.has(commit.hash))],
						},
						...(current.gitCommit?.repositoryPath === result.repositoryPath ? {} : { gitCommit: undefined }),
					};
				});
			} finally {
				if (requestId === gitHistoryRequestRef.current)
					updateState((current) => ({ ...current, gitHistoryLoading: false }));
			}
		},
		[updateState],
	);

	const loadGitCommit = useCallback(
		async (revision: string, repositoryPath = "", path?: string) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			const requestId = ++gitCommitRequestRef.current;
			if (path) gitDiffRequestRef.current++;
			updateState((current) => ({
				...current,
				gitCommitLoading: true,
				...(path ? { gitDiff: undefined, gitDiffLoading: true } : { gitCommit: undefined }),
			}));
			try {
				const result = await webApi.gitCommit(projectId, revision, repositoryPath || undefined, path);
				if (requestId !== gitCommitRequestRef.current || stateRef.current.currentProjectId !== projectId) return;
				updateState((current) => ({
					...current,
					gitCommit: result,
					...(path && result.diff ? { gitDiff: result.diff } : {}),
				}));
			} finally {
				if (requestId === gitCommitRequestRef.current) {
					updateState((current) => ({
						...current,
						gitCommitLoading: false,
						...(path ? { gitDiffLoading: false } : {}),
					}));
				}
			}
		},
		[updateState],
	);

	const closeGitCommit = useCallback(() => {
		gitCommitRequestRef.current++;
		updateState((current) => ({ ...current, gitCommit: undefined, gitCommitLoading: false }));
	}, [updateState]);

	const mutateGit = useCallback(
		async (mutation: GitMutation, repositoryPath = ""): Promise<boolean> => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId || stateRef.current.gitOperation) return false;
			updateState((current) => ({ ...current, gitOperation: mutation.type }));
			try {
				const result = await webApi.mutateGit(projectId, mutation, repositoryPath || undefined);
				if (stateRef.current.currentProjectId !== projectId) return false;
				gitStatsRepositoryRef.current.clear();
				updateState((current) => ({ ...current, gitStatus: result.status, gitFileStats: {} }));
				await Promise.allSettled([
					loadGitRepositoryStats(repositoryPath),
					loadGitBranches(repositoryPath),
					loadGitHistory(repositoryPath),
				]);
				showToast(result.message);
				return true;
			} catch (error) {
				const authorizationMessage = gitCredentialAuthorizationMessage(error);
				if (authorizationMessage) {
					updateState((current) => ({ ...current, gitCredentialAuthorizationMessage: authorizationMessage }));
				} else {
					showToast(errorMessage(error));
				}
				await loadGitStatusRef.current(true).catch(() => {});
				return false;
			} finally {
				if (stateRef.current.currentProjectId === projectId)
					updateState((current) => ({
						...current,
						...(current.gitOperation === mutation.type ? { gitOperation: undefined } : {}),
					}));
			}
		},
		[loadGitBranches, loadGitHistory, loadGitRepositoryStats, showToast, updateState],
	);

	const closeGitCredentialAuthorization = useCallback(
		() => updateState((current) => ({ ...current, gitCredentialAuthorizationMessage: undefined })),
		[updateState],
	);

	const loadGitDiff = useCallback(
		async (path?: string, staged = false, repositoryPath?: string) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			const requestId = ++gitDiffRequestRef.current;
			updateState((current) => ({ ...current, gitDiff: undefined, gitDiffLoading: true }));
			try {
				const result = await webApi.gitDiff(projectId, path, staged, repositoryPath);
				if (requestId !== gitDiffRequestRef.current || stateRef.current.currentProjectId !== projectId) return;
				updateState((current) => ({ ...current, gitDiff: result }));
			} finally {
				if (requestId === gitDiffRequestRef.current) {
					updateState((current) => ({ ...current, gitDiffLoading: false }));
				}
			}
		},
		[updateState],
	);

	const closeGitDiff = useCallback(() => {
		gitDiffRequestRef.current += 1;
		updateState((current) => ({ ...current, gitDiff: undefined, gitDiffLoading: false }));
	}, [updateState]);

	const openInspector = useCallback(
		async (mode: InspectorMode = "files") => {
			updateState((current) => ({ ...current, inspectorOpen: true, inspectorMode: mode }));
			if (mode === "git") await loadGitStatus();
			if (mode === "files" && !stateRef.current.fileTree) await loadProjectTreeRef.current();
			if (mode === "tree" && !stateRef.current.sessionTree.length) await loadSessionTreeRef.current();
		},
		[loadGitStatus, updateState],
	);

	const closeInspector = useCallback(
		() => updateState((current) => ({ ...current, inspectorOpen: false })),
		[updateState],
	);

	const loadProjectTree = useCallback(
		async (path = "", preserveCurrentTree = false) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			const projectGeneration = projectTreeGenerationRef.current;
			updateState((current) => ({ ...current, fileTreeLoading: true }));
			try {
				const result = await webApi.projectTree(projectId, path);
				if (
					projectGeneration !== projectTreeGenerationRef.current ||
					stateRef.current.currentProjectId !== projectId
				)
					return;
				updateState((current) => ({
					...current,
					fileTree: preserveCurrentTree ? current.fileTree : result,
					fileTreeRootPath: preserveCurrentTree ? current.fileTreeRootPath : result.path,
					fileTreeCache: { ...current.fileTreeCache, [result.path]: result },
				}));
			} finally {
				if (
					projectGeneration === projectTreeGenerationRef.current &&
					stateRef.current.currentProjectId === projectId
				)
					updateState((current) => ({ ...current, fileTreeLoading: false }));
			}
		},
		[updateState],
	);

	const refreshProjectTreePath = useCallback(
		(path: string): Promise<void> => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return Promise.resolve();
			const key = `${projectId}\0${path}`;
			const pending = projectTreeRefreshPromisesRef.current.get(key);
			if (pending) return pending;
			const run = webApi
				.projectTree(projectId, path)
				.then((result) => {
					if (stateRef.current.currentProjectId !== projectId) return;
					updateState((current) => {
						if (sameProjectTree(current.fileTreeCache[result.path], result)) return current;
						return {
							...current,
							fileTree: current.fileTreeRootPath === result.path ? result : current.fileTree,
							fileTreeCache: { ...current.fileTreeCache, [result.path]: result },
						};
					});
				})
				.catch(() => {});
			const tracked = run.finally(() => {
				if (projectTreeRefreshPromisesRef.current.get(key) === tracked) {
					projectTreeRefreshPromisesRef.current.delete(key);
				}
			});
			projectTreeRefreshPromisesRef.current.set(key, tracked);
			return tracked;
		},
		[updateState],
	);

	const openResource = useCallback(
		async (path: string) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			const requestId = ++fileRequestRef.current;
			updateState((current) => ({
				...current,
				fileLoading: true,
				filePath: path,
				fileError: undefined,
			}));
			try {
				const result = isAbsoluteResourcePath(path)
					? await webApi.externalFile(path)
					: await webApi.projectFile(projectId, path);
				if (requestId !== fileRequestRef.current) return;
				updateState((current) => ({
					...current,
					fileContent: result,
					fileError: undefined,
				}));
			} catch (error) {
				if (requestId !== fileRequestRef.current) return;
				updateState((current) => ({
					...current,
					fileContent: current.fileContent?.path === path ? current.fileContent : undefined,
					fileError: errorMessage(error),
				}));
			} finally {
				if (requestId === fileRequestRef.current) {
					updateState((current) => ({ ...current, fileLoading: false }));
				}
			}
		},
		[updateState],
	);

	const closeFilePreview = useCallback(() => {
		fileRequestRef.current += 1;
		updateState((current) => ({
			...current,
			fileContent: undefined,
			fileError: undefined,
			filePath: undefined,
			fileLoading: false,
		}));
	}, [updateState]);

	const refreshOpenFile = useCallback(
		(path = stateRef.current.filePath, force = false): Promise<void> => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId || !path || isAbsoluteResourcePath(path)) return Promise.resolve();
			const key = `${projectId}\0${path}`;
			const pending = fileMetadataPromisesRef.current.get(key);
			if (pending) return pending;
			const run = (async () => {
				const metadata = await webApi.projectFileMetadata(projectId, path);
				if (stateRef.current.currentProjectId !== projectId || stateRef.current.filePath !== path) return;
				if (!force && metadata.contentVersion && metadata.contentVersion === stateRef.current.fileContent?.contentVersion) {
					return;
				}
				const result = await webApi.projectFile(projectId, path);
				if (stateRef.current.currentProjectId !== projectId || stateRef.current.filePath !== path) return;
				updateState((current) => ({ ...current, fileContent: result, fileError: undefined }));
			})().catch(() => {});
			const tracked = run.finally(() => {
				if (fileMetadataPromisesRef.current.get(key) === tracked) fileMetadataPromisesRef.current.delete(key);
			});
			fileMetadataPromisesRef.current.set(key, tracked);
			return tracked;
		},
		[updateState],
	);

	const refreshProjectFiles = useCallback(
		async (paths: readonly string[], refreshOpenedFile = true) => {
			const current = stateRef.current;
			const project = current.projects.find((candidate) => candidate.id === current.currentProjectId);
			if (!project) return;
			const refreshAll = paths.includes("");
			const normalized = paths.flatMap((path) => {
				const value = normalizedProjectFilePath(project.path, path);
				return value ? [value] : [];
			});
			const directories = new Set(
				refreshAll ? Object.keys(current.fileTreeCache) : normalized.map(parentProjectPath),
			);
			const loadedDirectories = new Set(Object.keys(current.fileTreeCache));
			await Promise.all(
				[...directories]
					.filter((path) => path === current.fileTreeRootPath || loadedDirectories.has(path))
					.map(refreshProjectTreePath),
			);
			if (refreshOpenedFile && current.filePath && (refreshAll || normalized.includes(current.filePath))) {
				await refreshOpenFile(current.filePath, true);
			}
			if (current.inspectorOpen && current.inspectorMode === "git") {
				await loadGitStatusRef.current(true);
				const repositoryPath =
					stateRef.current.gitBranches?.repositoryPath ?? stateRef.current.gitHistory?.repositoryPath;
				if (repositoryPath !== undefined) {
					await Promise.allSettled([
						loadGitBranchesRef.current(repositoryPath),
						loadGitHistoryRef.current(repositoryPath),
					]);
				}
			}
		},
		[refreshOpenFile, refreshProjectTreePath],
	);

	const saveFile = useCallback(
		async (path: string, content: string, expectedHash: string): Promise<FileResponse> => {
			const current = stateRef.current;
			if (!current.currentProjectId || isAbsoluteResourcePath(path)) throw new Error("当前文件不可保存");
			const sessionId = current.sessionId && current.lease && !current.readOnly ? current.sessionId : undefined;
			try {
				const result = await webApi.saveProjectFile(
					current.currentProjectId,
					path,
					content,
					expectedHash,
					sessionId,
				);
				if (stateRef.current.currentProjectId === current.currentProjectId && stateRef.current.filePath === path) {
					updateState((value) => ({ ...value, fileContent: result, fileError: undefined }));
				}
				await refreshProjectFiles([path], false);
				showToast("文件已保存");
				return result;
			} catch (error) {
				if ((error as { code?: string }).code === "project_file_conflict") void refreshOpenFile(path, true);
				throw error;
			}
		},
		[refreshOpenFile, refreshProjectFiles, showToast, updateState],
	);

	const openFile = openResource;

	const loadSessionTree = useCallback(async () => {
		const sessionId = stateRef.current.sessionId;
		if (!sessionId) return;
		const requestId = ++sessionTreeRequestRef.current;
		updateState((current) => ({ ...current, sessionTreeLoading: true }));
		try {
			const result = await webApi.tree(sessionId);
			if (requestId !== sessionTreeRequestRef.current || stateRef.current.sessionId !== sessionId) return;
			updateState((current) => ({ ...current, sessionTree: result.tree }));
		} finally {
			if (requestId === sessionTreeRequestRef.current)
				updateState((current) => ({ ...current, sessionTreeLoading: false }));
		}
	}, [updateState]);

	const navigateTree = useCallback(
		async (entryId: string) => {
			const current = stateRef.current;
			if (!current.sessionId || current.readOnly) return;
			await webApi.navigateTree(current.sessionId, entryId);
			await loadTranscript();
		},
		[loadTranscript],
	);

	const loadProjectTrust = useCallback(async () => {
		const projectId = stateRef.current.currentProjectId;
		if (!projectId) return;
		try {
			const result = await webApi.projectTrust(projectId);
			updateState((current) => ({ ...current, projectTrust: result }));
		} catch {
			updateState((current) => ({ ...current, projectTrust: undefined }));
		}
	}, [updateState]);

	const setProjectTrust = useCallback(
		async (trusted: boolean) => {
			const current = stateRef.current;
			if (!current.currentProjectId || !current.sessionId || current.readOnly) return;
			const result = await webApi.setProjectTrust(current.currentProjectId, current.sessionId, trusted);
			updateState((next) => ({ ...next, projectTrust: result }));
		},
		[updateState],
	);

	const loadDirectory = useCallback(
		async (path?: string) => {
			const requestId = ++directoryRequestRef.current;
			updateState((current) => ({ ...current, directoryLoading: true }));
			try {
				const result = await webApi.directories(path);
				if (requestId !== directoryRequestRef.current) return;
				updateState((current) => ({ ...current, directoryListing: result }));
			} finally {
				if (requestId === directoryRequestRef.current)
					updateState((current) => ({ ...current, directoryLoading: false }));
			}
		},
		[updateState],
	);

	const addProject = useCallback(
		async (cwd: string, name?: string) => {
			const result = await webApi.addProject(cwd, name);
			updateState((current) => ({
				...current,
				projects: [result.project, ...current.projects.filter((project) => project.id !== result.project.id)],
			}));
			await selectProject(result.project.id);
		},
		[selectProject, updateState],
	);

	const addProjectGroup = useCallback(
		async (name: string) => {
			try {
				const result = await webApi.addProjectGroup(name);
				updateState((current) => ({ ...current, projectGroups: result.groups }));
				return true;
			} catch (error) {
				showToast(errorMessage(error));
				return false;
			}
		},
		[showToast, updateState],
	);

	const updateProjectGroup = useCallback(
		async (groupId: string, name: string) => {
			try {
				const result = await webApi.updateProjectGroup(groupId, name);
				updateState((current) => ({ ...current, projectGroups: result.groups }));
				return true;
			} catch (error) {
				showToast(errorMessage(error));
				return false;
			}
		},
		[showToast, updateState],
	);

	const removeProjectGroup = useCallback(
		async (groupId: string) => {
			try {
				const result = await webApi.removeProjectGroup(groupId);
				updateState((current) => ({ ...current, projectGroups: result.groups }));
				return true;
			} catch (error) {
				showToast(errorMessage(error));
				return false;
			}
		},
		[showToast, updateState],
	);

	const setProjectGroup = useCallback(
		async (projectId: string, groupId?: string) => {
			try {
				const result = await webApi.setProjectGroup(projectId, groupId);
				updateState((current) => ({ ...current, projectGroups: result.groups }));
				return true;
			} catch (error) {
				showToast(errorMessage(error));
				return false;
			}
		},
		[showToast, updateState],
	);

	const reorderProjectGroups = useCallback(
		async (groupIds: string[]) => {
			try {
				const result = await webApi.reorderProjectGroups(groupIds);
				updateState((current) => ({ ...current, projectGroups: result.groups }));
			} catch (error) {
				showToast(errorMessage(error));
			}
		},
		[showToast, updateState],
	);

	const updateProject = useCallback(
		async (projectId: string, update: Partial<Pick<WebProject, "name" | "pinned" | "color" | "archived">>) => {
			const result = await webApi.updateProject(projectId, update);
			updateState((current) => ({
				...current,
				projects: current.projects.map((project) => (project.id === projectId ? result.project : project)),
			}));
		},
		[updateState],
	);

	const reorderProjects = useCallback(
		async (projectIds: string[]) => {
			try {
				await webApi.reorderProjects(projectIds);
				const orderedSet = new Set(projectIds);
				updateState((current) => ({
					...current,
					projects: [
						...projectIds.flatMap((projectId) => current.projects.filter((project) => project.id === projectId)),
						...current.projects.filter((project) => !orderedSet.has(project.id)),
					],
				}));
			} catch (error) {
				showToast(errorMessage(error));
			}
		},
		[showToast, updateState],
	);

	const reorderSessions = useCallback(
		async (projectId: string, sessionIds: string[]) => {
			try {
				const result = await webApi.reorderSessions(projectId, sessionIds);
				updateState((current) => ({
					...current,
					projects: current.projects.map((project) =>
						project.id === projectId ? { ...project, sessions: result.sessions } : project,
					),
				}));
			} catch (error) {
				showToast(errorMessage(error));
			}
		},
		[showToast, updateState],
	);

	const removeProject = useCallback(
		async (projectId: string) => {
			if (projectId === stateRef.current.currentProjectId) return;
			await webApi.removeProject(projectId);
			updateState((current) => ({
				...current,
				projects: current.projects.filter((project) => project.id !== projectId),
			}));
		},
		[updateState],
	);

	const setModelProviderVisibility = useCallback(
		(providerId: string, visible: boolean) => {
			updateState((current) => {
				const hidden = new Set(current.hiddenModelProviders);
				if (visible) hidden.delete(providerId);
				else hidden.add(providerId);
				const hiddenModelProviders = [...hidden];
				if (typeof window !== "undefined") {
					const overrides = savedModelProviderVisibilityOverrides();
					overrides[providerId] = visible;
					window.localStorage.setItem(MODEL_PROVIDER_VISIBILITY_KEY, JSON.stringify(overrides));
				}
				return { ...current, hiddenModelProviders };
			});
			void refreshModelOptionsRef.current().catch(() => {});
		},
		[updateState],
	);

	const saveModelProvider = useCallback(
		async (input: WebModelProviderInput) => {
			await webApi.modelProvider(input);
			await Promise.all([refreshModelSettings(), refreshModelOptions()]);
			showToast("Provider 配置已保存");
		},
		[refreshModelOptions, refreshModelSettings, showToast],
	);

	const removeModelProvider = useCallback(
		async (providerId: string) => {
			const result = await webApi.removeModelProvider(providerId);
			const removed = !result.providers.some((provider) => provider.id === providerId);
			if (removed) {
				if (typeof window !== "undefined") {
					const overrides = savedModelProviderVisibilityOverrides();
					delete overrides[providerId];
					window.localStorage.setItem(MODEL_PROVIDER_VISIBILITY_KEY, JSON.stringify(overrides));
				}
				updateState((current) => ({
					...current,
					hiddenModelProviders: current.hiddenModelProviders.filter((id) => id !== providerId),
				}));
			}
			await Promise.all([refreshModelSettings(), refreshModelOptions()]);
			showToast(removed ? "Provider 已删除" : "Provider 自定义配置已清除");
		},
		[refreshModelOptions, refreshModelSettings, showToast, updateState],
	);

	const saveProviderModel = useCallback(
		async (provider: string, input: WebProviderModelInput) => {
			await webApi.providerModel(provider, input);
			await Promise.all([refreshModelSettings(), refreshModelOptions()]);
			showToast("模型配置已保存");
		},
		[refreshModelOptions, refreshModelSettings, showToast],
	);

	const setProviderModelEnabled = useCallback(
		async (provider: string, modelId: string, enabled: boolean) => {
			await webApi.setProviderModelEnabled(provider, modelId, enabled);
			await Promise.all([refreshModelSettings(), refreshModelOptions()]);
			showToast(enabled ? "模型已启用" : "模型已禁用");
		},
		[refreshModelOptions, refreshModelSettings, showToast],
	);

	const syncModelProvider = useCallback(
		async (provider: string) => {
			await webApi.syncModelProvider(provider);
			await Promise.all([refreshModelSettings(), refreshModelOptions()]);
			showToast("模型目录已同步");
		},
		[refreshModelOptions, refreshModelSettings, showToast],
	);

	const refreshSkills = useCallback(async () => {
		const projectId = stateRef.current.currentProjectId;
		if (!projectId) {
			updateState((current) => ({ ...current, skills: [], skillsLoading: false, skillsError: "请先选择一个项目" }));
			return;
		}
		updateState((current) => ({ ...current, skillsLoading: true, skillsError: undefined }));
		try {
			const result = await webApi.projectSkills(projectId);
			updateState((current) => ({
				...current,
				skills: result.skills,
				skillDiagnostics: result.diagnostics,
				skillsLoading: false,
				skillsError: undefined,
			}));
		} catch (error) {
			const message = errorMessage(error);
			updateState((current) => ({ ...current, skillsLoading: false, skillsError: message }));
			showToast(message);
		}
	}, [showToast, updateState]);

	const refreshDiagnostics = useCallback(async () => {
		const result = (await webApi.diagnostics(stateRef.current.currentProjectId)) as Record<string, unknown>;
		updateState((current) => ({ ...current, diagnostics: result }));
	}, [updateState]);

	const restartDiagnosticService = useCallback(
		async (service: "gateway" | "runtime") => {
			try {
				await webApi.restartDiagnosticService(service);
				showToast(service === "gateway" ? "Gateway 重启请求已发送" : "Runtime 已重启");
				if (service === "runtime") await refreshDiagnostics();
			} catch (error) {
				showToast(errorMessage(error));
				throw error;
			}
		},
		[refreshDiagnostics, showToast],
	);

	const toggleSkill = useCallback(
		async (skill: ProjectSkillsResponse["skills"][number]) => {
			if (skill.scope === "temporary") return;
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) {
				showToast("请先选择一个项目");
				return;
			}
			updateState((current) => ({ ...current, skillUpdatingPath: skill.path, skillsError: undefined }));
			try {
				const result = await webApi.setProjectSkillEnabled(projectId, skill.path, skill.scope, !skill.enabled);
				updateState((current) => ({
					...current,
					skills: result.skills,
					skillDiagnostics: result.diagnostics,
					skillUpdatingPath: undefined,
				}));
			} catch (error) {
				const message = errorMessage(error);
				updateState((current) => ({ ...current, skillUpdatingPath: undefined, skillsError: message }));
				showToast(message);
			}
		},
		[showToast, updateState],
	);

	const refreshHarnessImports = useCallback(async () => {
		const projectId = stateRef.current.currentProjectId;
		if (!projectId) {
			updateState((current) => ({
				...current,
				harnessImports: undefined,
				harnessImportsLoading: false,
				harnessImportsError: "请先选择一个项目",
			}));
			return;
		}
		updateState((current) => ({
			...current,
			harnessImportsLoading: true,
			harnessImportsError: undefined,
		}));
		try {
			const result = await webApi.harnessImports(projectId);
			updateState((current) => ({
				...current,
				harnessImports: result,
				harnessImportsLoading: false,
				harnessImportsError: undefined,
			}));
		} catch (error) {
			const message = errorMessage(error);
			updateState((current) => ({ ...current, harnessImportsLoading: false, harnessImportsError: message }));
			showToast(message);
		}
	}, [showToast, updateState]);

	const refreshSubagentConfigs = useCallback(async () => {
		const projectId = stateRef.current.currentProjectId;
		if (!projectId) {
			updateState((current) => ({
				...current,
				subagentConfigs: [],
				subagentConfigsLoading: false,
				subagentConfigsError: "请先选择一个项目",
			}));
			return;
		}
		updateState((current) => ({ ...current, subagentConfigsLoading: true, subagentConfigsError: undefined }));
		try {
			const result: SubagentConfigsResponse = await webApi.subagentConfigs(projectId);
			updateState((current) => ({
				...current,
				subagentConfigs: result.subagents,
				subagentConfigsLoading: false,
				subagentConfigsError: undefined,
			}));
		} catch (error) {
			const message = errorMessage(error);
			updateState((current) => ({ ...current, subagentConfigsLoading: false, subagentConfigsError: message }));
			showToast(message);
		}
	}, [showToast, updateState]);

	const saveSubagentConfig = useCallback(
		async (input: {
			scope: "user" | "project";
			originalName?: string;
			name: string;
			description: string;
			provider?: string;
			model?: string;
			thinkingLevel?: WebThinkingLevel;
			tools?: string[];
			content: string;
			expectedHash?: string;
		}): Promise<boolean> => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return false;
			updateState((current) => ({ ...current, subagentConfigsSaving: true, subagentConfigsError: undefined }));
			try {
				const result = await webApi.saveSubagentConfig(projectId, input);
				updateState((current) => ({
					...current,
					subagentConfigs: result.subagents,
					subagentConfigsSaving: false,
					subagentConfigsError: undefined,
				}));
				showToast("智能体已保存");
				return true;
			} catch (error) {
				const message = errorMessage(error);
				if ((error as { code?: string }).code === "subagent_conflict") await refreshSubagentConfigs();
				updateState((current) => ({ ...current, subagentConfigsSaving: false, subagentConfigsError: message }));
				showToast(message);
				return false;
			}
		},
		[refreshSubagentConfigs, showToast, updateState],
	);

	const deleteSubagentConfig = useCallback(
		async (config: SubagentConfig): Promise<boolean> => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId || config.scope === "builtin" || !config.contentHash) return false;
			updateState((current) => ({ ...current, subagentConfigsSaving: true, subagentConfigsError: undefined }));
			try {
				const result = await webApi.deleteSubagentConfig(projectId, {
					name: config.name,
					scope: config.scope,
					contentHash: config.contentHash,
				});
				updateState((current) => ({
					...current,
					subagentConfigs: result.subagents,
					subagentConfigsSaving: false,
					subagentConfigsError: undefined,
				}));
				showToast("智能体已删除");
				return true;
			} catch (error) {
				const message = errorMessage(error);
				if ((error as { code?: string }).code === "subagent_conflict") await refreshSubagentConfigs();
				updateState((current) => ({ ...current, subagentConfigsSaving: false, subagentConfigsError: message }));
				showToast(message);
				return false;
			}
		},
		[refreshSubagentConfigs, showToast, updateState],
	);

	const importHarnessResources = useCallback(
		async (itemIds: string[]) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId || itemIds.length === 0) return;
			updateState((current) => ({
				...current,
				harnessImporting: true,
				harnessImportsError: undefined,
				harnessImportResult: undefined,
			}));
			try {
				const result = await webApi.importHarnessResources(projectId, itemIds);
				updateState((current) => ({ ...current, harnessImporting: false, harnessImportResult: result }));
				await refreshHarnessImports();
				await refreshSkills();
				await refreshSubagentConfigs();
				showToast(result.imported > 0 ? `已迁移 ${result.imported} 项资源` : "没有可迁移的资源");
			} catch (error) {
				const message = errorMessage(error);
				updateState((current) => ({ ...current, harnessImporting: false, harnessImportsError: message }));
				showToast(message);
			}
		},
		[refreshHarnessImports, refreshSkills, refreshSubagentConfigs, showToast, updateState],
	);

	const refreshSecuritySettings = useCallback(async () => {
		updateState((current) => ({ ...current, securitySettingsLoading: true, securitySettingsError: undefined }));
		try {
			const securitySettings = await webApi.securitySettings();
			updateState((current) => ({
				...current,
				securitySettings,
				securitySettingsLoading: false,
				securitySettingsError: undefined,
			}));
		} catch (error) {
			const message = errorMessage(error);
			updateState((current) => ({ ...current, securitySettingsLoading: false, securitySettingsError: message }));
			showToast(message);
		}
	}, [showToast, updateState]);

	const saveSecuritySettings = useCallback(
		async (input: { host: string; allowedHosts: string[]; port: number; runtimePort: number; password?: string }) => {
			updateState((current) => ({ ...current, securitySettingsSaving: true, securitySettingsError: undefined }));
			try {
				const result = await webApi.saveSecuritySettings(input);
				if (input.password?.trim()) webApi.setToken(input.password);
				updateState((current) => ({
					...current,
					securitySettings: result,
					securitySettingsSaving: false,
					securitySettingsError: undefined,
				}));
				showToast("安全与访问设置已保存，Gateway 正在重启；Runtime 会话不会停止");
			} catch (error) {
				const message = errorMessage(error);
				updateState((current) => ({ ...current, securitySettingsSaving: false, securitySettingsError: message }));
				showToast(message);
			}
		},
		[showToast, updateState],
	);

	const saveBranding = useCallback(
		async (input: { name: string; logo?: string | null }) => {
			updateState((current) => ({ ...current, brandingSaving: true, brandingError: undefined }));
			try {
				const branding = await webApi.saveBranding(input);
				updateState((current) => ({
					...current,
					branding,
					brandingSaving: false,
					brandingError: undefined,
				}));
				showToast("系统设置已保存");
			} catch (error) {
				const message = errorMessage(error);
				updateState((current) => ({ ...current, brandingSaving: false, brandingError: message }));
				showToast(message);
			}
		},
		[showToast, updateState],
	);

	const refreshHostInstructions = useCallback(async () => {
		updateState((current) => ({ ...current, hostInstructionsLoading: true, hostInstructionsError: undefined }));
		try {
			const result: HostInstructionsResponse = await webApi.hostInstructions();
			updateState((current) => ({
				...current,
				hostInstructions: result.instructions,
				hostInstructionsLoading: false,
				hostInstructionsError: undefined,
			}));
		} catch (error) {
			const message = errorMessage(error);
			updateState((current) => ({ ...current, hostInstructionsLoading: false, hostInstructionsError: message }));
			showToast(message);
		}
	}, [showToast, updateState]);

	const saveHostInstruction = useCallback(
		async (content: string, expectedHash?: string) => {
			updateState((current) => ({ ...current, hostInstructionSaving: true, hostInstructionsError: undefined }));
			try {
				const result = await webApi.saveHostInstruction(content, expectedHash);
				updateState((current) => ({
					...current,
					hostInstructions: result.instructions,
					hostInstructionSaving: false,
					hostInstructionsError: undefined,
					toast: "全局 AGENTS.md 已保存",
				}));
			} catch (error) {
				const message = errorMessage(error);
				if ((error as { code?: string }).code === "instruction_conflict") await refreshHostInstructions();
				updateState((current) => ({ ...current, hostInstructionSaving: false, hostInstructionsError: message }));
				showToast(message);
			}
		},
		[refreshHostInstructions, showToast, updateState],
	);

	const openSettings = useCallback(
		async (tab: SettingsTab = "appearance") => {
			updateState((current) => ({ ...current, settingsOpen: true, settingsTab: tab }));
			if (tab === "models" && stateRef.current.models.length === 0) {
				await refreshModelSettings();
			}
			if (tab === "instructions") await refreshHostInstructions();
			if (tab === "skills") await refreshSkills();
			if (tab === "subagents") {
				await Promise.all([
					refreshSubagentConfigs(),
					stateRef.current.modelOptions.length === 0 ? refreshModelSettings() : Promise.resolve(),
				]);
			}
			if (tab === "imports") await refreshHarnessImports();
			if (tab === "security") await refreshSecuritySettings();
			if (tab === "diagnostics") {
				updateState((current) => ({ ...current, diagnostics: undefined }));
				await refreshDiagnostics();
			}
			if (tab === "about" && !stateRef.current.about) {
				const result = (await webApi.about()) as Record<string, unknown>;
				updateState((current) => ({ ...current, about: result }));
			}
		},
		[
			refreshHarnessImports,
			refreshHostInstructions,
			refreshModelSettings,
			refreshSecuritySettings,
			refreshSkills,
			refreshSubagentConfigs,
			refreshDiagnostics,
			updateState,
		],
	);
	const closeSettings = useCallback(
		() => updateState((current) => ({ ...current, settingsOpen: false })),
		[updateState],
	);
	const setTheme = useCallback(
		(theme: ThemeMode) => {
			applyTheme(theme);
			updateState((current) => ({ ...current, theme }));
		},
		[updateState],
	);
	const setComposerMode = useCallback(
		(composerMode: ComposerMode) => updateState((current) => ({ ...current, composerMode })),
		[updateState],
	);
	const openSubagent = useCallback(
		async (agentId: string) => {
			const sessionId = stateRef.current.sessionId;
			if (!sessionId) return;
			updateState((current) => {
				const snapshot = current.subagents.find((candidate) => candidate.agentId === agentId);
				return {
					...current,
					inspectorOpen: true,
					inspectorMode: "subagent",
					selectedSubagentId: agentId,
					subagentViews:
						current.subagentViews[agentId] || !snapshot
							? current.subagentViews
							: { ...current.subagentViews, [agentId]: createSubagentConversationState(snapshot) },
				};
			});
			try {
				await loadSubagent(agentId, sessionId);
			} catch (error) {
				showToast(errorMessage(error));
			}
		},
		[loadSubagent, showToast, updateState],
	);
	const closeSubagent = useCallback(
		() => updateState((current) => ({ ...current, selectedSubagentId: undefined, inspectorMode: "runs" })),
		[updateState],
	);
	const loadEarlierSubagentAction = useCallback(
		async () => loadEarlierSubagent(stateRef.current.selectedSubagentId ?? ""),
		[loadEarlierSubagent],
	);
	const abortSubagent = useCallback(async () => {
		const current = stateRef.current;
		if (!current.sessionId || !current.selectedSubagentId) return;
		await webApi.abortSubagent(current.sessionId, current.selectedSubagentId);
	}, []);
	const continueSubagent = useCallback(async (text: string) => {
		const current = stateRef.current;
		const normalized = text.trim();
		if (!current.sessionId || !current.selectedSubagentId || !normalized) return;
		await webApi.continueSubagent(current.sessionId, current.selectedSubagentId, normalized);
	}, []);
	const respondUiRequest = useCallback(
		async (request: UiRequestEvent, response: { value?: unknown; confirmed?: boolean; cancelled?: boolean }) => {
			await webApi.uiResponse(request.id, response);
			updateState((current) => ({
				...current,
				pendingUiRequests: current.pendingUiRequests.filter((candidate) => candidate.id !== request.id),
			}));
		},
		[updateState],
	);

	selectSessionRef.current = selectSession;
	loadSessionTreeRef.current = loadSessionTree;
	loadProjectTrustRef.current = loadProjectTrust;
	loadProjectTreeRef.current = loadProjectTree;
	loadGitStatusRef.current = loadGitStatus;
	loadGitBranchesRef.current = loadGitBranches;
	loadGitHistoryRef.current = loadGitHistory;
	refreshProjectFilesRef.current = refreshProjectFiles;
	refreshModelOptionsRef.current = refreshModelOptions;
	refreshModelSettingsRef.current = refreshModelSettings;

	const actions = useMemo(
		() => ({
			selectProject,
			selectSession,
			createSession,
			sendMessage,
			queueAction,
			abort,
			openInspector,
			closeInspector,
			openSettings,
			refreshBranding,
			saveBranding,
			closeSettings,
			signOut,
			setComposerMode,
			openSubagent,
			closeSubagent,
			loadEarlierSubagent: loadEarlierSubagentAction,
			abortSubagent,
			continueSubagent,
			loadEarlier,
			loadTranscript,
			loadGitStatus,
			loadGitRepositoryStats,
			loadGitBranches,
			loadGitHistory,
			loadGitCommit,
			closeGitCommit,
			mutateGit,
			closeGitCredentialAuthorization,
			loadGitDiff,
			closeGitDiff,
			loadProjectTree,
			openFile,
			openResource,
			saveFile,
			closeFilePreview,
			loadSessionTree,
			navigateTree,
			loadDirectory,
			addProject,
			updateProject,
			addProjectGroup,
			updateProjectGroup,
			removeProjectGroup,
			setProjectGroup,
			reorderProjectGroups,
			reorderProjects,
			reorderSessions,
			removeProject,
			deleteSession,
			deleteSessions,
			renameSession,
			setSessionPinned,
			fork,
			reloadResources,
			compact,
			exportSession,
			updateModel,
			updateThinking,
			setModelProviderVisibility,
			saveModelProvider,
			removeModelProvider,
			saveProviderModel,
			setProviderModelEnabled,
			syncModelProvider,
			refreshSkills,
			refreshDiagnostics,
			refreshSecuritySettings,
			saveSecuritySettings,
			restartDiagnosticService,
			refreshHarnessImports,
			importHarnessResources,
			refreshSubagentConfigs,
			saveSubagentConfig,
			deleteSubagentConfig,
			toggleSkill,
			refreshHostInstructions,
			saveHostInstruction,
			setTheme,
			setProjectTrust,
			respondUiRequest,
			showToast,
		}),
		[
			selectProject,
			selectSession,
			createSession,
			sendMessage,
			queueAction,
			abort,
			openInspector,
			closeInspector,
			openSettings,
			refreshBranding,
			saveBranding,
			closeSettings,
			signOut,
			setComposerMode,
			openSubagent,
			closeSubagent,
			loadEarlierSubagentAction,
			abortSubagent,
			continueSubagent,
			loadEarlier,
			loadTranscript,
			loadGitStatus,
			loadGitRepositoryStats,
			loadGitBranches,
			loadGitHistory,
			loadGitCommit,
			closeGitCommit,
			mutateGit,
			closeGitCredentialAuthorization,
			loadGitDiff,
			closeGitDiff,
			loadProjectTree,
			openFile,
			openResource,
			saveFile,
			closeFilePreview,
			loadSessionTree,
			navigateTree,
			loadDirectory,
			addProject,
			updateProject,
			addProjectGroup,
			updateProjectGroup,
			removeProjectGroup,
			setProjectGroup,
			reorderProjectGroups,
			reorderProjects,
			reorderSessions,
			removeProject,
			deleteSession,
			deleteSessions,
			renameSession,
			setSessionPinned,
			fork,
			reloadResources,
			compact,
			exportSession,
			updateModel,
			updateThinking,
			setModelProviderVisibility,
			saveModelProvider,
			removeModelProvider,
			saveProviderModel,
			setProviderModelEnabled,
			syncModelProvider,
			refreshSkills,
			refreshDiagnostics,
			refreshSecuritySettings,
			saveSecuritySettings,
			restartDiagnosticService,
			refreshHarnessImports,
			importHarnessResources,
			refreshSubagentConfigs,
			saveSubagentConfig,
			deleteSubagentConfig,
			toggleSkill,
			refreshHostInstructions,
			saveHostInstruction,
			setTheme,
			setProjectTrust,
			respondUiRequest,
			showToast,
		],
	);

	useEffect(() => {
		if (!state.currentProjectId || !state.sessionId) return;
		saveLastSession(state.currentProjectId, state.sessionId);
	}, [state.currentProjectId, state.sessionId]);

	useEffect(() => {
		applyTheme(state.theme);
	}, [state.theme]);


	useEffect(() => {
		if (!state.connected || !state.sessionId) {
			runtimeRecoverySessionRef.current = undefined;
			return;
		}
		if (!state.readOnly) {
			runtimeRecoverySessionRef.current = undefined;
			return;
		}
		if (selectionInFlightRef.current === state.sessionId || runtimeRecoverySessionRef.current === state.sessionId)
			return;
		const sessionId = state.sessionId;
		runtimeRecoverySessionRef.current = sessionId;
		void ensureSessionControl(sessionId).catch(() => {});
	}, [ensureSessionControl, state.connected, state.readOnly, state.sessionId]);

	useEffect(() => {
		const handleOffline = () => {
			if (reconnectTimerRef.current) {
				window.clearTimeout(reconnectTimerRef.current);
				reconnectTimerRef.current = undefined;
			}
			streamGenerationRef.current += 1;
			settleSessionSubscriptionWaiters("closed");
			const socket = socketRef.current;
			socketRef.current = undefined;
			if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
			updateState((current) => ({
				...current,
				...offlineConnectionState(),
				lease: undefined,
				readOnly: Boolean(current.sessionId),
				sessionReady: false,
			}));
		};
		const handleOnline = () => {
			if (!webApi.hasToken()) {
				updateState((current) => ({ ...current, networkOnline: true }));
				return;
			}
			updateState((current) => ({
				...current,
				...reconnectingConnectionState(),
				lease: undefined,
				readOnly: Boolean(current.sessionId),
				sessionReady: false,
			}));
			resumeConnectionRef.current();
		};
		window.addEventListener("offline", handleOffline);
		window.addEventListener("online", handleOnline);
		return () => {
			window.removeEventListener("offline", handleOffline);
			window.removeEventListener("online", handleOnline);
		};
	}, [settleSessionSubscriptionWaiters, updateState]);

	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.visibilityState !== "visible") return;
			flushPendingTextProgress();
			resumeConnectionRef.current();
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, [flushPendingTextProgress]);

	useEffect(() => {
		mountedRef.current = true;
		void initialize();
		return () => {
			mountedRef.current = false;
			streamGenerationRef.current += 1;
			settleSessionSubscriptionWaiters("closed");
			sessionDetailCacheRef.current.clear();
			sessionDetailSeqRef.current.clear();
			socketRef.current?.close();
			socketRef.current = undefined;
			if (pendingTextFrameRef.current !== undefined) {
				window.cancelAnimationFrame(pendingTextFrameRef.current);
				pendingTextFrameRef.current = undefined;
			}
			if (pendingTextTimeoutRef.current !== undefined) {
				window.clearTimeout(pendingTextTimeoutRef.current);
				pendingTextTimeoutRef.current = undefined;
			}
			pendingTextProgressRef.current = [];
			if (reconnectTimerRef.current) {
				window.clearTimeout(reconnectTimerRef.current);
				reconnectTimerRef.current = undefined;
			}
			if (transcriptTimerRef.current) window.clearTimeout(transcriptTimerRef.current);
			if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
		};
	}, [initialize, settleSessionSubscriptionWaiters]);

	return {
		state,
		actions,
		currentProject,
		currentSessions,
		currentSessionSummary,
		orderedProjects,
		hasActiveOperation,
		sessionTitle,
		transcriptText,
		initialize,
		submitToken,
		signOut,
		selectProject,
		selectSession,
		createSession,
		sendMessage,
		queueAction,
		abort,
		openSubagent,
		closeSubagent,
		loadEarlierSubagent: loadEarlierSubagentAction,
		abortSubagent,
		continueSubagent,
		deleteSession,
		deleteSessions,
		renameSession,
		setSessionPinned,
		fork,
		reloadResources,
		compact,
		exportSession,
		updateModel,
		updateThinking,
		setModelProviderVisibility,
		syncModelProvider,
		saveModelProvider,
		removeModelProvider,
		saveProviderModel,
		setProviderModelEnabled,
		refreshSkills,
		refreshDiagnostics,
		restartDiagnosticService,
		toggleSkill,
		refreshHarnessImports,
		importHarnessResources,
		refreshSubagentConfigs,
		saveSubagentConfig,
		deleteSubagentConfig,
		refreshHostInstructions,
		saveHostInstruction,
		refreshModelSettings,
		refreshBranding,
		refreshSecuritySettings,
		saveBranding,
		saveSecuritySettings,
		loadGitStatus,
		loadGitRepositoryStats,
		loadGitBranches,
		loadGitHistory,
		loadGitCommit,
		closeGitCommit,
		mutateGit,
		closeGitCredentialAuthorization,
		loadGitDiff,
		closeGitDiff,
		openInspector,
		closeInspector,
		loadProjectTree,
		openFile,
		openResource,
		saveFile,
		closeFilePreview,
		loadSessionTree,
		navigateTree,
		loadProjectTrust,
		setProjectTrust,
		loadDirectory,
		addProject,
		updateProject,
		addProjectGroup,
		updateProjectGroup,
		removeProjectGroup,
		setProjectGroup,
		reorderProjectGroups,
		reorderProjects,
		reorderSessions,
		removeProject,
		openSettings,
		closeSettings,
		setTheme,
		setComposerMode,
		loadTranscript,
		loadEarlier,
		respondUiRequest,
		showToast,
	};
}

function hasActive(operation: WebOperation | undefined): boolean {
	return Boolean(operation && ACTIVE_OPERATION_STATUSES.has(operation.status));
}
