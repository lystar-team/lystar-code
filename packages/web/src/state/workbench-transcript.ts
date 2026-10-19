import { MAX_TRANSCRIPT_PAGE_SIZE } from "@lystar/code-web-protocol/limits";
import { useCallback, useEffect, useRef } from "react";
import { webApi } from "../adapters/host-protocol/api.ts";
import type { TranscriptResponse } from "../types.ts";
import { reconcileCommittedTurn, reconcilePendingUserPrompts } from "./chat-lifecycle.ts";
import { reconcileCompactionState } from "./compaction-state.ts";
import { isSameTranscriptHistory, isTranscriptResponseObsolete } from "./session-sync.ts";
import { agentStepIndexChanged, mergeAgentStepIndex } from "./session-timeline.ts";
import { mergeTranscriptPage, transcriptRenderIdOverrides } from "./transcript-state.ts";
import { reconcileLiveUserPrompts, withPromptSendTimes } from "./workbench-live-state.ts";
import { errorMessage, shouldClearLiveTurn } from "./workbench-state.ts";
import type { WorkbenchState } from "./workbench-types.ts";

type Ref<T> = { current: T };
type StateUpdate = (update: (current: WorkbenchState) => WorkbenchState) => void;
type HistoryBoundary = {
	generation: WorkbenchState["transcriptGeneration"];
	leafId: WorkbenchState["transcriptLeafId"];
	previousCursor: WorkbenchState["previousCursor"];
};

