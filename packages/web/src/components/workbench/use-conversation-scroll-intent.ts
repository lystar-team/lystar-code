import { useEffect, useRef } from "react";
import type { HTMLAttributes, RefObject } from "react";

type ScrollIntentOptions = {
	onPause: () => void;
	onUp: () => void;
	onDown: () => void;
	onCancel: () => void;
	onExpansion: () => void;
	onUserPosition: (element: HTMLElement) => void;
};

/** 只识别用户输入，程序补偿产生的 scroll 不改变跟随意图。 */
export function useConversationScrollIntent(options: ScrollIntentOptions, scroller: RefObject<HTMLDivElement>): HTMLAttributes<HTMLDivElement> {
	const pointer = useRef(false);
	const lastTop = useRef(0);
	const touchY = useRef<number>();
	const pending = useRef(false);
	const active = useRef(options);
	active.current = options;
	useEffect(() => {
		const element = scroller.current;
		if (!element) return;
		const finish = () => {
			if (!pending.current) return;
			active.current.onUserPosition(element);
			pending.current = false;
		};
		element.addEventListener("scrollend", finish);
		return () => element.removeEventListener("scrollend", finish);
	}, [scroller]);
	const direction = (up: boolean) => {
		pending.current = true;
		options.onCancel();
		if (up) { options.onPause(); options.onUp(); }
		else options.onDown();
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
		onTouchStart: (event) => { touchY.current = event.touches[0]?.clientY; options.onCancel(); },
		onTouchMove: (event) => {
			const y = event.touches[0]?.clientY;
			if (y !== undefined && touchY.current !== undefined && y !== touchY.current) direction(y > touchY.current);
			touchY.current = y;
		},
		onTouchEnd: () => { touchY.current = undefined; },
		onPointerDown: (event) => {
			pointer.current = true;
			lastTop.current = event.currentTarget.scrollTop;
			options.onCancel();
		},
		onPointerUp: () => { pointer.current = false; },
		onPointerCancel: () => { pointer.current = false; },
		onScroll: (event) => {
			if (event.target !== event.currentTarget) return;
			if (pointer.current && lastTop.current !== event.currentTarget.scrollTop) direction(event.currentTarget.scrollTop < lastTop.current);
			lastTop.current = event.currentTarget.scrollTop;
			if (pending.current) options.onUserPosition(event.currentTarget);
		},
		onClickCapture: (event) => {
			if (event.target instanceof Element && event.target.closest('[data-slot="collapsible-trigger"][data-transcript-resize-anchor]')) options.onExpansion();
		},
	};
}
