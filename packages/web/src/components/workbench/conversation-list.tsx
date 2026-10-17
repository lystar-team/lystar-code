import { defaultRangeExtractor, elementScroll, observeElementOffset, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { Fragment, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefCallback } from "react";
import type { ConversationGroupEntry, ConversationListContent, ConversationListModel, ConversationListNode } from "./conversation-list-model";
import type { ConversationScrollSnapshot } from "./conversation-scroll-cache";
import type { ConversationListHandle } from "./use-conversation-scroll";
import { HISTORY_LOAD_THRESHOLD } from "./use-conversation-history";
import { useConversationScrollIntent } from "./use-conversation-scroll-intent";

const EDGE_PADDING = 48;
const BOTTOM_THRESHOLD = 2;

export type ConversationGroupLayout = {
	entry: ConversationGroupEntry;
	open: boolean;
	headerRef: RefCallback<HTMLElement>;
	headerIndex: number;
	padding: ReactNode;
	children: ReactNode;
};

type ConversationListProps = {
	model: ConversationListModel;
	sessionKey: string;
	following: boolean;
	initialSnapshot?: ConversationScrollSnapshot;
	header: ReactNode;
	footer: ReactNode;
	renderContent: (entry: ConversationListContent) => ReactNode;
	isItemEqual: (previous: ConversationListContent, next: ConversationListContent) => boolean;
	renderGroup: (layout: ConversationGroupLayout) => ReactNode;
	onListRef: (handle: ConversationListHandle | null) => void;
	onSnapshot: (key: string, snapshot: ConversationScrollSnapshot) => void;
	onAtBottom: (key: string, atBottom: boolean) => void;
	onAtTop: (atTop: boolean) => void;
	onPause: () => void;
	onResume: () => void;
	onUp: () => void;
	onDown: () => void;
};

const ConversationRowContent = memo(function ConversationRowContent({ entry, renderContent }: {
	entry: ConversationListContent;
	renderContent: ConversationListProps["renderContent"];
	isItemEqual: ConversationListProps["isItemEqual"];
}) {
	return renderContent(entry);
}, (previous, next) => previous.renderContent === next.renderContent && previous.isItemEqual === next.isItemEqual && next.isItemEqual(previous.entry, next.entry));

/** 单一滚动引擎；分组只保留 DOM 层级和样式，不再自行补偿位置。 */
export function ConversationList({
	model, sessionKey, following, initialSnapshot, header, footer, renderContent, renderGroup, isItemEqual,
	onListRef, onSnapshot, onAtBottom, onAtTop, onPause, onResume, onUp, onDown,
}: ConversationListProps) {
	const scroller = useRef<HTMLDivElement>(null);
	const [viewport, setViewport] = useState<{ width: number; height: number }>();
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element) setViewport({ width: element.clientWidth, height: element.clientHeight });
	}, []);
	const initial = useRef(initialSnapshot).current;
	const offsetObserver = useRef<((offset: number, isScrolling: boolean) => void)>();
	const offsetReadFrame = useRef<number>();
	const expansionFrame = useRef<number>();
	const getItemKey = useCallback((index: number) => model.rows[index]!.key, [model.rows]);
	const rangeExtractor = useCallback((range: Range) => {
		const indexes = new Set(defaultRangeExtractor(range));
		const includeHeaders = (nodes: ConversationListNode[]) => {
			for (const node of nodes) {
				if (!node.children || node.end < range.startIndex || node.start > range.endIndex) continue;
				indexes.add(node.start);
				includeHeaders(node.children);
			}
		};
		includeHeaders(model.nodes);
		return [...indexes].sort((a, b) => a - b);
	}, [model.nodes]);
	const restoredMeasurements = useMemo(() => {
		const sizes = new Map(initial?.measurements.map((item) => [String(item.key), item.size]));
		let offset = EDGE_PADDING;
		return model.rows.map((row, index) => {
			const size = sizes.get(row.key) ?? row.height;
			const item = { key: row.key, index, start: offset, end: offset + size, size, lane: 0 };
			offset += size;
			return item;
		});
	}, []);
	const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
		enabled: viewport !== undefined,
		initialRect: viewport,
		count: model.rows.length,
		getScrollElement: () => scroller.current,
		getItemKey,
		estimateSize: (index) => model.rows[index]!.height,
		initialMeasurementsCache: initial?.measurements ?? [],
		observeElementOffset: (instance, onOffset) => {
			offsetObserver.current = onOffset;
			const cleanup = observeElementOffset(instance, onOffset);
			return () => {
				if (offsetReadFrame.current !== undefined) window.cancelAnimationFrame(offsetReadFrame.current);
				offsetReadFrame.current = undefined;
				offsetObserver.current = undefined;
				cleanup?.();
			};
		},
		scrollToFn: (offset, options, instance) => {
			const element = instance.scrollElement;
			const previousOffset = element?.scrollTop;
			elementScroll(offset, options, instance);
			if (!element || options.behavior === "smooth" || element.scrollTop !== previousOffset) return;
			// 未移动的定位不会触发 scroll；提交布局后读回浏览器实际接受的位置。
			if (offsetReadFrame.current !== undefined) window.cancelAnimationFrame(offsetReadFrame.current);
			offsetReadFrame.current = window.requestAnimationFrame(() => {
				offsetReadFrame.current = undefined;
				offsetObserver.current?.(element.scrollTop, instance.isScrolling);
			});
		},
		initialOffset: () => {
			if (initial && !initial.atBottom) {
				const item = restoredMeasurements.find((candidate) => candidate.key === initial.anchor?.key);
				return item && initial.anchor ? Math.max(0, item.start - initial.anchor.offset) : initial.offset;
			}
			// 先取得真实视口，再从末尾开始测量，避免先显示开头再跳到底部。
			return Math.max(0, (restoredMeasurements.at(-1)?.end ?? EDGE_PADDING) + EDGE_PADDING - (viewport?.height ?? 0));
		},
		paddingStart: EDGE_PADDING,
		paddingEnd: EDGE_PADDING,
		anchorTo: "end",
		followOnAppend: following,
		scrollEndThreshold: following ? BOTTOM_THRESHOLD : -1,
		overscan: 6,
		useAnimationFrameWithResizeObserver: false,
		rangeExtractor,
	});
	const active = useRef({ model, onSnapshot, onAtBottom, onAtTop });
	active.current = { model, onSnapshot, onAtBottom, onAtTop };
	const lastBottom = useRef<boolean>();
	const lastTop = useRef<boolean>();
	const publishPosition = useCallback(() => {
		const atBottom = virtualizer.isAtEnd(BOTTOM_THRESHOLD);
		const atTop = (virtualizer.scrollOffset ?? 0) <= HISTORY_LOAD_THRESHOLD;
		if (lastBottom.current !== atBottom) {
			lastBottom.current = atBottom;
			active.current.onAtBottom(sessionKey, atBottom);
		}
		if (lastTop.current !== atTop) {
			lastTop.current = atTop;
			active.current.onAtTop(atTop);
		}
	}, [sessionKey, virtualizer]);
	const savePosition = useCallback(() => {
		const offset = virtualizer.scrollOffset ?? 0;
		const item = virtualizer.getVirtualItemForOffset(offset);
		active.current.onSnapshot(sessionKey, {
			atBottom: lastBottom.current ?? false, offset,
			anchor: item ? { key: String(item.key), offset: item.start - offset } : undefined,
			measurements: virtualizer.takeSnapshot(),
		});
	}, [sessionKey, virtualizer]);
	const cancelScroll = useCallback(() => {
		if (expansionFrame.current !== undefined) window.cancelAnimationFrame(expansionFrame.current);
		expansionFrame.current = undefined;
		virtualizer.cancelScroll();
	}, [virtualizer]);
	const revealExpansion = (trigger: HTMLElement) => {
		onPause();
		const element = scroller.current;
		if (!element || trigger.getAttribute("aria-expanded") !== "false") return;
		const viewport = element.getBoundingClientRect();
		if (viewport.bottom - trigger.getBoundingClientRect().bottom > Math.min(200, viewport.height / 3)) return;
		const container = trigger.closest<HTMLElement>('[data-slot="collapsible"], [data-json-output]');
		if (!container) return;
		const reveal = () => {
			expansionFrame.current = undefined;
			if (!trigger.isConnected || trigger.getAttribute("aria-expanded") !== "true") return;
			const content = container.querySelector<HTMLElement>(':scope > [data-slot="collapsible-content"]');
			const bounds = element.getBoundingClientRect();
			const delta = Math.max(0, Math.min(
				container.getBoundingClientRect().bottom - bounds.bottom + 16,
				trigger.getBoundingClientRect().top - bounds.top - 16,
			));
			if (delta > 1) virtualizer.scrollBy(delta);
			// 跟随本次展开动画；动画结束后交回用户滚动意图。
			if (content?.style.height) expansionFrame.current = window.requestAnimationFrame(reveal);
		};
		expansionFrame.current = window.requestAnimationFrame(reveal);
	};
	useLayoutEffect(() => cancelScroll, [cancelScroll]);
	useLayoutEffect(() => {
		if (!viewport) return;
		onListRef({
			cancelScroll,
			scrollToLatest: () => virtualizer.scrollToEnd(),
		});
		if (!initial || initial.atBottom) virtualizer.scrollToEnd();
		return () => { savePosition(); onListRef(null); };
	}, [cancelScroll, initial, onListRef, savePosition, viewport, virtualizer]);
	useLayoutEffect(() => {
		if (!viewport) return;
		publishPosition();
		if (!virtualizer.isScrolling) savePosition();
	});
	const intent = useConversationScrollIntent({
		onPause, onUp, onDown, onCancel: cancelScroll, onExpansion: revealExpansion,
		onUserPosition: (element, endOffset) => {
			const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD;
			const reachedPreviousEnd = endOffset !== undefined && Math.abs(element.scrollTop - endOffset) <= BOTTOM_THRESHOLD;
			if (!following && endOffset !== undefined && (atBottom || reachedPreviousEnd)) {
				onResume();
				virtualizer.scrollToEnd();
			}
			publishPosition();
		},
	}, scroller);
	const virtualItems = virtualizer.getVirtualItems();
	const visible = new Set(virtualItems.map((item) => item.index));
	const measurements = virtualizer.measurementsCache;
	const firstItem = virtualItems[0];
	// iOS 手势暂缓位置补偿时，公开的行坐标已扣除这段偏移。
	const contentShift = firstItem ? firstItem.start - measurements[firstItem.index]!.start : 0;
	const renderNode = (node: ConversationListNode): ReactNode => {
		if (node.children && node.entry) {
			if (!visible.has(node.start)) return spacer(node);
			const [padding, ...children] = node.children;
			return <Fragment key={node.key}>{renderGroup({
				entry: node.entry, open: node.open ?? false,
				headerRef: virtualizer.measureElement, headerIndex: node.start,
				padding: padding ? renderNode(padding) : null,
				children: renderNodes(children),
			})}</Fragment>;
		}
		if (!visible.has(node.start)) return spacer(node);
		const row = model.rows[node.start]!;
		return <div key={row.key} data-index={node.start} data-conversation-row={row.key}
			ref={virtualizer.measureElement}
			className={row.stepChild && row.entry?.kind === "message" ? "flow-root min-w-0 py-2" : "flow-root min-w-0"}
			style={row.kind === "space" ? { height: row.height } : undefined}>
			{row.entry ? <ConversationRowContent entry={row.entry} renderContent={renderContent} isItemEqual={isItemEqual} /> : null}
		</div>;
	};
	const spacer = (node: ConversationListNode) => <div key={"spacer:" + node.key} aria-hidden="true"
		style={{ height: (measurements[node.end]?.end ?? 0) - (measurements[node.start]?.start ?? 0) }} />;
	const renderNodes = (nodes: ConversationListNode[]): ReactNode => {
		const rendered: ReactNode[] = [];
		let hidden: ConversationListNode | undefined;
		for (const node of nodes) {
			if (!visible.has(node.start)) {
				hidden = hidden ? { ...hidden, end: node.end } : node;
				continue;
			}
			if (hidden) { rendered.push(spacer(hidden)); hidden = undefined; }
			rendered.push(renderNode(node));
		}
		if (hidden) rendered.push(spacer(hidden));
		return rendered;
	};
	return <div {...intent} ref={scroller} tabIndex={0}
		className="conversation-scroll min-w-0 max-w-full overflow-auto overscroll-y-contain"
		style={{ height: "100%", width: "100%", overflowAnchor: "none" }}>
		{header ? <div className="pointer-events-none absolute top-0 right-0 left-0 z-10 mx-auto min-w-0 w-full max-w-[var(--conversation-width)] px-5 pt-2 sm:px-10"><div className="pointer-events-auto">{header}</div></div> : null}
		<div aria-hidden="true" style={{ height: EDGE_PADDING }} />
		<div className="conversation-content mx-auto min-w-0 w-full max-w-[var(--conversation-width)] px-5 sm:px-10" style={{ marginTop: contentShift }}>
			{renderNodes(model.nodes)}
		</div>
		<div style={{ height: EDGE_PADDING }}>
			<div className="conversation-content mx-auto min-w-0 w-full max-w-[var(--conversation-width)] px-5 sm:px-10">{footer}</div>
		</div>
	</div>;
}
