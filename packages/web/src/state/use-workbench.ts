import type { SessionProgress } from "@lystar/code-web-protocol";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UnauthorizedError, webApi } from "../adapters/host-protocol/api.ts";
import type { ProjectGroup, UiRequestEvent, WebLease, WebOperation, WebProject } from "../types.ts";
import { reconcileCommittedTurn, reconcilePendingUserPrompts } from "./chat-lifecycle.ts";
import { reconcileCompactionState } from "./compaction-state.ts";
import {
	connectionStateAfterHostUpdate,
	offlineConnectionState,
	reconnectDelayMs,
	reconnectingConnectionState,
} from "./connection-recovery.ts";
import { readLastSession, saveLastSession } from "./session-persistence.ts";
import {
	bootstrapLeaseForSession,
	isOlderSessionSnapshot,
	isSameTranscriptHistory,
	isTranscriptResponseObsolete,
	mergeOperationSnapshots,
	replaceSessionOperationSnapshots,
} from "./session-sync.ts";
import { agentStepIndexChanged, mergeAgentStepIndex } from "./session-timeline.ts";
import { mergeTranscriptPage, transcriptRenderIdOverrides } from "./transcript-state.ts";
import {
	applySubagentProgress,
	createSubagentConversationState,
	mergeSubagentSnapshots,
	reconcileLiveUserPrompts,
	restoreRuntimeActivities,
	withPromptSendTimes,
} from "./workbench-live-state.ts";
import {
	ACTIVE_OPERATION_STATUSES,
	applyTheme,
	browserNetworkOnline,
	errorMessage,
	gitCredentialAuthorizationMessage,
	gitCredentialAuthorizationMessageFromProgress,
	gitCredentialAuthorizationMessageFromSystemPermissions,
	gitFileStatsKey,
	initialState,
	mergeProjectSessions,
	mergeSessionSummaries,
	operationForSessionSnapshot,
	updateSessionSummaryFirstMessage,
	projectInspectorStateForSelection,
	resolveHiddenModelProviders,
	savedModelProviderVisibilityOverrides,
	sessionTitle,
	shouldClearLiveTurn,
	transcriptText,
	updateSessionActivity,
	updateSessionSummaryName,
} from "./workbench-state.ts";
import type { CachedSessionDetail } from "./workbench-session-cache.ts";
import { useWorkbenchSettingsActions } from "./workbench-settings-actions.ts";
import { useWorkbenchGitActions } from "./workbench-git-actions.ts";
import { useWorkbenchFileActions } from "./workbench-file-actions.ts";
import { useWorkbenchSessionActions } from "./workbench-session-actions.ts";
import { useWorkbenchProjectActions } from "./workbench-project-actions.ts";
import { useWorkbenchStreamActions } from "./workbench-stream-actions.ts";
import type { SubagentConversationState, WorkbenchState } from "./workbench-types.ts";

export {
	applySubagentProgress,
	createSubagentConversationState,
	gitCredentialAuthorizationMessage,
	gitCredentialAuthorizationMessageFromProgress,
	gitCredentialAuthorizationMessageFromSystemPermissions,
	gitFileStatsKey,
	mergeSessionSummaries,
	mergeSubagentSnapshots,
	projectInspectorStateForSelection,
	resolveHiddenModelProviders,
	restoreRuntimeActivities,
	sessionTitle,
	transcriptText,
	updateSessionSummaryFirstMessage,
};
export type {
	ComposerMode,
	InspectorMode,
	LiveTool,
	LiveTurnItem,
	SettingsTab,
	SubagentConversationState,
	ThemeMode,
	WorkbenchState,
} from "./workbench-types.ts";

const TRANSCRIPT_PAGE_SIZE = 120;

type LiveTextProgress = Extract<SessionProgress, { type: "assistant_delta" | "thinking_delta" }>;
type PendingTextProgress = { selection: number; sessionId: string; progress: LiveTextProgress };
type SessionSubscriptionResult = "ready" | "gap" | "timeout" | "closed";
type SessionSubscriptionWaiter = {
	resolve: (result: SessionSubscriptionResult) => void;
	timeoutId: number;
};

