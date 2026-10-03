import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webApi } from "../src/adapters/host-protocol/api.ts";
import { useWorkbench } from "../src/state/use-workbench.ts";
import { initialState } from "../src/state/workbench-state.ts";
import type { WorkbenchState } from "../src/state/workbench-types.ts";
import type { TranscriptResponse, WebLease, WebSessionSnapshot, WebTranscriptItem } from "../src/types.ts";

const hooks = vi.hoisted(() => ({
	committed: undefined as WorkbenchState | undefined,
	refs: [] as Array<{ current: unknown }>,
	refIndex: 0,
	priority: "normal" as "normal" | "transition",
	pendingTransitions: [] as WorkbenchState[],
	effects: [] as Array<() => undefined | (() => void)>,
	publishes: 0,
}));

vi.mock("react", () => ({
	useState: <T>(initial: T | (() => T)): [T, (value: T) => void] => {
		hooks.committed ??=
			typeof initial === "function" ? (initial as () => WorkbenchState)() : (initial as WorkbenchState);
		return [
			hooks.committed as T,
			(value) => {
				hooks.publishes++;
				if (hooks.priority === "transition") hooks.pendingTransitions.push(value as WorkbenchState);
				else hooks.committed = value as WorkbenchState;
			},
		];
	},
	useRef: <T>(initial: T): { current: T } => {
		const index = hooks.refIndex++;
		hooks.refs[index] ??= { current: initial };
		return hooks.refs[index] as { current: T };
	},
	useCallback: <T>(callback: T): T => callback,
	useMemo: <T>(calculate: () => T): T => calculate(),
	useEffect: (effect: () => undefined | (() => void)) => {
		hooks.effects.push(effect);
	},
	startTransition: (callback: () => void) => {
		hooks.priority = "transition";
		try {
			callback();
		} finally {
			hooks.priority = "normal";
		}
	},
}));

const lease = { leaseId: "lease-1", leaseGeneration: 1, createdAt: 1, updatedAt: 1 } satisfies WebLease;
const snapshot = {
	id: "session-a",
	name: "会话 A",
	createdAt: 1,
	updatedAt: 1,
	phase: "idle",
	activity: "idle",
	thinkingLevel: "off",
	attached: true,
	writeAccess: "owned",
	revision: 1,
	leafId: "entry-a",
	queuedSteerCount: 0,
	queuedFollowUpCount: 0,
	transcriptGeneration: "runtime-a",
	transcriptRevision: 1,
} satisfies WebSessionSnapshot;
const item = {
	entryId: "entry-a",
	parentId: null,
	timestamp: "2026-09-25T00:00:00Z",
	kind: "message",
	view: { type: "user", text: "会话 A 的历史消息" },
} satisfies WebTranscriptItem;
const page = {
	items: [item],
	hasMorePrevious: false,
	leafId: item.entryId,
	transcriptGeneration: "history-a",
	transcriptRevision: 1,
	complete: true,
} satisfies TranscriptResponse;

function renderWorkbench() {
	hooks.refIndex = 0;
	return useWorkbench();
}

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(webApi, "hasToken").mockReturnValue(false);
	hooks.refs = [];
	hooks.refIndex = 0;
	hooks.priority = "normal";
	hooks.pendingTransitions = [];
	hooks.effects = [];
	hooks.publishes = 0;
	hooks.committed = {
		...initialState(),
		currentProjectId: "project",
		sessionId: snapshot.id,
		projects: [
			{
				id: "project",
				name: "测试项目",
				path: "/tmp/test-project",
				sessions: [
					{
						id: snapshot.id,
						name: snapshot.name,
						createdAt: 1,
						updatedAt: 1,
						messageCount: 1,
						firstMessage: "会话 A 的历史消息",
						activity: "idle",
						writeAccess: "owned",
					},
				],
			},
		],
	};
	vi.spyOn(webApi, "subagents").mockResolvedValue({ subagents: [] });
	vi.spyOn(webApi, "operations").mockResolvedValue({ operations: [] });
	vi.spyOn(webApi, "projectTrust").mockResolvedValue({ cwd: "/tmp/test-project", trusted: true });
});

