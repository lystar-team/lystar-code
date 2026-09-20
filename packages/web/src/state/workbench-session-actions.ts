import { useCallback } from "react";
import { createUuid } from "@lystar/code-web-protocol";
import { webApi } from "../adapters/host-protocol/api.ts";
import type {
	PromptAttachment,
	PromptAttachmentPreview,
	QueuedUserPrompt,
} from "../types.ts";
import {
	applyPromptAccepted,
	canSendPrompt,
	hasActiveSessionWork,
	promptDisplayText,
	removeQueuedUserPrompt,
	reconcilePendingUserPrompts,
	submitPromptWithFollowUpFallback,
	type PendingUserPrompt,
} from "./chat-lifecycle.ts";
import {
	ACTIVE_OPERATION_STATUSES,
	errorMessage,
	operationForSessionSnapshot,
	projectInspectorStateForSelection,
	readCachedSessionDetail,
	sessionDetailCacheFromState,
	updateSessionActivity,
	updateSessionSummaryFirstMessage,
	updateSessionSummaryName,
	cacheSessionDetail,
} from "./workbench-state.ts";
import {
	appendLiveUserPrompt,
	removeLiveUserPrompt,
	restoreRuntimeActivities,
	runningAgentStepId,
	withPromptSendTimes,
} from "./workbench-live-state.ts";
import { isOlderSessionSnapshot } from "./session-sync.ts";
import type { CachedSessionDetail } from "./workbench-state.ts";
import type { ComposerMode, WorkbenchState } from "./workbench-types.ts";

type StateRef = { current: WorkbenchState };
type StateUpdate = WorkbenchState | ((current: WorkbenchState) => WorkbenchState);
type UpdateState = (update: StateUpdate) => WorkbenchState;
type Ref<T> = { current: T };
type PromiseMapRef = { current: Map<string, Promise<void>> };
type StringSetRef = { current: Set<string> };
type SessionSubscriptionResult = "ready" | "gap" | "timeout" | "closed";

export interface WorkbenchSessionActionsContext {
	stateRef: StateRef;
	updateState: UpdateState;
	transitionState: (update: StateUpdate | ((current: WorkbenchState) => WorkbenchState)) => void;
	showToast: (message: string) => void;
	refreshProjectSessions: (projectId: string) => Promise<void>;
	loadTranscript: (sessionId?: string, cursor?: string, deferCommit?: boolean) => Promise<void>;
	loadSubagents: (sessionId?: string) => Promise<void>;
	loadSessionOperations: (sessionId: string) => Promise<void>;
	subscribeSessionAndWait: (sessionId: string) => Promise<SessionSubscriptionResult>;
	completeSessionSubscription: (sessionId: string, result: SessionSubscriptionResult) => Promise<boolean>;
	scheduleTranscriptRefresh: (sessionId?: string) => void;
	selectionRef: Ref<number>;
	selectionInFlightRef: Ref<string | undefined>;
	socketRef: Ref<WebSocket | undefined>;
	fileRequestRef: Ref<number>;
	fileMetadataPromisesRef: PromiseMapRef;
	projectTreeRefreshPromisesRef: PromiseMapRef;
	gitStatusPromiseRef: Ref<Promise<void> | undefined>;
	gitStatusRequestRef: Ref<number>;
	gitBranchesRequestRef: Ref<number>;
	gitHistoryRequestRef: Ref<number>;
	gitCommitRequestRef: Ref<number>;
	gitDiffRequestRef: Ref<number>;
	gitStatsRepositoryRef: StringSetRef;
	projectTreeGenerationRef: Ref<number>;
	sessionTreeRequestRef: Ref<number>;
	transcriptTimerRef: Ref<number | undefined>;
	transcriptRefreshPendingRef: Ref<string | undefined>;
	transcriptRequestRef: Ref<number>;
	pendingUserPromptRef: Ref<number>;
	sessionDetailCacheRef: Ref<Map<string, CachedSessionDetail>>;
	sessionDetailSeqRef: Ref<Map<string, number>>;
	loadProjectTreeRef: Ref<(path?: string) => Promise<void>>;
	loadGitStatusRef: Ref<(silent?: boolean) => Promise<void>>;
	loadProjectTrustRef: Ref<() => Promise<void>>;
	loadSessionTreeRef: Ref<() => Promise<void>>;
}

export function useWorkbenchSessionActions({
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
}: WorkbenchSessionActionsContext) {
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
								agentSteps: {},
								transcriptPageLoaded: false,
								transcriptGeneration: undefined,
								toolActivityEpoch: undefined,
								toolActivityRevision: undefined,
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
				agentSteps: {},
				transcriptPageLoaded: false,
				transcriptLoading: false,
				transcriptError: undefined,
				transcriptGeneration: undefined,
				toolActivityEpoch: undefined,
				toolActivityRevision: undefined,
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
			agentSteps: {},
			transcriptPageLoaded: false,
			transcriptLoading: false,
			transcriptError: undefined,
			transcriptGeneration: undefined,
			transcriptRevision: undefined,
			transcriptLeafId: undefined,
			previousCursor: undefined,
			hasMorePrevious: false,
			toolActivityEpoch: undefined,
			toolActivityRevision: undefined,
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
							agentSteps: {},
							transcriptPageLoaded: false,
							transcriptLoading: false,
							transcriptError: undefined,
							transcriptGeneration: undefined,
							toolActivityEpoch: undefined,
							toolActivityRevision: undefined,
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
				agentSteps: {},
				transcriptPageLoaded: false,
				transcriptLoading: true,
				transcriptError: undefined,
				sessionError: undefined,
				toolActivityEpoch: undefined,
				toolActivityRevision: undefined,
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

	return {
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
	};
}
