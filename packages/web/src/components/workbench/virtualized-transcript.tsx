import type { ReactNode, Ref } from "react";
import { forwardRef, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	Virtuoso,
	type FollowOutput,
	type ListProps,
	type ScrollerProps,
	type VirtuosoHandle,
} from "react-virtuoso";

export const DEFAULT_TRANSCRIPT_GAP = 12;
const TRANSCRIPT_OVERSCAN = 480;
const TRANSCRIPT_MIN_OVERSCAN_ITEMS = 4;
const INITIAL_RENDER_ITEM_COUNT = 24;
const CONVERSATION_EDGE_PADDING = 48;
const TRANSCRIPT_FIRST_ITEM_INDEX = 1_000_000_000;

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

export function shouldFollowTranscriptResize(
	followRequested: boolean,
	lastUserScrollAt: number,
	now: number,
): boolean {
	return followRequested && now - lastUserScrollAt >= 120;
}

export function shouldPreserveTranscriptResizeAnchor(
	scrollTop: number,
	scrollHeight: number,
	clientHeight: number,
): boolean {
	return scrollHeight - scrollTop - clientHeight > 2;
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
	edgePadding: number;
	isFirst: boolean;
	isLast: boolean;
	renderItem: (item: unknown, index: number) => ReactNode;
	isItemEqual?: (previous: unknown, next: unknown) => boolean;
};

const VirtualizedTranscriptRow = memo(
	function VirtualizedTranscriptRow({
		item,
		index,
		gap,
		edgePadding,
		isFirst,
		isLast,
		renderItem,
	}: VirtualizedTranscriptRowProps) {
		return (
			<div data-virtualized-transcript-row>
				{isFirst && edgePadding > 0 ? <div aria-hidden="true" style={{ height: edgePadding }} /> : null}
				{renderItem(item, index)}
				{gap > 0 ? <div aria-hidden="true" style={{ height: gap }} /> : null}
				{isLast && edgePadding > 0 ? <div aria-hidden="true" style={{ height: edgePadding }} /> : null}
			</div>
		);
	},
	(previous, next) => {
		if (
			previous.index !== next.index ||
			previous.gap !== next.gap ||
			previous.edgePadding !== next.edgePadding ||
			previous.isFirst !== next.isFirst ||
			previous.isLast !== next.isLast ||
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
	edgePadding = 0,
}: Omit<VirtualizedTranscriptProps<T>, "scrollRef"> & { edgePadding?: number }) {
	const itemsRef = useRef(items);
	const gapRef = useRef(gap ?? DEFAULT_TRANSCRIPT_GAP);
	itemsRef.current = items;
	gapRef.current = gap ?? DEFAULT_TRANSCRIPT_GAP;

	const heightEstimates = useMemo(() => {
		const estimates = buildTranscriptHeightEstimates(items, estimateHeight, gap ?? DEFAULT_TRANSCRIPT_GAP);
		if (edgePadding > 0 && estimates.length) {
			estimates[0] += edgePadding;
			estimates[estimates.length - 1] += edgePadding;
		}
		return estimates;
	}, [edgePadding, estimateHeight, gap, items]);
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
					edgePadding={edgePadding}
					isFirst={index === 0}
					isLast={index === currentItems.length - 1}
					renderItem={renderItem as (item: unknown, index: number) => ReactNode}
					isItemEqual={isItemEqual as ((previous: unknown, next: unknown) => boolean) | undefined}
				/>
			);
		},
		[edgePadding, isItemEqual, renderItem],
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
						edgePadding={0}
						isFirst={index === 0}
						isLast={index === items.length - 1}
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
	header: ReactNode;
	onResizeAnchor: (element: HTMLElement) => void;
	onScrollerRef: (element: HTMLElement | null) => void;
	onUserScrollAway: () => void;
};

const SCROLL_AWAY_KEYS = new Set(["ArrowUp", "Home", "PageUp"]);

const ConversationTranscriptScroller = forwardRef<
	HTMLDivElement,
	ScrollerProps & { context: ConversationTranscriptContext }
