import { useCallback, useRef } from "react";
import type { WorkbenchState } from "../../state/use-workbench";
import type { WorkbenchActions } from "./types";

export const HISTORY_LOAD_THRESHOLD = 800;
type HistoryState = Pick<WorkbenchState, "hasMorePrevious" | "loadingEarlier" | "previousCursor" | "transcriptError">;

type ConversationHistoryOptions = HistoryState & {
	sessionKey: string;
	loadEarlier: WorkbenchActions["loadEarlier"];
	showToast: WorkbenchActions["showToast"];
};
type HistoryRequest = {
	sessionKey: string;
	atTop: boolean;
	upwardIntent: boolean;
	requestedCursor?: string;
	inFlight?: object;
};

export function shouldLoadEarlierHistory(
	atTop: boolean,
	userInitiated: boolean,
	state: HistoryState,
	requestedCursor: string | undefined,
): boolean {
	return userInitiated && atTop && state.hasMorePrevious && Boolean(state.previousCursor) &&
		state.previousCursor !== requestedCursor && !state.loadingEarlier && !state.transcriptError;
}

/** 历史请求只响应向上阅读，不因列表补偿或首屏定位自动连翻。 */
export function useConversationHistory({ sessionKey, loadEarlier, showToast, ...state }: ConversationHistoryOptions) {
	const active = useRef<HistoryRequest>({ sessionKey, atTop: false, upwardIntent: false });
	if (active.current.sessionKey !== sessionKey) active.current = { sessionKey, atTop: false, upwardIntent: false };

	const requestEarlierHistory = useCallback((retry = false) => {
		const requestState = active.current;
		if (!state.hasMorePrevious || !state.previousCursor || state.loadingEarlier || requestState.inFlight ||
			(!retry && (state.transcriptError || requestState.requestedCursor === state.previousCursor))) return;
		requestState.requestedCursor = state.previousCursor;
		const request = {};
		requestState.inFlight = request;
		void loadEarlier().catch((error: unknown) => {
			if (active.current === requestState) showToast(error instanceof Error ? error.message : String(error), "error");
		}).finally(() => {
			if (requestState.inFlight === request) requestState.inFlight = undefined;
		});
	}, [loadEarlier, showToast, state.hasMorePrevious, state.loadingEarlier, state.previousCursor, state.transcriptError]);

	const tryLoad = useCallback(() => {
		const requestState = active.current;
		if (!requestState.atTop) return;
		const shouldLoad = shouldLoadEarlierHistory(true, requestState.upwardIntent, state, requestState.requestedCursor);
		requestState.upwardIntent = false;
		if (shouldLoad) requestEarlierHistory();
	}, [requestEarlierHistory, state.hasMorePrevious, state.loadingEarlier, state.previousCursor, state.transcriptError]);

	const handleAtTopStateChange = useCallback((value: boolean) => {
		active.current.atTop = value;
		if (value) tryLoad();
	}, [tryLoad]);
	const handleUserScrollUp = useCallback(() => {
		active.current.upwardIntent = true;
		tryLoad();
	}, [tryLoad]);
	const handleUserScrollDown = useCallback(() => { active.current.upwardIntent = false; }, []);

	return { requestEarlierHistory, handleAtTopStateChange, handleUserScrollUp, handleUserScrollDown };
}
