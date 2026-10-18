import { afterEach, expect, test, vi } from "vitest";
import { webApi } from "../src/adapters/host-protocol/api.ts";
import { useWorkbenchGitActions, type WorkbenchGitActionsContext } from "../src/state/workbench-git-actions.ts";
import { initialState } from "../src/state/workbench-state.ts";
import type { WorkbenchState } from "../src/state/workbench-types.ts";

vi.mock("react", () => ({ useCallback: <T>(callback: T): T => callback }));

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function createActions() {
	vi.stubGlobal("localStorage", { getItem: () => null });
	const stateRef = { current: {
		...initialState(),
		currentProjectId: "project-1",
		gitStatus: { root: "/work", branch: "main", ahead: 0, behind: 0, files: [] },
		gitDiff: { path: "app.ts", repositoryPath: "nested", staged: true, diff: "old", additions: 1, deletions: 0 },
	} as WorkbenchState };
	const actions = useWorkbenchGitActions({
		stateRef,
		updateState: (value) => {
			stateRef.current = typeof value === "function" ? value(stateRef.current) : value;
			return stateRef.current;
		},
		showToast: vi.fn(),
		gitStatusRequestRef: { current: 0 },
		gitBranchesRequestRef: { current: 0 },
		gitHistoryRequestRef: { current: 0 },
		gitCommitRequestRef: { current: 0 },
		gitDiffRequestRef: { current: 0 },
		gitStatusPromiseRef: { current: undefined },
		gitStatsRepositoryRef: { current: new Set() },
		loadGitStatusRef: { current: vi.fn(async () => {}) },
	} satisfies WorkbenchGitActionsContext);
	vi.spyOn(webApi, "gitStatus").mockResolvedValue(stateRef.current.gitStatus!);
	return { actions, stateRef };
}

test("Git 元数据失效后，即使状态摘要没变也刷新已打开的工作区 Diff", async () => {
	const { actions, stateRef } = createActions();
	const previous = stateRef.current.gitDiff!;
	const diff = vi.spyOn(webApi, "gitDiff").mockResolvedValue({ ...previous, diff: "updated" });
	await actions.loadGitStatus(true);
	expect(diff).toHaveBeenCalledWith("project-1", "app.ts", true, "nested");
	expect(stateRef.current.gitDiff?.diff).toBe("updated");
	expect(stateRef.current.gitDiffLoading).toBe(false);
});

test("Git 状态刷新保留按提交版本打开的 Diff", async () => {
	const { actions, stateRef } = createActions();
	stateRef.current.gitDiff = { ...stateRef.current.gitDiff!, revision: "a".repeat(40) };
	const previous = stateRef.current.gitDiff;
	const diff = vi.spyOn(webApi, "gitDiff");
	await actions.loadGitStatus(true);
	expect(diff).not.toHaveBeenCalled();
	expect(stateRef.current.gitDiff).toBe(previous);
});

test("自动刷新进行中关闭 Diff，旧结果不会重新打开预览", async () => {
	const { actions, stateRef } = createActions();
	let finish!: (result: NonNullable<WorkbenchState["gitDiff"]>) => void;
	const result = { ...stateRef.current.gitDiff!, diff: "stale" };
	const diff = vi.spyOn(webApi, "gitDiff").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
	const refreshing = actions.loadGitStatus(true);
	await vi.waitFor(() => expect(diff).toHaveBeenCalledOnce());
	actions.closeGitDiff();
	finish(result);
	await refreshing;
	expect(stateRef.current.gitDiff).toBeUndefined();
});
