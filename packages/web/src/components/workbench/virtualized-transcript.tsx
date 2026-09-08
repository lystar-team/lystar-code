import type { ReactNode } from "react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export const DEFAULT_TRANSCRIPT_GAP = 12;
const MOBILE_BREAKPOINT = 640;
const MOBILE_OVERSCAN = 320;
const DESKTOP_OVERSCAN = 640;
const INITIAL_RENDER_COUNT = 24;

export interface VirtualLayout {
	offsets: number[];
	heights: number[];
	totalHeight: number;
}

export interface VirtualRange {
	start: number;
	end: number;
}

export function buildVirtualLayout<T>(
	items: readonly T[],
	getKey: (item: T, index: number) => string,
	measuredHeights: ReadonlyMap<string, number>,
	estimateHeight: (item: T, index: number) => number,
	gap: number | ((previous: T, current: T, index: number) => number) = DEFAULT_TRANSCRIPT_GAP,
): VirtualLayout {
	const offsets: number[] = [];
	const heights: number[] = [];
	let totalHeight = 0;

	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		const measured = measuredHeights.get(getKey(item, index));
		const height = Math.max(1, measured ?? estimateHeight(item, index));
		offsets.push(totalHeight);
		heights.push(height);
		totalHeight += height;
		if (index < items.length - 1) {
			const nextItem = items[index + 1];
			const rowGap = typeof gap === "function" ? gap(item, nextItem, index) : gap;
			totalHeight += Math.max(0, rowGap);
		}
	}

	return { offsets, heights, totalHeight };
}

function firstIndexAtOrAfter(layout: VirtualLayout, offset: number): number {
	let low = 0;
	let high = layout.heights.length - 1;
	let result = high;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const end = layout.offsets[middle] + layout.heights[middle];
		if (end >= offset) {
			result = middle;
			high = middle - 1;
		} else {
			low = middle + 1;
		}
	}
	return result;
}

