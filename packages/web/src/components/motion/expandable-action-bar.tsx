"use client";

// 改编自 beUI ExpandableActionBar（https://beui.dev/components/blocks/expandable-action-bar）。
// 保留 beUI 的展开手感与结构：悬停/聚焦展开、收起延迟、弹簧尺寸布局、滑动高亮、标签展开动画。
// 与 beUI 原版的差异：轨道内的按钮元素交给消费方渲染，标签的 tab 语义、键盘导航和焦点管理由消费方承担
// （本项目审阅工作区用 Radix Tabs）；阴影换成与面板一致的轻量值，颜色走项目语义 Token。

import { LayoutGroup, motion, type Transition, useReducedMotion } from "motion/react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { useHoverGesture } from "../../lib/hooks/use-hover-gesture";
import { cn } from "../../lib/utils";

export type ExpandableActionBarSize = "sm" | "md";

export const EXPANDABLE_ACTION_BAR_TRANSITION: Transition = {
	type: "spring",
	stiffness: 460,
	damping: 34,
	mass: 0.62,
};

const LABEL_TRANSITION: Transition = {
	type: "spring",
	stiffness: 380,
	damping: 32,
	mass: 0.7,
};

const SIZE_CLASS: Record<ExpandableActionBarSize, string> = {
	sm: "min-h-9 gap-1 p-1 text-xs",
	md: "min-h-11 gap-1.5 p-1.5 text-sm",
};

interface PointerBoundaryEvent {
	buttons: number;
	pointerId: number;
	pointerType: string;
}

type ExpandableActionBarContextValue = {
	activeId: string | undefined;
	enterItem: (event: PointerBoundaryEvent, itemId: string) => void;
	expanded: boolean;
	focusItem: (itemId: string) => void;
	highlightedId: string | null;
};

const ExpandableActionBarContext = createContext<ExpandableActionBarContextValue | null>(null);

function useExpandableActionBarContext(component: string): ExpandableActionBarContextValue {
	const context = useContext(ExpandableActionBarContext);
	if (!context) throw new Error(`${component} 必须在 ExpandableActionBar 内使用`);
	return context;
}

/** 供轨道内的按钮读取展开状态并上报悬停/聚焦，高亮和标签动画据此联动。 */
export function useExpandableActionBarItem(itemId: string) {
	const context = useExpandableActionBarContext("useExpandableActionBarItem");
	return {
		highlighted: context.highlightedId === itemId,
		// 当前项始终保持可读，避免收起后只剩图标认不出当前视图。
		labelVisible: context.expanded || context.activeId === itemId,
		onFocus: () => context.focusItem(itemId),
		onPointerEnter: (event: PointerBoundaryEvent) => context.enterItem(event, itemId),
	};
}

/** 在悬停或聚焦项之间滑动的高亮块，同一时刻只有一个。 */
export function ExpandableActionBarHighlight({ className, itemId }: { className?: string; itemId: string }) {
	const reduce = useReducedMotion() ?? false;
	const context = useExpandableActionBarContext("ExpandableActionBarHighlight");
	if (context.highlightedId !== itemId) return null;

	return (
		<motion.span
			aria-hidden="true"
			layoutId="expandable-action-bar-highlight"
			transition={reduce ? { duration: 0 } : EXPANDABLE_ACTION_BAR_TRANSITION}
			className={cn("absolute inset-0 -z-10 rounded-full bg-primary/[0.07]", className)}
		/>
	);
}

