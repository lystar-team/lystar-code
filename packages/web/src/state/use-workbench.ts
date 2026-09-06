import type { SessionProgress, ToolActivity, ToolActivityState, ToolDiff } from "@lystar/code-gui-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UnauthorizedError, webApi } from "../adapters/host-protocol/api.ts";
import { shouldJoinToolBatch } from "./tool-batching.ts";
import type {
	GatewayEvent,
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
export type InspectorMode = "runs" | "files" | "tree" | "git";
export type ComposerMode = "prompt" | "steer" | "follow-up";
export type ThemeMode = "system" | "light" | "dark";
export type SettingsTab = "appearance" | "models" | "diagnostics" | "about";

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
	| { id: string; kind: "text"; text: string }
	| { id: string; kind: "thinking"; text: string }
	| { id: string; kind: "tools"; batchId: string; toolIds: string[] };

function appendLiveTextBlock(
	items: LiveTurnItem[],
	kind: "text" | "thinking",
	text: string,
	id: string,
): LiveTurnItem[] {
	const last = items.at(-1);
	if (last?.kind === kind) return [...items.slice(0, -1), { ...last, text: last.text + text }];
	return [...items, { id, kind, text }];
}

function appendLiveToolBlock(items: LiveTurnItem[], batchId: string, toolCallId: string, id: string): LiveTurnItem[] {
	const last = items.at(-1);
	if (last?.kind === "tools" && last.batchId === batchId) {
		if (last.toolIds.includes(toolCallId)) return items;
		return [...items.slice(0, -1), { ...last, toolIds: [...last.toolIds, toolCallId] }];
	}
	return [...items, { id, kind: "tools", batchId, toolIds: [toolCallId] }];
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

function nextLiveToolBatchId(current: WorkbenchState, toolName: string, fallback: string): string {
	const last = current.liveTurnItems.at(-1);
	if (last?.kind !== "tools") return fallback;
	const previousToolId = last.toolIds.at(-1);
	const previousTool = previousToolId ? current.liveTools[previousToolId] : undefined;
	return previousTool && shouldJoinToolBatch(previousTool.name, toolName) ? last.batchId : fallback;
}

function applyToolActivityState(current: WorkbenchState, activity: ToolActivity): WorkbenchState {
	if (current.toolActivityEpoch === activity.activityEpoch && (current.toolActivityRevision ?? -1) >= activity.revision) {
		return current;
	}
	const newEpoch = current.toolActivityEpoch !== activity.activityEpoch;
	const liveTools = newEpoch ? {} : current.liveTools;
	const previous = liveTools[activity.toolCallId];
	const batchId = previous?.batchId ?? nextLiveToolBatchId(current, activity.name, `live-tool-batch:${activity.activityEpoch}:${activity.toolCallId}`);
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
			),
		};
	}
	return next;
}

interface GitFileDiffStats {
	additions: number;
	deletions: number;
}

export type WorkbenchTranscriptItem = WebTranscriptItem & { renderId: string };

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
	transcriptLoading: boolean;
	transcriptError?: string;
	transcriptGeneration?: string;
	transcriptRevision?: number;
	previousCursor?: string;
	toolActivityEpoch?: string;
	toolActivityRevision?: number;
	hasMorePrevious: boolean;
	loadingEarlier: boolean;
	lease?: { leaseId: string; leaseGeneration: number; createdAt: number; updatedAt: number };
	readOnly: boolean;
	currentOperation?: WebOperation;
	operations: WebOperation[];
	liveText: string;
	liveThinking: string;
	liveTools: Record<string, LiveTool>;
	liveTurnItems: LiveTurnItem[];
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
	gitDiff?: { path?: string; staged: boolean; diff: string; additions: number; deletions: number };
	gitLoading: boolean;
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

const THEME_KEY = "lystar.web.theme";
const MODEL_PROVIDER_VISIBILITY_KEY = "lystar.web.model-provider-visibility.v2";
const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "waiting_for_input"]);
const TERMINAL_OPERATION_STATUSES = new Set(["completed", "failed", "aborted", "interrupted"]);
const THINKING_DISPLAY_HOLD_MS = 1500;

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