>(function ConversationTranscriptScroller({ children, context, style, ...props }, forwardedRef) {
	const pointerActiveRef = useRef(false);
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
			onKeyDownCapture={(event) => {
				if (SCROLL_AWAY_KEYS.has(event.key)) contextRef.current.onUserScrollAway();
			}}
			onWheelCapture={(event) => {
				if (event.deltaY < 0) contextRef.current.onUserScrollAway();
			}}
			onPointerDownCapture={(event) => {
				const target = event.target;
				if (!(target instanceof Element) || !target.closest("[data-transcript-resize-anchor]")) return;
				const row = target.closest("[data-virtualized-transcript-row]");
				if (row instanceof HTMLElement) contextRef.current.onResizeAnchor(row);
			}}
			onPointerCancel={() => {
				pointerActiveRef.current = false;
			}}
			onPointerDown={() => {
				pointerActiveRef.current = true;
			}}
			onPointerUp={() => {
				pointerActiveRef.current = false;
			}}
			onScroll={(event) => {
				if (!pointerActiveRef.current) return;
				const element = event.currentTarget;
				if (element.scrollHeight - element.scrollTop - element.clientHeight > 2)
					contextRef.current.onUserScrollAway();
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
	followOutput: FollowOutput;
	header?: ReactNode;
	onScrollerRef: (element: HTMLElement | null) => void;
	onTotalListHeightChanged: (height: number) => void;
	onUserScrollAway: () => void;
	sessionKey: string;
	virtuosoRef: Ref<VirtuosoHandle>;
}

export function VirtualizedConversationTranscript<T>({
	items,
	getKey,
	estimateHeight,
	renderItem,
	atBottomStateChange,
	followOutput,
	header = null,
	onScrollerRef,
	onTotalListHeightChanged,
	onUserScrollAway,
	sessionKey,
	virtuosoRef,
	isItemEqual,
	gap = DEFAULT_TRANSCRIPT_GAP,
}: VirtualizedConversationTranscriptProps<T>) {
	const renderer = useTranscriptRenderer({
		items,
		getKey,
		estimateHeight,
		renderItem,
		isItemEqual,
		gap,
		edgePadding: CONVERSATION_EDGE_PADDING,
	});
	const scrollerElementRef = useRef<HTMLElement | null>(null);
	const resizeAnchorRef = useRef<{ element: HTMLElement; top: number }>();
	const totalHeightFrameRef = useRef<number>();
	const latestTotalHeightRef = useRef(0);
	const handleScrollerRef = useCallback(
		(element: HTMLElement | null) => {
			scrollerElementRef.current = element;
			onScrollerRef(element);
		},
		[onScrollerRef],
	);
	const handleResizeAnchor = useCallback(
		(element: HTMLElement) => {
			const scroller = scrollerElementRef.current;
			if (
				!scroller ||
				!shouldPreserveTranscriptResizeAnchor(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight)
			) {
				resizeAnchorRef.current = undefined;
				return;
			}
			resizeAnchorRef.current = { element, top: element.getBoundingClientRect().top };
			onUserScrollAway();
		},
		[onUserScrollAway],
	);
	const handleTotalListHeightChanged = useCallback(
		(height: number) => {
			const anchor = resizeAnchorRef.current;
			resizeAnchorRef.current = undefined;
			if (anchor?.element.isConnected) {
				const offset = anchor.element.getBoundingClientRect().top - anchor.top;
				if (Math.abs(offset) >= 0.5) scrollerElementRef.current?.scrollBy({ behavior: "auto", top: offset });
				return;
			}
			latestTotalHeightRef.current = height;
			if (totalHeightFrameRef.current !== undefined) window.cancelAnimationFrame(totalHeightFrameRef.current);
			totalHeightFrameRef.current = window.requestAnimationFrame(() => {
				totalHeightFrameRef.current = undefined;
				onTotalListHeightChanged(latestTotalHeightRef.current);
			});
		},
		[onTotalListHeightChanged],
	);
	useLayoutEffect(
		() => () => {
			if (totalHeightFrameRef.current !== undefined) window.cancelAnimationFrame(totalHeightFrameRef.current);
		},
		[],
	);
	const context = useMemo(
		() => ({
			header,
			onResizeAnchor: handleResizeAnchor,
			onScrollerRef: handleScrollerRef,
			onUserScrollAway,
		}),
		[header, handleResizeAnchor, handleScrollerRef, onUserScrollAway],
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

	if (!items.length) return null;
	return (
		<Virtuoso
			key={sessionKey}
			ref={virtuosoRef}
			alignToBottom
			atBottomStateChange={atBottomStateChange}
			components={CONVERSATION_TRANSCRIPT_COMPONENTS}
			computeItemKey={computeConversationItemKey}
			context={context}
			data={items}
			firstItemIndex={firstItemIndex}
			followOutput={followOutput}
			heightEstimates={renderer.heightEstimates}
			initialTopMostItemIndex={{ index: "LAST", align: "end" }}
			itemContent={conversationItemContent}
			minOverscanItemCount={{ bottom: TRANSCRIPT_MIN_OVERSCAN_ITEMS, top: TRANSCRIPT_MIN_OVERSCAN_ITEMS }}
			overscan={{ main: TRANSCRIPT_OVERSCAN, reverse: TRANSCRIPT_OVERSCAN }}
			style={{ height: "100%", minWidth: 0, width: "100%" }}
			totalListHeightChanged={handleTotalListHeightChanged}
		/>
	);
}