type TranscriptContext = {
	state: WorkbenchState;
	stateRef: Ref<WorkbenchState>;
	selectionRef: Ref<number>;
	transcriptRequestRef: Ref<number>;
	transcriptReadsRef: Ref<Map<string, Promise<TranscriptResponse | undefined>>>;
	readSelectedSession: <T>(sessionId: string, read: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined>;
	updateState: StateUpdate;
	transitionState: StateUpdate;
};

function applyTranscriptPage(
	current: WorkbenchState,
	result: TranscriptResponse,
	requestedHistory: HistoryBoundary,
	cursor: string | undefined,
	recoveringCursor: boolean,
): WorkbenchState {
	const currentHistoryChangedSinceRequest = cursor
		? requestedHistory.generation !== current.transcriptGeneration ||
			(requestedHistory.leafId !== current.transcriptLeafId &&
				requestedHistory.previousCursor !== current.previousCursor &&
				!current.transcript.some((item) => item.entryId === requestedHistory.leafId))
		: isTranscriptResponseObsolete(
				requestedHistory,
				{ generation: current.transcriptGeneration, leafId: current.transcriptLeafId },
				result,
			);
	const sameHistory =
		(isSameTranscriptHistory(
			{ generation: current.transcriptGeneration, leafId: current.transcriptLeafId },
			result,
		) ||
			(current.transcriptGeneration === result.transcriptGeneration &&
				(cursor
					// 游标可绑定未展示的 Hook 结束记录，尾页更新后仍属于同一历史。
					? current.previousCursorLeafId === result.leafId ||
						current.transcript.some((item) => item.entryId === result.leafId)
					: result.items.some((item) => item.entryId === current.transcriptLeafId || item.parentId === current.transcriptLeafId)))) &&
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
		return cursor ? { ...current, transcriptError: "历史记录已更新，请重新打开会话" } : { ...current, transcriptLoading: false };
	if (cursor && !sameHistory) return { ...current, transcriptError: "历史记录已更新，请重新打开会话" };
	if (staleRevision && !cursor) {
		return {
			...current,
			transcriptLoading: false,
			...(shouldClearLiveTurn(current) ? { liveTools: {}, liveTurnItems: [] } : {}),
		};
	}
	if (
		!cursor &&
		!recoveringCursor &&
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
			return !current.transcriptLoading && current.displayedResultRevision === result.resultRevision
				? current
				: { ...current, transcriptLoading: false, displayedResultRevision: result.resultRevision };
		return {
			...current,
			agentSteps: mergeAgentStepIndex(current.agentSteps, result.agentSteps),
			transcriptLoading: false,
			displayedResultRevision: result.resultRevision,
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
		// 有游标的是补更早历史，放前面；无游标的首屏在未加载过时放前面，已加载过是尾页更新放后面。
		Boolean(cursor) || !current.transcriptPageLoaded,
		sameHistory && !recoveringCursor,
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
		...(!cursor ? { displayedResultRevision: result.resultRevision } : {}),
		...(completedTurnSynced ? { liveTools: {}, liveSteps: {}, liveTurnItems: [] } : {}),
	};
	return {
		...updated,
		liveCompaction: reconcileCompactionState(updated.liveCompaction, updated.transcript),
	};
}

/** 历史读取、逐页提交与下一页预读共用同一条请求链路。 */
export function useWorkbenchTranscript({
	state, stateRef, selectionRef, transcriptRequestRef, transcriptReadsRef,
	readSelectedSession, updateState, transitionState,
}: TranscriptContext) {
	const prefetched = useRef<{ key: string; page: Promise<TranscriptResponse | undefined> }>();
	const readPage = useCallback((sessionId: string, cursor?: string) => {
		const key = JSON.stringify([selectionRef.current, sessionId, cursor, stateRef.current.transcriptGeneration]);
		if (prefetched.current?.key === key) {
			const page = prefetched.current.page;
			prefetched.current = undefined;
			return page;
		}
		const pending = transcriptReadsRef.current.get(key);
		if (pending) return pending;
		const request = readSelectedSession(sessionId, (signal) =>
			webApi.transcript(sessionId, { cursor, limit: MAX_TRANSCRIPT_PAGE_SIZE, signal }));
		const tracked = request.finally(() => {
			if (transcriptReadsRef.current.get(key) === tracked) transcriptReadsRef.current.delete(key);
		});
		transcriptReadsRef.current.set(key, tracked);
		return tracked;
	}, [readSelectedSession]);

	useEffect(() => {
		prefetched.current = undefined;
		if (!state.connected || !state.sessionReady || !state.sessionId || !state.transcriptPageLoaded ||
			state.transcriptLoading || state.loadingEarlier || state.transcriptError || !state.hasMorePrevious || !state.previousCursor) return;
		// 只预读一页，不提交状态或递归翻页；读取失败留给用户实际加载时重试。
		const entry = {
			key: JSON.stringify([selectionRef.current, state.sessionId, state.previousCursor, state.transcriptGeneration]),
			page: readPage(state.sessionId, state.previousCursor),
		};
		prefetched.current = entry;
		void entry.page.catch(() => {
			if (prefetched.current === entry) prefetched.current = undefined;
		});
		return () => { if (prefetched.current === entry) prefetched.current = undefined; };
	}, [readPage, state.connected, state.sessionReady, state.sessionId, state.transcriptGeneration,
		state.transcriptPageLoaded, state.transcriptLoading, state.loadingEarlier, state.transcriptError,
		state.hasMorePrevious, state.previousCursor]);

	const loadTranscript = useCallback(
		async function readTranscript(
			sessionId = stateRef.current.sessionId,
			cursor?: string,
			deferCommit = false,
			completeTurn = false,
			recoveringCursor = false,
		): Promise<void> {
			if (!sessionId || stateRef.current.sessionId !== sessionId) return;
			const selection = selectionRef.current;
			const requestIsActive = () => selectionRef.current === selection && stateRef.current.sessionId === sessionId;
			const requestId = cursor ? transcriptRequestRef.current : ++transcriptRequestRef.current;
			if (!cursor && (!stateRef.current.transcriptPageLoaded || stateRef.current.transcriptError)) {
				updateState((current) => ({ ...current, transcriptLoading: true, transcriptError: undefined }));
			}
			const requiredUsers = stateRef.current.transcript.some((item) => item.view?.type === "user") ? 1 : 2;
			const userIds = new Set<string>();
			const visitedCursors = new Set<string>();
			let pageCursor = cursor;
			let firstPage: TranscriptResponse | undefined;
			try {
				do {
					if (!requestIsActive()) return;
					if (pageCursor) {
						if (visitedCursors.has(pageCursor)) throw new Error("历史游标未前进");
						visitedCursors.add(pageCursor);
					}
					const requestedHistory: HistoryBoundary = {
						generation: stateRef.current.transcriptGeneration,
						leafId: stateRef.current.transcriptLeafId,
						previousCursor: stateRef.current.previousCursor,
					};
					const result = await readPage(sessionId, pageCursor);
					if (!result || !requestIsActive() || (!cursor && requestId !== transcriptRequestRef.current)) return;
					if (cursor && stateRef.current.transcriptGeneration !== requestedHistory.generation)
						throw new Error("历史记录已更新，请重新打开会话");
					if (firstPage && (result.transcriptGeneration !== firstPage.transcriptGeneration || result.leafId !== firstPage.leafId))
						throw new Error("历史记录发生变化，请重新打开会话");
					firstPage ??= result;
					// 每页完成即提交；后续页失败或切走时，已读历史仍有有效边界可恢复。
					(deferCommit && !cursor ? transitionState : updateState)((current) =>
						applyTranscriptPage(current, result, requestedHistory, pageCursor, recoveringCursor));
					if (!cursor || !completeTurn || stateRef.current.transcriptError || !result.hasMorePrevious) return;
					for (const item of result.items) if (item.view?.type === "user") userIds.add(item.entryId);
					if (userIds.size >= requiredUsers) return;
					if (!result.previousCursor) throw new Error("历史游标未前进");
					pageCursor = result.previousCursor;
				} while (true);
			} catch (error) {
				if (!requestIsActive() || (!cursor && requestId !== transcriptRequestRef.current)) return;
				if (!recoveringCursor && error instanceof Error && "code" in error && error.code === "cursor_stale") {
					// 文件重写后只恢复一次尾页，重新建立窗口与分页边界。
					await readTranscript(sessionId, undefined, deferCommit, false, true);
					return;
				}
				updateState((current) => ({ ...current, transcriptLoading: false, transcriptError: errorMessage(error) }));
				throw error;
			}
		},
		[readPage, transitionState, updateState],
	);
	return loadTranscript;
}
