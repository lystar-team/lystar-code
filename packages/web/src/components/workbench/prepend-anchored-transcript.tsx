import { useCallback, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
	VirtualizedConversationTranscript,
	type VirtualizedConversationTranscriptProps,
} from "./virtualized-transcript";

const SCROLL_UP_KEYS = new Set(["ArrowUp", "Home", "PageUp"]);
const SCROLL_DOWN_KEYS = new Set(["ArrowDown", "End", "PageDown", " "]);
const ANCHOR_TOLERANCE = 0.5;
const STABLE_FRAME_COUNT = 3;
const MISSING_ANCHOR_FRAME_LIMIT = 60;
const MAX_CAPTURED_ANCHORS = 16;

export type TranscriptContentAnchor = { anchorKey: string; anchorOffset: number };
export type TranscriptContentAnchorCandidate = { key: string; top: number; bottom: number };

type PrependAnchorTransaction = {
	anchors: TranscriptContentAnchor[];
	stableFrames: number;
	missingFrames: number;
};

type PrependAnchoredTranscriptProps<T> = VirtualizedConversationTranscriptProps<T> & {
	loadingEarlier: boolean;
};

export function transcriptAnchorScrollDelta(currentOffset: number, anchorOffset: number): number {
	if (!Number.isFinite(currentOffset) || !Number.isFinite(anchorOffset)) return 0;
	const delta = currentOffset - anchorOffset;
	return Math.abs(delta) < ANCHOR_TOLERANCE ? 0 : delta;
}

export function selectTranscriptContentAnchors(
	candidates: readonly TranscriptContentAnchorCandidate[],
	viewportTop: number,
	viewportBottom: number,
): TranscriptContentAnchor[] {
	const anchors: TranscriptContentAnchor[] = [];
	const seenKeys = new Set<string>();
	for (const candidate of candidates) {
		if (
			!candidate.key ||
			seenKeys.has(candidate.key) ||
			candidate.bottom <= viewportTop + ANCHOR_TOLERANCE ||
			candidate.top >= viewportBottom - ANCHOR_TOLERANCE
		)
			continue;
		seenKeys.add(candidate.key);
		anchors.push({ anchorKey: candidate.key, anchorOffset: candidate.top - viewportTop });
		if (anchors.length >= MAX_CAPTURED_ANCHORS) break;
	}
	return anchors;
}

export function shouldCancelPrependAnchorForWheel(deltaY: number, loadingEarlier: boolean): boolean {
	return deltaY > 0 || !loadingEarlier;
}

export function shouldCancelPrependAnchorForKey(key: string, loadingEarlier: boolean): boolean {
	if (SCROLL_DOWN_KEYS.has(key)) return true;
	return SCROLL_UP_KEYS.has(key) && !loadingEarlier;
}

function transcriptAnchorElements(scroller: HTMLElement): HTMLElement[] {
	return Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-anchor-key]"));
}

function captureVisibleContentAnchors(scroller: HTMLElement): TranscriptContentAnchor[] {
	const viewport = scroller.getBoundingClientRect();
	return selectTranscriptContentAnchors(
		transcriptAnchorElements(scroller).map((element) => {
			const bounds = element.getBoundingClientRect();
			return {
				key: element.dataset.transcriptAnchorKey ?? "",
				top: bounds.top,
				bottom: bounds.bottom,
			};
		}),
		viewport.top,
		viewport.bottom,
	);
}

export function PrependAnchoredConversationTranscript<T>({
	loadingEarlier,
	sessionKey,
	...props
}: PrependAnchoredTranscriptProps<T>) {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const loadingEarlierRef = useRef(loadingEarlier);
	const previousLoadingEarlierRef = useRef(loadingEarlier);
	const transactionRef = useRef<PrependAnchorTransaction>();
	const frameRef = useRef<number>();
	loadingEarlierRef.current = loadingEarlier;

	const stopAnchorTransaction = useCallback(() => {
		transactionRef.current = undefined;
		if (frameRef.current !== undefined) {
			window.cancelAnimationFrame(frameRef.current);
			frameRef.current = undefined;
		}
	}, []);

	const maintainAnchor = useCallback(function maintainAnchorFrame() {
		frameRef.current = undefined;
		const transaction = transactionRef.current;
		const scroller = rootRef.current?.querySelector<HTMLElement>(".conversation-scroll");
		if (!transaction || !scroller) {
			stopAnchorTransaction();
			return;
		}

		const elementsByKey = new Map(
			transcriptAnchorElements(scroller).flatMap((element) => {
				const key = element.dataset.transcriptAnchorKey;
				return key ? [[key, element] as const] : [];
			}),
		);
		const activeAnchor = transaction.anchors.find((anchor) => elementsByKey.has(anchor.anchorKey));
		const anchorElement = activeAnchor ? elementsByKey.get(activeAnchor.anchorKey) : undefined;
		if (!activeAnchor || !anchorElement) {
			transaction.stableFrames = 0;
			transaction.missingFrames += 1;
			if (!loadingEarlierRef.current && transaction.missingFrames >= MISSING_ANCHOR_FRAME_LIMIT) {
				stopAnchorTransaction();
				return;
			}
			frameRef.current = window.requestAnimationFrame(maintainAnchorFrame);
			return;
		}

		transaction.missingFrames = 0;
		const currentOffset = anchorElement.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
		const scrollDelta = transcriptAnchorScrollDelta(currentOffset, activeAnchor.anchorOffset);
		if (scrollDelta !== 0) scroller.scrollTop += scrollDelta;
		if (loadingEarlierRef.current || scrollDelta !== 0) transaction.stableFrames = 0;
		else transaction.stableFrames += 1;
		if (!loadingEarlierRef.current && transaction.stableFrames >= STABLE_FRAME_COUNT) {
			stopAnchorTransaction();
			return;
		}
		frameRef.current = window.requestAnimationFrame(maintainAnchorFrame);
	}, [stopAnchorTransaction]);

	const startAnchorTransaction = useCallback(() => {
		stopAnchorTransaction();
		const scroller = rootRef.current?.querySelector<HTMLElement>(".conversation-scroll");
		if (!scroller) return;
		const anchors = captureVisibleContentAnchors(scroller);
		if (!anchors.length) return;
		transactionRef.current = { anchors, stableFrames: 0, missingFrames: 0 };
		frameRef.current = window.requestAnimationFrame(maintainAnchor);
	}, [maintainAnchor, stopAnchorTransaction]);

	useLayoutEffect(() => {
		const wasLoadingEarlier = previousLoadingEarlierRef.current;
		previousLoadingEarlierRef.current = loadingEarlier;
		if (!wasLoadingEarlier && loadingEarlier) startAnchorTransaction();
	}, [loadingEarlier, startAnchorTransaction]);

	useLayoutEffect(() => () => stopAnchorTransaction(), [sessionKey, stopAnchorTransaction]);

	const cancelForScrollKey = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			if (shouldCancelPrependAnchorForKey(event.key, loadingEarlierRef.current)) stopAnchorTransaction();
		},
		[stopAnchorTransaction],
	);

	return (
		<div
			ref={rootRef}
			className="contents"
			onKeyDownCapture={cancelForScrollKey}
			onPointerDownCapture={stopAnchorTransaction}
			onWheelCapture={(event) => {
				if (shouldCancelPrependAnchorForWheel(event.deltaY, loadingEarlierRef.current)) stopAnchorTransaction();
			}}
		>
			<VirtualizedConversationTranscript {...props} sessionKey={sessionKey} />
		</div>
	);
}
