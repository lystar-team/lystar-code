import { describe, expect, it, vi } from "vitest";
import { webApi } from "../src/adapters/host-protocol/api.ts";
import {
	mergeSessionSummaries,
	projectInspectorStateForSelection,
	updateSessionSummaryFirstMessage,
} from "../src/state/use-workbench.ts";
import { acknowledgeSessionRead, initialState, updateSessionActivity } from "../src/state/workbench-state.ts";
import type { WebProject, WebSessionSummary } from "../src/types.ts";

function session(overrides: Partial<WebSessionSummary> = {}): WebSessionSummary {
	return {
		id: "session-1",
		createdAt: 1,
		updatedAt: 1,
		messageCount: 0,
		firstMessage: "未命名会话",
		activity: "idle",
		writeAccess: "available",
		...overrides,
	};
}

function project(current: WebSessionSummary): WebProject {
	return {
		id: "project-1",
		name: "项目",
		path: "/tmp/project",
		sessions: [current],
	};
}

describe("session summary lifecycle", () => {
	it("shows the first accepted prompt before the generated title arrives", () => {
		const next = updateSessionSummaryFirstMessage([project(session())], "session-1", "  首条 Prompt  ");

		expect(next[0]?.sessions[0]).toMatchObject({ firstMessage: "首条 Prompt", messageCount: 1 });
	});

	it("does not let an empty refresh overwrite the optimistic first message or title", () => {
		const current = session({ firstMessage: "首条 Prompt", messageCount: 1, name: "自动标题" });
		const incoming = session({ firstMessage: "未命名会话" });

		expect(mergeSessionSummaries([current], [incoming])[0]).toMatchObject({
			firstMessage: "首条 Prompt",
			name: "自动标题",
		});
	});

	it("打开执行完毕的会话不会被 idle 快照移出已完成列表，新一轮执行仍更新状态", () => {
		const completed = [project(session({ activity: "completed" }))];
		expect(updateSessionActivity(completed, "session-1", "idle")).toBe(completed);
		const running = updateSessionActivity(completed, "session-1", "running");
		expect(running[0]?.sessions[0]?.activity).toBe("running");
		expect(updateSessionActivity(running, "session-1", "failed")[0]?.sessions[0]?.activity).toBe("failed");
		expect(updateSessionActivity([project(session())], "session-1", "idle")[0]?.sessions[0]?.activity).toBe("idle");
	});

	it("跨窗口已读只清除同一次执行的蓝点，不清除更新的执行结果", () => {
		vi.spyOn(webApi, "hasToken").mockReturnValue(false);
		const current = {
			...initialState(),
			projects: [project(session({ activity: "completed", operationUpdatedAt: 30 }))],
			unreadSessionIds: { "session-1": true as const },
		};
		expect(acknowledgeSessionRead(current, "session-1", 29)).toBe(current);
		expect(acknowledgeSessionRead(current, "session-1", 30).unreadSessionIds).toEqual({});
	});

	it("跨项目切换时清空旧项目的审阅状态", () => {
		expect(projectInspectorStateForSelection("project-1", "project-2")).toEqual({
			fileTree: undefined,
			fileTreeRootPath: undefined,
			fileTreeCache: {},
			fileTreeLoading: false,
			gitStatus: undefined,
			gitBranches: undefined,
			gitHistory: undefined,
			gitCommit: undefined,
			gitFileStats: {},
			gitDiff: undefined,
			gitLoading: false,
			gitBranchesLoading: false,
			gitHistoryLoading: false,
			gitCommitLoading: false,
			gitDiffLoading: false,
			gitOperation: undefined,
			fileContent: undefined,
			fileError: undefined,
			fileLoading: false,
		});
		expect(projectInspectorStateForSelection("project-1", "project-1")).toEqual({});
	});
});
