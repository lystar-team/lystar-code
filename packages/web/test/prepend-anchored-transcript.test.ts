import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrependAnchoredConversationTranscript } from "../src/components/workbench/prepend-anchored-transcript.tsx";
import type { VirtualizedConversationTranscriptProps } from "../src/components/workbench/virtualized-transcript.tsx";

type Item = { key: string };

afterEach(() => vi.unstubAllGlobals());

function mountTranscript() {
	let scrollTop = 70;
	let contentTop = 150;
	let frameId = 0;
	let notifyResize = () => {};
	let notifyMutation = () => {};
	const frames = new Map<number, FrameRequestCallback>();
	vi.stubGlobal("window", {
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++frameId, callback);
			return frameId;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
	});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: ResizeObserverCallback) {
				notifyResize = () => callback([], this as unknown as ResizeObserver);
			}
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"MutationObserver",
		class {
			constructor(callback: MutationCallback) {
				notifyMutation = () => callback([], this as unknown as MutationObserver);
			}
			observe() {}
			disconnect() {}
		},
	);
	const element = {
		dataset: { transcriptAnchorKey: "visible" },
		getBoundingClientRect: () => ({ top: contentTop - scrollTop, bottom: contentTop - scrollTop + 100, height: 100 }),
		contains: () => false,
	};
	const scroller = {
		get scrollTop() {
			return scrollTop;
		},
		set scrollTop(value: number) {
			scrollTop = value;
		},
		getBoundingClientRect: () => ({ top: 100, bottom: 600 }),
		querySelectorAll: () => [element],
	} as unknown as HTMLElement;
	const previous: VirtualizedConversationTranscriptProps<Item> = {
		items: [{ key: "visible" }],
		getKey: (item) => item.key,
		estimateHeight: () => 100,
		renderItem: () => null,
		atBottomStateChange: vi.fn(),
		atTopStateChange: vi.fn(),
		followOutput: false,
		onScrollStateCapture: vi.fn(),
		onUserScrollAway: vi.fn(),
		onUserScrollDown: vi.fn(),
		onUserScrollUp: vi.fn(),
		sessionKey: "review",
		virtuosoRef: vi.fn(),
	};
	const component = new PrependAnchoredConversationTranscript<Item>({
		...previous,
		items: [{ key: "earlier" }, ...previous.items],
	});
	const rendered = component.render() as ReactElement<VirtualizedConversationTranscriptProps<Item>>;
	rendered.props.onScrollerRef?.(scroller);
	const snapshot = component.getSnapshotBeforeUpdate(previous);
	return {
		component,
		frames,
		prepend: (height: number) => {
			contentTop += height;
		},
		commit: () => component.componentDidUpdate(previous, undefined, snapshot),
		offset: () => element.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
		resize: () => notifyResize(),
		mutate: () => notifyMutation(),
		userScroll: rendered.props.onUserScrollAway,
	};
}

describe("history prepend paint timing", () => {
	it("组件提交就恢复锚点，不等待动画帧露出中间位置", () => {
		const transcript = mountTranscript();
		transcript.prepend(240);
		transcript.commit();
		expect(transcript.offset()).toBe(-20);
		expect(transcript.frames.size).toBe(1);
		transcript.component.componentWillUnmount();
	});

	it("待处理动画帧不推迟尺寸和 DOM 变化后的补偿", () => {
		const transcript = mountTranscript();
		transcript.prepend(240);
		transcript.commit();
		transcript.prepend(37.5);
		transcript.resize();
		expect(transcript.offset()).toBe(-20);
		transcript.prepend(64);
		transcript.mutate();
		expect(transcript.offset()).toBe(-20);
		expect(transcript.frames.size).toBe(1);
		transcript.component.componentWillUnmount();
	});

	it("用户滚动取消锚点后，旧观察回调不改位置、不安排动画帧", () => {
		const transcript = mountTranscript();
		transcript.prepend(240);
		transcript.commit();
		transcript.userScroll();
		transcript.prepend(37.5);
		const offset = transcript.offset();
		transcript.resize();
		transcript.mutate();
		expect(transcript.offset()).toBe(offset);
		expect(transcript.frames.size).toBe(0);
		transcript.component.componentWillUnmount();
	});
});
