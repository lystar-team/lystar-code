import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { cn } from "../../lib/utils";

export type VirtualListProps<T> = {
	items: readonly T[];
	getKey: (item: T, index: number) => string;
	estimateSize: (item: T, index: number) => number;
	renderItem: (item: T, index: number) => ReactNode;
	isItemEqual?: (previous: T, next: T) => boolean;
	scrollRef?: RefObject<HTMLElement | null>;
	scrollToKey?: string;
	scrollRequestId?: number;
	gap?: number;
	className?: string;
};

const VirtualListContent = memo(function VirtualListContent({ item, index, renderItem }: {
	item: unknown;
	index: number;
	renderItem: (item: unknown, index: number) => ReactNode;
	isItemEqual?: (previous: unknown, next: unknown) => boolean;
}) {
	return renderItem(item, index);
}, (previous, next) => previous.index === next.index && previous.renderItem === next.renderItem &&
	previous.isItemEqual === next.isItemEqual && (next.isItemEqual ? next.isItemEqual(previous.item, next.item) : previous.item === next.item));

/** 普通列表共用测量与定位；外部滚动容器中的列表显式提供自身起点。 */
export function VirtualList<T>({
	items, getKey, estimateSize, renderItem, isItemEqual, scrollRef, scrollToKey, scrollRequestId, gap = 0, className,
}: VirtualListProps<T>) {
	const listRef = useRef<HTMLDivElement>(null);
	const [scrollMargin, setScrollMargin] = useState<number | undefined>(scrollRef ? undefined : 0);
	const handledRequest = useRef<string>();
	const getItemKey = useCallback((index: number) => getKey(items[index]!, index), [getKey, items]);
	const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
		count: items.length,
		getScrollElement: () => scrollRef ? scrollRef.current : listRef.current,
		initialOffset: () => scrollRef?.current?.scrollTop ?? 0,
		getItemKey,
		estimateSize: (index) => estimateSize(items[index]!, index),
		gap,
		scrollMargin: scrollMargin ?? 0,
		overscan: 8,
		useAnimationFrameWithResizeObserver: true,
	});

	useEffect(() => {
		const list = listRef.current;
		const scroller = scrollRef?.current;
		if (!list || !scroller) return;
		const measureMargin = () => setScrollMargin(list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientTop);
		measureMargin();
		const observer = new ResizeObserver(measureMargin);
		observer.observe(scroller);
		for (const content of scroller.children) observer.observe(content);
		return () => observer.disconnect();
	}, [scrollRef]);

	useLayoutEffect(() => {
		if (!scrollToKey || scrollRequestId === undefined || scrollMargin === undefined || !virtualizer.scrollElement) return;
		const request = `${scrollRequestId}:${scrollToKey}`;
		if (handledRequest.current === request) return;
		const index = items.findIndex((item, index) => getKey(item, index) === scrollToKey);
		if (index < 0) return;
		virtualizer.scrollToIndex(index, { align: "auto" });
		handledRequest.current = request;
	}, [getKey, items, scrollMargin, scrollRequestId, scrollToKey, virtualizer]);

	const totalSize = virtualizer.getTotalSize();
	const rows = virtualizer.scrollElement ? virtualizer.getVirtualItems() : virtualizer.measurementsCache.slice(0, 24);
	return <div ref={listRef} data-virtual-list className={cn("min-w-0 w-full", !scrollRef && "h-full overflow-auto", className)}>
		<div className="relative min-w-0 w-full" style={{ height: totalSize }}>
			{rows.map((row) => <div key={row.key} ref={virtualizer.measureElement} data-index={row.index} data-virtual-list-row
				className="absolute left-0 top-0 w-full min-w-0 flow-root"
				style={{ transform: `translateY(${row.start - (scrollMargin ?? 0)}px)` }}>
				<VirtualListContent item={items[row.index]} index={row.index}
					renderItem={renderItem as (item: unknown, index: number) => ReactNode}
					isItemEqual={isItemEqual as ((previous: unknown, next: unknown) => boolean) | undefined} />
			</div>)}
		</div>
	</div>;
}
