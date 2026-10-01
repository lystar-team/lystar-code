import { afterEach, describe, expect, it, vi } from "vitest";
import { webApi } from "../src/adapters/host-protocol/api.ts";
import { initialState } from "../src/state/workbench-state.ts";
import {
	useWorkbenchStreamActions,
	type WorkbenchStreamActionsContext,
} from "../src/state/workbench-stream-actions.ts";
import type { WorkbenchState } from "../src/state/workbench-types.ts";

vi.mock("react", () => ({
	useCallback: <T>(callback: T): T => callback,
	useRef: <T>(value: T): { current: T } => ({ current: value }),
}));

function createRecovery(overrides: Partial<WorkbenchState> = {}) {
	vi.stubGlobal("localStorage", { getItem: () => null });
	const initial = initialState();
	const frames = new Map<number, FrameRequestCallback>();
	let frameId = 0;
	vi.stubGlobal("window", {
		...globalThis,
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frameId += 1;
			frames.set(frameId, callback);
			return frameId;
		},
		cancelAnimationFrame: (id: number) => {
			frames.delete(id);
		},
	});
	vi.stubGlobal("document", { visibilityState: "visible" });
	vi.stubGlobal("WebSocket", { OPEN: 1, CONNECTING: 0 });
	vi.spyOn(webApi, "subscribeSession").mockImplementation(() => {});
	const stateRef = { current: { ...initial, sessionId: "session-1", ...overrides } as WorkbenchState };
	const updateState: WorkbenchStreamActionsContext["updateState"] = (value) => {
		stateRef.current = typeof value === "function" ? value(stateRef.current) : value;
		return stateRef.current;
	};
	const loadSessionSnapshot = vi.fn(async () => {});
	const loadSessionOperations = vi.fn(async () => {});
	const loadTranscript = vi.fn(async () => {});
	const loadSubagents = vi.fn(async () => {});
	const refreshProjectFiles = vi.fn(async () => {});
	const actions = useWorkbenchStreamActions({
		stateRef,
		updateState,
		showToast: vi.fn(),
		applyBootstrap: vi.fn(),
		refreshBootstrap: vi.fn(async () => {}),
		refreshProjectSessions: vi.fn(async () => {}),
		loadTranscript,
		loadSessionOperations,
		loadSessionSnapshot,
		loadSubagents,
		refreshProjectFilesRef: { current: refreshProjectFiles },
		refreshModelOptionsRef: { current: vi.fn(async () => {}) },
		refreshModelSettingsRef: { current: vi.fn(async () => {}) },
		selectionRef: { current: 0 },
		selectionInFlightRef: { current: undefined },
		socketRef: {
			current: { readyState: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as WebSocket,
		},
		reconnectAttemptRef: { current: 0 },
		liveToolBatchRef: { current: 0 },
		liveTurnItemRef: { current: 0 },
		pendingTextProgressRef: { current: [] },
		pendingTextFrameRef: { current: undefined },
		pendingTextTimeoutRef: { current: undefined },
		transcriptTimerRef: { current: undefined },
		sessionDetailCacheRef: { current: new Map() },
		sessionDetailSeqRef: { current: new Map() },
		sessionReadAtRef: { current: new Map() },
		scheduleSubagentTranscriptRefresh: vi.fn(),
		sessionSubscriptionWaitersRef: { current: new Map() },
		handledNotifyIdsRef: { current: new Set() },
	} satisfies WorkbenchStreamActionsContext);
	return {
		actions,
		stateRef,
		loadSessionSnapshot,
		loadSessionOperations,
		loadTranscript,
		loadSubagents,
		refreshProjectFiles,
	};
}

