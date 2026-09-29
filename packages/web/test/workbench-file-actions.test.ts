import { afterEach, describe, expect, it, vi } from "vitest";
import { webApi } from "../src/adapters/host-protocol/api.ts";
import { useWorkbenchFileActions, type WorkbenchFileActionsContext } from "../src/state/workbench-file-actions.ts";
import { initialState } from "../src/state/workbench-state.ts";
import type { WorkbenchState } from "../src/state/workbench-types.ts";

vi.mock("react", () => ({ useCallback: <T>(callback: T): T => callback }));

function createActions() {
	vi.stubGlobal("localStorage", { getItem: () => null });
	const stateRef = {
		current: {
			...initialState(),
			currentProjectId: "project-1",
			projects: [{ id: "project-1", path: "/work", name: "项目", sessions: [] }],
			fileTreeRootPath: "",
			fileTreeCache: {
				"": { path: "", home: "", entries: [{ name: "src", path: "src", hidden: false, kind: "directory" }] },
				src: { path: "src", parent: "", home: "", entries: [] },
			},
		} as WorkbenchState,
	};
	stateRef.current.fileTree = stateRef.current.fileTreeCache[""];
	const updateState: WorkbenchFileActionsContext["updateState"] = (value) => {
		stateRef.current = typeof value === "function" ? value(stateRef.current) : value;
		return stateRef.current;
	};
	const actions = useWorkbenchFileActions({
		stateRef,
		updateState,
		showToast: vi.fn(),
		fileRequestRef: { current: 0 },
		fileMetadataPromisesRef: { current: new Map() },
		projectTreeRefreshPromisesRef: { current: new Map() },
		projectTreeGenerationRef: { current: 0 },
		loadProjectTreeRef: { current: vi.fn(async () => {}) },
		loadSessionTreeRef: { current: vi.fn(async () => {}) },
		loadGitStatus: vi.fn(async () => {}),
		loadGitStatusRef: { current: vi.fn(async () => {}) },
		loadGitBranchesRef: { current: vi.fn(async () => {}) },
		loadGitHistoryRef: { current: vi.fn(async () => {}) },
	});
	return { stateRef, actions };
}

describe("项目文件树刷新", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("刷新全部已加载目录，包括展开的子目录", async () => {
		const { actions, stateRef } = createActions();
		const projectTree = vi.spyOn(webApi, "projectTree").mockImplementation(async (_projectId, path = "") => ({
			path,
			home: "",
			entries: [{ name: "new.txt", path: path ? `${path}/new.txt` : "new.txt", hidden: false, kind: "file" }],
		}));
		await actions.refreshProjectFiles([""]);
		expect(projectTree.mock.calls.map(([, path]) => path).sort()).toEqual(["", "src"]);
		expect(stateRef.current.fileTree?.entries[0]?.name).toBe("new.txt");
		expect(stateRef.current.fileTreeCache.src?.entries[0]?.name).toBe("new.txt");
	});

	it("目录本身收到变更时刷新其已加载的内容", async () => {
		const { actions } = createActions();
		const projectTree = vi.spyOn(webApi, "projectTree").mockResolvedValue({ path: "", home: "", entries: [] });
		await actions.refreshProjectFiles(["src"]);
		expect(projectTree.mock.calls.map(([, path]) => path).sort()).toEqual(["", "src"]);
	});

	it("刷新失败不会被静默处理，允许刷新按钮反馈错误", async () => {
		const { actions } = createActions();
		vi.spyOn(webApi, "projectTree").mockRejectedValue(new Error("读取失败"));
		await expect(actions.refreshProjectFiles([""])).rejects.toThrow("读取失败");
	});
});
