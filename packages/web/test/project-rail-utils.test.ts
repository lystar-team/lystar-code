import { describe, expect, it } from "vitest";
import {
	countSessionsByTab,
	excludeRoomAgentSessions,
	hasUnreadProjectSessions,
	hasUnreadSessions,
	isResumedCompletedSession,
	isSessionUnread,
	orderedSessions,
	reorderIds,
	searchProjectSessions,
	sessionMatchesTab,
} from "../src/components/workbench/project-rail-utils.ts";
import type { WebProject } from "../src/types.ts";

describe("项目和会话列表", () => {
	it("从项目会话列表中排除 Room Agent 会话", () => {
		const sessions = [
			{
				id: "owner",
				createdAt: 1,
				updatedAt: 1,
				messageCount: 0,
				firstMessage: "用户会话",
				activity: "idle" as const,
				writeAccess: "available" as const,
			},
			{
				id: "room-agent",
				createdAt: 1,
				updatedAt: 1,
				messageCount: 0,
				firstMessage: "Room 会话",
				activity: "idle" as const,
				writeAccess: "available" as const,
			},
		];

		expect(excludeRoomAgentSessions(sessions, new Set(["room-agent"])).map((session) => session.id)).toEqual([
			"owner",
		]);
		expect(
			excludeRoomAgentSessions([{ ...sessions[1]!, roomMember: true }], new Set()).map((session) => session.id),
		).toEqual([]);
	});

	it("按父子关系排列多层子会话，保留无父会话的条目", () => {
		const sessions = [
			{ id: "grandchild", parentId: "child", relation: "collaboration" as const },
			{ id: "other" },
			{ id: "child", parentId: "root", relation: "collaboration" as const },
			{ id: "orphan", parentId: "missing", relation: "collaboration" as const },
			{ id: "root" },
		].map((item) => ({
			createdAt: 1,
			updatedAt: 1,
			messageCount: 0,
			firstMessage: "任务",
			activity: "idle" as const,
			writeAccess: "available" as const,
			...item,
		}));
		expect(
			orderedSessions({ id: "project", name: "项目", path: "/project", sessions }).map((item) => item.id),
		).toEqual(["other", "orphan", "root", "child", "grandchild"]);
	});

	it("按会话状态聚合项目和项目组的未读提示", () => {
		const unreadSessionIds = { "session-1": true } as const;
		const unreadProject = [{ id: "session-1", activity: "idle" as const }];
		const runningProject = [{ id: "session-1", activity: "running" as const }];

		expect(hasUnreadSessions(unreadProject, unreadSessionIds)).toBe(true);
		expect(hasUnreadSessions(runningProject, unreadSessionIds)).toBe(false);
		expect(isSessionUnread(unreadProject[0]!, unreadSessionIds)).toBe(true);
		expect(isSessionUnread(runningProject[0]!, unreadSessionIds)).toBe(false);
		expect(hasUnreadProjectSessions([{ sessions: unreadProject }], unreadSessionIds)).toBe(true);
		expect(
			hasUnreadProjectSessions([{ sessions: [{ id: "session-2", activity: "idle" as const }] }], unreadSessionIds),
		).toBe(false);
	});

	it("未读记录尚未就绪时不会让项目栏崩溃", () => {
		const missing = undefined as unknown as Readonly<Record<string, true>>;
		const session = { id: "session-1", activity: "completed" as const };
		expect(isSessionUnread(session, missing)).toBe(false);
		expect(sessionMatchesTab(session, "completed", missing)).toBe(false);
		expect(countSessionsByTab(new Map([["project", [session]]]), missing)).toEqual({
			all: 1,
			running: 0,
			completed: 0,
		});
	});

	it("已完成只显示带蓝点且不在运行的会话", () => {
		const activities = [
			"idle",
			"running",
			"waiting_for_input",
			"completed",
			"failed",
			"aborted",
			"interrupted",
		] as const;
		const unreadSessionIds = { idle: true, running: true, completed: true, failed: true } as const;
		const matches = (tab: "all" | "running" | "completed", unread = unreadSessionIds) =>
			activities.filter((activity) => sessionMatchesTab({ id: activity, activity }, tab, unread));
		expect(matches("all")).toEqual(activities);
		expect(matches("running")).toEqual(["running", "waiting_for_input"]);
		expect(matches("completed")).toEqual(["idle", "completed", "failed"]);
		expect(matches("completed", {})).toEqual([]);
	});

	it("搜索项目名时保留该项目会话，搜索会话时只显示标题匹配的会话", () => {
		const base = { createdAt: 1, updatedAt: 1, messageCount: 1, writeAccess: "available" as const };
		const project: WebProject = {
			id: "project-1",
			name: "控制台",
			path: "/project",
			sessions: [
				{
					...base,
					id: "completed",
					name: "优化导航",
					firstMessage: "原始消息",
					activity: "completed",
					pinned: true,
				},
				{ ...base, id: "running", firstMessage: "修复同步", activity: "running" },
				{ ...base, id: "named", name: "自定义标题", firstMessage: "修复同步", activity: "completed" },
				{ ...base, id: "room", name: "修复同步", firstMessage: "", activity: "running", roomMember: true },
			],
		};
		const unreadSessionIds = { completed: true } as const;
		const ids = (tab: "all" | "running" | "completed", query: string, unread = unreadSessionIds) =>
			searchProjectSessions(project, tab, query, new Set(), unread).map((session) => session.id);

		expect(ids("all", "控制台")).toEqual(["completed", "running", "named"]);
		expect(ids("completed", "控制台")).toEqual(["completed"]);
		expect(ids("completed", "控制台", {})).toEqual([]);
		expect(ids("all", "导航")).toEqual(["completed"]);
		expect(ids("all", "修复")).toEqual(["running"]);
		expect(ids("running", "修复")).toEqual(["running"]);
		expect(ids("completed", "修复")).toEqual([]);
		expect(ids("all", "")).toEqual(["completed", "running", "named"]);
		const counts = (query: string, unread = unreadSessionIds) =>
			countSessionsByTab(
				new Map([[project.id, searchProjectSessions(project, "all", query, new Set(), unread)]]),
				unread,
			);
		expect(counts("控制台")).toEqual({ all: 3, running: 1, completed: 1 });
		expect(counts("控制台", {})).toEqual({ all: 3, running: 1, completed: 0 });
		expect(counts("修复")).toEqual({ all: 1, running: 1, completed: 0 });
		expect(counts("没有匹配")).toEqual({ all: 0, running: 0, completed: 0 });
	});

	it("Badge 按蓝点统计待查看结果，已查看的历史结果不计入", () => {
		const sessions = [
			{ id: "waiting", activity: "waiting_for_input" as const },
			{ id: "completed-read", activity: "completed" as const },
			{ id: "completed-unread", activity: "completed" as const },
			{ id: "failed-unread", activity: "failed" as const },
			{ id: "idle-unread", activity: "idle" as const },
			{ id: "aborted-read", activity: "aborted" as const },
		];
		const unreadSessionIds = {
			waiting: true,
			"completed-unread": true,
			"failed-unread": true,
			"idle-unread": true,
			other: true,
		} as const;
		expect(countSessionsByTab(new Map([["project", sessions]]), unreadSessionIds)).toEqual({
			all: 6,
			running: 1,
			completed: 3,
		});
		const totals = countSessionsByTab(
			new Map([
				["project", sessions],
				["other", [{ id: "other", activity: "completed" as const }]],
			]),
			unreadSessionIds,
		);
		expect(totals).toEqual({ all: 7, running: 1, completed: 4 });
	});

	it("当前已完成会话恢复运行时切换，手动浏览其它会话不触发", () => {
		const selected = { id: "session-1", activity: "completed" as const };
		expect(isResumedCompletedSession(selected, { id: "session-1", activity: "running" })).toBe(true);
		expect(isResumedCompletedSession(selected, { id: "session-1", activity: "waiting_for_input" })).toBe(true);
		expect(isResumedCompletedSession(selected, { id: "session-1", activity: "idle" })).toBe(false);
		expect(isResumedCompletedSession(selected, { id: "session-2", activity: "running" })).toBe(false);
		expect(
			isResumedCompletedSession({ id: "session-1", activity: "running" }, { id: "session-1", activity: "running" }),
		).toBe(false);
	});

	it("拖到目标上方插入", () => {
		expect(reorderIds(["a", "b", "c"], "c", "b", "before")).toEqual(["a", "c", "b"]);
	});

	it("拖到目标下方插入", () => {
		expect(reorderIds(["a", "b", "c"], "a", "b", "after")).toEqual(["b", "a", "c"]);
	});

	it("源和目标无效时保留原顺序", () => {
		expect(reorderIds(["a", "b"], "a", "missing", "after")).toEqual(["a", "b"]);
		expect(reorderIds(["a", "b"], "a", "a", "before")).toEqual(["a", "b"]);
	});
});