describe("会话断线恢复", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("提交先到时丢弃同会话文本缓存，已落盘内容不再被 RAF 加回", () => {
		const context = createRecovery({
			session: { id: "session-1", transcriptGeneration: "gen-1" } as WorkbenchState["session"],
			transcriptPageLoaded: true,
			transcriptGeneration: "gen-1",
			transcriptRevision: 1,
		});
		// 文本 delta 进入 RAF 缓存后尚未应用，此时提交先到：提交分支必须先清缓存。
		context.actions.handleEvent({
			type: "session_progress",
			sessionId: "session-1",
			progress: { type: "assistant_delta", text: "已完成" },
		});
		expect(context.stateRef.current.liveTurnItems).toEqual([]);
		context.actions.handleEvent({
			type: "transcript_committed",
			sessionId: "session-1",
			transcriptGeneration: "gen-1",
			fromRevision: 1,
			toRevision: 2,
			items: [
				{
					entryId: "assistant-1",
					parentId: null,
					timestamp: "2026-10-01T00:00:00Z",
					kind: "message",
					view: { type: "assistant", text: "已完成" },
				},
			],
		});
		expect(context.stateRef.current.transcript.map((item) => item.entryId)).toEqual(["assistant-1"]);
		// 缓存已被提交分支清空：后续 RAF 即使执行，也不会把同一文本加回实时状态。
		expect(context.stateRef.current.liveTurnItems).toEqual([]);
	});

	it("Runtime 重连时校准已加载的项目文件树", async () => {
		const { actions, refreshProjectFiles } = createRecovery({
			currentProjectId: "project-1",
			inspectorOpen: true,
			inspectorMode: "files",
			fileTree: { path: "", home: "", entries: [] },
		});
		actions.handleEvent({ type: "connection_state", connected: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(refreshProjectFiles).toHaveBeenCalledWith([""]);
	});

	it("已有完整会话且详情未断档时只核对操作", async () => {
		const { actions, stateRef, loadSessionSnapshot, loadSessionOperations, loadTranscript, loadSubagents } =
			createRecovery({ session: { id: "session-1" } as WorkbenchState["session"], transcriptPageLoaded: true });
		actions.restoreSelectedSessionSubscription("session-1");
		actions.handleEvent({ type: "session_subscription", sessionId: "session-1", seq: 0, gap: false });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(stateRef.current.sessionReady).toBe(true);
		expect(loadSessionSnapshot).not.toHaveBeenCalled();
		expect(loadSessionOperations).toHaveBeenCalledTimes(1);
		expect(loadTranscript).not.toHaveBeenCalled();
		expect(loadSubagents).not.toHaveBeenCalled();
	});

	it("没有会话基线时即使详情无断档也补读四项", async () => {
		const { actions, loadSessionSnapshot, loadSessionOperations, loadTranscript, loadSubagents } = createRecovery();
		actions.restoreSelectedSessionSubscription("session-1");
		actions.handleEvent({ type: "session_subscription", sessionId: "session-1", seq: 0, gap: false });
		await vi.waitFor(() => expect(loadTranscript).toHaveBeenCalledTimes(1));
		expect(loadSessionSnapshot).toHaveBeenCalledTimes(1);
		expect(loadSessionOperations).toHaveBeenCalledTimes(1);
		expect(loadSubagents).toHaveBeenCalledTimes(1);
	});

	it("同一次断档确认有两个订阅等待者时只执行一次完整对账", async () => {
		const { actions, loadSessionSnapshot, loadSessionOperations, loadTranscript, loadSubagents } = createRecovery({
			session: { id: "session-1" } as WorkbenchState["session"],
			transcriptPageLoaded: true,
		});
		let finishRecovery!: () => void;
		const recovery = new Promise<void>((resolve) => {
			finishRecovery = resolve;
		});
		loadSessionSnapshot.mockImplementation(() => recovery);
		actions.restoreSelectedSessionSubscription("session-1");
		const concurrentWaiter = actions.subscribeSessionAndWait("session-1");
		actions.handleEvent({ type: "session_subscription", sessionId: "session-1", seq: 1, gap: true });
		const secondRecovery = actions.completeSessionSubscription("session-1", await concurrentWaiter);
		expect(loadTranscript).toHaveBeenCalledTimes(1);
		finishRecovery();
		await secondRecovery;
		expect(loadSessionSnapshot).toHaveBeenCalledTimes(1);
		expect(loadSessionOperations).toHaveBeenCalledTimes(1);
		expect(loadSubagents).toHaveBeenCalledTimes(1);
	});
});
