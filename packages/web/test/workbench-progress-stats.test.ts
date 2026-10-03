import { afterEach, describe, expect, it, vi } from "vitest";
import { webApi } from "../src/adapters/host-protocol/api.ts";
import type { WorkbenchState } from "../src/state/workbench-types.ts";

vi.mock("react", () => ({ useCallback: <T>(callback: T): T => callback }));

import { useWorkbenchProgressActions } from "../src/state/workbench-progress-actions.ts";
import { initialState } from "../src/state/workbench-state.ts";

describe("session usage progress", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("后台连续文本合并保留所有字符，终态前仍按顺序刷新", () => {
		vi.useFakeTimers();
		vi.stubGlobal("document", { visibilityState: "hidden" });
		vi.stubGlobal("window", {
			setTimeout: globalThis.setTimeout,
			clearTimeout: globalThis.clearTimeout,
			requestAnimationFrame: vi.fn(),
			cancelAnimationFrame: vi.fn(),
			matchMedia: () => ({ matches: false }),
			localStorage: { getItem: () => null },
		});
		vi.spyOn(webApi, "hasToken").mockReturnValue(false);
		const stateRef = { current: { ...initialState(), sessionId: "session-1" } as WorkbenchState };
		const updateState = vi.fn((update: WorkbenchState | ((current: WorkbenchState) => WorkbenchState)) => {
			stateRef.current = typeof update === "function" ? update(stateRef.current) : update;
			return stateRef.current;
		});
		const { applyProgress, flushPendingTextProgress } = useWorkbenchProgressActions({
			stateRef,
			updateState,
			selectionRef: { current: 0 },
			liveToolBatchRef: { current: 0 },
			liveTurnItemRef: { current: 0 },
			pendingTextProgressRef: { current: [] },
			pendingTextFrameRef: { current: undefined },
			pendingTextTimeoutRef: { current: undefined },
		});
		for (let index = 0; index < 100; index++) {
			applyProgress({ type: "assistant_delta", text: "字", blockId: "answer" }, "session-1");
			vi.advanceTimersByTime(32);
		}
		expect(updateState).toHaveBeenCalledTimes(3);
		flushPendingTextProgress();
		expect(updateState).toHaveBeenCalledTimes(4);
		expect(
			stateRef.current.liveTurnItems.filter((entry) => entry.kind === "text").map((entry) => entry.parts.join("")),
		).toEqual(["字".repeat(100)]);
		applyProgress({ type: "thinking_delta", text: "思考", blockId: "thinking" }, "session-1");
		applyProgress({ type: "phase", phase: "idle" }, "session-1");
		expect(stateRef.current.liveTurnItems.map((entry) => entry.kind)).toEqual(["text", "thinking"]);
		expect(stateRef.current.liveTurnActive).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stores only completed output speed samples", () => {
		vi.spyOn(webApi, "hasToken").mockReturnValue(false);
		const stateRef = { current: { ...initialState(), sessionId: "session-1" } as WorkbenchState };
		const updateState = (update: WorkbenchState | ((current: WorkbenchState) => WorkbenchState)) => {
			stateRef.current = typeof update === "function" ? update(stateRef.current) : update;
			return stateRef.current;
		};
		const { applyProgress } = useWorkbenchProgressActions({
			stateRef,
			updateState,
			selectionRef: { current: 0 },
			liveToolBatchRef: { current: 0 },
			liveTurnItemRef: { current: 0 },
			pendingTextProgressRef: { current: [] },
			pendingTextFrameRef: { current: undefined },
			pendingTextTimeoutRef: { current: undefined },
		});

		applyProgress({ type: "usage", usage: { inputTokens: 10, outputTokens: 50 } }, "session-1");
		expect(stateRef.current.lastOutputSpeed).toBeUndefined();
		applyProgress({ type: "usage", usage: { outputTokens: 50, elapsedMs: 500 } }, "session-1");
		expect(stateRef.current.lastOutputSpeed).toEqual({ outputTokens: 50, elapsedMs: 500 });

		applyProgress({ type: "phase", phase: "turn" }, "session-1");
		expect(stateRef.current.lastOutputSpeed).toBeUndefined();
	});
});
