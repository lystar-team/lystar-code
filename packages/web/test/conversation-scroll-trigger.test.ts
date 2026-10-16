import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationListHandle } from "../src/components/workbench/use-conversation-scroll.ts";
import { useConversationScroll } from "../src/components/workbench/use-conversation-scroll.ts";
import { useConversationHistory } from "../src/components/workbench/use-conversation-history.ts";

const hooks = vi.hoisted(() => ({
	refs: [] as Array<{ current: unknown }>, states: [] as unknown[], effects: [] as Array<() => void>, index: 0, changed: false,
}));

vi.mock("react", () => ({
	useState: <T>(initial: T | (() => T)): [T, (value: T | ((current: T) => T)) => void] => {
		const index = hooks.index++;
		if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
		return [hooks.states[index] as T, (value) => {
			const next = typeof value === "function" ? (value as (current: T) => T)(hooks.states[index] as T) : value;
			hooks.changed ||= next !== hooks.states[index];
			hooks.states[index] = next;
		}];
	},
	useRef: <T>(initial: T): { current: T } => {
		const index = hooks.index++;
		hooks.refs[index] ??= { current: initial };
		return hooks.refs[index] as { current: T };
	},
	useCallback: <T>(callback: T): T => callback,
	useLayoutEffect: (effect: () => void) => hooks.effects.push(effect),
}));

const loadEarlier = vi.fn<() => Promise<void>>();
const showToast = vi.fn();
function renderHistory(previousCursor = "cursor-1", sessionKey = "session-1", transcriptError?: string) {
	hooks.index = 0;
	return useConversationHistory({ sessionKey, hasMorePrevious: true, previousCursor, loadingEarlier: false,
		transcriptError, loadEarlier, showToast });
}
function renderScroll(sessionKey = "session-1", promptScrollRequest = 0) {
	for (let render = 0; render < 10; render++) {
		hooks.index = 0;
		hooks.effects = [];
		hooks.changed = false;
		const result = useConversationScroll({ sessionKey, promptScrollRequest });
		for (const effect of hooks.effects) effect();
		if (!hooks.changed) return result;
	}
	throw new Error("滚动 Hook 未完成状态更新");
}

beforeEach(() => {
	hooks.refs = []; hooks.states = []; hooks.effects = []; hooks.index = 0; hooks.changed = false;
	loadEarlier.mockReset().mockResolvedValue(); showToast.mockReset();
});

describe("conversation scroll control", () => {
	it("暂停跟随取消列表定位；返回最新恢复跟随并交给列表定位", () => {
		const handle: ConversationListHandle = { scrollToLatest: vi.fn(), cancelScroll: vi.fn() };
		const scroll = renderScroll();
		scroll.handleListRef(handle);
		scroll.pauseFollowing();
		expect(handle.cancelScroll).toHaveBeenCalledTimes(1);
		expect(renderScroll().following).toBe(false);
		renderScroll().handleReturnToBottom();
		expect(handle.scrollToLatest).toHaveBeenCalledTimes(1);
		expect(renderScroll().following).toBe(true);
	});

	it("程序滚动到底部只更新几何状态，用户操作才恢复跟随", () => {
		const scroll = renderScroll();
		scroll.pauseFollowing();
		renderScroll().handleAtBottomStateChange("session-1", true);
		expect(renderScroll()).toMatchObject({ following: false, isAtBottom: true });
		renderScroll().resumeFollowing();
		expect(renderScroll().following).toBe(true);
	});

	it("新的发送信号定位到底部，相同信号不重复定位", () => {
		const handle = { scrollToLatest: vi.fn(), cancelScroll: vi.fn() };
		renderScroll().handleListRef(handle);
		renderScroll().pauseFollowing();
		expect(renderScroll("session-1", 1).following).toBe(true);
		renderScroll("session-1", 1);
		expect(handle.scrollToLatest).toHaveBeenCalledTimes(1);
	});

	it("切换会话恢复原锚点，忽略旧会话的底部回调", () => {
		const snapshot = { atBottom: false, offset: 120, anchor: { key: "tool:read-2", offset: -8 }, measurements: [] };
		renderScroll().handleSnapshot("session-1", snapshot);
		renderScroll("session-2").handleAtBottomStateChange("session-1", true);
		expect(renderScroll("session-2").isAtBottom).toBe(false);
		expect(renderScroll("session-1")).toMatchObject({ initialSnapshot: snapshot, following: false });
	});
});

describe("conversation history scroll intent", () => {
	it("首次向上操作早于顶部回调时仍加载；程序到顶不触发请求", () => {
		const history = renderHistory();
		history.handleUserScrollUp();
		expect(loadEarlier).not.toHaveBeenCalled();
		history.handleAtTopStateChange(true);
		expect(loadEarlier).toHaveBeenCalledTimes(1);
	});

	it("相同游标不重复请求，下一页需要新的向上操作", async () => {
		renderHistory().handleAtTopStateChange(true);
		expect(loadEarlier).not.toHaveBeenCalled();
		renderHistory().handleUserScrollUp();
		expect(loadEarlier).toHaveBeenCalledTimes(1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		renderHistory().handleUserScrollUp();
		expect(loadEarlier).toHaveBeenCalledTimes(1);
		renderHistory("cursor-2").handleAtTopStateChange(true);
		expect(loadEarlier).toHaveBeenCalledTimes(1);
		renderHistory("cursor-2").handleUserScrollUp();
		expect(loadEarlier).toHaveBeenCalledTimes(2);
	});

	it("失败后显示错误并允许显式重试", async () => {
		loadEarlier.mockRejectedValueOnce(new Error("读取失败")).mockResolvedValueOnce();
		const history = renderHistory();
		history.handleUserScrollUp(); history.handleAtTopStateChange(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(showToast).toHaveBeenCalledWith("读取失败", "error");
		renderHistory("cursor-1", "session-1", "读取失败").requestEarlierHistory(true);
		expect(loadEarlier).toHaveBeenCalledTimes(2);
	});

	it("向下操作取消尚未完成的向上意图", () => {
		const history = renderHistory();
		history.handleUserScrollUp(); history.handleUserScrollDown(); history.handleAtTopStateChange(true);
		expect(loadEarlier).not.toHaveBeenCalled();
	});

	it("切换会话后相同游标可加载，旧会话请求失败不显示错误", async () => {
		let rejectRequest: (reason: Error) => void = () => {};
		loadEarlier.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
		const first = renderHistory();
		first.handleAtTopStateChange(true); first.handleUserScrollUp();
		const second = renderHistory("cursor-1", "session-2");
		second.handleAtTopStateChange(true); second.handleUserScrollUp();
		expect(loadEarlier).toHaveBeenCalledTimes(2);
		rejectRequest(new Error("旧会话读取失败"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(showToast).not.toHaveBeenCalled();
	});
});