function lastIndexAtOrBefore(layout: VirtualLayout, offset: number): number {
	let low = 0;
	let high = layout.heights.length - 1;
	let result = 0;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (layout.offsets[middle] <= offset) {
			result = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return result;
}

export function getVirtualRange(
	layout: VirtualLayout,
	scrollTop: number,
	viewportHeight: number,
	overscan: number,
): VirtualRange {
	if (!layout.heights.length || viewportHeight <= 0) {
		return { start: 0, end: Math.max(0, layout.heights.length - 1) };
	}

	const startOffset = Math.max(0, scrollTop - overscan);
	const endOffset = Math.max(startOffset, scrollTop + viewportHeight + overscan);
	const start = firstIndexAtOrAfter(layout, startOffset);
	const end = lastIndexAtOrBefore(layout, endOffset);
	return start <= end
		? { start, end }
		: { start: Math.max(0, start - 1), end: Math.min(layout.heights.length - 1, start) };
}

type ScrollRef = { current: HTMLElement | null };

type VirtualizedTranscriptRowProps = {
	item: unknown;
	index: number;
	top: number;
	rowRef: (element: HTMLDivElement | null) => void;
	renderItem: (item: unknown, index: number) => ReactNode;
	isItemEqual?: (previous: unknown, next: unknown) => boolean;
};

const VirtualizedTranscriptRow = memo(function VirtualizedTranscriptRow({
	item,
	index,
	top,
	rowRef,
	renderItem,
	isItemEqual,
}: VirtualizedTranscriptRowProps) {
	return (
		<div ref={rowRef} style={{ left: 0, position: "absolute", right: 0, top }}>
			{renderItem(item, index)}
		</div>
	);
}, (previous, next) => {
	if (previous.index !== next.index || previous.top !== next.top || previous.renderItem !== next.renderItem) return false;
	return next.isItemEqual ? next.isItemEqual(previous.item, next.item) : previous.item === next.item;
});


export interface VirtualizedTranscriptProps<T> {
	items: readonly T[];
	getKey: (item: T, index: number) => string;
	estimateHeight: (item: T, index: number) => number;
	renderItem: (item: T, index: number) => ReactNode;
	scrollRef: ScrollRef;
	isItemEqual?: (previous: T, next: T) => boolean;
	gap?: number | ((previous: T, current: T, index: number) => number);
}

export function VirtualizedTranscript<T>({
	items,
	getKey,
	estimateHeight,
	renderItem,
	scrollRef,
	isItemEqual,
	gap,
}: VirtualizedTranscriptProps<T>) {
	const measuredHeightsRef = useRef(new Map<string, number>());
	const elementsRef = useRef(new Map<string, HTMLDivElement>());
	const elementKeysRef = useRef(new WeakMap<Element, string>());
	const rowRefCallbacksRef = useRef(new Map<string, (element: HTMLDivElement | null) => void>());
	const resizeObserverRef = useRef<ResizeObserver | undefined>(undefined);
	const layoutRef = useRef<VirtualLayout>({ offsets: [], heights: [], totalHeight: 0 });
	const indexByKeyRef = useRef(new Map<string, number>());
	const [measurementVersion, setMeasurementVersion] = useState(0);
	const [viewport, setViewport] = useState({ top: 0, height: 0, width: 0, listTop: 0 });
	const listRef = useRef<HTMLDivElement>(null);

	const updateViewport = useCallback(() => {
		const scroller = scrollRef.current;
		const list = listRef.current;
		if (!scroller || !list) return;
		const scrollerRect = scroller.getBoundingClientRect();
		const listRect = list.getBoundingClientRect();
		const next = {
			top: scroller.scrollTop,
			height: scroller.clientHeight,
			width: scroller.clientWidth,
			listTop: listRect.top - scrollerRect.top + scroller.scrollTop,
		};
		setViewport((current) =>
			current.top === next.top &&
			current.height === next.height &&
			current.width === next.width &&
			current.listTop === next.listTop
				? current
				: next,
		);
	}, [scrollRef]);

	const itemKeys = useMemo(() => items.map(getKey), [getKey, items]);
	const indexByKey = useMemo(() => new Map(itemKeys.map((key, index) => [key, index])), [itemKeys]);
	indexByKeyRef.current = indexByKey;

	const layout = useMemo(
		() => buildVirtualLayout(items, getKey, measuredHeightsRef.current, estimateHeight, gap),
		[estimateHeight, gap, getKey, items, measurementVersion],
	);
	layoutRef.current = layout;

	useLayoutEffect(() => {
		const scroller = scrollRef.current;
		if (!scroller || !layout.heights.length) return;
		const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
		if (scroller.scrollTop > maxScrollTop + 1) scroller.scrollTop = maxScrollTop;
	}, [layout.heights.length, layout.totalHeight, scrollRef]);

	const registerRow = useCallback((key: string, element: HTMLDivElement | null) => {
		const previous = elementsRef.current.get(key);
		if (previous === element) return;
		if (previous) resizeObserverRef.current?.unobserve(previous);
		if (!element) {
			elementsRef.current.delete(key);
			return;
		}
		elementsRef.current.set(key, element);
		elementKeysRef.current.set(element, key);
		resizeObserverRef.current?.observe(element);
	}, []);

	const getRowRef = useCallback(
		(key: string) => {
			const existing = rowRefCallbacksRef.current.get(key);
			if (existing) return existing;
			const callback = (element: HTMLDivElement | null) => registerRow(key, element);
			rowRefCallbacksRef.current.set(key, callback);
			return callback;
		},
		[registerRow],
	);

	useLayoutEffect(() => {
		updateViewport();
	}, [items.length, layout.totalHeight, updateViewport]);

	useLayoutEffect(() => {
		const scroller = scrollRef.current;
		if (!scroller) return;

		let frame: number | undefined;
		const scheduleViewportUpdate = () => {
			if (frame !== undefined) return;
			frame = window.requestAnimationFrame(() => {
				frame = undefined;
				updateViewport();
			});
		};
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleViewportUpdate);

		updateViewport();
		scroller.addEventListener("scroll", scheduleViewportUpdate, { passive: true });
		observer?.observe(scroller);
		observer?.observe(listRef.current ?? scroller);
		return () => {
			scroller.removeEventListener("scroll", scheduleViewportUpdate);
			observer?.disconnect();
			if (frame !== undefined) window.cancelAnimationFrame(frame);
		};
	}, [scrollRef, updateViewport]);

	useLayoutEffect(() => {
		if (typeof ResizeObserver === "undefined") return;
		let bottomCorrectionFrame: number | undefined;
		const observer = new ResizeObserver((entries) => {
			const scroller = scrollRef.current;
			const currentLayout = layoutRef.current;
			const measured = measuredHeightsRef.current;
			const wasAtBottom = scroller
				? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2
				: false;
			let changed = false;
			let scrollAdjustment = 0;

			for (const entry of entries) {
				const key = elementKeysRef.current.get(entry.target);
				const index = key ? indexByKeyRef.current.get(key) : undefined;
				if (key === undefined || index === undefined) continue;
				const nextHeight = Math.max(1, entry.contentRect.height);
				const previousHeight = measured.get(key) ?? currentLayout.heights[index] ?? nextHeight;
				const difference = nextHeight - previousHeight;
				if (Math.abs(difference) < 0.5) continue;
				measured.set(key, nextHeight);
				changed = true;
				if (!wasAtBottom && scroller && currentLayout.offsets[index] < scroller.scrollTop) {
					scrollAdjustment += difference;
				}
			}

			if (scrollAdjustment && scroller) scroller.scrollTop += scrollAdjustment;
			if (changed) {
				setMeasurementVersion((version) => version + 1);
				if (wasAtBottom && scroller && bottomCorrectionFrame === undefined) {
					bottomCorrectionFrame = window.requestAnimationFrame(() => {
						bottomCorrectionFrame = undefined;
						const currentScroller = scrollRef.current;
						if (!currentScroller) return;
						const maxScrollTop = Math.max(0, currentScroller.scrollHeight - currentScroller.clientHeight);
						if (
							currentScroller.scrollTop > maxScrollTop + 1 ||
							currentScroller.scrollHeight - currentScroller.scrollTop - currentScroller.clientHeight <= 8
						)
							currentScroller.scrollTop = maxScrollTop;
					});
				}
			}
		});
		resizeObserverRef.current = observer;
		for (const element of elementsRef.current.values()) observer.observe(element);

		return () => {
			observer.disconnect();
			if (bottomCorrectionFrame !== undefined) window.cancelAnimationFrame(bottomCorrectionFrame);
			if (resizeObserverRef.current === observer) resizeObserverRef.current = undefined;
		};
	}, [scrollRef]);

	if (!items.length) return null;

	const overscan = viewport.width > 0 && viewport.width < MOBILE_BREAKPOINT ? MOBILE_OVERSCAN : DESKTOP_OVERSCAN;
	const range =
		viewport.height > 0
			? getVirtualRange(layout, viewport.top - viewport.listTop, viewport.height, overscan)
			: { start: 0, end: Math.min(items.length - 1, INITIAL_RENDER_COUNT - 1) };
	const renderedIndexes: number[] = [];
	for (let index = range.start; index <= range.end; index++) renderedIndexes.push(index);

	return (
		<div ref={listRef} style={{ height: layout.totalHeight, minWidth: 0, position: "relative", width: "100%" }}>
			{renderedIndexes.map((index) => {
				const item = items[index];
				const key = itemKeys[index];
				return (
					<VirtualizedTranscriptRow
						key={key}
						item={item}
						index={index}
						top={layout.offsets[index]}
						rowRef={getRowRef(key)}
						renderItem={renderItem as (item: unknown, index: number) => ReactNode}
						isItemEqual={isItemEqual as ((previous: unknown, next: unknown) => boolean) | undefined}
					/>
				);
			})}
		</div>
	);
}
