import { gsap } from "gsap";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { WorkbenchState } from "../../state/use-workbench";
import type { WorkbenchActions } from "./types";
import type { ConversationTranscriptScrollState } from "./virtualized-transcript";

const SESSION_SCROLL_CACHE_LIMIT = 8;
export const HISTORY_LOAD_THRESHOLD = 240;

type EarlierHistoryState = Pick<
	WorkbenchState,
	"hasMorePrevious" | "loadingEarlier" | "previousCursor" | "transcriptError"
>;

type ConversationScrollOptions = EarlierHistoryState & {
	sessionId?: string;
	promptScrollRequest?: number;
	responseActive: boolean;
	loadEarlier: WorkbenchActions["loadEarlier"];
	showToast: WorkbenchActions["showToast"];
	resetExpandedState: () => void;
};

export function shouldLoadEarlierHistory(
	atTop: boolean,
	userInitiated: boolean,
	state: Pick<WorkbenchState, "hasMorePrevious" | "loadingEarlier" | "previousCursor" | "transcriptError">,
	requestedCursor: string | undefined,
): boolean {
	return (
		userInitiated &&
		atTop &&
		state.hasMorePrevious &&
		Boolean(state.previousCursor) &&
		state.previousCursor !== requestedCursor &&
		!state.loadingEarlier &&
		!state.transcriptError
	);
}

export function useConversationScroll({
	sessionId,
	promptScrollRequest,
	hasMorePrevious,
	loadingEarlier,
	previousCursor,
	transcriptError,
	responseActive,
	loadEarlier,
	showToast,
	resetExpandedState,
}: ConversationScrollOptions) {
	const virtuosoRef = useRef<VirtuosoHandle | null>(null);
	const transcriptScrollerRef = useRef<HTMLElement | null>(null);
	const scrollToBottomTweenRef = useRef<gsap.core.Tween | null>(null);
	const scrollToBottomSettleTimerRef = useRef<number>();
	const sessionScrollStatesRef = useRef(new Map<string, ConversationTranscriptScrollState>());
	const activeSessionIdRef = useRef(sessionId);
	activeSessionIdRef.current = sessionId;
	const [isAtBottom, setIsAtBottom] = useState(true);
	const [isAtTop, setIsAtTop] = useState(false);
	const readingEarlierRef = useRef(false);
	const historyLoadRequestedCursorRef = useRef<string>();
	const historyLoadInFlightRef = useRef<{ sessionId: string; cursor: string }>();
	const [followOutput, setFollowOutput] = useState<false | "auto">(false);
	const promptScrollRequestRef = useRef(promptScrollRequest);
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
		if (readingEarlierRef.current) {
			setIsAtBottom(false);
			return;
		}
		setIsAtBottom(atBottom);
		if (atBottom) {
			promptFollowRef.current = true;
			setFollowOutput("auto");
		}
	}, []);
	const pauseFollowOutput = useCallback(() => {
		promptFollowRef.current = false;
		setFollowOutput(false);
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
	const requestEarlierHistory = useCallback(
		(retry = false) => {
			if (
				!sessionId ||
				!hasMorePrevious ||
				!previousCursor ||
				loadingEarlier ||
				historyLoadInFlightRef.current ||
				(!retry && (transcriptError || historyLoadRequestedCursorRef.current === previousCursor))
			)
				return;
			historyLoadRequestedCursorRef.current = previousCursor;
			const request = { sessionId, cursor: previousCursor };
			historyLoadInFlightRef.current = request;
			void loadEarlier()
				.catch((error: unknown) => {
					if (activeSessionIdRef.current === sessionId)
						showToast(error instanceof Error ? error.message : String(error));
				})
				.finally(() => {
					if (historyLoadInFlightRef.current === request) historyLoadInFlightRef.current = undefined;
				});
		},
		[hasMorePrevious, loadEarlier, loadingEarlier, previousCursor, sessionId, showToast, transcriptError],
	);
	const handleUserScrollUp = useCallback(() => {
		if (
			shouldLoadEarlierHistory(
				isAtTop,
				true,
				{ hasMorePrevious, loadingEarlier, previousCursor, transcriptError },
				historyLoadRequestedCursorRef.current,
			)
		) {
			readingEarlierRef.current = true;
			requestEarlierHistory();
		}
	}, [hasMorePrevious, isAtTop, loadingEarlier, previousCursor, requestEarlierHistory, transcriptError]);

	useLayoutEffect(() => {
		if (promptScrollRequestRef.current === promptScrollRequest) return;
		promptScrollRequestRef.current = promptScrollRequest;
		readingEarlierRef.current = false;
		promptFollowRef.current = true;
		setFollowOutput("auto");
		scrollToBottom();
	}, [scrollToBottom, promptScrollRequest]);

	useEffect(() => {
		if (!promptFollowRef.current || responseActive) return;
		const frame = window.requestAnimationFrame(() => {
			promptFollowRef.current = false;
			setFollowOutput(false);
		});
		return () => window.cancelAnimationFrame(frame);
	}, [responseActive]);

	useLayoutEffect(() => {
		historyLoadRequestedCursorRef.current = undefined;
		historyLoadInFlightRef.current = undefined;
		readingEarlierRef.current = false;
		scrollToBottomTweenRef.current?.kill();
		scrollToBottomTweenRef.current = null;
		if (scrollToBottomSettleTimerRef.current !== undefined) {
			window.clearTimeout(scrollToBottomSettleTimerRef.current);
			scrollToBottomSettleTimerRef.current = undefined;
		}
		const savedScroll = sessionId ? sessionScrollStatesRef.current.get(sessionId) : undefined;
		const atBottom = savedScroll?.atBottom ?? true;
		resetExpandedState();
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
	}, [scrollToBottom, sessionId, resetExpandedState]);

	const handleReturnToBottom = useCallback(() => {
		readingEarlierRef.current = false;
		promptFollowRef.current = true;
		animateScrollToBottom();
	}, [animateScrollToBottom]);

	return {
		followOutput,
		handleAtBottomStateChange,
		handleAtTopStateChange: setIsAtTop,
		handleReturnToBottom,
		handleScrollStateCapture,
		handleTranscriptScrollerRef,
		handleUserScrollAway,
		handleUserScrollUp,
		handleVirtuosoRef,
		pauseFollowOutput,
		isAtBottom,
		requestEarlierHistory,
		scrollState: sessionId ? sessionScrollStatesRef.current.get(sessionId) : undefined,
	};
}
