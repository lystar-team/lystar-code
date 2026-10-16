import type { VirtualListProps } from "../ui/virtual-list";
import { VirtualList } from "../ui/virtual-list";

export interface ScrollRef {
	readonly current: HTMLElement | null;
}

export type VirtualizedSessionListProps<T> = Pick<VirtualListProps<T>,
	"items" | "getKey" | "renderItem" | "scrollRef" | "scrollToKey" | "scrollRequestId"
> & { scrollRef: ScrollRef; rowHeight?: number; rowGap?: number };

/** 会话列表保留调用方的行高与间距，窗口计算和定位由公共列表执行。 */
export function VirtualizedSessionList<T>({ rowHeight = 32, rowGap = 2, ...props }: VirtualizedSessionListProps<T>) {
	return <VirtualList {...props} estimateSize={() => rowHeight} gap={rowGap} />;
}