/** 标签展开动画：宽度、位移和模糊一起收放。 */
export function ExpandableActionBarLabel({
	children,
	className,
	visible,
}: {
	children: ReactNode;
	className?: string;
	visible?: boolean;
}) {
	const reduce = useReducedMotion() ?? false;
	const context = useExpandableActionBarContext("ExpandableActionBarLabel");
	const shown = visible ?? context.expanded;

	return (
		<motion.span
			aria-hidden={!shown}
			initial={false}
			animate={
				reduce
					? {
							filter: "blur(0px)",
							marginLeft: shown ? 8 : 0,
							opacity: shown ? 1 : 0,
							width: shown ? "auto" : 0,
							x: 0,
						}
					: {
							filter: shown ? "blur(0px)" : "blur(3px)",
							marginLeft: shown ? 8 : 0,
							opacity: shown ? 1 : 0,
							width: shown ? "auto" : 0,
							x: shown ? 0 : -4,
						}
			}
			transition={reduce ? { duration: 0 } : LABEL_TRANSITION}
			className={cn("inline-block overflow-hidden whitespace-nowrap", className)}
		>
			{children}
		</motion.span>
	);
}

export function ExpandableActionBar({
	activeId,
	children,
	className,
	collapseDelay = 90,
	defaultExpanded = false,
	expandOnFocus = true,
	expandOnHover = true,
	size = "md",
}: {
	activeId?: string;
	children: ReactNode;
	className?: string;
	collapseDelay?: number;
	defaultExpanded?: boolean;
	expandOnFocus?: boolean;
	expandOnHover?: boolean;
	size?: ExpandableActionBarSize;
}) {
	const layoutId = useId();
	const hover = useHoverGesture();
	const [expanded, setExpanded] = useState(defaultExpanded);
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const collapseTimer = useRef<number | null>(null);

	const clearCollapseTimer = useCallback(() => {
		if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
		collapseTimer.current = null;
	}, []);

	const open = useCallback(() => {
		clearCollapseTimer();
		setExpanded(true);
	}, [clearCollapseTimer]);

	const close = useCallback(() => {
		clearCollapseTimer();
		collapseTimer.current = window.setTimeout(() => {
			collapseTimer.current = null;
			setExpanded(false);
			setHoveredId(null);
		}, collapseDelay);
	}, [clearCollapseTimer, collapseDelay]);

	useEffect(() => clearCollapseTimer, [clearCollapseTimer]);

	const enterItem = (event: PointerBoundaryEvent, itemId: string) => {
		if (!hover.enter(event)) return;
		clearCollapseTimer();
		setHoveredId(itemId);
	};

	const focusItem = (itemId: string) => {
		clearCollapseTimer();
		setFocusedId(itemId);
	};

	return (
		<LayoutGroup id={layoutId}>
			<motion.div
				layout="size"
				// 指针事件而不是 mouseenter/mouseleave：触摸会补发不带 pointerType 的兼容鼠标事件，
				// 轨道在手下方展开时会把 leave 提前送到，导致一次点击只展开又立刻收起。
				onPointerEnter={(event) => {
					if (hover.enter(event) && expandOnHover) open();
				}}
				onPointerLeave={(event) => {
					if (!hover.leave(event)) return;
					setHoveredId(null);
					if (expandOnHover) close();
				}}
				onFocus={() => {
					if (expandOnFocus) open();
				}}
				onBlur={(event) => {
					if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
					setFocusedId(null);
					if (expandOnFocus) close();
				}}
				transition={EXPANDABLE_ACTION_BAR_TRANSITION}
				className={cn("flex w-full min-w-0", className)}
			>
				<motion.div
					layout="size"
					transition={EXPANDABLE_ACTION_BAR_TRANSITION}
					className={cn(
						// 展开后的标签可能超出容器，轨道自己横向滚动，避免最后一项跑出可视区；滚动条不进入视觉。
						"relative flex w-full min-w-0 items-center overflow-x-auto overflow-y-hidden rounded-full",
						"border border-border bg-card/90 shadow-[0_8px_24px_rgb(0_0_0/0.08)] backdrop-blur-xl",
						"[-webkit-scrollbar]:hidden [scrollbar-width:none]",
						SIZE_CLASS[size],
					)}
				>
					<ExpandableActionBarContext.Provider
						value={{
							activeId,
							enterItem,
							expanded,
							focusItem,
							highlightedId: hoveredId ?? focusedId ?? activeId ?? null,
						}}
					>
						{children}
					</ExpandableActionBarContext.Provider>
				</motion.div>
			</motion.div>
		</LayoutGroup>
	);
}
