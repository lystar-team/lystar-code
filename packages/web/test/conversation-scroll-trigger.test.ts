import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationScroll } from "../src/components/workbench/use-conversation-scroll.ts";

const hooks = vi.hoisted(() => ({
	refs: [] as Array<{ current: unknown }>,
	states: [] as unknown[],
	index: 0,
}));

vi.mock("react", () => ({
	useState: <T>(initial: T): [T, (value: T) => void] => {
		const index = hooks.index++;
		hooks.states[index] ??= initial;
		return [
			hooks.states[index] as T,
			(value) => {
				hooks.states[index] = value;
			},
		];
	},
	useRef: <T>(initial: T): { current: T } => {
		const index = hooks.index++;
		hooks.refs[index] ??= { current: initial };
		return hooks.refs[index] as { current: T };
	},
	useCallback: <T>(callback: T): T => callback,
	useEffect: () => {},
	useLayoutEffect: () => {},
}));

const loadEarlier = vi.fn<() => Promise<void>>();
function renderScroll(previousCursor = "cursor-1", loadingEarlier = false) {
	hooks.index = 0;
	return useConversationScroll({
		sessionId: "session-1",
		responseActive: false,
		hasMorePrevious: true,
		previousCursor,
		loadingEarlier,
		transcriptError: undefined,
		loadEarlier,
		showToast: vi.fn(),
		resetExpandedState: vi.fn(),
	});
}

beforeEach(() => {
	hooks.refs = [];
	hooks.states = [];
	hooks.index = 0;
	loadEarlier.mockReset().mockResolvedValue();
});

afterEach(() => vi.unstubAllGlobals());

describe("conversation history scroll intent", () => {
	it("暂停跟随后取消回到底部的滚动定时器", () => {
		const timers = new Map<number, () => void>();
		let timerId = 0;
		vi.stubGlobal("window", {
			setTimeout: ((callback: () => void) => {
				timerId += 1;
				timers.set(timerId, callback);
				return timerId;
			}) as typeof setTimeout,
			clearTimeout: ((id: number) => {
				timers.delete(id);
			}) as typeof clearTimeout,
			matchMedia: () => ({ matches: true }),
		});
		const scroll = renderScroll();
		const scroller = { scrollTop: 100, scrollHeight: 400, clientHeight: 100 } as unknown as HTMLElement;
		scroll.handleTranscriptScrollerRef(scroller);
		scroll.handleReturnToBottom();
		expect(timers.size).toBe(1);
		const staleCallback = [...timers.values()][0]!;
		scroll.pauseFollowOutput();
		expect(timers.size).toBe(0);
		scroller.scrollHeight = 800;
		scroller.scrollTop = 100;
		staleCallback();
		expect(scroller.scrollTop).toBe(100);
	});

	it("loads on the first upward gesture even when the top callback arrives later", async () => {
		const scroll = renderScroll();
		scroll.handleUserScrollUp();
		expect(loadEarlier).not.toHaveBeenCalled();
		scroll.handleAtTopStateChange(true);
		expect(loadEarlier).toHaveBeenCalledTimes(1);
		await Promise.resolve();
	});

	it("does not request the same cursor again; a new upward gesture loads the next turn", async () => {
		const scroll = renderScroll();
		scroll.handleAtTopStateChange(true);
		renderScroll().handleUserScrollUp();
		expect(loadEarlier).toHaveBeenCalledTimes(1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		renderScroll().handleUserScrollUp();
		expect(loadEarlier).toHaveBeenCalledTimes(1);
		renderScroll("cursor-2").handleAtTopStateChange(true);
		expect(loadEarlier).toHaveBeenCalledTimes(1);
		renderScroll("cursor-2").handleUserScrollUp();
		expect(loadEarlier).toHaveBeenCalledTimes(2);
	});

	it("allows a retry after a failed history request", async () => {
		loadEarlier.mockRejectedValueOnce(new Error("读取失败")).mockResolvedValueOnce();
		const scroll = renderScroll();
		scroll.handleUserScrollUp();
		scroll.handleAtTopStateChange(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		scroll.requestEarlierHistory(true);
		expect(loadEarlier).toHaveBeenCalledTimes(2);
	});

	it("cancels an unfinished upward gesture when scrolling down", () => {
		const scroll = renderScroll();
		scroll.handleUserScrollUp();
		scroll.handleUserScrollDown();
		scroll.handleAtTopStateChange(true);
		expect(loadEarlier).not.toHaveBeenCalled();
	});
});