describe("后台展示与读取生命周期", () => {
	let cleanups: Array<() => void>;
	let visibility: {
		visibilityState: string;
		addEventListener: ReturnType<typeof vi.fn>;
		removeEventListener: ReturnType<typeof vi.fn>;
		documentElement: { dataset: Record<string, string> };
	};

	beforeEach(() => {
		cleanups = [];
		vi.useFakeTimers();
		visibility = {
			visibilityState: "hidden",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			documentElement: { dataset: {} },
		};
		vi.stubGlobal("document", visibility);
		vi.stubGlobal("BroadcastChannel", undefined);
		vi.stubGlobal("navigator", { onLine: true });
		vi.stubGlobal("window", {
			setTimeout: globalThis.setTimeout,
			clearTimeout: globalThis.clearTimeout,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			cancelAnimationFrame: vi.fn(),
			matchMedia: () => ({ matches: false }),
			localStorage: { getItem: () => null, setItem: vi.fn() },
		});
		vi.spyOn(webApi, "branding").mockResolvedValue({ name: "LYStar Code" });
	});

	afterEach(() => {
		for (const cleanup of cleanups) cleanup();
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("后台更新保留完整记录，返回前台一次提交最新状态", async () => {
		vi.spyOn(webApi, "transcript").mockResolvedValue(page);
		const workbench = renderWorkbench();
		for (const effect of hooks.effects) {
			const cleanup = effect();
			if (cleanup) cleanups.push(cleanup);
		}
		await Promise.resolve();
		hooks.publishes = 0;
		const before = hooks.committed;
		await workbench.actions.loadTranscript(snapshot.id);
		expect(hooks.publishes).toBe(0);
		expect(hooks.committed).toBe(before);
		expect((hooks.refs[0]!.current as WorkbenchState).transcript.map((entry) => entry.entryId)).toEqual([
			item.entryId,
		]);

		visibility.visibilityState = "visible";
		const listener = visibility.addEventListener.mock.calls.find(
			([name]) => name === "visibilitychange",
		)?.[1] as () => void;
		listener();
		expect(hooks.publishes).toBe(1);
		expect(hooks.committed?.transcript.map((entry) => entry.entryId)).toEqual([item.entryId]);
	});

	it("切换会话取消旧历史和子任务读取，保留控制权请求", async () => {
		visibility.visibilityState = "visible";
		const signals: AbortSignal[] = [];
		let finishOldHistory!: (value: TranscriptResponse) => void;
		let finishOldControl!: (value: { owned: boolean; lease: WebLease; snapshot: WebSessionSnapshot }) => void;
		let finishOldSubagents!: (value: { subagents: [] }) => void;
		const sessionB = { ...snapshot, id: "session-b", name: "会话 B" };
		vi.spyOn(webApi, "transcript").mockImplementation((sessionId, options) => {
			if (sessionId !== snapshot.id) return Promise.resolve({ ...page, items: [], leafId: null });
			signals.push(options!.signal!);
			return new Promise((resolve) => {
				finishOldHistory = resolve;
			});
		});
		vi.spyOn(webApi, "subagents").mockImplementation((sessionId, signal) => {
			if (sessionId !== snapshot.id) return Promise.resolve({ subagents: [] });
			signals.push(signal!);
			return new Promise((resolve) => {
				finishOldSubagents = resolve;
			});
		});
		const control = vi.spyOn(webApi, "control").mockImplementation((sessionId) =>
			sessionId === snapshot.id
				? new Promise((resolve) => {
						finishOldControl = resolve;
					})
				: Promise.resolve({ owned: true, lease, snapshot: sessionB }),
		);
		vi.spyOn(webApi, "release").mockResolvedValue(undefined);
		const actions = renderWorkbench().actions;
		const openingA = actions.selectSession(snapshot.id);
		await actions.selectSession(sessionB.id);
		expect(signals).toHaveLength(2);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		expect(control.mock.calls).toEqual([[snapshot.id], [sessionB.id]]);
		finishOldHistory(page);
		finishOldSubagents({ subagents: [] });
		finishOldControl({ owned: true, lease, snapshot });
		await openingA;
		expect((hooks.refs[0]!.current as WorkbenchState).sessionId).toBe(sessionB.id);
		expect((hooks.refs[0]!.current as WorkbenchState).transcript).toEqual([]);
		expect((hooks.refs[0]!.current as WorkbenchState).transcriptError).toBeUndefined();
	});

	it("退出时取消只读回退，不阻止再次打开同一会话", async () => {
		visibility.visibilityState = "visible";
		vi.spyOn(webApi, "transcript").mockResolvedValue(page);
		vi.spyOn(webApi, "subagents").mockResolvedValue({ subagents: [] });
		const control = vi.spyOn(webApi, "control").mockRejectedValue(new Error("控制权获取失败"));
		vi.spyOn(webApi, "clearToken").mockImplementation(() => {});
		let readSignal!: AbortSignal;
		let finishSnapshot!: (value: { session: WebSessionSnapshot }) => void;
		vi.spyOn(webApi, "session").mockImplementation((_sessionId, signal) => {
			readSignal = signal!;
			return new Promise((resolve) => {
				finishSnapshot = resolve;
			});
		});
		const actions = renderWorkbench().actions;
		const opening = actions.selectSession(snapshot.id);
		await vi.waitFor(() => expect(readSignal).toBeDefined());
		actions.signOut();
		expect(readSignal.aborted).toBe(true);
		finishSnapshot({ session: snapshot });
		await opening;
		control.mockResolvedValue({ owned: true, lease, snapshot });
		await actions.selectSession(snapshot.id);
		expect(control).toHaveBeenCalledTimes(2);
		expect((hooks.refs[0]!.current as WorkbenchState).sessionId).toBe(snapshot.id);
	});

	it("尾页刷新不取消并行历史分页；退出时取消仍在读取的响应", async () => {
		visibility.visibilityState = "visible";
		let finishOlder!: (value: TranscriptResponse) => void;
		let olderSignal!: AbortSignal;
		vi.spyOn(webApi, "transcript").mockImplementation((_sessionId, options) => {
			if (!options?.cursor) return Promise.resolve(page);
			olderSignal = options.signal!;
			return new Promise((resolve) => {
				finishOlder = resolve;
			});
		});
		const actions = renderWorkbench().actions;
		const older = actions.loadTranscript(snapshot.id, "older");
		await actions.loadTranscript(snapshot.id);
		expect(olderSignal.aborted).toBe(false);
		vi.spyOn(webApi, "clearToken").mockImplementation(() => {});
		actions.signOut();
		expect(olderSignal.aborted).toBe(true);
		finishOlder(page);
		await older;
		expect(hooks.committed?.sessionId).toBeUndefined();
		expect(hooks.committed?.transcript).toEqual([]);
	});
});

describe("会话停止请求", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
		hooks.committed = {
			...hooks.committed!,
			session: { ...snapshot, activity: "running" },
			sessionReady: true,
			readOnly: false,
			lease,
			pendingUserPrompts: [{ id: "pending-a", text: "未提交消息", attachments: [] }],
			queuedUserPrompts: [
				{ id: "queued-a", text: "排队消息", displayText: "排队消息", delivery: "follow-up", attachments: [] },
			],
		};
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("重复停止只发送一次请求，确认后清队列并使用真实空闲快照", async () => {
		let complete!: (value: Awaited<ReturnType<typeof webApi.abort>>) => void;
		const request = vi.spyOn(webApi, "abort").mockImplementation(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		const prompt = vi.spyOn(webApi, "prompt");
		const actions = renderWorkbench().actions;
		const stopping = actions.abort();
		expect(hooks.committed?.stoppingSessionIds[snapshot.id]).toBe(true);
		await actions.abort();
		await actions.sendMessage("停止中提交的任务");
		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith(snapshot.id);
		expect(prompt).not.toHaveBeenCalled();
		expect(hooks.committed?.pendingUserPrompts).toHaveLength(1);

		complete({ stopped: true, session: { ...snapshot, revision: 2 } });
		await stopping;
		expect(hooks.committed?.stoppingSessionIds[snapshot.id]).toBeUndefined();
		expect(hooks.committed?.session?.activity).toBe("idle");
		expect(hooks.committed?.pendingUserPrompts).toEqual([]);
		expect(hooks.committed?.queuedUserPrompts).toEqual([]);
	});

	it("停止 A 时切换到 B，A 的迟到响应保留 B 的任务和快照", async () => {
		let complete!: (value: Awaited<ReturnType<typeof webApi.abort>>) => void;
		vi.spyOn(webApi, "abort").mockImplementation(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		const stopping = renderWorkbench().actions.abort();
		const sessionB = { ...snapshot, id: "session-b", activity: "running" as const };
		const pendingB = [{ id: "pending-b", text: "B 的未提交消息", attachments: [] }];
		const next = { ...hooks.committed!, sessionId: sessionB.id, session: sessionB, pendingUserPrompts: pendingB };
		hooks.refs[0]!.current = next;
		hooks.committed = next;

		complete({ stopped: true, session: { ...snapshot, revision: 2 } });
		await stopping;
		expect(hooks.committed?.session).toEqual(sessionB);
		expect(hooks.committed?.pendingUserPrompts).toEqual(pendingB);
		expect(hooks.committed?.stoppingSessionIds[snapshot.id]).toBeUndefined();
	});

	it("停止失败显示错误并保留消息，用户可以重试", async () => {
		const request = vi.spyOn(webApi, "abort").mockRejectedValueOnce(new Error("停止请求失败"));
		const actions = renderWorkbench().actions;
		await actions.abort();
		expect(hooks.committed?.toast).toBe("停止请求失败");
		expect(hooks.committed?.pendingUserPrompts).toHaveLength(1);
		expect(hooks.committed?.stoppingSessionIds[snapshot.id]).toBeUndefined();

		request.mockResolvedValueOnce({ stopped: true, session: { ...snapshot, revision: 2 } });
		await actions.abort();
		expect(request).toHaveBeenCalledTimes(2);
		expect(hooks.committed?.pendingUserPrompts).toEqual([]);
	});
});

describe("会话切换时的记录状态", () => {
	it("切换会话时清空目标会话没有的 TPS，并在返回时恢复原会话 TPS", async () => {
		const sessionB = { ...snapshot, id: "session-b", name: "会话 B", leafId: "entry-b" };
		hooks.committed = {
			...hooks.committed!,
			session: snapshot,
			sessionReady: true,
			lastOutputSpeed: { outputTokens: 120, elapsedMs: 1_000 },
			projects: hooks.committed!.projects.map((project) => ({
				...project,
				sessions: [
					...project.sessions,
					{
						id: sessionB.id,
						name: sessionB.name,
						createdAt: 2,
						updatedAt: 2,
						messageCount: 0,
						firstMessage: "",
						activity: "idle",
						writeAccess: "owned",
					},
				],
			})),
		};
		vi.spyOn(webApi, "transcript").mockResolvedValue(page);
		vi.spyOn(webApi, "control").mockImplementation(async (sessionId) => ({
			owned: true,
			lease,
			snapshot: sessionId === sessionB.id ? sessionB : snapshot,
		}));
		vi.spyOn(webApi, "release").mockResolvedValue(undefined);

		const openB = renderWorkbench().actions.selectSession(sessionB.id);
		expect(hooks.committed?.sessionId).toBe(sessionB.id);
		expect(hooks.committed?.lastOutputSpeed).toBeUndefined();
		await openB;

		const openA = renderWorkbench().actions.selectSession(snapshot.id);
		expect(hooks.committed?.sessionId).toBe(snapshot.id);
		expect(hooks.committed?.lastOutputSpeed).toEqual({ outputTokens: 120, elapsedMs: 1_000 });
		await openA;
	});

	it("记录请求先于会话控制完成时，旧渲染不能覆盖已提交的历史", async () => {
		let resolvePage!: (value: TranscriptResponse) => void;
		let resolveControl!: (value: { owned: boolean; lease: WebLease; snapshot: WebSessionSnapshot }) => void;
		vi.spyOn(webApi, "transcript").mockImplementation(
			() =>
				new Promise((resolve) => {
					resolvePage = resolve;
				}),
		);
		vi.spyOn(webApi, "control").mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveControl = resolve;
				}),
		);

		const opening = renderWorkbench().actions.selectSession(snapshot.id);
		renderWorkbench();
		resolvePage(page);
		await vi.waitFor(() => expect(hooks.pendingTransitions).toHaveLength(1));
		expect(hooks.pendingTransitions[0]?.transcriptPageLoaded).toBe(true);

		// 模拟 React 在低优先级记录提交前渲染较早的紧急更新。
		renderWorkbench();
		resolveControl({ owned: true, lease, snapshot });
		await opening;

		expect(hooks.committed?.transcript.map((entry) => entry.entryId)).toEqual([item.entryId]);
		expect(hooks.committed?.transcriptPageLoaded).toBe(true);
		expect(hooks.committed?.transcriptLoading).toBe(false);
	});

	it("向上阅读跨页回合时保持加载状态，并阻止重复请求", async () => {
		const earlierTool = {
			...item,
			entryId: "tool-a",
			parentId: "older-user",
			view: { type: "assistant" as const, text: "中间的工作记录" },
		} satisfies WebTranscriptItem;
		const earlierUser = {
			...item,
			entryId: "older-user",
			parentId: null,
		} satisfies WebTranscriptItem;
		let resolveOlder!: (value: TranscriptResponse) => void;
		const request = vi
			.spyOn(webApi, "transcript")
			.mockResolvedValueOnce({ ...page, items: [earlierTool], previousCursor: "older-2", hasMorePrevious: true })
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveOlder = resolve;
					}),
			);
		hooks.committed = {
			...hooks.committed!,
			transcript: [{ ...item, renderId: "entry-a:message:0" }],
			transcriptPageLoaded: true,
			transcriptGeneration: page.transcriptGeneration,
			transcriptLeafId: page.leafId,
			transcriptRevision: page.transcriptRevision,
			previousCursor: "older-1",
			hasMorePrevious: true,
		};

		const actions = renderWorkbench().actions;
		const loading = actions.loadEarlier();
		await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
		expect(hooks.committed?.loadingEarlier).toBe(true);
		expect(hooks.committed?.transcript.map((entry) => entry.entryId)).toEqual([item.entryId]);
		await actions.loadEarlier();
		expect(request).toHaveBeenCalledTimes(2);
		resolveOlder({ ...page, items: [earlierUser], hasMorePrevious: false });
		await loading;

		expect(request.mock.calls.map(([, options]) => options?.cursor)).toEqual(["older-1", "older-2"]);
		expect(hooks.committed?.transcript.map((entry) => entry.entryId)).toEqual(["older-user", "tool-a", item.entryId]);
		expect(hooks.committed?.hasMorePrevious).toBe(false);
		expect(hooks.committed?.loadingEarlier).toBe(false);
	});

	it("历史分页被并发状态更新打断时保留可重试错误", async () => {
		const earlierTool = {
			...item,
			entryId: "older-tool",
			view: { type: "assistant" as const, text: "更早的工作记录" },
		} satisfies WebTranscriptItem;
		let resolveOlder!: (value: TranscriptResponse) => void;
		const request = vi
			.spyOn(webApi, "transcript")
			.mockResolvedValueOnce({ ...page, items: [earlierTool], previousCursor: "cursor-2", hasMorePrevious: true })
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveOlder = resolve;
					}),
			);
		hooks.committed = {
			...hooks.committed!,
			transcript: [{ ...item, renderId: "entry-a:message:0" }],
			transcriptPageLoaded: true,
			transcriptGeneration: page.transcriptGeneration,
			transcriptLeafId: page.leafId,
			transcriptRevision: page.transcriptRevision,
			previousCursor: "cursor-1",
			hasMorePrevious: true,
		};

		const loading = renderWorkbench().actions.loadEarlier();
		await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
		hooks.refs[0]!.current = {
			...(hooks.refs[0]!.current as WorkbenchState),
			transcriptGeneration: "generation-changed",
		};
		resolveOlder({ ...page, items: [{ ...item, entryId: "older-user" }], hasMorePrevious: false });

		await expect(loading).rejects.toThrow("历史记录已更新，请重新打开会话");
		expect(hooks.committed?.transcriptError).toBe("历史记录已更新，请重新打开会话");
		expect(hooks.committed?.loadingEarlier).toBe(false);
	});

	it("当前窗口从回复中间开始时，加载到上一轮提问", async () => {
		hooks.committed = {
			...hooks.committed!,
			transcript: [{ ...item, view: { type: "assistant", text: "当前回复" }, renderId: "entry-a:assistant:0" }],
			transcriptPageLoaded: true,
			transcriptGeneration: page.transcriptGeneration,
			transcriptLeafId: page.leafId,
			previousCursor: "cursor-1",
			hasMorePrevious: true,
		};
		const requests = vi
			.spyOn(webApi, "transcript")
			.mockResolvedValueOnce({
				...page,
				items: [{ ...item, entryId: "current-user", parentId: "previous-user" }],
				previousCursor: "cursor-2",
				hasMorePrevious: true,
			})
			.mockResolvedValueOnce({ ...page, items: [{ ...item, entryId: "previous-user" }] });

		await renderWorkbench().actions.loadEarlier();
		expect(requests.mock.calls.map(([, options]) => options?.cursor)).toEqual(["cursor-1", "cursor-2"]);
		expect(hooks.committed?.transcript.map((entry) => entry.entryId)).toEqual([
			"previous-user",
			"current-user",
			item.entryId,
		]);
	});

	it("一轮历史跨越二十页时只需一次向上操作", async () => {
		hooks.committed = {
			...hooks.committed!,
			transcript: [{ ...item, renderId: "entry-a:message:0" }],
			transcriptPageLoaded: true,
			transcriptGeneration: page.transcriptGeneration,
			transcriptLeafId: page.leafId,
			previousCursor: "cursor-0",
			hasMorePrevious: true,
		};
		const requests = vi.spyOn(webApi, "transcript").mockImplementation(async (_sessionId, options) => {
			const index = Number(options?.cursor?.replace("cursor-", ""));
			return {
				...page,
				items: [
					{
						...item,
						entryId: `older-${index}`,
						parentId: index === 19 ? null : `older-${index + 1}`,
						...(index < 19 ? { view: { type: "assistant" as const, text: `步骤 ${index}` } } : {}),
					},
				],
				previousCursor: index === 19 ? undefined : `cursor-${index + 1}`,
				hasMorePrevious: index < 19,
			};
		});

		await renderWorkbench().actions.loadEarlier();
		expect(requests).toHaveBeenCalledTimes(20);
		expect(requests.mock.calls.map(([, options]) => options?.cursor)).toEqual(
			Array.from({ length: 20 }, (_, index) => `cursor-${index}`),
		);
		expect(hooks.committed?.transcript).toHaveLength(21);
		expect(hooks.committed?.transcript.at(0)?.entryId).toBe("older-19");
		expect(hooks.committed?.transcript.at(-1)?.entryId).toBe(item.entryId);
		expect(hooks.committed?.hasMorePrevious).toBe(false);
	});

	it("尾页已追加新消息后，重试旧游标能加载历史并清除错误", async () => {
		const newTool = {
			...item,
			entryId: "new-tool",
			parentId: item.entryId,
			view: { type: "assistant" as const, text: "新增回复" },
		};
		hooks.committed = {
			...hooks.committed!,
			transcript: [
				{ ...item, renderId: "entry-a:user:0" },
				{ ...newTool, renderId: "new-tool:assistant:0" },
			],
			transcriptPageLoaded: true,
			transcriptGeneration: page.transcriptGeneration,
			transcriptLeafId: newTool.entryId,
			transcriptRevision: 2,
			transcriptError: "历史记录已更新，请重新打开会话",
			previousCursor: "older-1",
			hasMorePrevious: true,
		};
		vi.spyOn(webApi, "transcript").mockResolvedValue({
			...page,
			items: [{ ...item, entryId: "older-user" }],
			leafId: item.entryId,
		});

		await renderWorkbench().actions.loadEarlier();

		expect(hooks.committed?.transcript.map((entry) => entry.entryId)).toEqual([
			"older-user",
			item.entryId,
			newTool.entryId,
		]);
		expect(hooks.committed?.transcriptError).toBeUndefined();
		expect(hooks.committed?.hasMorePrevious).toBe(false);
	});

	it("旧游标不属于当前窗口时仍拒绝合并", async () => {
		hooks.committed = {
			...hooks.committed!,
			transcript: [{ ...item, renderId: "entry-a:user:0" }],
			transcriptPageLoaded: true,
			transcriptGeneration: page.transcriptGeneration,
			transcriptLeafId: item.entryId,
			previousCursor: "older-1",
			hasMorePrevious: true,
		};
		vi.spyOn(webApi, "transcript").mockResolvedValue({
			...page,
			items: [{ ...item, entryId: "other-branch-user" }],
			leafId: "other-branch-leaf",
		});

		await renderWorkbench().actions.loadEarlier();

		expect(hooks.committed?.transcript.map((entry) => entry.entryId)).toEqual([item.entryId]);
		expect(hooks.committed?.transcriptError).toBe("历史记录已更新，请重新打开会话");
	});

	it("新工具刷新尾页时保留旧页请求和已加载消息", async () => {
		hooks.committed = {
			...hooks.committed!,
			transcript: [{ ...item, renderId: "entry-a:message:0" }],
			transcriptPageLoaded: true,
			transcriptGeneration: page.transcriptGeneration,
			transcriptLeafId: page.leafId,
			transcriptRevision: 1,
			previousCursor: "older-1",
			hasMorePrevious: true,
		};
		const newTool = {
			...item,
			entryId: "new-tool",
			parentId: item.entryId,
			view: { type: "tool_call" as const, calls: [{ id: "call-new", name: "read", summary: "读取" }] },
		};
		let resolveOlder!: (value: TranscriptResponse) => void;
		const requests = vi.spyOn(webApi, "transcript").mockImplementation((_sessionId, options) =>
			options?.cursor
				? new Promise((resolve) => {
						resolveOlder = resolve;
					})
				: Promise.resolve({
						...page,
						leafId: newTool.entryId,
						transcriptRevision: 2,
						items: [item, newTool],
						previousCursor: "tail-cursor",
						hasMorePrevious: true,
					}),
		);

		const actions = renderWorkbench().actions;
		const loading = actions.loadEarlier();
		await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
		await actions.loadTranscript(snapshot.id);
		expect(hooks.committed?.transcript.map((entry) => entry.entryId)).toEqual([item.entryId, newTool.entryId]);
		expect(hooks.committed?.previousCursor).toBe("older-1");
		resolveOlder({ ...page, items: [{ ...item, entryId: "older-tool", parentId: null }] });
		await loading;

		expect(hooks.committed?.transcript.map((entry) => entry.entryId)).toEqual([
			"older-tool",
			item.entryId,
			newTool.entryId,
		]);
		expect(hooks.committed?.transcriptRevision).toBe(2);
		expect(hooks.committed?.hasMorePrevious).toBe(false);
	});

	it("新工具的尾页不与旧页重叠时也不丢已加载历史", async () => {
		const oldTool = {
			...item,
			entryId: "old-tool",
			parentId: item.entryId,
			view: { type: "tool_call" as const, calls: [{ id: "call-old", name: "read", summary: "旧调用" }] },
		};
		const newTool = {
			...oldTool,
			entryId: "new-tool",
			parentId: oldTool.entryId,
			view: { type: "tool_call" as const, calls: [{ id: "call-new", name: "read", summary: "新调用" }] },
		};
		hooks.committed = {
			...hooks.committed!,
			session: { ...snapshot, leafId: "intermediate-leaf", transcriptGeneration: page.transcriptGeneration },
			transcript: [
				{ ...item, renderId: "entry-a:message:0" },
				{ ...oldTool, renderId: "old-tool:tool_call:0" },
			],
			transcriptPageLoaded: true,
			transcriptGeneration: page.transcriptGeneration,
			transcriptLeafId: oldTool.entryId,
			transcriptRevision: 1,
			previousCursor: "oldest-cursor",
			hasMorePrevious: true,
		};
		vi.spyOn(webApi, "transcript").mockResolvedValue({
			...page,
			items: [newTool],
			leafId: newTool.entryId,
			transcriptRevision: 2,
			previousCursor: "newer-cursor",
			hasMorePrevious: true,
		});

		await renderWorkbench().actions.loadTranscript(snapshot.id);

		expect(hooks.committed?.transcript.map((entry) => entry.entryId)).toEqual([
			item.entryId,
			oldTool.entryId,
			newTool.entryId,
		]);
		expect(hooks.committed?.previousCursor).toBe("oldest-cursor");
		expect(hooks.committed?.hasMorePrevious).toBe(true);
	});

	it("已确认分支切换后替换旧分支记录", async () => {
		const branch = { ...item, entryId: "branch-leaf", parentId: null };
		hooks.committed = {
			...hooks.committed!,
			transcript: [{ ...item, renderId: "entry-a:message:0" }],
			transcriptPageLoaded: true,
			transcriptGeneration: undefined,
			transcriptLeafId: branch.entryId,
			previousCursor: undefined,
			hasMorePrevious: false,
		};
		vi.spyOn(webApi, "transcript").mockResolvedValue({ ...page, items: [branch], leafId: branch.entryId });

		await renderWorkbench().actions.loadTranscript(snapshot.id);

		expect(hooks.committed?.transcript.map((entry) => entry.entryId)).toEqual([branch.entryId]);
		expect(hooks.committed?.transcriptGeneration).toBe(page.transcriptGeneration);
	});

	it("新建 B 后返回 A 时保留 A 的已加载记录", async () => {
		hooks.committed = {
			...hooks.committed!,
			session: snapshot,
			transcript: [{ ...item, renderId: "entry-a:message:0" }],
			transcriptPageLoaded: true,
			transcriptLoading: false,
			previousCursor: "older-a",
			hasMorePrevious: true,
			loadingEarlier: true,
		};
		const nextSnapshot = { ...snapshot, id: "session-b", name: "会话 B", leafId: null, transcriptRevision: 0 };
		vi.spyOn(webApi, "createSession").mockResolvedValue({ session: nextSnapshot, lease });
		vi.spyOn(webApi, "transcript").mockResolvedValue(page);
		vi.spyOn(webApi, "control").mockResolvedValue({ owned: true, lease, snapshot });

		await renderWorkbench().actions.createSession();
		expect(hooks.committed?.sessionId).toBe("session-b");
		const reopening = renderWorkbench().actions.selectSession(snapshot.id);
		expect(hooks.pendingTransitions[0]?.transcript.map((entry) => entry.entryId)).toEqual([item.entryId]);
		expect(hooks.pendingTransitions[0]?.transcriptPageLoaded).toBe(true);
		expect(hooks.pendingTransitions[0]?.previousCursor).toBe("older-a");
		expect(hooks.pendingTransitions[0]?.loadingEarlier).toBe(false);
		await reopening;
	});
});
