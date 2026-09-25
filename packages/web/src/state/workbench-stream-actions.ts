import { useCallback } from "react";
import {
	type SessionProgress,
} from "@lystar/code-web-protocol";
import { webApi } from "../adapters/host-protocol/api.ts";
import type {
	GatewayEvent,
	ProjectGroup,
	UiRequestEvent,
	WebLease,
	WebOperation,
	WebProject,
} from "../types.ts";
import {
	hasActiveSessionSnapshot,
	hasActiveSessionWork,
	reconcileCommittedTurn,
	reconcilePendingUserPrompts,
} from "./chat-lifecycle.ts";
import { reconcileCompactionState } from "./compaction-state.ts";
import {
	connectionStateAfterHostUpdate,
	connectionStateAfterSessionSubscription,
} from "./connection-recovery.ts";
import {
	isOlderSessionSnapshot,
	isSameSessionSnapshot,
	needsTranscriptRefreshForCommit,
	runtimeHistoryChanged,
} from "./session-sync.ts";
import { agentStepIndexChanged, mergeAgentStepIndex } from "./session-timeline.ts";
import {
	appendLiveTextBlock,
	applySubagentProgress,
	createSubagentConversationState,
	mergeSubagentSnapshots,
	reconcileLiveUserPrompts,
	restoreRuntimeActivities,
	withPromptSendTimes,
} from "./workbench-live-state.ts";
import { useWorkbenchProgressActions } from "./workbench-progress-actions.ts";
import {
	ACTIVE_OPERATION_STATUSES,
	TERMINAL_OPERATION_STATUSES,
	browserNetworkOnline,
	changedFilePaths,
	errorMessage,
	eventIsObject,
	operationForSessionSnapshot,
	sessionActivityFromProgress,
	shouldRefreshCompletedTurn,
	updateSessionActivity,
	updateSessionSummaryName,
} from "./workbench-state.ts";
import type { CachedSessionDetail } from "./workbench-session-cache.ts";
import {
	mergeTranscriptEntries,
	transcriptRenderIdOverrides,
} from "./transcript-state.ts";
import type {
	LiveTurnItem,
	WorkbenchState,
} from "./workbench-types.ts";

type StateRef = { current: WorkbenchState };
type StateUpdate = WorkbenchState | ((current: WorkbenchState) => WorkbenchState);
type UpdateState = (update: StateUpdate) => WorkbenchState;
type Ref<T> = { current: T };
type LiveTextProgress = Extract<SessionProgress, { type: "assistant_delta" | "thinking_delta" }>;
type PendingTextProgress = { selection: number; sessionId: string; progress: LiveTextProgress };
type SessionSubscriptionResult = "ready" | "gap" | "timeout" | "closed";
type SessionSubscriptionWaiter = {
	resolve: (result: SessionSubscriptionResult) => void;
	timeoutId: number;
};
const MAX_HANDLED_NOTIFY_IDS = 256;

export interface WorkbenchStreamActionsContext {
	stateRef: StateRef;
	updateState: UpdateState;
	showToast: (message: string) => void;
	applyBootstrap: (data: {
		projects: WebProject[];
		projectGroups: ProjectGroup[];
		capabilities: readonly string[];
		connection: { connected: boolean; host: string; productVersion?: string };
		pendingUiRequests: UiRequestEvent[];
		operations: WebOperation[];
		leases?: Array<{ sessionId: string; lease: WebLease }>;
	}) => void;
	refreshBootstrap: () => Promise<void>;
	refreshProjectSessions: (projectId: string) => Promise<void>;
	loadTranscript: (sessionId?: string, cursor?: string, deferCommit?: boolean) => Promise<void>;
	loadSessionOperations: (sessionId: string) => Promise<void>;
	loadSessionSnapshot: (sessionId: string) => Promise<void>;
	loadSubagents: (sessionId?: string) => Promise<void>;
	refreshProjectFilesRef: Ref<(paths: readonly string[]) => Promise<void>>;
	refreshModelOptionsRef: Ref<() => Promise<void>>;
	refreshModelSettingsRef: Ref<() => Promise<void>>;
	selectionRef: Ref<number>;
	selectionInFlightRef: Ref<string | undefined>;
	socketRef: Ref<WebSocket | undefined>;
	reconnectAttemptRef: Ref<number>;
	liveToolBatchRef: Ref<number>;
	liveTurnItemRef: Ref<number>;
	pendingTextProgressRef: Ref<PendingTextProgress[]>;
	pendingTextFrameRef: Ref<number | undefined>;
	pendingTextTimeoutRef: Ref<number | undefined>;
	transcriptTimerRef: Ref<number | undefined>;
	transcriptRefreshPendingRef: Ref<string | undefined>;
	sessionDetailCacheRef: Ref<Map<string, CachedSessionDetail>>;
	sessionDetailSeqRef: Ref<Map<string, number>>;
	scheduleSubagentTranscriptRefresh: (agentId: string, sessionId?: string) => void;
	sessionSubscriptionWaitersRef: Ref<Map<string, Set<SessionSubscriptionWaiter>>>;
	handledNotifyIdsRef: Ref<Set<string>>;
}

export function useWorkbenchStreamActions({
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
}: WorkbenchStreamActionsContext) {
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

	const { flushPendingTextProgress, applyProgress } = useWorkbenchProgressActions({
		stateRef,
		updateState,
		selectionRef,
		liveToolBatchRef,
		liveTurnItemRef,
		pendingTextProgressRef,
		pendingTextFrameRef,
		pendingTextTimeoutRef,
	});

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
					const retained = current.liveTurnItems.filter(
						(item) => item.kind === "tools" || item.kind === "user" || item.kind === "compaction",
					);
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
									agentSteps: {},
									toolActivityEpoch: undefined,
									toolActivityRevision: undefined,
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
								agentSteps: {},
								toolActivityEpoch: undefined,
								toolActivityRevision: undefined,
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
				const refreshNeeded =
					Boolean(event.agentSteps?.length && agentStepIndexChanged(stateRef.current.agentSteps, event.agentSteps)) ||
					needsTranscriptRefreshForCommit(
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
						agentSteps: mergeAgentStepIndex(current.agentSteps, event.agentSteps),
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

	return {
		scheduleTranscriptRefresh,
		cancelScheduledTranscriptRefresh,
		flushPendingTextProgress,
		settleSessionSubscriptionWaiters,
		subscribeSessionAndWait,
		completeSessionSubscription,
		restoreSelectedSessionSubscription,
		handleEvent,
	};
}
