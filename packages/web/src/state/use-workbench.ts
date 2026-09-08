import type { SessionProgress, ToolActivity, ToolActivityState, ToolDiff } from "@lystar/code-web-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UnauthorizedError, webApi } from "../adapters/host-protocol/api.ts";
import {
	applyPromptAccepted,
	canSendPrompt,
	type PendingUserPrompt,
	committedToolCallIds,
	reconcileCommittedTurn,
	reconcilePendingUserPrompts,
} from "./chat-lifecycle.ts";
import {
	reconcileCompactionState,
	restoreCompactionState,
	type LiveCompactionState,
	updateCompactionState,
} from "./compaction-state.ts";
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
import { shouldJoinLiveToolBatch } from "./tool-batching.ts";
import {
	mergeTranscriptEntries,
	mergeTranscriptPage,
	transcriptRenderIdOverrides,
	type WorkbenchTranscriptItem,
} from "./transcript-state.ts";
import type {
	GatewayEvent,
	HarnessImportsResponse,
	HarnessImportResultResponse,
	HostInstructionsResponse,
	ProjectInstruction,
	PromptAttachment,
	ProjectSkillsResponse,
	ProjectTreeResponse,
	UiRequestEvent,
	WebLease,
	WebModelProviderInput,
	WebOperation,
	WebProject,
	WebProviderModelInput,
	WebSessionSnapshot,
	WebSessionSummary,
	WebTranscriptItem,
} from "../types.ts";
const TRANSCRIPT_PAGE_SIZE = 120;

export type InspectorMode = "runs" | "files" | "tree" | "git";
export type ComposerMode = "prompt" | "steer" | "follow-up";
export type ThemeMode = "system" | "light" | "dark";
export type SettingsTab = "appearance" | "instructions" | "skills" | "models" | "imports" | "diagnostics" | "about";

export interface LiveTool {
	id: string;
	name: string;
	batchId: string;
	summary: string;
	state: ToolActivityState;
	result?: string;
	status: "running" | "success" | "error";
	inputPreview?: boolean;
	diff?: ToolDiff;
}

export type LiveTurnItem =
	| { id: string; kind: "text"; parts: readonly string[]; turnId: number }
	| { id: string; kind: "thinking"; parts: readonly string[]; turnId: number }
	| { id: string; kind: "tools"; turnId: number; batchId: string; toolIds: string[] };

