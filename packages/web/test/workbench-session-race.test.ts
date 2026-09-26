import { beforeEach, describe, expect, it, vi } from "vitest";
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
}));

vi.mock("react", () => ({
	useState: <T>(initial: T | (() => T)): [T, (value: T) => void] => {
		hooks.committed ??=
			typeof initial === "function" ? (initial as () => WorkbenchState)() : (initial as WorkbenchState);
		return [
			hooks.committed as T,
			(value) => {
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
	useEffect: () => {},
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

describe("会话切换时的记录状态", () => {
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

	it("向上阅读时把同一回合的旧页合并后提交", async () => {
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

		const loading = renderWorkbench().actions.loadEarlier();
		await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
		expect(hooks.committed?.transcript.map((entry) => entry.entryId)).toEqual([item.entryId]);
		expect(hooks.committed?.loadingEarlier).toBe(true);
		resolveOlder({ ...page, items: [earlierUser], hasMorePrevious: false });
		await loading;

		expect(request.mock.calls.map(([, options]) => options?.cursor)).toEqual(["older-1", "older-2"]);
		expect(hooks.committed?.transcript.map((entry) => entry.entryId)).toEqual(["older-user", "tool-a", item.entryId]);
		expect(hooks.committed?.hasMorePrevious).toBe(false);
		expect(hooks.committed?.loadingEarlier).toBe(false);
	});

	it("后台补全超过十六页的历史，最后一次提交到会话窗口", async () => {
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
				items: [{ ...item, entryId: `older-${index}`, parentId: index === 19 ? null : `older-${index + 1}` }],
				previousCursor: index === 19 ? undefined : `cursor-${index + 1}`,
				hasMorePrevious: index < 19,
			};
		});

		await renderWorkbench().actions.loadEarlier();

		expect(requests).toHaveBeenCalledTimes(20);
		expect(hooks.committed?.transcript).toHaveLength(21);
		expect(hooks.committed?.transcript.at(0)?.entryId).toBe("older-19");
		expect(hooks.committed?.transcript.at(-1)?.entryId).toBe(item.entryId);
		expect(hooks.committed?.hasMorePrevious).toBe(false);
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
