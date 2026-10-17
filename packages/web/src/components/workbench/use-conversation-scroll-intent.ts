import { useEffect, useRef } from "react";
import type { HTMLAttributes, RefObject } from "react";

type ScrollIntentOptions = {
	onPause: () => void;
	onUp: () => void;
	onDown: () => void;
	onCancel: () => void;
	onExpansion: (trigger: HTMLElement) => void;
	onUserPosition: (element: HTMLElement, endOffset?: number) => void;
};

/** 只识别用户输入，程序补偿产生的 scroll 不改变跟随意图。 */
export function useConversationScrollIntent(options: ScrollIntentOptions, scroller: RefObject<HTMLDivElement>): HTMLAttributes<HTMLDivElement> {
	const pointer = useRef<{ endOffset: number }>();
	const pointerReleaseFrame = useRef<number>();
	const lastTop = useRef(0);
	const touchY = useRef<number>();
	const touchUp = useRef(false);
	const pending = useRef<{ endOffset?: number }>();
	const active = useRef(options);
	active.current = options;
	useEffect(() => {
		const element = scroller.current;
		if (!element) return;
		const finish = () => {
			if (!pending.current) return;
			const { endOffset } = pending.current;
			pending.current = undefined;
			active.current.onUserPosition(element, endOffset);
		};
		element.addEventListener("scrollend", finish);
		return () => {
			element.removeEventListener("scrollend", finish);
			if (pointerReleaseFrame.current !== undefined) window.cancelAnimationFrame(pointerReleaseFrame.current);
		};
	}, [scroller]);
	const direction = (up: boolean, endOffset?: number) => {
		const element = scroller.current;
		if (!element) return;
		// 保留输入发生时的底部，避免离屏内容重新测量后把用户刚到达的末尾推远。
		pending.current = { endOffset: up ? undefined : endOffset ?? Math.max(0, element.scrollHeight - element.clientHeight) };
		options.onCancel();
		if (up) {
			options.onPause();
			// 手指离开后再补页，避免分页重组卡片移除当前触摸目标。
			if (touchY.current !== undefined) touchUp.current = true;
			else options.onUp();
		} else {
			touchUp.current = false;
			options.onDown();
			// 已在底部时继续向下不会触发 scroll，也需要恢复跟随。
			options.onUserPosition(element, pending.current.endOffset);
		}
	};
	return {
		onWheelCapture: (event) => {
			if (event.target instanceof Element) {
				const nested = event.target.closest<HTMLElement>('[data-transcript-resize-anchor]');
				if (nested && nested !== event.currentTarget && nested.scrollHeight > nested.clientHeight &&
					/auto|scroll/.test(getComputedStyle(nested).overflowY)) {
					const canScroll = event.deltaY < 0 ? nested.scrollTop > 0 : nested.scrollTop + nested.clientHeight < nested.scrollHeight;
					if (canScroll) return;
				}
			}
			if (event.deltaY !== 0) direction(event.deltaY < 0);
		},
		onKeyDownCapture: (event) => {
			if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]')) return;
			if (event.key === " " && event.target instanceof Element && event.target.closest('button,a[href],[role="button"]')) return;
			if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) direction(true);
			else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) direction(false);
		},
		onTouchStartCapture: (event) => { touchY.current = event.touches[0]?.clientY; touchUp.current = false; options.onCancel(); },
		onTouchMoveCapture: (event) => {
			const y = event.touches[0]?.clientY;
			if (y !== undefined && touchY.current !== undefined && y !== touchY.current) direction(y > touchY.current);
			touchY.current = y;
		},
		onTouchEndCapture: () => {
			touchY.current = undefined;
			if (touchUp.current) {
				touchUp.current = false;
				options.onUp();
			}
		},
		onTouchCancelCapture: () => { touchY.current = undefined; touchUp.current = false; options.onDown(); },
		onPointerDown: (event) => {
			if (pointerReleaseFrame.current !== undefined) window.cancelAnimationFrame(pointerReleaseFrame.current);
			pointerReleaseFrame.current = undefined;
			pointer.current = { endOffset: Math.max(0, event.currentTarget.scrollHeight - event.currentTarget.clientHeight) };
			lastTop.current = event.currentTarget.scrollTop;
			options.onCancel();
		},
		onPointerUp: () => {
			// 原生滚动条可能在 pointerup 后才派发最终 scroll，保留意图到该帧结束。
			if (pointerReleaseFrame.current !== undefined) window.cancelAnimationFrame(pointerReleaseFrame.current);
			pointerReleaseFrame.current = window.requestAnimationFrame(() => {
				pointerReleaseFrame.current = undefined;
				pointer.current = undefined;
			});
		},
		onPointerCancel: () => {
			if (pointerReleaseFrame.current !== undefined) window.cancelAnimationFrame(pointerReleaseFrame.current);
			pointerReleaseFrame.current = undefined;
			pointer.current = undefined;
		},
		onScrollCapture: (event) => {
			if (event.target !== event.currentTarget) return;
			if (pointer.current && lastTop.current !== event.currentTarget.scrollTop) direction(event.currentTarget.scrollTop < lastTop.current, pointer.current.endOffset);
			lastTop.current = event.currentTarget.scrollTop;
			if (pending.current) options.onUserPosition(event.currentTarget, pending.current.endOffset);
		},
		onClickCapture: (event) => {
			if (!(event.target instanceof Element)) return;
			const trigger = event.target.closest<HTMLElement>('[data-slot="collapsible-trigger"][data-transcript-resize-anchor], [data-json-toggle]');
			if (trigger) options.onExpansion(trigger);
		},
	};
}