type LiveTextProgress = Extract<SessionProgress, { type: "assistant_delta" | "thinking_delta" }>;
type PendingTextProgress = { selection: number; progress: LiveTextProgress };
type SessionSubscriptionResult = "ready" | "gap" | "timeout";
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
): LiveTurnItem[] {
	if (!text) return items;
	const last = items.at(-1);
	if (last?.kind === kind && last.turnId === turnId)
		return [...items.slice(0, -1), { ...last, parts: [...last.parts, text] }];
	return [...items, { id, kind, parts: [text], turnId }];
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
	return state === "success" ? "success" : state === "error" || state === "cancelled" || state === "interrupted" ? "error" : "running";
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

function liveToolFromActivity(
	activity: ToolActivity,
	previous: LiveTool | undefined,
	batchId: string,
): LiveTool {
	const terminal = activity.state === "success" || activity.state === "error" || activity.state === "cancelled" || activity.state === "interrupted";
	return {
		id: activity.toolCallId,
		name: activity.name,
		batchId,
		summary: activity.summary || previous?.summary || activity.name,
		state: activity.state,
		status: toolActivityStatus(activity.state),
		inputPreview: activity.inputPreview,
		result: activity.output ?? activity.progress ?? activity.error ?? previous?.result,
		...(terminal ? { diff: activity.diff } : { diff: mergeToolDiff(previous?.diff, activity.diff) }),
	};
}

function nextLiveToolBatchId(current: WorkbenchState, toolName: string, turnId: number, fallback: string): string {
	const last = current.liveTurnItems.at(-1);
	if (last?.kind !== "tools" || last.turnId !== turnId) return fallback;
	const previousToolId = last.toolIds.at(-1);
	const previousTool = previousToolId ? current.liveTools[previousToolId] : undefined;
	return shouldJoinLiveToolBatch(previousTool?.name, toolName, last?.turnId, turnId) ? last.batchId : fallback;
}

function applyToolActivityState(current: WorkbenchState, activity: ToolActivity): WorkbenchState {
	if (current.toolActivityEpoch === activity.activityEpoch && (current.toolActivityRevision ?? -1) >= activity.revision) {
		return current;
	}
	const newEpoch = current.toolActivityEpoch !== activity.activityEpoch;
	const liveTools = newEpoch ? {} : current.liveTools;
	const previous = liveTools[activity.toolCallId];
	const batchId =
		previous?.batchId ??
		nextLiveToolBatchId(current, activity.name, current.liveTurnId, `live-tool-batch:${activity.activityEpoch}:${activity.toolCallId}`);
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

function restoreRuntimeActivities(current: WorkbenchState, snapshot: WebSessionSnapshot): WorkbenchState {
	const next = {
		...current,
		liveCompaction: restoreCompactionState(current.liveCompaction, snapshot.phase, current.transcript),
	};
	return restoreToolActivities(next, snapshot);
}

interface GitFileDiffStats {
	additions: number;
	deletions: number;
}

export interface WorkbenchState {
	loading: boolean;
	connected: boolean;
	reconnecting: boolean;
	connectionError: string;
	authRequired: boolean;
	projects: WebProject[];
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
	currentOperation?: WebOperation;
	operations: WebOperation[];
	liveTools: Record<string, LiveTool>;
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
	gitStatus?: {
		root: string;
		branch?: string;
		upstream?: string;
		ahead: number;
		behind: number;
		files: Array<{
			path: string;
			indexStatus: string;
			worktreeStatus: string;
			staged: boolean;
			unstaged: boolean;
			untracked: boolean;
			conflicted: boolean;
		}>;
	};
	gitFileStats: Record<string, GitFileDiffStats>;
	gitDiff?: {
		path?: string;
		staged: boolean;
		diff: string;
		additions: number;
		deletions: number;
		original?: string;
		modified?: string;
		contentTruncated?: boolean;
	};
	gitLoading: boolean;
	gitDiffLoading: boolean;
	fileTree?: ProjectTreeResponse;
	fileTreeRootPath?: string;
	fileTreeCache: Record<string, ProjectTreeResponse>;
	fileTreeLoading: boolean;
	filePath?: string;
	fileContent?: {
		kind: "text" | "image";
		path: string;
		mimeType: string;
		byteLength: number;
		content?: string;
		data?: string;
	};
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
	harnessImportScope: "user" | "project";
	harnessImporting: boolean;
	harnessImportResult?: HarnessImportResultResponse;
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
	| "liveTurnItems"
	| "liveTurnId"
	| "liveTurnStartRevision"
	| "liveTurnActive"
	| "liveCompaction"
	| "pendingUserPrompts"
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
		liveTurnItems: state.liveTurnItems,
		liveTurnId: state.liveTurnId,
		liveTurnStartRevision: state.liveTurnStartRevision,
		liveTurnActive: state.liveTurnActive,
		liveCompaction: state.liveCompaction,
		pendingUserPrompts: state.pendingUserPrompts,
		statusText: state.statusText,
	};
}

const SESSION_DETAIL_CACHE_LIMIT = 8;

function cacheSessionDetail(cache: Map<string, SessionDetailCache>, sessionId: string, detail: SessionDetailCache): void {
	cache.delete(sessionId);
	cache.set(sessionId, detail);
	while (cache.size > SESSION_DETAIL_CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

function readCachedSessionDetail(
	cache: Map<string, SessionDetailCache>,
	sessionId: string,
): SessionDetailCache | undefined {
	const detail = cache.get(sessionId);
	if (!detail) return undefined;
	cache.delete(sessionId);
	cache.set(sessionId, detail);
	return detail;
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

function savedHiddenModelProviders(): string[] {
	if (typeof window === "undefined") return [];
	try {
		const value: unknown = JSON.parse(window.localStorage.getItem(MODEL_PROVIDER_VISIBILITY_KEY) ?? "[]");
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function applyTheme(theme: ThemeMode): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.theme = theme === "system" ? "" : theme;
	window.localStorage.setItem(THEME_KEY, theme);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

function sessionSnapshotIsActive(snapshot: WebSessionSnapshot): boolean {
	return (
		snapshot.activity === "running" ||
		snapshot.activity === "waiting_for_input" ||
		["turn", "compaction", "retry", "waiting_for_input"].includes(snapshot.phase)
	);
}

function mergeSessionSummaries(
	current: readonly WebSessionSummary[],
	incoming: readonly WebSessionSummary[],
): WebSessionSummary[] {
	const currentById = new Map(current.map((session) => [session.id, session]));
	return incoming.map((next) => {
		const previous = currentById.get(next.id);
		if (Object.hasOwn(next, "name")) return next;
		return previous?.name?.trim() ? { ...next, name: previous.name } : next;
	});
}

function updateSessionSummaryName(
	projects: WebProject[],
	sessionId: string,
	name: string | undefined,
): WebProject[] {
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

export function transcriptText(item: WebTranscriptItem): string {
	return item.view && "text" in item.view ? item.view.text : "";
}

function parseGitDiffStats(diff: string): Map<string, GitFileDiffStats> {
	const stats = new Map<string, GitFileDiffStats>();
	let currentPath: string | undefined;
	for (const line of diff.split("\n")) {
		const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line) ?? /^diff --git "a\/(.+)" "b\/(.+)"$/u.exec(line);
		if (match) {
			currentPath = match[2];
			stats.set(currentPath, { additions: 0, deletions: 0 });
			continue;
		}
		if (!currentPath) continue;
		const entry = stats.get(currentPath);
		if (!entry) continue;
		if (line.startsWith("+") && !line.startsWith("+++")) entry.additions += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) entry.deletions += 1;
	}
	return stats;
}

function textLineCount(content: string): number {
	if (!content) return 0;
	const lines = content.split(/\r\n?|\n/gu);
	return content.endsWith("\n") || content.endsWith("\r") ? lines.length - 1 : lines.length;
}

function hasLiveTurnContent(state: Pick<WorkbenchState, "liveTools" | "liveTurnItems">): boolean {
	return Boolean(Object.keys(state.liveTools).length || state.liveTurnItems.length);
}

function shouldClearLiveTurn(state: WorkbenchState): boolean {
	return state.liveTurnActive === false && hasLiveTurnContent(state);
}

function shouldRefreshCompletedTurn(state: WorkbenchState): boolean {
	return !state.transcriptPageLoaded || Boolean(state.liveTurnItems.length);
}

function initialState(): WorkbenchState {
	return {
		loading: false,
		connected: false,
		reconnecting: false,
		connectionError: "",
		authRequired: !webApi.hasToken(),
		projects: [],
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
		operations: [],
		liveTools: {},
		liveTurnItems: [],
		liveCompaction: undefined,
		liveTurnId: 0,
		unreadSessionIds: {},
		gitFileStats: {},
		statusText: "",
		pendingUiRequests: [],
		inspectorOpen: typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches,
		inspectorMode: "runs",
		gitLoading: false,
		gitDiffLoading: false,
		fileTreeLoading: false,
		fileTreeRootPath: undefined,
		fileTreeCache: {},
		fileLoading: false,
		sessionTree: [],
		sessionTreeLoading: false,
		directoryLoading: false,
		settingsOpen: false,
		settingsTab: "appearance",
		skills: [],
		skillDiagnostics: undefined,
		skillsLoading: false,
		hostInstructions: [],
		hostInstructionsLoading: false,
		hostInstructionSaving: false,
		harnessImportsLoading: false,
		harnessImportScope: "user",
		harnessImporting: false,
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
	const transcriptTimerRef = useRef<number | undefined>(undefined);
	const transcriptRefreshPendingRef = useRef<string | undefined>(undefined);
	const liveToolBatchRef = useRef(0);
	const liveTurnItemRef = useRef(0);
	const pendingTextProgressRef = useRef<PendingTextProgress[]>([]);
	const pendingTextFrameRef = useRef<number | undefined>(undefined);
	const transcriptRequestRef = useRef(0);
	const fileRequestRef = useRef(0);
	const gitDiffRequestRef = useRef(0);
	const pendingUserPromptRef = useRef(0);
	const projectRefreshRef = useRef(new Map<string, { promise: Promise<void>; rerun: boolean }>());
	const toastTimerRef = useRef<number | undefined>(undefined);
	const selectionRef = useRef(0);
	const selectionInFlightRef = useRef<string | undefined>(undefined);
	const sessionDetailCacheRef = useRef(new Map<string, SessionDetailCache>());
	const sessionDetailSeqRef = useRef(new Map<string, number>());
	const sessionSubscriptionWaitersRef = useRef(new Map<string, Set<SessionSubscriptionWaiter>>());
	const initializePromiseRef = useRef<Promise<void> | undefined>(undefined);
	const runtimeRecoverySessionRef = useRef<string | undefined>(undefined);
	const selectSessionRef = useRef<(sessionId: string) => Promise<void>>(async () => {});
	const loadSessionTreeRef = useRef<() => Promise<void>>(async () => {});
	const loadProjectTrustRef = useRef<() => Promise<void>>(async () => {});
	const loadProjectTreeRef = useRef<(path?: string) => Promise<void>>(async () => {});

	const updateState = useCallback((update: WorkbenchState | ((current: WorkbenchState) => WorkbenchState)) => {
		const next = typeof update === "function" ? update(stateRef.current) : update;
		stateRef.current = next;
		setState(next);
		return next;
	}, []);


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
			capabilities: readonly string[];
			connection: { connected: boolean; host: string; productVersion?: string };
			pendingUiRequests: UiRequestEvent[];
			operations: WebOperation[];
			leases?: Array<{ sessionId: string; lease: WebLease }>;
		}) => {
			updateState((current) => {
				const nextLease = bootstrapLeaseForSession(current.sessionId, current.lease, data.leases ?? []);
				const operations = mergeOperationSnapshots(current.operations, data.operations);
				const projects = mergeProjectSessions(current.projects, data.projects);
				return {
					...current,
					projects: current.session
						? updateSessionSummaryName(projects, current.sessionId!, current.session.name)
						: projects,
					operations,
					pendingUiRequests: data.pendingUiRequests,
					connected: data.connection.connected,
					connectionError: "",
					reconnecting: false,
					authRequired: false,
					lease: nextLease,
					readOnly: current.sessionId ? nextLease === undefined : current.readOnly,
					sessionReady: current.sessionId ? current.sessionReady && data.connection.connected : false,
					currentProjectId:
						current.currentProjectId && data.projects.some((project) => project.id === current.currentProjectId)
							? current.currentProjectId
							: undefined,
					currentOperation: operationForSession(operations, current.sessionId),
				};
			});
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
										pendingUserPrompts: [],
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
		async (sessionId = stateRef.current.sessionId, cursor?: string) => {
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
				updateState((current) => {
					const resultMatchesCurrentHistory =
						current.transcriptGeneration === undefined ||
						current.transcriptGeneration === result.transcriptGeneration;
					const currentHistoryChangedSinceRequest = isTranscriptResponseObsolete(requestedHistory, {
						generation: current.transcriptGeneration, leafId: current.transcriptLeafId,
					}, result);
					const sameHistory = resultMatchesCurrentHistory &&
						!(current.transcriptPageLoaded && current.transcriptGeneration === undefined && current.transcript.length > 0);
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
									...(shouldClearLiveTurn(current)
										? { liveTools: {}, liveTurnItems: [] }
										: {}),
							  };
					}
					if (!cursor && sameHistory && current.transcriptPageLoaded &&
						current.transcriptRevision === result.transcriptRevision && !shouldClearLiveTurn(current))
						return current.transcriptLoading ? { ...current, transcriptLoading: false } : current;
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
						: reconcilePendingUserPrompts(current.pendingUserPrompts, result.items);
					const completedTurnSynced = !cursor && shouldClearLiveTurn(current);
					const knownIds = new Set(current.transcript.map((item) => item.entryId));
					const next = !cursor && sameHistory
						? reconcileCommittedTurn(current, result.items.filter((item) => !knownIds.has(item.entryId)), result.transcriptRevision)
						: current;
					const updated = {
						...next,
						...transcriptWindow,
						transcriptLoading: false,
						transcriptError: undefined,
						pendingUserPrompts,
						transcriptGeneration: result.transcriptGeneration,
						transcriptRevision: sameHistory
							? Math.max(current.transcriptRevision ?? 0, result.transcriptRevision)
							: result.transcriptRevision,
						transcriptLeafId: cursor ? current.transcriptLeafId : result.leafId,
						...(completedTurnSynced ? { liveTools: {}, liveTurnItems: [] } : {}),
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
		[updateState],
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
					currentOperation:
						current.session && !sessionSnapshotIsActive(current.session)
							? undefined
							: operationForSession(operations, sessionId),
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
					currentOperation: sessionSnapshotIsActive(snapshot)
						? operationForSession(current.operations, sessionId)
						: undefined,
				};
				return restoreRuntimeActivities(next, snapshot);
			});
		},
		[updateState],
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
		updateState((current) => {
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
							),
							statusText: "正在思考",
						};
					case "user_message":
						return { ...current, statusText: "正在处理" };
					case "tool_state":
						return applyToolActivityState(current, progress.activity);
					case "tool_start": {
						const previous = current.liveTools[progress.toolCallId];
						const batchId =
							previous?.batchId ??
							nextLiveToolBatchId(current, progress.name, current.liveTurnId, `live-tool-batch:${liveToolBatchRef.current++}`);
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[progress.toolCallId]: {
									id: progress.toolCallId,
									name: progress.name,
									batchId,
									summary: progress.summary ?? previous?.summary ?? "正在执行",
									state: "running",
									status: "running",
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
						const batchId =
							previous?.batchId ??
							nextLiveToolBatchId(current, progress.name, current.liveTurnId, `live-tool-batch:${liveToolBatchRef.current++}`);
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[progress.toolCallId]: {
									id: progress.toolCallId,
									name: progress.name,
									batchId,
									summary: progress.summary || previous?.summary || "正在执行",
									state: "running",
									result: progress.summary,
									status: "running",
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
						const batchId =
							previous?.batchId ??
							nextLiveToolBatchId(current, progress.name, current.liveTurnId, `live-tool-batch:${liveToolBatchRef.current++}`);
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[progress.toolCallId]: {
									id: progress.toolCallId,
									name: progress.name,
									batchId,
									summary: previous?.summary ?? progress.summary,
									state: progress.status === "success" ? "success" : "error",
									result: progress.summary,
									status: progress.status,
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
					case "queue_update":
						return {
							...current,
							statusText:
								progress.steeringCount + progress.followUpCount > 0
									? `队列中 ${progress.steeringCount + progress.followUpCount} 项`
									: "正在处理",
						};
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
										liveTurnItems: [],
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
		const pending = pendingTextProgressRef.current
			.filter(({ selection }) => selection === selectionRef.current)
			.map(({ progress }) => progress);
		pendingTextProgressRef.current = [];
		let batch: LiveTextProgress | undefined;
		for (const progress of pending) {
			if (batch && batch.type === progress.type) {
				batch = { ...batch, text: batch.text + progress.text };
				continue;
			}
			if (batch) applyProgressNow(batch);
			batch = progress;
		}
		if (batch) applyProgressNow(batch);
	}, [applyProgressNow]);

	const applyProgress = useCallback(
		(progress: SessionProgress) => {
			if (progress.type === "assistant_delta" || progress.type === "thinking_delta") {
				pendingTextProgressRef.current.push({ selection: selectionRef.current, progress });
				if (pendingTextFrameRef.current === undefined) {
					pendingTextFrameRef.current = window.requestAnimationFrame(flushPendingTextProgress);
				}
				return;
			}
			flushPendingTextProgress();
			applyProgressNow(progress);
		},
		[applyProgressNow, flushPendingTextProgress],
	);

	const subscribeSessionAndWait = useCallback((sessionId: string): Promise<SessionSubscriptionResult> => {
		const socket = socketRef.current;
		if (!socket || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING))
			return Promise.resolve("timeout");
		return new Promise((resolve) => {
			const waiters = sessionSubscriptionWaitersRef.current.get(sessionId) ?? new Set<SessionSubscriptionWaiter>();
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
			webApi.subscribeSession(socket, sessionId, sessionDetailSeqRef.current.get(sessionId));
		});
	}, []);

	const completeSessionSubscription = useCallback(
		async (sessionId: string, result: SessionSubscriptionResult): Promise<boolean> => {
			if (result === "timeout") {
				const socket = socketRef.current;
				if (stateRef.current.sessionId === sessionId && socket?.readyState === WebSocket.OPEN)
					socket.close(4002, "会话订阅确认超时");
				return false;
			}
			if (result === "gap") {
				await Promise.all([loadSessionSnapshot(sessionId), loadSessionOperations(sessionId), loadTranscript(sessionId)]);
			}
			if (stateRef.current.sessionId === sessionId)
				updateState((current) => ({ ...current, sessionReady: true }));
			return true;
		},
		[loadSessionOperations, loadSessionSnapshot, loadTranscript, updateState],
	);

	const handleEvent = useCallback(
		(event: GatewayEvent) => {
			if (event.type === "session_subscription") {
				sessionDetailSeqRef.current.set(event.sessionId, event.seq);
				const waiters = sessionSubscriptionWaitersRef.current.get(event.sessionId);
				if (waiters) {
					for (const waiter of [...waiters]) waiter.resolve(event.gap ? "gap" : "ready");
				}
				const selected = stateRef.current.sessionId === event.sessionId;
				if (selected) updateState((current) => ({ ...current, sessionReady: !event.gap }));
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
			if (sequenceSessionId && "seq" in event && typeof event.seq === "number") {
				const previousSeq = sessionDetailSeqRef.current.get(sequenceSessionId);
				if (previousSeq !== undefined && event.seq <= previousSeq) return;
				sessionDetailSeqRef.current.set(sequenceSessionId, event.seq);
			}
			if (event.type === "session_stream") {
				if (event.sessionId !== stateRef.current.sessionId) return;
				updateState((current) => {
					const tools = current.liveTurnItems.filter((item) => item.kind === "tools");
					let items: LiveTurnItem[] = tools;
					if (event.thinking) items = appendLiveTextBlock(items, "thinking", event.thinking, `restored-thinking:${liveTurnItemRef.current++}`, current.liveTurnId);
					if (event.text) items = appendLiveTextBlock(items, "text", event.text, `restored-text:${liveTurnItemRef.current++}`, current.liveTurnId);
					return { ...current, liveTurnItems: items, liveTurnActive: Boolean(event.text || event.thinking || tools.length) };
				});
				return;
			}
			if (event.type === "bootstrap") {
				applyBootstrap(event.data);
				return;
			}
			if (event.type === "connection_state") {
				updateState((current) => ({
					...current,
					connected: event.connected,
					reconnecting: !event.connected,
					connectionError: event.message ?? (event.connected ? "" : "Web Host 连接已断开"),
					...(event.connected ? {} : { lease: undefined, readOnly: Boolean(current.sessionId), sessionReady: false }),
				}));
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
				if (
					event.sessionId === current.sessionId &&
					(isOlderSessionSnapshot(current.session, event.snapshot) || isSameSessionSnapshot(current.session, event.snapshot))
				)
					return;
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
									liveTurnItems: [],
								  }
							: {}),
					};
					return restoreRuntimeActivities(next, event.snapshot);
				});
				if (event.sessionId === stateRef.current.sessionId &&
					(event.snapshot.transcriptRevision > (stateRef.current.transcriptRevision ?? -1) || !stateRef.current.transcriptPageLoaded))
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
								liveCompaction: undefined,
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
					const updated = {
						...next,
						transcript: stale
							? current.transcript
							: mergeTranscriptEntries(current.transcript, event.items, false, renderIdOverrides),
						transcriptPageLoaded: current.transcriptPageLoaded,
						previousCursor: current.previousCursor,
						hasMorePrevious: current.hasMorePrevious,
						pendingUserPrompts: reconcilePendingUserPrompts(current.pendingUserPrompts, event.items),
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
					applyProgress(event.progress);
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
						...(selected && operationIsTerminal && ["prompt", "compact", "run_bash"].includes(event.operation.type)
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
					const payload = eventIsObject(event.payload) ? event.payload : undefined;
					showToast(
						typeof payload?.message === "string"
							? payload.message
							: typeof payload?.text === "string"
								? payload.text
								: "后台通知",
					);
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
			refreshProjectSessions,
			loadTranscript,
			scheduleTranscriptRefresh,
			showToast,
			updateState,
		],
	);

	const connectStream = useCallback(() => {
		const generation = streamGenerationRef.current + 1;
		streamGenerationRef.current = generation;
		if (reconnectTimerRef.current) {
			window.clearTimeout(reconnectTimerRef.current);
			reconnectTimerRef.current = undefined;
		}
		const previous = socketRef.current;
		socketRef.current = undefined;
		if (previous && previous.readyState !== WebSocket.CLOSED) previous.close();

		updateState((current) => (current.sessionId ? { ...current, sessionReady: false } : current));
		let socket: WebSocket;
		socket = webApi.connect(
			(event) => {
				if (streamGenerationRef.current !== generation || socketRef.current !== socket) return;
				handleEvent(event);
			},
			() => {
				if (streamGenerationRef.current !== generation || socketRef.current !== socket) return;
				socketRef.current = undefined;
				if (!mountedRef.current) return;
				updateState((current) => ({
					...current,
					connected: false,
					reconnecting: true,
					connectionError: "Web Host 连接已断开，正在重连",
					lease: undefined,
					readOnly: Boolean(current.sessionId),
					sessionReady: false,
				}));
				if (reconnectTimerRef.current) return;
				reconnectTimerRef.current = window.setTimeout(() => {
					reconnectTimerRef.current = undefined;
					if (
						mountedRef.current &&
						streamGenerationRef.current === generation &&
						!socketRef.current &&
						webApi.hasToken()
					)
						connectStream();
				}, 1200);
			},
		);
		const subscribeSelectedSession = () => {
			const sessionId = stateRef.current.sessionId;
			if (sessionId)
				void subscribeSessionAndWait(sessionId)
					.then((result) => completeSessionSubscription(sessionId, result))
					.catch((error) => showToast(errorMessage(error)));
		};
		socket.addEventListener("open", subscribeSelectedSession, { once: true });
		socketRef.current = socket;
		if (socket.readyState === WebSocket.OPEN) subscribeSelectedSession();
	}, [completeSessionSubscription, handleEvent, showToast, subscribeSessionAndWait, updateState]);

	const refreshModelSettings = useCallback(async () => {
		updateState((current) => ({ ...current, modelSettingsLoading: true, modelSettingsError: undefined }));
		try {
			const result = await webApi.models();
			const visibilityConfigured =
				typeof window !== "undefined" && window.localStorage.getItem(MODEL_PROVIDER_VISIBILITY_KEY) !== null;
			updateState((current) => {
				const hiddenModelProviders = visibilityConfigured
					? current.hiddenModelProviders
					: [
							...new Set([
								...current.hiddenModelProviders,
								...result.providers
									.filter((provider) => provider.builtIn && !provider.authenticated)
									.map((provider) => provider.id),
							]),
						];
				if (!visibilityConfigured && typeof window !== "undefined") {
					window.localStorage.setItem(MODEL_PROVIDER_VISIBILITY_KEY, JSON.stringify(hiddenModelProviders));
				}
				return {
					...current,
					models: result.models,
					providers: result.providers,
					hiddenModelProviders,
					modelSettingsLoading: false,
				};
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			updateState((current) => ({ ...current, modelSettingsLoading: false, modelSettingsError: message }));
			throw error;
		}
	}, [updateState]);

	const initialize = useCallback((): Promise<void> => {
		const existing = initializePromiseRef.current;
		if (existing) return existing;
		const promise = (async () => {
			if (!webApi.hasToken()) {
				updateState((current) => ({ ...current, authRequired: true, loading: false }));
				return;
			}
			updateState((current) => ({ ...current, loading: !current.transcriptPageLoaded, connectionError: "" }));
			try {
				const data = await webApi.bootstrap();
				applyBootstrap(data);
				connectStream();
				void refreshModelSettings().catch(() => undefined);
				const firstProject = data.projects.find(
					(project) => project.id === stateRef.current.currentProjectId && !project.archived,
				) ?? data.projects
					.filter((project) => !project.archived)
					.slice()
					.sort((left, right) => Number(right.pinned) - Number(left.pinned))[0];
				if (firstProject) {
					updateState((current) => ({ ...current, currentProjectId: firstProject.id }));
					const sessions = stateRef.current.projects.find((project) => project.id === firstProject.id)?.sessions ?? firstProject.sessions;
					const firstSession = sessions.find((session) => session.id === stateRef.current.sessionId) ?? sessions[0];
					if (firstSession) await selectSessionRef.current(firstSession.id);
				}
			} catch (error) {
				if (error instanceof UnauthorizedError) {
					webApi.clearToken();
					updateState((current) => ({ ...current, authRequired: true, connected: false }));
				} else {
					const message = errorMessage(error);
					updateState((current) => ({ ...current, connectionError: message }));
					showToast(message);
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
	}, [applyBootstrap, connectStream, refreshModelSettings, showToast, updateState]);

	const submitToken = useCallback(
		async (token: string) => {
			webApi.setToken(token);
			await initialize();
		},
		[initialize],
	);

	const signOut = useCallback(() => {
		streamGenerationRef.current += 1;
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
	}, [updateState]);

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
			if (previous.sessionId && previous.sessionId !== sessionId) {
				cacheSessionDetail(sessionDetailCacheRef.current, previous.sessionId, sessionDetailCacheFromState(previous));
			}
			const cached = readCachedSessionDetail(sessionDetailCacheRef.current, sessionId);
			const socket = socketRef.current;
			if (transcriptTimerRef.current) {
				window.clearTimeout(transcriptTimerRef.current);
				transcriptTimerRef.current = undefined;
			}
			transcriptRefreshPendingRef.current = undefined;
			transcriptRequestRef.current++;
			updateState((current) => ({
				...current,
				...(selectedProjectId ? { currentProjectId: selectedProjectId } : {}),
				sessionId,
				session: cached?.session,
				sessionError: undefined,
				lease: undefined,
				readOnly: true,
				sessionReady: false,
				transcriptLoading: cached?.transcriptPageLoaded ? false : true,
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
								liveTurnItems: [],
								liveTurnActive: undefined,
								liveTurnStartRevision: undefined,
							}
						: {}),
				pendingUserPrompts: current.sessionId === sessionId ? current.pendingUserPrompts : cached?.pendingUserPrompts ?? [],
				unreadSessionIds: Object.fromEntries(
					Object.entries(current.unreadSessionIds).filter(([id]) => id !== sessionId),
				) as Record<string, true>,
				statusText: cached ? "正在同步会话" : "正在打开会话",
				currentOperation: operationForSession(current.operations, sessionId),
				liveCompaction: cached?.liveCompaction,
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
			const transcriptPromise = loadTranscript(sessionId);
			void transcriptPromise.catch(() => {});
			try {
				const controlled = await webApi.control(sessionId);
				if (request !== selectionRef.current) {
					if (selectionInFlightRef.current === sessionId) selectionInFlightRef.current = undefined;
					return;
				}
				updateState((current) => {
					if (isOlderSessionSnapshot(current.session, controlled.snapshot)) return { ...current, lease: controlled.lease, sessionError: undefined };
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
						currentOperation: sessionSnapshotIsActive(controlled.snapshot)
							? operationForSession(current.operations, sessionId)
							: undefined,
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
							currentOperation: sessionSnapshotIsActive(snapshot)
								? operationForSession(current.operations, sessionId)
								: undefined,
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
		[completeSessionSubscription, loadSessionOperations, loadTranscript, showToast, subscribeSessionAndWait, updateState],
	);

	const selectProject = useCallback(
		async (projectId: string) => {
			const request = ++selectionRef.current;
			const previous = stateRef.current;
			if (previous.sessionId) {
				cacheSessionDetail(sessionDetailCacheRef.current, previous.sessionId, sessionDetailCacheFromState(previous));
				if (socketRef.current) webApi.unsubscribeSession(socketRef.current, previous.sessionId);
			}
			if (previous.sessionId && !ACTIVE_OPERATION_STATUSES.has(previous.currentOperation?.status ?? "")) {
				void webApi.release(previous.sessionId).catch(() => {});
			}
			updateState((current) => ({
				...current,
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
				liveTools: {},
				liveTurnItems: [],
				liveCompaction: undefined,
			}));
			try {
				await refreshProjectSessions(projectId);
			} catch (error) {
				showToast(errorMessage(error));
			}
			if (request !== selectionRef.current) return;
			await loadProjectTreeRef.current();
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
			updateState((value) => value.sessionId === sessionId ? { ...value, loadingEarlier: false } : value);
			if (transcriptRefreshPendingRef.current === sessionId) {
				transcriptRefreshPendingRef.current = undefined;
				scheduleTranscriptRefresh(sessionId);
			}
		}
	}, [loadTranscript, scheduleTranscriptRefresh, updateState]);

	const createSession = useCallback(async () => {
		const projectId = stateRef.current.currentProjectId;
		if (!projectId) return;
		const previousSessionId = stateRef.current.sessionId;
		const socket = socketRef.current;
		const result = await webApi.createSession(projectId);
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
		) => {
			const current = stateRef.current;
			if (!current.sessionId || !canSendPrompt(current)) return;
			if (hasActive(current.currentOperation) && mode === "prompt") mode = "follow-up";
			const value = text.trim();
			if (!value) return;
			const optimisticPrompt: PendingUserPrompt | undefined =
				mode === "prompt"
					? { id: `optimistic-user:${pendingUserPromptRef.current++}`, text: value }
					: undefined;
			if (optimisticPrompt)
				updateState((next) =>
					next.sessionId === current.sessionId
						? { ...next, pendingUserPrompts: [...next.pendingUserPrompts, optimisticPrompt] }
						: next,
				);
			try {
				const result = await webApi.prompt(current.sessionId, value, mode, attachments);
				updateState((next) => next.sessionId !== current.sessionId ? next : ({
					...applyPromptAccepted(next, current.sessionId!, result.operation),
					promptScrollRequest: (next.promptScrollRequest ?? 0) + 1,
				}));
			} catch (error) {
				if (optimisticPrompt)
					updateState((next) =>
						next.sessionId === current.sessionId
							? {
									...next,
									pendingUserPrompts: next.pendingUserPrompts.filter((prompt) => prompt.id !== optimisticPrompt.id),
							  }
							: next,
					);
				throw error;
			}
		},
		[updateState],
	);

	const abort = useCallback(async () => {
		const current = stateRef.current;
		if (!current.sessionId || !current.currentOperation) return;
		await webApi.abort(current.sessionId, current.currentOperation.operationId);
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
			const project = current.projects.find((candidate) => candidate.sessions.some((session) => session.id === sessionId));
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

	const deleteSession = useCallback(
		async (sessionId: string) => {
			const current = stateRef.current;
			const project = current.projects.find((candidate) => candidate.sessions.some((session) => session.id === sessionId));
			if (!project) return;
			if (current.sessionId === sessionId && hasActive(current.currentOperation)) {
				showToast("运行中的会话不能删除");
				return;
			}
			try {
				if (current.sessionId === sessionId && current.lease) await webApi.release(sessionId);
				await webApi.deleteSession(sessionId);
				const nextSessionId = project.sessions.find((session) => session.id !== sessionId)?.id;
				updateState((next) => {
					const projects = next.projects.map((candidate) =>
						candidate.id === project.id
							? { ...candidate, sessions: candidate.sessions.filter((session) => session.id !== sessionId) }
							: candidate,
					);
					if (next.sessionId !== sessionId) {
						sessionDetailCacheRef.current.delete(sessionId);
						sessionDetailSeqRef.current.delete(sessionId);
						return { ...next, projects };
					}
					sessionDetailCacheRef.current.delete(sessionId);
					sessionDetailSeqRef.current.delete(sessionId);
					return {
						...next,
						projects,
						sessionId: nextSessionId,
						session: undefined,
						lease: undefined,
						readOnly: false,
						sessionReady: false,
						pendingUserPrompts: [],
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
						liveTools: {},
						liveTurnItems: [],
						statusText: "",
						unreadSessionIds: Object.fromEntries(
							Object.entries(next.unreadSessionIds).filter(([id]) => id !== sessionId),
						) as Record<string, true>,
					};
				});
				if (current.sessionId === sessionId) {
					if (nextSessionId) await selectSession(nextSessionId);
					else await loadProjectTreeRef.current();
				}
			} catch (error) {
				showToast(errorMessage(error));
			}
		},
		[selectSession, showToast, updateState],
	);

	const fork = useCallback(
		async (entryId: string) => {
			const current = stateRef.current;
			if (!current.sessionId || current.readOnly) return;
			const oldSessionId = current.sessionId;
			const socket = socketRef.current;
			const result = await webApi.fork(oldSessionId, entryId);
			if (socket && oldSessionId !== result.session.id) webApi.unsubscribeSession(socket, oldSessionId);
			updateState((next) => ({
				...next,
				sessionId: result.session.id,
				session: result.session,
				lease: result.lease,
				readOnly: false,
				sessionReady: false,
				pendingUserPrompts: [],
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
				liveTools: {},
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
		[completeSessionSubscription, loadTranscript, refreshProjectSessions, showToast, subscribeSessionAndWait, updateState],
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

	const compact = useCallback(async (customInstructions?: string) => {
		const current = stateRef.current;
		if (!current.sessionId || current.readOnly) return;
		const result = await webApi.compact(current.sessionId, customInstructions);
		updateState((next) =>
			next.sessionId === current.sessionId && result.operation.sessionId === current.sessionId
				? { ...next, currentOperation: result.operation }
				: next,
		);
	}, [updateState]);

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
				updateState((next) => ({
					...next,
					projects: updateSessionSummaryName(next.projects, sessionId, controlled.snapshot.name),
					lease: controlled.lease,
					session: controlled.snapshot,
					readOnly: controlled.owned === false,
					currentOperation: operationForSession(next.operations, sessionId),
				}));
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

	const loadGitStatus = useCallback(async () => {
		const projectId = stateRef.current.currentProjectId;
		if (!projectId) return;
		updateState((current) => ({ ...current, gitLoading: true }));
		try {
			updateState((current) => ({ ...current, gitStatus: undefined, gitFileStats: {}, gitLoading: true }));
			const [result, worktreeDiff, stagedDiff] = await Promise.all([
				webApi.gitStatus(projectId),
				webApi.gitDiff(projectId, undefined, false).catch(() => undefined),
				webApi.gitDiff(projectId, undefined, true).catch(() => undefined),
			]);
			const stats = new Map<string, GitFileDiffStats>();
			for (const diff of [worktreeDiff?.diff, stagedDiff?.diff]) {
				if (!diff) continue;
				for (const [path, value] of parseGitDiffStats(diff)) {
					const current = stats.get(path) ?? { additions: 0, deletions: 0 };
					stats.set(path, {
						additions: current.additions + value.additions,
						deletions: current.deletions + value.deletions,
					});
				}
			}
			const untrackedStats = await Promise.all(
				result.files
					.filter((file) => file.untracked)
					.map(async (file) => {
						const content = await webApi.projectFile(projectId, file.path).catch(() => undefined);
						return [
							file.path,
							{
								additions: content?.kind === "text" && content.content ? textLineCount(content.content) : 0,
								deletions: 0,
							},
						] as const;
					}),
			);
			for (const [path, value] of untrackedStats) stats.set(path, value);
			updateState((current) => ({ ...current, gitStatus: result, gitFileStats: Object.fromEntries(stats) }));
		} finally {
			updateState((current) => ({ ...current, gitLoading: false }));
		}
	}, [updateState]);

	const loadGitDiff = useCallback(
		async (path?: string, staged = false) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			const requestId = ++gitDiffRequestRef.current;
			updateState((current) => ({ ...current, gitDiff: undefined, gitDiffLoading: true }));
			try {
				const result = await webApi.gitDiff(projectId, path, staged);
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
		async (mode: InspectorMode = "runs") => {
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
			updateState((current) => ({ ...current, fileTreeLoading: true }));
			try {
				const result = await webApi.projectTree(projectId, path);
				updateState((current) => ({
					...current,
					fileTree: preserveCurrentTree ? current.fileTree : result,
					fileTreeRootPath: preserveCurrentTree ? current.fileTreeRootPath : result.path,
					fileTreeCache: { ...current.fileTreeCache, [result.path]: result },
				}));
			} finally {
				updateState((current) => ({ ...current, fileTreeLoading: false }));
			}
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
				fileContent: undefined,
			}));
			try {
				const result = await webApi.projectFile(projectId, path).catch(() => webApi.externalFile(path));
				if (requestId !== fileRequestRef.current) return;
				updateState((current) => ({
					...current,
					fileContent: result,
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
		updateState((current) => ({ ...current, fileContent: undefined, filePath: undefined, fileLoading: false }));
	}, [updateState]);

	const openFile = openResource;

	const loadSessionTree = useCallback(async () => {
		const sessionId = stateRef.current.sessionId;
		if (!sessionId) return;
		updateState((current) => ({ ...current, sessionTreeLoading: true }));
		try {
			const result = await webApi.tree(sessionId);
			updateState((current) => ({ ...current, sessionTree: result.tree }));
		} finally {
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
			updateState((current) => ({ ...current, directoryLoading: true }));
			try {
				const result = await webApi.directories(path);
				updateState((current) => ({ ...current, directoryListing: result }));
			} finally {
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
				if (typeof window !== "undefined")
					window.localStorage.setItem(MODEL_PROVIDER_VISIBILITY_KEY, JSON.stringify(hiddenModelProviders));
				return { ...current, hiddenModelProviders };
			});
		},
		[updateState],
	);

	const saveModelProvider = useCallback(
		async (input: WebModelProviderInput) => {
			await webApi.modelProvider(input);
			await refreshModelSettings();
			showToast("Provider 配置已保存");
		},
		[refreshModelSettings, showToast],
	);

	const saveProviderModel = useCallback(
		async (provider: string, input: WebProviderModelInput) => {
			await webApi.providerModel(provider, input);
			await refreshModelSettings();
			showToast("模型配置已保存");
		},
		[refreshModelSettings, showToast],
	);

	const syncModelProvider = useCallback(
		async (provider: string) => {
			await webApi.syncModelProvider(provider);
			await refreshModelSettings();
			showToast("模型目录已同步");
		},
		[refreshModelSettings, showToast],
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

	const refreshHarnessImports = useCallback(
		async (targetScope: "user" | "project" = stateRef.current.harnessImportScope) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) {
				updateState((current) => ({ ...current, harnessImports: undefined, harnessImportsLoading: false, harnessImportsError: "请先选择一个项目" }));
				return;
			}
			updateState((current) => ({
				...current,
				harnessImportScope: targetScope,
				harnessImportsLoading: true,
				harnessImportsError: undefined,
				harnessImportResult: undefined,
			}));
			try {
				const result = await webApi.harnessImports(projectId, targetScope);
				updateState((current) => ({ ...current, harnessImports: result, harnessImportsLoading: false, harnessImportsError: undefined }));
			} catch (error) {
				const message = errorMessage(error);
				updateState((current) => ({ ...current, harnessImportsLoading: false, harnessImportsError: message }));
				showToast(message);
			}
		},
		[showToast, updateState],
	);

	const importHarnessResources = useCallback(
		async (
			targetScope: "user" | "project",
			itemIds: string[],
			ruleSelections?: Record<string, string[]>,
			replaceItemIds?: string[],
		) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId || itemIds.length === 0) return;
			updateState((current) => ({ ...current, harnessImporting: true, harnessImportsError: undefined }));
			try {
				const result = await webApi.importHarnessResources(projectId, targetScope, itemIds, ruleSelections, replaceItemIds);
				updateState((current) => ({ ...current, harnessImporting: false, harnessImportResult: result }));
				await refreshHarnessImports(targetScope);
				await refreshSkills();
				showToast(result.imported > 0 ? `已导入 ${result.imported} 项资源` : "没有导入新的资源");
			} catch (error) {
				const message = errorMessage(error);
				updateState((current) => ({ ...current, harnessImporting: false, harnessImportsError: message }));
				showToast(message);
			}
		},
		[refreshHarnessImports, refreshSkills, showToast, updateState],
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
			if (tab === "imports") await refreshHarnessImports();
			if (tab === "diagnostics") updateState((current) => ({ ...current, diagnostics: undefined }));
			if (tab === "diagnostics") {
				const result = (await webApi.diagnostics(stateRef.current.currentProjectId)) as Record<string, unknown>;
				updateState((current) => ({ ...current, diagnostics: result }));
			}
			if (tab === "about" && !stateRef.current.about) {
				const result = (await webApi.about()) as Record<string, unknown>;
				updateState((current) => ({ ...current, about: result }));
			}
		},
		[refreshHarnessImports, refreshHostInstructions, refreshModelSettings, refreshSkills, updateState],
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
		if (selectionInFlightRef.current === state.sessionId || runtimeRecoverySessionRef.current === state.sessionId) return;
		const sessionId = state.sessionId;
		runtimeRecoverySessionRef.current = sessionId;
		void ensureSessionControl(sessionId).catch(() => {});
	}, [ensureSessionControl, state.connected, state.readOnly, state.sessionId]);

	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.visibilityState !== "visible" || !webApi.hasToken()) return;
			const socket = socketRef.current;
			if (socket && socket.readyState !== WebSocket.CLOSED) return;
			if (reconnectTimerRef.current) {
				window.clearTimeout(reconnectTimerRef.current);
				reconnectTimerRef.current = undefined;
			}
			connectStream();
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, [connectStream]);

	useEffect(() => {
		mountedRef.current = true;
		void initialize();
		return () => {
			mountedRef.current = false;
			streamGenerationRef.current += 1;
			sessionDetailCacheRef.current.clear();
			sessionDetailSeqRef.current.clear();
			socketRef.current?.close();
			socketRef.current = undefined;
			if (pendingTextFrameRef.current !== undefined) {
				window.cancelAnimationFrame(pendingTextFrameRef.current);
				pendingTextFrameRef.current = undefined;
			}
			pendingTextProgressRef.current = [];
			if (reconnectTimerRef.current) {
				window.clearTimeout(reconnectTimerRef.current);
				reconnectTimerRef.current = undefined;
			}
			if (transcriptTimerRef.current) window.clearTimeout(transcriptTimerRef.current);
			if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
		};
	}, [initialize]);

	return {
		state,
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
		abort,
		deleteSession,
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
		saveProviderModel,
		refreshSkills,
		toggleSkill,
		refreshHarnessImports,
		importHarnessResources,
		refreshHostInstructions,
		saveHostInstruction,
		refreshModelSettings,
		loadGitStatus,
		loadGitDiff,
		closeGitDiff,
		openInspector,
		closeInspector,
		loadProjectTree,
		openFile,
		openResource,
		closeFilePreview,
		loadSessionTree,
		navigateTree,
		loadProjectTrust,
		setProjectTrust,
		loadDirectory,
		addProject,
		updateProject,
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
