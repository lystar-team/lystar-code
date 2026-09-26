import type { ReactNode } from "react";
import { forwardRef, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	Virtuoso,
	type FollowOutput,
	type IndexLocationWithAlign,
	type ListProps,
	type ScrollerProps,
	type VirtuosoHandle,
} from "react-virtuoso";

export const DEFAULT_TRANSCRIPT_GAP = 12;
const TRANSCRIPT_OVERSCAN = 480;
const TRANSCRIPT_MIN_OVERSCAN_ITEMS = 4;
const INITIAL_RENDER_ITEM_COUNT = 24;
export const CONVERSATION_EDGE_PADDING = 48;
const TRANSCRIPT_FIRST_ITEM_INDEX = 1_000_000_000;

export type ConversationTranscriptAnchor = { atBottom: false; anchorKey: string; anchorOffset: number };

export type ConversationTranscriptScrollState = { atBottom: true } | ConversationTranscriptAnchor;

type TranscriptAnchorCandidate = { index: number; top: number; bottom: number };

type ScrollRef = { current: HTMLElement | null };
type TranscriptGap<T> = number | ((previous: T, current: T, index: number) => number);

function normalizeHeight(value: number): number {
	return Number.isFinite(value) ? Math.max(1, value) : 1;
}

function normalizeGap(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function transcriptGapAt<T>(items: readonly T[], index: number, gap: TranscriptGap<T>): number {
	if (index >= items.length - 1) return 0;
	const value = typeof gap === "function" ? gap(items[index], items[index + 1], index) : gap;
	return normalizeGap(value);
}

export function safeTranscriptItemKey<T>(
	index: number,
	item: T | undefined,
	getKey: (item: T, index: number) => React.Key,
): React.Key {
	return item === undefined ? `virtual-placeholder:${index}` : getKey(item, index);
}

export function shouldCaptureTranscriptScrollState(
	userInitiated: boolean,
	atBottom: boolean,
	followOutput: FollowOutput,
): boolean {
	return userInitiated || (atBottom && followOutput !== false);
}

export function selectTranscriptScrollAnchor<T>(
	items: readonly T[],
	candidates: readonly TranscriptAnchorCandidate[],
	viewportTop: number,
	getKey: (item: T, index: number) => string,
): ConversationTranscriptAnchor | undefined {
	for (const candidate of candidates) {
		const item = items[candidate.index];
		if (!Number.isInteger(candidate.index) || item === undefined || candidate.bottom <= viewportTop + 0.5) continue;
		return {
			atBottom: false,
			anchorKey: getKey(item, candidate.index),
			anchorOffset: candidate.top - viewportTop,
		};
	}
	return undefined;
}

export function buildTranscriptHeightEstimates<T>(
	items: readonly T[],
	estimateHeight: (item: T, index: number) => number,
	gap: TranscriptGap<T> = DEFAULT_TRANSCRIPT_GAP,
): number[] {
	return items.map((item, index) => normalizeHeight(estimateHeight(item, index)) + transcriptGapAt(items, index, gap));
}

type VirtualizedTranscriptRowProps = {
	item: unknown;
	index: number;
	gap: number;
	renderItem: (item: unknown, index: number) => ReactNode;
	isItemEqual?: (previous: unknown, next: unknown) => boolean;
};

const VirtualizedTranscriptRow = memo(
	function VirtualizedTranscriptRow({ item, index, gap, renderItem }: VirtualizedTranscriptRowProps) {
		return (
			<div data-virtualized-transcript-row>
				{renderItem(item, index)}
				{gap > 0 ? <div aria-hidden="true" style={{ height: gap }} /> : null}
			</div>
		);
	},
	(previous, next) => {
		if (
			previous.index !== next.index ||
			previous.gap !== next.gap ||
			previous.renderItem !== next.renderItem
		)
			return false;
		return next.isItemEqual ? next.isItemEqual(previous.item, next.item) : previous.item === next.item;
	},
);

export interface VirtualizedTranscriptProps<T> {
	items: readonly T[];
	getKey: (item: T, index: number) => string;
	estimateHeight: (item: T, index: number) => number;
	renderItem: (item: T, index: number) => ReactNode;
	scrollRef: ScrollRef;
	isItemEqual?: (previous: T, next: T) => boolean;
	gap?: TranscriptGap<T>;
}

function useTranscriptRenderer<T>({
	items,
	getKey,
	estimateHeight,
	renderItem,
	isItemEqual,
	gap,
}: Omit<VirtualizedTranscriptProps<T>, "scrollRef">) {
	const itemsRef = useRef(items);
	const gapRef = useRef(gap ?? DEFAULT_TRANSCRIPT_GAP);
	itemsRef.current = items;
	gapRef.current = gap ?? DEFAULT_TRANSCRIPT_GAP;

	const heightEstimates = useMemo(
		() => buildTranscriptHeightEstimates(items, estimateHeight, gap ?? DEFAULT_TRANSCRIPT_GAP),
		[estimateHeight, gap, items],
	);
	const computeItemKey = useCallback(
		(index: number, item: T | undefined) => safeTranscriptItemKey(index, item, getKey),
		[getKey],
	);
	const itemContent = useCallback(
		(index: number, item: T | undefined) => {
			if (item === undefined) return null;
			const currentItems = itemsRef.current;
			return (
				<VirtualizedTranscriptRow
					item={item}
					index={index}
					gap={transcriptGapAt(currentItems, index, gapRef.current)}
					renderItem={renderItem as (item: unknown, index: number) => ReactNode}
					isItemEqual={isItemEqual as ((previous: unknown, next: unknown) => boolean) | undefined}
				/>
			);
		},
		[isItemEqual, renderItem],
	);
	return { computeItemKey, heightEstimates, itemContent };
}

export function VirtualizedTranscript<T>({
	items,
	getKey,
	estimateHeight,
	renderItem,
	scrollRef,
	isItemEqual,
	gap = DEFAULT_TRANSCRIPT_GAP,
}: VirtualizedTranscriptProps<T>) {
	const [scrollParent, setScrollParent] = useState<HTMLElement | null>(() => scrollRef.current);
	const renderer = useTranscriptRenderer({ items, getKey, estimateHeight, renderItem, isItemEqual, gap });

	useLayoutEffect(() => {
		if (scrollRef.current) {
			setScrollParent(scrollRef.current);
			return;
		}
		let frame = window.requestAnimationFrame(function bindScrollParent() {
			if (scrollRef.current) setScrollParent(scrollRef.current);
			else frame = window.requestAnimationFrame(bindScrollParent);
		});
		return () => window.cancelAnimationFrame(frame);
	}, [scrollRef]);

	if (!items.length) return null;
	if (!scrollParent) {
		return (
			<>
				{items.slice(0, INITIAL_RENDER_ITEM_COUNT).map((item, index) => (
					<VirtualizedTranscriptRow
						key={getKey(item, index)}
						item={item}
						index={index}
						gap={transcriptGapAt(items, index, gap)}
						renderItem={renderItem as (item: unknown, index: number) => ReactNode}
						isItemEqual={isItemEqual as ((previous: unknown, next: unknown) => boolean) | undefined}
					/>
				))}
			</>
		);
	}

	return (
		<Virtuoso
			computeItemKey={renderer.computeItemKey}
			customScrollParent={scrollParent}
			data={items}
			heightEstimates={renderer.heightEstimates}
			itemContent={renderer.itemContent}
			minOverscanItemCount={{ bottom: TRANSCRIPT_MIN_OVERSCAN_ITEMS, top: TRANSCRIPT_MIN_OVERSCAN_ITEMS }}
			overscan={{ main: TRANSCRIPT_OVERSCAN, reverse: TRANSCRIPT_OVERSCAN }}
			style={{ minWidth: 0, width: "100%" }}
		/>
	);
}

type ConversationTranscriptContext = {
	footer: ReactNode;
	header: ReactNode;
	onScrollerRef: (element: HTMLElement | null) => void;
	onUserScrollAway: () => void;
	onUserScrollIntent: () => void;
	onUserScrollUp: () => void;
	onExpansionIntent?: () => void;
};

const SCROLL_AWAY_KEYS = new Set(["ArrowUp", "Home", "PageUp"]);
const SCROLL_INTENT_KEYS = new Set(["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "]);

const ConversationTranscriptScroller = forwardRef<
	HTMLDivElement,
	ScrollerProps & { context: ConversationTranscriptContext }
>(function ConversationTranscriptScroller({ children, context, style, ...props }, forwardedRef) {
	const pointerActiveRef = useRef(false);
	const lastScrollTopRef = useRef<number>();
	const lastTouchYRef = useRef<number>();
	const contextRef = useRef(context);
	contextRef.current = context;
	const attachScroller = useCallback(
		(element: HTMLDivElement | null) => {
			if (typeof forwardedRef === "function") forwardedRef(element);
			else if (forwardedRef) forwardedRef.current = element;
			contextRef.current.onScrollerRef(element);
		},
		[forwardedRef],
	);
	return (
		<div
			{...props}
			ref={attachScroller}
			className="conversation-scroll min-w-0 max-w-full overflow-auto overscroll-y-contain"
			style={{ ...style, overflowAnchor: "none" }}
			onClickCapture={(event) => {
				if (
					event.target instanceof Element &&
					event.target.closest('[data-slot="collapsible-trigger"][data-transcript-resize-anchor]')
				) contextRef.current.onExpansionIntent?.();
			}}
			onKeyDownCapture={(event) => {
				if (SCROLL_INTENT_KEYS.has(event.key)) contextRef.current.onUserScrollIntent();
				if (SCROLL_AWAY_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) {
					contextRef.current.onUserScrollAway();
					contextRef.current.onUserScrollUp();
				}
			}}
			onWheelCapture={(event) => {
				contextRef.current.onUserScrollIntent();
				if (event.deltaY < 0) {
					contextRef.current.onUserScrollAway();
					contextRef.current.onUserScrollUp();
				}
			}}
			onTouchStart={(event) => {
				lastTouchYRef.current = event.touches[0]?.clientY;
			}}
			onTouchMove={(event) => {
				const y = event.touches[0]?.clientY;
				if (y !== undefined && lastTouchYRef.current !== undefined && y > lastTouchYRef.current) {
					contextRef.current.onUserScrollIntent();
					contextRef.current.onUserScrollAway();
					contextRef.current.onUserScrollUp();
				}
				lastTouchYRef.current = y;
			}}
			onTouchEnd={() => {
				lastTouchYRef.current = undefined;
			}}
			onPointerCancel={() => {
				pointerActiveRef.current = false;
			}}
			onPointerDown={(event) => {
				pointerActiveRef.current = true;
				lastScrollTopRef.current = event.currentTarget.scrollTop;
			}}
			onPointerUp={() => {
				pointerActiveRef.current = false;
			}}
			onScroll={(event) => {
				const element = event.currentTarget;
				const scrollingUp = lastScrollTopRef.current !== undefined && element.scrollTop < lastScrollTopRef.current;
				lastScrollTopRef.current = element.scrollTop;
				if (!pointerActiveRef.current) return;
				contextRef.current.onUserScrollIntent();
				if (element.scrollHeight - element.scrollTop - element.clientHeight > 2)
					contextRef.current.onUserScrollAway();
				if (scrollingUp) contextRef.current.onUserScrollUp();
			}}
		>
			{context.header ? (
				<div className="pointer-events-none absolute top-0 right-0 left-0 z-10 mx-auto min-w-0 w-full max-w-[var(--conversation-width)] px-5 pt-2 sm:px-10">
					<div className="pointer-events-auto">{context.header}</div>
				</div>
			) : null}
			{children}
		</div>
	);
});

function ConversationTranscriptHeader() {
	return <div aria-hidden="true" style={{ height: CONVERSATION_EDGE_PADDING }} />;
}

function ConversationTranscriptFooter({ context }: { context: ConversationTranscriptContext }) {
	return (
		<div style={{ height: CONVERSATION_EDGE_PADDING }}>
			<div className="conversation-content mx-auto min-w-0 w-full max-w-[var(--conversation-width)] px-5 sm:px-10">
				{context.footer}
			</div>
		</div>
	);
}

const ConversationTranscriptList = forwardRef<
	HTMLDivElement,
	ListProps & { context: ConversationTranscriptContext }
>(function ConversationTranscriptList({ context: _context, style, ...props }, ref) {
	return (
		<div
			{...props}
			ref={ref}
			className="conversation-content mx-auto min-w-0 w-full max-w-[var(--conversation-width)] px-5 sm:px-10"
			style={style}
		/>
	);
});

const CONVERSATION_TRANSCRIPT_COMPONENTS = {
	Footer: ConversationTranscriptFooter,
	Header: ConversationTranscriptHeader,
	List: ConversationTranscriptList,
	Scroller: ConversationTranscriptScroller,
};

type TranscriptWindowAnchor = { sessionKey: string; firstItemIndex: number; firstKey: string };

export function resolveTranscriptFirstItemIndex(
	previous: TranscriptWindowAnchor | undefined,
	itemKeys: readonly string[],
): number {
	if (!previous) return TRANSCRIPT_FIRST_ITEM_INDEX;
	const prependedItemCount = itemKeys.indexOf(previous.firstKey);
	return prependedItemCount > 0 ? previous.firstItemIndex - prependedItemCount : previous.firstItemIndex;
}

export function transcriptDataIndex(index: number, firstItemIndex: number): number {
	return index - firstItemIndex;
}

function useTranscriptFirstItemIndex<T>(
	items: readonly T[],
	getKey: (item: T, index: number) => string,
	sessionKey: string,
): number {
	const committedWindowRef = useRef<TranscriptWindowAnchor>();
	const committed = committedWindowRef.current;
	const previous = committed?.sessionKey === sessionKey ? committed : undefined;
	const firstKey = items.length ? getKey(items[0], 0) : "";
	let firstItemIndex = previous?.firstItemIndex ?? TRANSCRIPT_FIRST_ITEM_INDEX;
	if (previous && firstKey !== previous.firstKey) {
		const prependedItemCount = items.findIndex((item, index) => getKey(item, index) === previous.firstKey);
		if (prependedItemCount > 0) firstItemIndex -= prependedItemCount;
	}

	useLayoutEffect(() => {
		committedWindowRef.current = { sessionKey, firstItemIndex, firstKey };
	}, [firstItemIndex, firstKey, sessionKey]);
	return firstItemIndex;
}

export interface VirtualizedConversationTranscriptProps<T>
	extends Omit<VirtualizedTranscriptProps<T>, "scrollRef"> {
	atBottomStateChange: (atBottom: boolean) => void;
	atTopStateChange: (atTop: boolean) => void;
	atTopThreshold?: number;
	followOutput: FollowOutput;
	footer?: ReactNode;
	header?: ReactNode;
	onScrollStateCapture: (sessionKey: string, state: ConversationTranscriptScrollState) => void;
	scrollState?: ConversationTranscriptScrollState;
	onScrollerRef?: (element: HTMLElement | null) => void;
	onUserScrollAway: () => void;
	onUserScrollUp: () => void;
	onExpansionIntent?: () => void;
	sessionKey: string;
	virtuosoRef: (handle: VirtuosoHandle | null) => void;
}

export function VirtualizedConversationTranscript<T>({
	items,
	getKey,
	estimateHeight,
	renderItem,
	atBottomStateChange,
	atTopStateChange,
	atTopThreshold,
	followOutput,
	footer,
	header = null,
	onScrollStateCapture,
	scrollState,
	onScrollerRef,
	onUserScrollAway,
	onUserScrollUp,
	onExpansionIntent,
	sessionKey,
	virtuosoRef,
	isItemEqual,
	gap = DEFAULT_TRANSCRIPT_GAP,
}: VirtualizedConversationTranscriptProps<T>) {
	const renderer = useTranscriptRenderer({ items, getKey, estimateHeight, renderItem, isItemEqual, gap });
	const scrollerElementRef = useRef<HTMLElement | null>(null);
	const activeSessionKeyRef = useRef(sessionKey);
	const scrollingStartedRef = useRef(false);
	const userScrollIntentRef = useRef(false);
	if (activeSessionKeyRef.current !== sessionKey) {
		activeSessionKeyRef.current = sessionKey;
		scrollingStartedRef.current = false;
		userScrollIntentRef.current = false;
	}
	const handleScrollingStateChange = useCallback(
		(scrolling: boolean) => {
			if (scrolling) {
				scrollingStartedRef.current = true;
				return;
			}
			if (!scrollingStartedRef.current) return;
			scrollingStartedRef.current = false;
			const scroller = scrollerElementRef.current;
			if (!scroller) return;
			const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
			const userInitiated = userScrollIntentRef.current;
			userScrollIntentRef.current = false;
			if (!shouldCaptureTranscriptScrollState(userInitiated, atBottom, followOutput)) {
				atBottomStateChange(false);
				return;
			}
			if (atBottom) {
				atBottomStateChange(true);
				onScrollStateCapture(sessionKey, { atBottom: true });
				return;
			}
			atBottomStateChange(false);
			const scrollerTop = scroller.getBoundingClientRect().top;
			const anchor = selectTranscriptScrollAnchor(
				items,
				Array.from(scroller.querySelectorAll<HTMLElement>("[data-virtualized-transcript-row]"), (row) => {
					const bounds = row.getBoundingClientRect();
					const indexValue = row.parentElement?.getAttribute("data-index");
					return {
						bottom: bounds.bottom,
						index: indexValue === null || indexValue === undefined ? Number.NaN : Number(indexValue),
						top: bounds.top,
					};
				}),
				scrollerTop,
				getKey,
			);
			if (anchor) onScrollStateCapture(sessionKey, anchor);
		},
		[atBottomStateChange, followOutput, getKey, items, onScrollStateCapture, sessionKey],
	);
	const handleScrollerRef = useCallback(
		(element: HTMLElement | null) => {
			scrollerElementRef.current = element;
			onScrollerRef?.(element);
		},
		[onScrollerRef],
	);
	const handleUserScrollIntent = useCallback(() => {
		userScrollIntentRef.current = true;
	}, []);
	const context = useMemo(
		() => ({
			footer,
			header,
			onScrollerRef: handleScrollerRef,
			onUserScrollAway,
			onUserScrollIntent: handleUserScrollIntent,
			onUserScrollUp,
			onExpansionIntent,
		}),
		[footer, header, handleScrollerRef, handleUserScrollIntent, onUserScrollAway, onUserScrollUp, onExpansionIntent],
	);
	const firstItemIndex = useTranscriptFirstItemIndex(items, getKey, sessionKey);
	const computeConversationItemKey = useCallback(
		(index: number, item: T | undefined) =>
			renderer.computeItemKey(transcriptDataIndex(index, firstItemIndex), item),
		[firstItemIndex, renderer.computeItemKey],
	);
	const conversationItemContent = useCallback(
		(index: number, item: T | undefined) => renderer.itemContent(transcriptDataIndex(index, firstItemIndex), item),
		[firstItemIndex, renderer.itemContent],
	);
	const initialTopMostItemIndex = useMemo<IndexLocationWithAlign>(() => {
		if (!scrollState || scrollState.atBottom) return { align: "end", index: "LAST" };
		const anchorIndex = items.findIndex((item, index) => getKey(item, index) === scrollState.anchorKey);
		return anchorIndex < 0
			? { align: "end", index: "LAST" }
			: { align: "start", index: anchorIndex, offset: -scrollState.anchorOffset };
	}, [getKey, items, scrollState]);

	if (!items.length) return null;
	return (
		<Virtuoso
			key={sessionKey}
			ref={virtuosoRef}
			atBottomStateChange={atBottomStateChange}
			atTopStateChange={atTopStateChange}
			atTopThreshold={atTopThreshold}
			components={CONVERSATION_TRANSCRIPT_COMPONENTS}
			computeItemKey={computeConversationItemKey}
			context={context}
			data={items}
			firstItemIndex={firstItemIndex}
			followOutput={followOutput}
			heightEstimates={renderer.heightEstimates}
			initialTopMostItemIndex={initialTopMostItemIndex}
			isScrolling={handleScrollingStateChange}
			itemContent={conversationItemContent}
			minOverscanItemCount={{ bottom: TRANSCRIPT_MIN_OVERSCAN_ITEMS, top: TRANSCRIPT_MIN_OVERSCAN_ITEMS }}
			overscan={{ main: TRANSCRIPT_OVERSCAN, reverse: TRANSCRIPT_OVERSCAN }}
			style={{ height: "100%", minWidth: 0, width: "100%" }}
		/>
	);
}
