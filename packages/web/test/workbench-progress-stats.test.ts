import { describe, expect, it, vi } from "vitest";
import { webApi } from "../src/adapters/host-protocol/api.ts";
import type { WorkbenchState } from "../src/state/workbench-types.ts";

vi.mock("react", () => ({ useCallback: <T>(callback: T): T => callback }));

import { useWorkbenchProgressActions } from "../src/state/workbench-progress-actions.ts";
import { initialState } from "../src/state/workbench-state.ts";

describe("session usage progress", () => {
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
