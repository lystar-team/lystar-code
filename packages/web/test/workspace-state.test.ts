import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../src/state/workbench-state.ts";
import { applyWorkspaceSnapshot } from "../src/state/workspace-state.ts";
import { sessionUnreadIndex } from "../src/state/session-result-state.ts";
import type { WebProject } from "../src/types.ts";

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null }));
afterEach(() => vi.unstubAllGlobals());
const project: WebProject = {
	id: "p", name: "项目", path: "/project", sessionsLoaded: true,
	sessions: [{ id: "s", name: "会话", createdAt: 1, updatedAt: 2, messageCount: 1, firstMessage: "任务", activity: "completed", writeAccess: "available", result: { sessionId: "s", revision: 2, readRevision: 1, updatedAt: 2, activity: "completed", version: 3 } }],
};

describe("共享工作区快照", () => {
	it("相同版本让独立客户端得到相同数据，并保留各自选择和主题", () => {
		const snapshot = { workspaceRevision: 8, projects: [project], projectGroups: [{ id: "g", name: "组", projectIds: ["p"] }] };
		const desktop = applyWorkspaceSnapshot({ ...initialState(), currentProjectId: "p", sessionId: "s", theme: "dark" }, snapshot);
		const phone = applyWorkspaceSnapshot({ ...initialState(), theme: "light" }, snapshot);
		expect(desktop.projects).toEqual(phone.projects);
		expect(desktop.projectGroups).toEqual(phone.projectGroups);
		expect(desktop.sessionId).toBe("s");
		expect(phone.sessionId).toBeUndefined();
		expect(desktop.theme).toBe("dark");
		expect(phone.theme).toBe("light");
	});

	it("晚到的旧快照不会恢复已经移除的项目或撤销分组更新", () => {
		const current = applyWorkspaceSnapshot(initialState(), { workspaceRevision: 10, projects: [], projectGroups: [] });
		expect(applyWorkspaceSnapshot(current, { workspaceRevision: 9, projects: [project], projectGroups: [{ id: "old", name: "旧组", projectIds: ["p"] }] })).toBe(current);
	});

	it("跳过离线期间的中间版本后，已读和新结果都以最新快照恢复", () => {
		const before = applyWorkspaceSnapshot(initialState(), { workspaceRevision: 2, projects: [project], projectGroups: [] });
		const viewed: WebProject = { ...project, sessions: project.sessions.map((session) => ({ ...session, result: { ...session.result!, readRevision: 2, version: 4 } })) };
		const after = applyWorkspaceSnapshot(before, { workspaceRevision: 20, projects: [viewed], projectGroups: [] });
		expect(sessionUnreadIndex(after.projects, { s: true })).toEqual({});
		const fresh: WebProject = { ...viewed, sessions: viewed.sessions.map((session) => ({ ...session, result: { ...session.result!, revision: 3, version: 5 } })) };
		const latest = applyWorkspaceSnapshot(after, { workspaceRevision: 21, projects: [fresh], projectGroups: [] });
		expect(sessionUnreadIndex(latest.projects, {})).toEqual({ s: true });
	});
});
