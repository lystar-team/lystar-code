import type { SessionProgress, TranscriptItem } from "@lystar/code-gui-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UnauthorizedError, webApi } from "../adapters/host-protocol/api.ts";
import type {
	GatewayEvent,
	ProjectTreeResponse,
	UiRequestEvent,
	WebOperation,
	WebProject,
	WebSessionSnapshot,
	WebSessionSummary,
} from "../types.ts";

export type InspectorMode = "runs" | "files" | "tree" | "git";
export type ComposerMode = "prompt" | "steer" | "follow-up";
export type ThemeMode = "system" | "light" | "dark";
export type SettingsTab = "appearance" | "models" | "diagnostics" | "about";

export interface LiveTool {
	id: string;
	name: string;
	summary: string;
	status: "running" | "success" | "error";
	diff?: {
		files: Array<{ path?: string; operation?: string; additions?: number; deletions?: number; diff?: string }>;
	};
}

export type WorkbenchTranscriptItem = TranscriptItem & { renderId: string };

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
	hasMorePrevious: boolean;
	loadingEarlier: boolean;
	lease?: { leaseId: string; leaseGeneration: number; createdAt: number; updatedAt: number };
	readOnly: boolean;
	currentOperation?: WebOperation;
	operations: WebOperation[];
	liveText: string;
	liveThinking: string;
	liveTools: Record<string, LiveTool>;
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
	gitDiff?: { path?: string; staged: boolean; diff: string; additions: number; deletions: number };
	gitLoading: boolean;
	fileTree?: ProjectTreeResponse;
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
		supportedThinkingLevels: string[];
		authenticated: boolean;
		authMethods: string[];
		authSource?: string;
	}>;
	providers: Array<{
		id: string;
		name: string;
		authenticated: boolean;
		authMethods: string[];
		authSource?: string;
		modelCount: number;
		builtIn: boolean;
		custom: boolean;
	}>;
	about?: Record<string, unknown>;
	diagnostics?: Record<string, unknown>;
	projectTrust?: { cwd: string; trusted: boolean | null; reason: string; resourceRisk: boolean };
	toast?: string;
	theme: ThemeMode;
	composerMode: ComposerMode;
}

const THEME_KEY = "lystar.web.theme";
const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "waiting_for_input"]);

