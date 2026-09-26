import { afterEach, describe, expect, it, vi } from "vitest";
import { WebApi } from "../src/adapters/host-protocol/api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Room 看板 API", () => {
	it("按当前 Room 与会话读取、创建和更新任务", async () => {
		vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
		const calls: Array<{ path: string; method: string; body?: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				calls.push({ path: String(input), method: init?.method ?? "GET", body: init?.body?.toString() });
				return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
			}),
		);
		const api = new WebApi();
		await api.roomTasks("project-a", "room-a", "owner");
		await api.createRoomTask("project-a", "room-a", "owner", "检查接口", "核对响应字段");
		await api.updateRoomTask("project-a", "room-a", "task-a", "owner", "blocked", "等接口确认");
		await api.editRoomTask("project-a", "room-a", "task-a", "owner", {
			title: "新标题",
			assigneeSessionId: "worker",
		});
		await api.commentRoomTask("project-a", "room-a", "task-a", "owner", "@worker 请检查");
		expect(calls).toEqual([
			{ path: "/api/projects/project-a/rooms/room-a/tasks?sessionId=owner", method: "GET" },
			{
				path: "/api/projects/project-a/rooms/room-a/tasks",
				method: "POST",
				body: JSON.stringify({ sessionId: "owner", title: "检查接口", description: "核对响应字段" }),
			},
			{
				path: "/api/projects/project-a/rooms/room-a/tasks/task-a",
				method: "PATCH",
				body: JSON.stringify({ sessionId: "owner", status: "blocked", note: "等接口确认" }),
			},
			{
				path: "/api/projects/project-a/rooms/room-a/tasks/task-a",
				method: "PATCH",
				body: JSON.stringify({ sessionId: "owner", title: "新标题", assigneeSessionId: "worker" }),
			},
			{
				path: "/api/projects/project-a/rooms/room-a/tasks/task-a/comments",
				method: "POST",
				body: JSON.stringify({ sessionId: "owner", body: "@worker 请检查" }),
			},
		]);
	});
});