export function useWorkbench() {
	const [state, setState] = useState<WorkbenchState>(() => initialState());
	const stateRef = useRef(state);
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
										agentSteps: {},
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
					const currentHistoryChangedSinceRequest = isTranscriptResponseObsolete(
						requestedHistory,
						{
							generation: current.transcriptGeneration,
							leafId: current.transcriptLeafId,
						},
						result,
					);
					const sameHistory =
						isSameTranscriptHistory(
							{
								generation: current.transcriptGeneration,
								leafId: current.transcriptLeafId,
							},
							result,
						) &&
						!(
							current.transcriptPageLoaded &&
							current.transcriptGeneration === undefined &&
							current.transcript.length > 0
						);
					const staleRevision =
						sameHistory &&
						current.transcriptGeneration === result.transcriptGeneration &&
						current.transcriptRevision !== undefined &&
						current.transcriptRevision > result.transcriptRevision;
					const incomingAgentStepsChanged = agentStepIndexChanged(current.agentSteps, result.agentSteps);
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
						!shouldClearLiveTurn(current) &&
						!incomingAgentStepsChanged
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
							agentSteps: mergeAgentStepIndex(current.agentSteps, result.agentSteps),
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
						agentSteps: mergeAgentStepIndex(sameHistory ? current.agentSteps : {}, result.agentSteps),
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
						agentSteps: mergeAgentStepIndex(sameHistory ? view.agentSteps : {}, result.agentSteps),
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
									agentSteps: {},
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

	const {
		scheduleTranscriptRefresh,
		flushPendingTextProgress,
		settleSessionSubscriptionWaiters,
		subscribeSessionAndWait,
		completeSessionSubscription,
		restoreSelectedSessionSubscription,
		handleEvent,
	} = useWorkbenchStreamActions({
		stateRef,
		updateState,
		showToast,
		applyBootstrap,
		refreshBootstrap,
		refreshProjectSessions,
		loadTranscript,
		loadSessionOperations,
		loadSessionSnapshot,
		loadSubagents,
		refreshProjectFilesRef,
		refreshModelOptionsRef,
		refreshModelSettingsRef,
		selectionRef,
		selectionInFlightRef,
		socketRef,
		reconnectAttemptRef,
		liveToolBatchRef,
		liveTurnItemRef,
		pendingTextProgressRef,
		pendingTextFrameRef,
		pendingTextTimeoutRef,
		transcriptTimerRef,
		transcriptRefreshPendingRef,
		sessionDetailCacheRef,
		sessionDetailSeqRef,
		scheduleSubagentTranscriptRefresh,
		sessionSubscriptionWaitersRef,
		handledNotifyIdsRef,
	});

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

	const {
		selectSession,
		selectProject,
		loadEarlier,
		createSession,
		sendMessage,
		queueAction,
		abort,
		renameSession,
		setSessionPinned,
		deleteSessions,
		deleteSession,
		fork,
		reloadResources,
		compact,
		exportSession,
		ensureSessionControl,
		updateModel,
		updateThinking,
	} = useWorkbenchSessionActions({
		stateRef,
		updateState,
		transitionState,
		showToast,
		refreshProjectSessions,
		loadTranscript,
		loadSubagents,
		loadSessionOperations,
		subscribeSessionAndWait,
		completeSessionSubscription,
		scheduleTranscriptRefresh,
		selectionRef,
		selectionInFlightRef,
		socketRef,
		fileRequestRef,
		fileMetadataPromisesRef,
		projectTreeRefreshPromisesRef,
		gitStatusPromiseRef,
		gitStatusRequestRef,
		gitBranchesRequestRef,
		gitHistoryRequestRef,
		gitCommitRequestRef,
		gitDiffRequestRef,
		gitStatsRepositoryRef,
		projectTreeGenerationRef,
		sessionTreeRequestRef,
		transcriptTimerRef,
		transcriptRefreshPendingRef,
		transcriptRequestRef,
		pendingUserPromptRef,
		sessionDetailCacheRef,
		sessionDetailSeqRef,
		loadProjectTreeRef,
		loadGitStatusRef,
		loadProjectTrustRef,
		loadSessionTreeRef,
	});

	const {
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
	} = useWorkbenchGitActions({
		stateRef,
		updateState,
		showToast,
		gitStatusRequestRef,
		gitBranchesRequestRef,
		gitHistoryRequestRef,
		gitCommitRequestRef,
		gitDiffRequestRef,
		gitStatusPromiseRef,
		gitStatsRepositoryRef,
		loadGitStatusRef,
	});

	const {
		openInspector,
		closeInspector,
		loadProjectTree,
		openFile,
		openResource,
		saveFile,
		closeFilePreview,
		refreshProjectFiles,
	} = useWorkbenchFileActions({
		stateRef,
		updateState,
		showToast,
		fileRequestRef,
		fileMetadataPromisesRef,
		projectTreeRefreshPromisesRef,
		projectTreeGenerationRef,
		loadProjectTreeRef,
		loadSessionTreeRef,
		loadGitStatus,
		loadGitStatusRef,
		loadGitBranchesRef,
		loadGitHistoryRef,
	});

	const {
		loadSessionTree,
		navigateTree,
		loadProjectTrust,
		setProjectTrust,
		loadDirectory,
		addProject,
		addProjectGroup,
		updateProjectGroup,
		removeProjectGroup,
		setProjectGroup,
		reorderProjectGroups,
		updateProject,
		reorderProjects,
		reorderSessions,
		removeProject,
	} = useWorkbenchProjectActions({
		stateRef,
		updateState,
		showToast,
		loadTranscript,
		selectProject,
		sessionTreeRequestRef,
		directoryRequestRef,
	});

	const {
		setModelProviderVisibility,
		saveModelProvider,
		removeModelProvider,
		saveProviderModel,
		setProviderModelEnabled,
		syncModelProvider,
		refreshSkills,
		refreshDiagnostics,
		restartDiagnosticService,
		toggleSkill,
		refreshHarnessImports,
		importHarnessResources,
		refreshSubagentConfigs,
		saveSubagentConfig,
		deleteSubagentConfig,
		refreshSecuritySettings,
		saveSecuritySettings,
		saveBranding,
		refreshSessionNameSettings,
		saveSessionNameSettings,
		refreshHostInstructions,
		saveHostInstruction,
		openSettings,
		closeSettings,
		setTheme,
		setComposerMode,
		openSubagent,
		closeSubagent,
		loadEarlierSubagentAction,
		abortSubagent,
		continueSubagent,
		respondUiRequest,
	} = useWorkbenchSettingsActions({
		stateRef,
		updateState,
		showToast,
		refreshModelOptions,
		refreshModelOptionsRef,
		refreshModelSettings,
		loadSubagent,
		loadEarlierSubagent,
	});

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
			refreshSessionNameSettings,
			saveSessionNameSettings,
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
			refreshProjectSessions,
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
			refreshProjectSessions,
			refreshSessionNameSettings,
			saveSessionNameSettings,
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
		refreshProjectSessions,
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
		refreshSessionNameSettings,
		refreshSecuritySettings,
		saveBranding,
		saveSessionNameSettings,
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