function savedTheme(): ThemeMode {
	if (typeof window === "undefined") return "system";
	const value = window.localStorage.getItem(THEME_KEY);
	return value === "light" || value === "dark" ? value : "system";
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

function transcriptViewIdentity(item: TranscriptItem): string {
	const view = item.view;
	if (!view) return item.kind;
	if (view.type === "tool_call") return `${view.type}:${view.calls.map((call) => call.id).join(",")}`;
	if (view.type === "tool_result") return `${view.type}:${view.callId}`;
	return view.type;
}

function decorateTranscriptItems(items: readonly TranscriptItem[]): WorkbenchTranscriptItem[] {
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
	incoming: readonly TranscriptItem[],
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

export function transcriptText(item: TranscriptItem): string {
	return item.view && "text" in item.view ? item.view.text : "";
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
		statusText: "",
		pendingUiRequests: [],
		inspectorOpen: typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches,
		inspectorMode: "runs",
		gitLoading: false,
		fileTreeLoading: false,
		fileLoading: false,
		sessionTree: [],
		sessionTreeLoading: false,
		directoryLoading: false,
		settingsOpen: false,
		settingsTab: "appearance",
		models: [],
		providers: [],
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
	const reconnectTimerRef = useRef<number | undefined>(undefined);
	const transcriptTimerRef = useRef<number | undefined>(undefined);
	const transcriptRequestRef = useRef(0);
	const projectRefreshRef = useRef(new Map<string, { promise: Promise<void>; rerun: boolean }>());
	const projectRefreshSuppressedUntilRef = useRef(new Map<string, number>());
	const toastTimerRef = useRef<number | undefined>(undefined);
	const selectionRef = useRef(0);
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
		}) => {
			updateState((current) => ({
				...current,
				projects: data.projects,
				operations: data.operations,
				pendingUiRequests: data.pendingUiRequests,
				connected: data.connection.connected,
				connectionError: "",
				reconnecting: false,
				authRequired: false,
				currentProjectId:
					current.currentProjectId && data.projects.some((project) => project.id === current.currentProjectId)
						? current.currentProjectId
						: undefined,
				currentOperation: operationForSession(data.operations, current.sessionId),
			}));
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
							project.id === projectId ? { ...project, sessions: result.sessions } : project,
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
				const result = await webApi.transcript(sessionId, { cursor, limit: 120 });
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
			if (!sessionId) return;
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
			updateState((current) => {
				switch (progress.type) {
					case "assistant_delta":
						return { ...current, liveText: current.liveText + progress.text, statusText: "正在生成回复" };
					case "thinking_delta":
						return { ...current, liveThinking: current.liveThinking + progress.text, statusText: "正在思考" };
					case "user_message":
						return { ...current, statusText: "正在处理" };
					case "tool_start":
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[progress.toolCallId]: {
									id: progress.toolCallId,
									name: progress.name,
									summary: progress.summary ?? "正在执行",
									status: "running",
									diff: progress.diff,
								},
							},
							statusText: `正在执行 ${progress.name}`,
						};
					case "tool_update":
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[progress.toolCallId]: {
									id: progress.toolCallId,
									name: progress.name,
									summary: progress.summary,
									status: "running",
									diff: progress.diff,
								},
							},
						};
					case "tool_end":
						return {
							...current,
							liveTools: {
								...current.liveTools,
								[progress.toolCallId]: {
									id: progress.toolCallId,
									name: progress.name,
									summary: progress.summary,
									status: progress.status,
									diff: progress.diff,
								},
							},
							statusText: progress.status === "error" ? `${progress.name} 执行失败` : `${progress.name} 已完成`,
						};
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
										? "上下文整理完成"
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
		[updateState],
	);

	const handleEvent = useCallback(
		(event: GatewayEvent) => {
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
				if (event.sessionId === stateRef.current.sessionId)
					updateState((current) => ({
						...current,
						session: event.snapshot,
						readOnly: event.snapshot.writeAccess !== "owned",
						transcriptGeneration: event.snapshot.transcriptGeneration,
						transcriptRevision: event.snapshot.transcriptRevision,
					}));
				return;
			}
			if (event.type === "session_removed") {
				updateState((current) =>
					event.sessionId === current.sessionId
						? {
								...current,
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
						: current,
				);
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
				if (event.sessionId === stateRef.current.sessionId) applyProgress(event.progress);
				return;
			}
			if (event.type === "operation_updated") {
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
					const selected = event.operation.sessionId === current.sessionId || !event.operation.sessionId;
					return {
						...current,
						operations,
						...(selected ? { currentOperation: event.operation } : {}),
						...(selected && event.operation.status === "completed"
							? { liveText: "", liveThinking: "", liveTools: {} }
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
				if (event.operation.sessionId === stateRef.current.sessionId || !event.operation.sessionId) {
					if (
						event.operation.status === "completed" ||
						event.operation.status === "failed" ||
						event.operation.status === "aborted" ||
						event.operation.status === "interrupted"
					)
						scheduleTranscriptRefresh(event.operation.sessionId ?? stateRef.current.sessionId);
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
		socketRef.current?.close();
		socketRef.current = webApi.connect(handleEvent, () => {
			updateState((current) => ({
				...current,
				connected: false,
				reconnecting: true,
				connectionError: "Web Host 连接已断开，正在重连",
			}));
			if (!mountedRef.current || reconnectTimerRef.current) return;
			reconnectTimerRef.current = window.setTimeout(() => {
				reconnectTimerRef.current = undefined;
				if (webApi.hasToken()) connectStream();
			}, 1200);
		});
	}, [handleEvent, updateState]);

	const initialize = useCallback(async () => {
		if (!webApi.hasToken()) {
			updateState((current) => ({ ...current, authRequired: true, loading: false }));
			return;
		}
		updateState((current) => ({ ...current, loading: true, connectionError: "" }));
		try {
			const data = await webApi.bootstrap();
			applyBootstrap(data);
			connectStream();
			const firstProject = data.projects
				.filter((project) => !project.archived)
				.slice()
				.sort((left, right) => Number(right.pinned) - Number(left.pinned))[0];
			if (firstProject) {
				updateState((current) => ({ ...current, currentProjectId: firstProject.id }));
				await refreshProjectSessions(firstProject.id).catch((error) => showToast(errorMessage(error)));
				const firstSession =
					stateRef.current.projects.find((project) => project.id === firstProject.id)?.sessions[0] ?? firstProject.sessions[0];
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
	}, [applyBootstrap, connectStream, refreshProjectSessions, showToast, updateState]);

	const submitToken = useCallback(
		async (token: string) => {
			webApi.setToken(token);
			await initialize();
		},
		[initialize],
	);

	const signOut = useCallback(() => {
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
			const request = ++selectionRef.current;
			const previous = stateRef.current;
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
				statusText: "正在打开会话",
				currentOperation: operationForSession(current.operations, sessionId),
			}));
			try {
				const controlled = await webApi.control(sessionId);
				updateState((current) => ({
					...current,
					lease: controlled.lease,
					session: controlled.snapshot,
					sessionError: undefined,
					readOnly: controlled.owned === false,
				}));
			} catch (error) {
				try {
					const snapshot = (await webApi.session(sessionId)).session;
					if (request !== selectionRef.current) return;
					updateState((current) => ({
						...current,
						session: snapshot,
						sessionError: undefined,
						readOnly: true,
					}));
					showToast(errorMessage(error));
				} catch (snapshotError) {
					if (request !== selectionRef.current) return;
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
					return;
				}
			}
			if (request !== selectionRef.current) return;
			try {
				await loadTranscript(sessionId);
			} catch (error) {
				showToast(errorMessage(error));
			}
			await Promise.allSettled([loadSessionTreeRef.current(), loadProjectTrustRef.current()]);
			updateState((current) => ({ ...current, statusText: "" }));
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
			if (hasActive(current.currentOperation) && mode === "prompt") mode = "steer";
			const value = text.trim();
			if (!value) return;
			const result = await webApi.prompt(current.sessionId, value, mode, images);
			updateState((next) => ({
				...next,
				currentOperation: result.operation ?? next.currentOperation,
				liveText: "",
				liveThinking: "",
				liveTools: {},
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
			updateState((next) => ({ ...next, session: result.session }));
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

	const updateModel = useCallback(
		async (provider: string, id: string) => {
			const current = stateRef.current;
			if (!current.sessionId || current.readOnly) return;
			const result = await webApi.model(current.sessionId, provider, id);
			updateState((next) => ({ ...next, session: result.session }));
		},
		[updateState],
	);

	const updateThinking = useCallback(
		async (level: string) => {
			const current = stateRef.current;
			if (!current.sessionId || current.readOnly) return;
			const result = await webApi.thinking(current.sessionId, level);
			updateState((next) => ({ ...next, session: result.session }));
		},
		[updateState],
	);

	const loadGitStatus = useCallback(async () => {
		const projectId = stateRef.current.currentProjectId;
		if (!projectId) return;
		updateState((current) => ({ ...current, gitLoading: true }));
		try {
			updateState((current) => ({ ...current, gitStatus: undefined, gitLoading: true }));
			const result = await webApi.gitStatus(projectId);
			updateState((current) => ({ ...current, gitStatus: result }));
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
		async (path = "") => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			updateState((current) => ({ ...current, fileTreeLoading: true }));
			try {
				const result = await webApi.projectTree(projectId, path);
				updateState((current) => ({ ...current, fileTree: result }));
			} finally {
				updateState((current) => ({ ...current, fileTreeLoading: false }));
			}
		},
		[updateState],
	);

	const openFile = useCallback(
		async (path: string) => {
			const projectId = stateRef.current.currentProjectId;
			if (!projectId) return;
			updateState((current) => ({ ...current, fileLoading: true, filePath: path }));
			try {
				const result = await webApi.projectFile(projectId, path);
				updateState((current) => ({
					...current,
					fileContent: result,
					inspectorOpen: true,
					inspectorMode: "files",
				}));
			} finally {
				updateState((current) => ({ ...current, fileLoading: false }));
			}
		},
		[updateState],
	);

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

	const openSettings = useCallback(
		async (tab: SettingsTab = "appearance") => {
			updateState((current) => ({ ...current, settingsOpen: true, settingsTab: tab }));
			if (tab === "models" && stateRef.current.models.length === 0) {
				const result = await webApi.models();
				updateState((current) => ({ ...current, models: result.models, providers: result.providers }));
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
		[updateState],
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
		mountedRef.current = true;
		void initialize();
		return () => {
			mountedRef.current = false;
			socketRef.current?.close();
			if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
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
		renameSession,
		fork,
		compact,
		exportSession,
		updateModel,
		updateThinking,
		loadGitStatus,
		loadGitDiff,
		openInspector,
		closeInspector,
		loadProjectTree,
		openFile,
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
