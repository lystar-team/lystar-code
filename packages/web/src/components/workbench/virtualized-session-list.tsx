import type { ReactNode } from "react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

const SESSION_ROW_HEIGHT = 36;
const SESSION_ROW_GAP = 4;
const SESSION_SLOT_HEIGHT = SESSION_ROW_HEIGHT + SESSION_ROW_GAP;
const SESSION_OVERSCAN = 240;
const INITIAL_RENDER_COUNT = 16;

export interface VirtualizedSessionRange {
	start: number;
	end: number;
}

export function getVirtualSessionRange(
	itemCount: number,
	scrollTop: number,
	viewportHeight: number,
	listTop: number,
	rowHeight = SESSION_SLOT_HEIGHT,
	overscan = SESSION_OVERSCAN,
): VirtualizedSessionRange {
	if (itemCount <= 0) return { start: 0, end: -1 };
	if (viewportHeight <= 0) return { start: 0, end: Math.min(itemCount - 1, INITIAL_RENDER_COUNT - 1) };

	const start = Math.floor((scrollTop - listTop - overscan) / rowHeight);
	const end = Math.ceil((scrollTop + viewportHeight - listTop + overscan) / rowHeight) - 1;
	if (end < 0 || start >= itemCount || start > end) return { start: 0, end: -1 };

	return {
		start: Math.max(0, start),
		end: Math.min(itemCount - 1, end),
	};
}

export interface ScrollRef {
	readonly current: HTMLElement | null;
}

export interface VirtualizedSessionListProps<T> {
	items: readonly T[];
	getKey: (item: T, index: number) => string;
	renderItem: (item: T, index: number) => ReactNode;
	scrollRef: ScrollRef;
	rowHeight?: number;
	rowGap?: number;
	overscan?: number;
}

export function VirtualizedSessionList<T>({
	items,
	getKey,
	renderItem,
	scrollRef,
	rowHeight = SESSION_ROW_HEIGHT,
	rowGap = SESSION_ROW_GAP,
	overscan = SESSION_OVERSCAN,
}: VirtualizedSessionListProps<T>) {
	const listRef = useRef<HTMLDivElement>(null);
	const [viewport, setViewport] = useState({ scrollTop: 0, height: 0, listTop: 0 });

	const updateViewport = useCallback(() => {
		const scroller = scrollRef.current;
		const list = listRef.current;
		if (!scroller || !list) return;
		const scrollerRect = scroller.getBoundingClientRect();
		const listRect = list.getBoundingClientRect();
		const next = {
			scrollTop: scroller.scrollTop,
			height: scroller.clientHeight,
			listTop: listRect.top - scrollerRect.top + scroller.scrollTop,
		};
		setViewport((current) =>
			current.scrollTop === next.scrollTop && current.height === next.height && current.listTop === next.listTop
				? current
				: next,
		);
	}, [scrollRef]);

	useLayoutEffect(() => {
		updateViewport();
	});

	useLayoutEffect(() => {
		let frame: number | undefined;
		let disposed = false;
		let boundScroller: HTMLElement | null = null;
		let boundResizeObserver: ResizeObserver | undefined;

		const scheduleViewportUpdate = () => {
			if (frame !== undefined) return;
			frame = window.requestAnimationFrame(() => {
				frame = undefined;
				updateViewport();
			});
		};
		const attach = () => {
			if (disposed) return;
			const scroller = scrollRef.current;
			if (!scroller) {
				frame = window.requestAnimationFrame(() => {
					frame = undefined;
					attach();
				});
				return;
			}
			boundScroller = scroller;
			boundResizeObserver =
				typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleViewportUpdate);
			scheduleViewportUpdate();
			scroller.addEventListener("scroll", scheduleViewportUpdate, { passive: true });
			boundResizeObserver?.observe(scroller);
		};

		attach();
		return () => {
			disposed = true;
			boundScroller?.removeEventListener("scroll", scheduleViewportUpdate);
			boundResizeObserver?.disconnect();
			if (frame !== undefined) window.cancelAnimationFrame(frame);
		};
	}, [scrollRef, updateViewport]);

	const slotHeight = rowHeight + rowGap;
	const itemKeys = useMemo(() => items.map(getKey), [getKey, items]);
	const range = getVirtualSessionRange(items.length, viewport.scrollTop, viewport.height, viewport.listTop, slotHeight, overscan);
	const renderedIndexes: number[] = [];
	for (let index = range.start; index <= range.end; index++) renderedIndexes.push(index);

	if (!items.length) return null;

	return (
		<div
			ref={listRef}
			data-virtualized-session-list
			style={{ height: items.length * slotHeight - rowGap, minWidth: 0, position: "relative" }}
		>
			{renderedIndexes.map((index) => {
				const item = items[index];
				const key = itemKeys[index];
				if (!item || !key) return null;
				return (
					<div
						key={key}
						data-virtualized-session-row
						style={{ height: rowHeight, left: 0, position: "absolute", right: 0, top: index * slotHeight }}
					>
						{renderItem(item, index)}
					</div>
				);
			})}
		</div>
	);
}
