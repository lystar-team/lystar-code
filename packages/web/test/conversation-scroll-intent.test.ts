import type { MouseEvent, PointerEvent, TouchEvent, UIEvent, WheelEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationScrollIntent } from "../src/components/workbench/use-conversation-scroll-intent.ts";

vi.mock("react", () => ({
	useRef: <T>(initial: T) => ({ current: initial }),
	useEffect: () => {},
}));

class ElementStub {
	closest = vi.fn<() => Element | null>().mockReturnValue(null);
}

const frames = new Map<number, FrameRequestCallback>();

function setup(scrollbarWidth = 10) {
	const element = Object.assign(new ElementStub(), {
		scrollTop: 400, scrollHeight: 1000, clientHeight: 200,
		offsetWidth: 500, clientWidth: 500 - scrollbarWidth,
		getBoundingClientRect: () => ({ left: 0, right: 500 }),
	}) as unknown as HTMLDivElement;
	const options = {
		onPause: vi.fn(), onUp: vi.fn(), onDown: vi.fn(), onCancel: vi.fn(),
		onExpansion: vi.fn(), onUserPosition: vi.fn(),
	};
	const intent = useConversationScrollIntent(options, { current: element });
	const pointer = (target: EventTarget = element, clientX = 495) => ({
		target, currentTarget: element, clientX, button: 0, pointerType: "mouse",
	}) as PointerEvent<HTMLDivElement>;
	const scroll = () => intent.onScrollCapture?.({ target: element, currentTarget: element } as UIEvent<HTMLDivElement>);
	return { element, options, intent, pointer, scroll };
}

beforeEach(() => {
	frames.clear();
	vi.stubGlobal("Element", ElementStub);
	vi.stubGlobal("getComputedStyle", () => ({ width: "10px" }));
	vi.stubGlobal("window", {
		requestAnimationFrame: (callback: FrameRequestCallback) => { const id = frames.size + 1; frames.set(id, callback); return id; },
		cancelAnimationFrame: (id: number) => frames.delete(id),
	});
});
afterEach(() => vi.unstubAllGlobals());

describe("conversation scroll intent", () => {
	it.each(["工具按钮", "列表空白"])("按下%s时程序滚动不取消定位或暂停跟随", (target) => {
		const { element, options, intent, pointer, scroll } = setup();
		intent.onPointerDown?.(pointer(target === "工具按钮" ? new ElementStub() as unknown as Element : element, 200));
		element.scrollTop = 350;
		scroll();
		intent.onPointerUp?.(pointer());
		expect(options.onCancel).not.toHaveBeenCalled();
		expect(options.onPause).not.toHaveBeenCalled();
		expect(options.onUp).not.toHaveBeenCalled();
		expect(options.onUserPosition).not.toHaveBeenCalled();
		expect(frames.size).toBe(0);
	});

	it.each([10, 0])("滚动条占位为 %i 像素时，上拖暂停，下拖报告用户位置", (width) => {
		const { element, options, intent, pointer, scroll } = setup(width);
		intent.onPointerDown?.(pointer());
		expect(options.onCancel).toHaveBeenCalledTimes(1);
		element.scrollTop = 350;
		scroll();
		expect(options.onPause).toHaveBeenCalledTimes(1);
		expect(options.onUp).toHaveBeenCalledTimes(1);
		element.scrollTop = 800;
		scroll();
		expect(options.onDown).toHaveBeenCalledTimes(1);
		expect(options.onUserPosition).toHaveBeenCalledWith(element, 800);
		intent.onPointerUp?.(pointer());
		for (const callback of [...frames.values()]) callback(0);
		options.onPause.mockClear();
		element.scrollTop = 750;
		scroll();
		expect(options.onPause).not.toHaveBeenCalled();
	});

	it("工具开合点击只报告展开意图，随后程序滚动不转为用户上翻", () => {
		const { element, options, intent, pointer, scroll } = setup();
		const trigger = new ElementStub();
		trigger.closest.mockReturnValue(trigger as unknown as Element);
		intent.onPointerDown?.(pointer(trigger as unknown as Element, 200));
		intent.onClickCapture?.({ target: trigger, currentTarget: element } as unknown as MouseEvent<HTMLDivElement>);
		element.scrollTop = 350;
		scroll();
		expect(options.onExpansion).toHaveBeenCalledWith(trigger);
		expect(options.onPause).not.toHaveBeenCalled();
		expect(options.onCancel).not.toHaveBeenCalled();
	});

	it("触屏点按不取消跟随，真实上翻手势才暂停", () => {
		const { element, options, intent } = setup();
		intent.onTouchStartCapture?.({ touches: [{ clientY: 100 }] } as unknown as TouchEvent<HTMLDivElement>);
		intent.onTouchEndCapture?.({} as TouchEvent<HTMLDivElement>);
		expect(options.onCancel).not.toHaveBeenCalled();
		expect(options.onPause).not.toHaveBeenCalled();
		intent.onTouchStartCapture?.({ touches: [{ clientY: 100 }] } as unknown as TouchEvent<HTMLDivElement>);
		intent.onTouchMoveCapture?.({ touches: [{ clientY: 120 }] } as unknown as TouchEvent<HTMLDivElement>);
		expect(options.onCancel).toHaveBeenCalledTimes(1);
		expect(options.onPause).toHaveBeenCalledTimes(1);
		expect(options.onUp).not.toHaveBeenCalled();
		intent.onTouchEndCapture?.({ currentTarget: element } as TouchEvent<HTMLDivElement>);
		expect(options.onUp).toHaveBeenCalledTimes(1);
	});

	it("滚轮上翻仍暂停，向下到达底部时报告恢复所需的原底部位置", () => {
		const { element, options, intent, scroll } = setup();
		intent.onWheelCapture?.({ deltaY: -100, target: element } as WheelEvent<HTMLDivElement>);
		expect(options.onPause).toHaveBeenCalledTimes(1);
		expect(options.onUp).toHaveBeenCalledTimes(1);
		intent.onWheelCapture?.({ deltaY: 400, target: element } as WheelEvent<HTMLDivElement>);
		element.scrollTop = 800;
		scroll();
		expect(options.onDown).toHaveBeenCalledTimes(1);
		expect(options.onUserPosition).toHaveBeenLastCalledWith(element, 800);
	});
});