function transcriptViewIdentity(item: WebTranscriptItem): string {
	const view = item.view;
	if (!view) return item.kind;
	if (view.type === "tool_call") return `${view.type}:${view.calls.map((call) => call.id).join(",")}`;
	if (view.type === "tool_result") return `${view.type}:${view.callId}`;
	return view.type;
}

function decorateTranscriptItems(items: readonly WebTranscriptItem[]): WorkbenchTranscriptItem[] {
	const occurrences = new Map<string, number>();
	return items.map((item) => {
		const base = `${item.entryId}:${transcriptViewIdentity(item)}`;
		const occurrence = occurrences.get(base) ?? 0;
		occurrences.set(base, occurrence + 1);
		return { ...item, renderId: `${base}:${occurrence}` };
	});
}

function replaceTranscriptEntries(
	current: readonly WorkbenchTranscriptItem[],
	incoming: readonly WebTranscriptItem[],
	prepend = false,
): WorkbenchTranscriptItem[] {
	const incomingEntryIds = new Set(incoming.map((item) => item.entryId));
	const retained = current.filter((item) => !incomingEntryIds.has(item.entryId));
	const next = decorateTranscriptItems(incoming);
	return prepend ? [...next, ...retained] : [...retained, ...next];
}

function operationForSession(operations: WebOperation[], sessionId: string | undefined): WebOperation | undefined {
	if (!sessionId) return undefined;
	return operations
		.filter((operation) => operation.sessionId === sessionId)
		.sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function mergeSessionSummaries(
	current: readonly WebSessionSummary[],
	incoming: readonly WebSessionSummary[],
): WebSessionSummary[] {
	const incomingById = new Map(incoming.map((session) => [session.id, session]));
	const currentIds = new Set(current.map((session) => session.id));
	return [
		...current.flatMap((session) => {
			const next = incomingById.get(session.id);
			if (!next) return [];
			if (Object.hasOwn(next, "name")) return [next];
			return [session.name?.trim() ? { ...next, name: session.name } : next];
		}),
		...incoming.filter((session) => !currentIds.has(session.id)),
	];
}

function updateSessionSummaryName(
	projects: readonly WebProject[],
	sessionId: string,
	name: string | undefined,
): WebProject[] {
	const normalizedName = name?.trim();
	return projects.map((project) => ({
		...project,
		sessions: project.sessions.map((session) => {
			if (session.id !== sessionId) return session;
			const { name: _name, ...withoutName } = session;
			return normalizedName ? { ...withoutName, name: normalizedName } : withoutName;
		}),
	}));
}

function mergeProjectSessions(current: readonly WebProject[], incoming: readonly WebProject[]): WebProject[] {
	const currentById = new Map(current.map((project) => [project.id, project]));
	return incoming.map((project) => {
		const previous = currentById.get(project.id);
		return previous ? { ...project, sessions: mergeSessionSummaries(previous.sessions, project.sessions) } : project;
	});
}

function updateSessionActivity(
	projects: readonly WebProject[],
	sessionId: string,
	activity: WebSessionSummary["activity"],
	operationUpdatedAt?: number,
): WebProject[] {
	return projects.map((project) => ({
		...project,
		sessions: project.sessions.map((session) =>
			session.id === sessionId
				? { ...session, activity, ...(operationUpdatedAt === undefined ? {} : { operationUpdatedAt }) }
				: session,
		),
	}));
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
		transcriptLoading: false,
		transcriptError: undefined,
		transcriptGeneration: undefined,
		transcriptRevision: undefined,
		hasMorePrevious: false,
		loadingEarlier: false,
		readOnly: false,
		operations: [],
		liveText: "",
		liveThinking: "",
		liveTools: {},
		liveTurnItems: [],
		unreadSessionIds: {},
		gitFileStats: {},
		statusText: "",
		pendingUiRequests: [],
		inspectorOpen: typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches,
		inspectorMode: "runs",
		gitLoading: false,
		fileTreeLoading: false,
		fileTreeRootPath: undefined,
		fileTreeCache: {},
		fileLoading: false,
		sessionTree: [],
		sessionTreeLoading: false,
		directoryLoading: false,
		settingsOpen: false,
		settingsTab: "appearance",
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
	const thinkingClearTimerRef = useRef<number | undefined>(undefined);
	const liveToolBatchRef = useRef(0);
	const liveTurnItemRef = useRef(0);
	const transcriptRequestRef = useRef(0);
	const fileRequestRef = useRef(0);
	const projectRefreshRef = useRef(new Map<string, { promise: Promise<void>; rerun: boolean }>());
	const projectRefreshSuppressedUntilRef = useRef(new Map<string, number>());
	const toastTimerRef = useRef<number | undefined>(undefined);
	const selectionRef = useRef(0);
	const selectionInFlightRef = useRef<string | undefined>(undefined);
	const initializePromiseRef = useRef<Promise<void> | undefined>(undefined);
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

	const cancelThinkingClear = useCallback(() => {
		if (thinkingClearTimerRef.current) {
			window.clearTimeout(thinkingClearTimerRef.current);
			thinkingClearTimerRef.current = undefined;
		}
	}, []);
	const scheduleThinkingClear = useCallback(() => {
		if (!stateRef.current.liveThinking) return;
		cancelThinkingClear();
		thinkingClearTimerRef.current = window.setTimeout(() => {
			thinkingClearTimerRef.current = undefined;
			updateState((current) => ({
				...current,
				liveThinking: "",
				liveTurnItems: current.liveTurnItems.filter((item) => item.kind !== "thinking"),
			}));
		}, THINKING_DISPLAY_HOLD_MS);
	}, [cancelThinkingClear, updateState]);

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
				const restoredLease = current.sessionId
					? data.leases?.find((entry) => entry.sessionId === current.sessionId)?.lease
					: undefined;
				const nextLease = data.leases === undefined ? current.lease : restoredLease;
				const projects = mergeProjectSessions(current.projects, data.projects);
				return {
					...current,
					projects: current.session
						? updateSessionSummaryName(projects, current.sessionId!, current.session.name)
						: projects,
					operations: data.operations,
					pendingUiRequests: data.pendingUiRequests,
					connected: data.connection.connected,
					connectionError: "",
					reconnecting: false,
					authRequired: false,
					lease: nextLease,
					readOnly: current.sessionId ? nextLease === undefined : current.readOnly,
					currentProjectId:
						current.currentProjectId && data.projects.some((project) => project.id === current.currentProjectId)
							? current.currentProjectId
							: undefined,
					currentOperation: operationForSession(data.operations, current.sessionId),
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
			projectRefreshSuppressedUntilRef.current.set(projectId, Date.now() + 5000);
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
										transcriptLoading: false,
										transcriptError: undefined,
										sessionError: undefined,
										transcriptGeneration: undefined,
										transcriptRevision: undefined,
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
			const requestId = ++transcriptRequestRef.current;
			if (!cursor) {
				updateState((current) =>
					current.sessionId === sessionId
						? { ...current, transcriptLoading: true, transcriptError: undefined }
						: current,
				);
			}
			try {
				const result = await webApi.transcript(sessionId, { cursor, limit: 40 });
				if (requestId !== transcriptRequestRef.current || stateRef.current.sessionId !== sessionId) return;
				updateState((current) => ({
					...current,
					transcript: cursor
						? replaceTranscriptEntries(current.transcript, result.items, true)
						: decorateTranscriptItems(result.items),
					previousCursor: result.previousCursor,
					hasMorePrevious: result.hasMorePrevious,
					transcriptLoading: false,
					transcriptError: undefined,
					transcriptGeneration: result.transcriptGeneration,
					transcriptRevision: result.transcriptRevision,
				}));
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

	const scheduleTranscriptRefresh = useCallback(
		(sessionId = stateRef.current.sessionId) => {
			if (
				!sessionId ||
				selectionInFlightRef.current === sessionId ||
				(stateRef.current.transcriptLoading && stateRef.current.statusText === "正在打开会话")
			)
				return;
			if (transcriptTimerRef.current) window.clearTimeout(transcriptTimerRef.current);
			transcriptTimerRef.current = window.setTimeout(
				() => void loadTranscript(sessionId).catch((error) => showToast(errorMessage(error))),
				140,
			);
		},
		[loadTranscript, showToast],
	);

	const applyProgress = useCallback(
		(progress: SessionProgress) => {
			if (
				progress.type === "assistant_delta" ||
				progress.type === "user_message" ||
				progress.type === "tool_start" ||
				progress.type === "tool_state"
			) {
				scheduleThinkingClear();
			} else if (progress.type === "thinking_delta") {
				cancelThinkingClear();
			}
			updateState((current) => {
				switch (progress.type) {
					case "assistant_delta":
						return {
							...current,
							liveText: current.liveText + progress.text,
							liveTurnItems: appendLiveTextBlock(
								current.liveTurnItems,
								"text",
								progress.text,
								`live-turn:${liveTurnItemRef.current++}`,
							),
							statusText: "正在生成回复",
						};
					case "thinking_delta":
						return {
							...current,
							liveThinking: current.liveThinking + progress.text,
							liveTurnItems: appendLiveTextBlock(
								current.liveTurnItems,
								"thinking",
								progress.text,
								`live-thinking:${liveTurnItemRef.current++}`,
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
							previous?.batchId ?? nextLiveToolBatchId(current, progress.name, `live-tool-batch:${liveToolBatchRef.current++}`);
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
									),
							statusText: `正在执行 ${progress.name}`,
						};
					}
					case "tool_update": {
						const previous = current.liveTools[progress.toolCallId];
						if (previous && previous.status !== "running") return current;
						const batchId =
							previous?.batchId ?? nextLiveToolBatchId(current, progress.name, `live-tool-batch:${liveToolBatchRef.current++}`);
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
									),
						};
					}
					case "tool_end": {
						const previous = current.liveTools[progress.toolCallId];
						const batchId =
							previous?.batchId ?? nextLiveToolBatchId(current, progress.name, `live-tool-batch:${liveToolBatchRef.current++}`);
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
					case "phase":
						if (progress.phase === "turn") liveToolBatchRef.current += 1;
						return {
							...current,
							statusText:
								progress.phase === "waiting_for_input"
									? "等待输入"
									: progress.phase === "compaction"
										? "正在整理上下文"
										: "正在处理",
						};
					case "compaction":
						return {
							...current,
							statusText:
								progress.status === "running"
									? "正在整理上下文"
									: progress.status === "completed"
										? "上下文已整理"
										: progress.status === "failed"
											? "上下文整理失败"
											: "上下文整理已停止",
						};
					case "retry":
						return {
							...current,
							statusText:
								progress.status === "running"
									? "正在重试"
									: progress.status === "failed"
										? "重试失败"
										: "等待重试",
						};
					case "bash":
						return { ...current, statusText: "正在运行命令" };
					case "status":
						return { ...current, statusText: progress.status };
					case "usage":
						return current;
				}
			});
		},
		[cancelThinkingClear, scheduleThinkingClear, updateState],
	);

	const handleEvent = useCallback(
		(event: GatewayEvent) => {
			if (event.type === "bootstrap") {
				const sessionId = stateRef.current.sessionId;
				applyBootstrap(event.data);
				if (sessionId && event.data.leases && !event.data.leases.some((entry) => entry.sessionId === sessionId)) {
					void selectSessionRef.current(sessionId).catch((error) => showToast(errorMessage(error)));
				}
				return;
			}
			if (event.type === "connection_state") {
				updateState((current) => ({
					...current,
					connected: event.connected,
					reconnecting: !event.connected,
					connectionError: event.message ?? (event.connected ? "" : "Web Host 连接已断开"),
				}));
				return;
			}
			if (event.type === "sessions_changed") {
				if (event.projectId) {
					const suppressedUntil = projectRefreshSuppressedUntilRef.current.get(event.projectId) ?? 0;
					if (suppressedUntil > Date.now()) return;
					void refreshProjectSessions(event.projectId).catch((error) => showToast(errorMessage(error)));
				} else {
					void refreshBootstrap().catch((error) => showToast(errorMessage(error)));
				}
				return;
			}
			if (event.type === "session_snapshot") {
				updateState((current) => {
					const projects = updateSessionActivity(
						updateSessionSummaryName(current.projects, event.sessionId, event.snapshot.name),
						event.sessionId,
						event.snapshot.activity,
					);
					if (event.sessionId !== current.sessionId) return { ...current, projects };
					const next: WorkbenchState = {
						...current,
						projects,
						session: event.snapshot,
						readOnly: event.snapshot.writeAccess !== "owned",
						transcriptGeneration: event.snapshot.transcriptGeneration,
						transcriptRevision: event.snapshot.transcriptRevision,
					};
					return restoreToolActivities(next, event.snapshot);
				});
				return;
			}
			if (event.type === "session_removed") {
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
								transcript: [],
								transcriptLoading: false,
								transcriptError: undefined,
								sessionError: undefined,
								transcriptGeneration: undefined,
								transcriptRevision: undefined,
							}
						: { ...current, unreadSessionIds };
				});
				void refreshBootstrap();
				return;
			}
			if (event.type === "transcript_changed" || event.type === "transcript_committed") {
				if (event.sessionId !== stateRef.current.sessionId) return;
				if (event.type === "transcript_committed") {
					updateState((current) =>
						current.sessionId === event.sessionId
							? {
									...current,
									transcript: replaceTranscriptEntries(current.transcript, event.items),
									transcriptGeneration: event.transcriptGeneration,
									transcriptRevision: event.toRevision,
								}
							: current,
					);
				}
				scheduleTranscriptRefresh(event.sessionId);
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
						const unreadSessionIds = { ...current.unreadSessionIds };
						if (activity === "idle" && event.sessionId !== current.sessionId && wasRunning)
							unreadSessionIds[event.sessionId] = true;
						else if (activity !== "idle" || event.sessionId === current.sessionId)
							delete unreadSessionIds[event.sessionId];
						return {
							...current,
							projects: updateSessionActivity(current.projects, event.sessionId, activity),
							unreadSessionIds,
						};
					});
				}
				if (event.sessionId === stateRef.current.sessionId) applyProgress(event.progress);
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
					const selected = operationSessionId === current.sessionId || !operationSessionId;
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
						event.operation.status === "completed" &&
						["prompt", "compact", "run_bash"].includes(event.operation.type)
							? { liveText: "", liveThinking: "", liveTools: {}, liveTurnItems: [], statusText: "" }
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
					if (operationIsTerminal) scheduleTranscriptRefresh(operationSessionId ?? stateRef.current.sessionId);
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
			refreshBootstrap,
			refreshProjectSessions,
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
		socketRef.current = socket;
	}, [handleEvent, updateState]);

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
			updateState((current) => ({ ...current, loading: true, connectionError: "" }));
			try {
				const data = await webApi.bootstrap();
				applyBootstrap(data);
				await refreshModelSettings().catch(() => undefined);
				connectStream();
				const firstProject = data.projects
					.filter((project) => !project.archived)
					.slice()
					.sort((left, right) => Number(right.pinned) - Number(left.pinned))[0];
				if (firstProject) {
					updateState((current) => ({ ...current, currentProjectId: firstProject.id }));
					const firstSession =
						stateRef.current.projects.find((project) => project.id === firstProject.id)?.sessions[0] ??
						firstProject.sessions[0];
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
				!currentSelection.transcriptError
			)
				return;
			selectionInFlightRef.current = sessionId;
			const request = ++selectionRef.current;
			const previous = stateRef.current;
			const projectId = previous.currentProjectId;
			if (projectId) projectRefreshSuppressedUntilRef.current.set(projectId, Date.now() + 2_000);
			if (
				previous.sessionId &&
				previous.sessionId !== sessionId &&
				!ACTIVE_OPERATION_STATUSES.has(previous.currentOperation?.status ?? "")
			)
				await webApi.release(previous.sessionId).catch(() => {});
			if (transcriptTimerRef.current) window.clearTimeout(transcriptTimerRef.current);
			transcriptRequestRef.current++;
			updateState((current) => ({
				...current,
				sessionId,
				session: undefined,
				sessionError: undefined,
				lease: undefined,
				readOnly: false,
				transcript: [],
				transcriptLoading: true,
				transcriptError: undefined,
				transcriptGeneration: undefined,
				transcriptRevision: undefined,
				previousCursor: undefined,
				hasMorePrevious: false,
				liveText: "",
				liveThinking: "",
				liveTools: {},
				liveTurnItems: [],
				unreadSessionIds: Object.fromEntries(
					Object.entries(current.unreadSessionIds).filter(([id]) => id !== sessionId),
				) as Record<string, true>,
				statusText: "正在打开会话",
				currentOperation: operationForSession(current.operations, sessionId),
			}));
			const transcriptPromise = loadTranscript(sessionId);
			try {
				const controlled = await webApi.control(sessionId);
				if (request !== selectionRef.current) {
					if (selectionInFlightRef.current === sessionId) selectionInFlightRef.current = undefined;
					return;
				}
				updateState((current) => {
					const next: WorkbenchState = {
						...current,
						projects: updateSessionSummaryName(current.projects, sessionId, controlled.snapshot.name),
						lease: controlled.lease,
						session: controlled.snapshot,
						sessionError: undefined,
						readOnly: controlled.owned === false,
					};
					return restoreToolActivities(next, controlled.snapshot);
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
							projects: updateSessionSummaryName(current.projects, sessionId, snapshot.name),
							session: snapshot,
							sessionError: undefined,
							readOnly: true,
						};
						return restoreToolActivities(next, snapshot);
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
			const supplementalLoads = [loadProjectTrustRef.current()];
			if (stateRef.current.inspectorMode === "tree") supplementalLoads.push(loadSessionTreeRef.current());
			void Promise.allSettled(supplementalLoads);
			updateState((current) => ({ ...current, statusText: "" }));
			if (selectionInFlightRef.current === sessionId) selectionInFlightRef.current = undefined;
		},
		[loadTranscript, showToast, updateState],
	);

	const selectProject = useCallback(
		async (projectId: string) => {
			const request = ++selectionRef.current;
			const previous = stateRef.current;
			if (previous.sessionId && !ACTIVE_OPERATION_STATUSES.has(previous.currentOperation?.status ?? ""))
				await webApi.release(previous.sessionId).catch(() => {});
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
				transcript: [],
				transcriptLoading: false,
				transcriptError: undefined,
				transcriptGeneration: undefined,
				transcriptRevision: undefined,
				currentOperation: undefined,
				liveText: "",
				liveThinking: "",
				liveTools: {},
				liveTurnItems: [],
			}));
			try {
				await refreshProjectSessions(projectId);
			} catch (error) {
				showToast(errorMessage(error));
			}
			if (request !== selectionRef.current) return;
			const firstSession = stateRef.current.projects.find((project) => project.id === projectId)?.sessions[0];
			if (firstSession) await selectSession(firstSession.id);
			else await loadProjectTreeRef.current();
		},
		[refreshProjectSessions, selectSession, updateState, showToast],
	);

	const loadEarlier = useCallback(async () => {
		const current = stateRef.current;
		if (!current.sessionId || !current.previousCursor || current.loadingEarlier) return;
		updateState((value) => ({ ...value, loadingEarlier: true }));
		try {
			await loadTranscript(current.sessionId, current.previousCursor);
		} finally {
			updateState((value) => ({ ...value, loadingEarlier: false }));
		}
	}, [loadTranscript, updateState]);

	const createSession = useCallback(async () => {
		const projectId = stateRef.current.currentProjectId;
		if (!projectId) return;
		const result = await webApi.createSession(projectId);
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
			transcript: [],
			transcriptLoading: false,
			transcriptError: undefined,
			transcriptGeneration: result.session.transcriptGeneration,
			transcriptRevision: result.session.transcriptRevision,
			currentOperation: undefined,
			statusText: "",
			liveTurnItems: [],
		}));
	}, [updateState]);

	const sendMessage = useCallback(
		async (
			text: string,
			mode: ComposerMode = stateRef.current.composerMode,
			images?: Array<{ data: string; mimeType: string }>,
		) => {
			const current = stateRef.current;
			if (!current.sessionId || current.readOnly) return;
			if (hasActive(current.currentOperation) && mode === "prompt") mode = "follow-up";
			const value = text.trim();
			if (!value) return;
			const result = await webApi.prompt(current.sessionId, value, mode, images);
			updateState((next) => ({
				...next,
				currentOperation: result.operation ?? next.currentOperation,
				liveText: "",
				liveThinking: "",
				liveTools: {},
				liveTurnItems: [],
				statusText: mode === "steer" ? "已加入当前任务" : mode === "follow-up" ? "已排入后续任务" : "正在处理",
			}));
		},
		[updateState],
	);

	const abort = useCallback(async () => {
		const current = stateRef.current;
		if (!current.sessionId || !current.currentOperation) return;
		await webApi.abort(current.sessionId, current.currentOperation.operationId);
	}, []);

	const renameSession = useCallback(
		async (name: string) => {
			const current = stateRef.current;
			if (!current.sessionId || current.readOnly) return;
			const result = await webApi.renameSession(current.sessionId, name);
			updateState((next) => ({
				...next,
				projects: updateSessionSummaryName(next.projects, current.sessionId!, result.session.name),
				session: result.session,
			}));
			if (current.currentProjectId) await refreshProjectSessions(current.currentProjectId);
		},
		[refreshProjectSessions, updateState],
	);

	const fork = useCallback(
		async (entryId: string) => {
			const current = stateRef.current;
			if (!current.sessionId || current.readOnly) return;
			const result = await webApi.fork(current.sessionId, entryId);
			const oldSessionId = current.sessionId;
			updateState((next) => ({
				...next,
				sessionId: result.session.id,
				session: result.session,
				lease: result.lease,
				readOnly: false,
				transcript: [],
				transcriptLoading: true,
				transcriptError: undefined,
				sessionError: undefined,
				transcriptGeneration: result.session.transcriptGeneration,
				transcriptRevision: result.session.transcriptRevision,
				currentOperation: undefined,
			}));
			if (current.currentProjectId) await refreshProjectSessions(current.currentProjectId);
			await loadTranscript(result.session.id);
			if (oldSessionId !== result.session.id) showToast("已创建新的会话分支");
		},
		[loadTranscript, refreshProjectSessions, showToast, updateState],
	);

	const compact = useCallback(async () => {
		const current = stateRef.current;
		if (!current.sessionId || current.readOnly) return;
		const result = await webApi.compact(current.sessionId);
		updateState((next) => ({ ...next, currentOperation: result.operation }));
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
			updateState((current) => ({ ...current, gitLoading: true }));
			try {
				updateState((current) => ({ ...current, gitDiff: undefined }));
				const result = await webApi.gitDiff(projectId, path, staged);
				updateState((current) => ({ ...current, gitDiff: result }));
			} finally {
				updateState((current) => ({ ...current, gitLoading: false }));
			}
		},
		[updateState],
	);

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

	const openSettings = useCallback(
		async (tab: SettingsTab = "appearance") => {
			updateState((current) => ({ ...current, settingsOpen: true, settingsTab: tab }));
			if (tab === "models" && stateRef.current.models.length === 0) {
				await refreshModelSettings();
			}
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
		[refreshModelSettings, updateState],
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
			socketRef.current?.close();
			socketRef.current = undefined;
			if (reconnectTimerRef.current) {
				window.clearTimeout(reconnectTimerRef.current);
				reconnectTimerRef.current = undefined;
			}
			if (transcriptTimerRef.current) window.clearTimeout(transcriptTimerRef.current);
			if (thinkingClearTimerRef.current) window.clearTimeout(thinkingClearTimerRef.current);
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
		renameSession,
		fork,
		compact,
		exportSession,
		updateModel,
		updateThinking,
		setModelProviderVisibility,
		syncModelProvider,
		saveModelProvider,
		saveProviderModel,
		refreshModelSettings,
		loadGitStatus,
		loadGitDiff,
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
