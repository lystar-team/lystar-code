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

	it("新建 B 后返回 A 时保留 A 的已加载记录", async () => {
		hooks.committed = {
			...hooks.committed!,
			session: snapshot,
			transcript: [{ ...item, renderId: "entry-a:message:0" }],
			transcriptPageLoaded: true,
			transcriptLoading: false,
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
		await reopening;
	});
});
