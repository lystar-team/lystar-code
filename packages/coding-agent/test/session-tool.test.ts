import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import type { SessionCoordinator, SessionCoordinatorCreateInput } from "../src/core/session-coordinator.ts";
import {
	createCollaborationTools,
	createRoomJoinTool,
	createSessionCreateTool,
	createSessionListTool,
} from "../src/core/session-tool.ts";

function context(workspace?: { projectCwd: string }): ExtensionToolContext {
	return {
		cwd: workspace ? "/project/worktree" : "/project",
		sessionManager: {
			getSessionId: () => "parent",
			getSessionFile: () => "/sessions/parent.jsonl",
			getHeader: () => (workspace ? { collaborationWorkspace: { projectCwd: workspace.projectCwd } } : {}),
		},
	} as unknown as ExtensionToolContext;
}

describe("协作会话工具", () => {
	it("room_join 传递当前角色，未选角色时支持显式 profileId", async () => {
		const join = vi.fn(async () => ({ room: { id: "room" } }));
		const tool = createRoomJoinTool(() => ({ room: { join } }) as unknown as SessionCoordinator);
		const ctx = {
			...context(),
			sessionManager: {
				getSessionId: () => "parent",
				getHeader: () => ({ profile: { id: "backend", name: "后端开发" } }),
			},
		} as unknown as ExtensionToolContext;
		await tool.execute("join", { roomId: "room", nickname: "星河" }, undefined, undefined, ctx);
		expect(join).toHaveBeenCalledWith({
			cwd: "/project",
			roomId: "room",
			sessionId: "parent",
			profileId: "backend",
			profileName: "后端开发",
			nickname: "星河",
		});
		await tool.execute("join-explicit", { roomId: "room", profileId: "reviewer" }, undefined, undefined, context());
		expect(join).toHaveBeenLastCalledWith(expect.objectContaining({ profileId: "reviewer" }));
	});
	it("将工作区内创建的下级会话归入父会话所在项目", async () => {
		const create = vi.fn(async (_input: SessionCoordinatorCreateInput) => ({
			session: { id: "child", parentId: "parent" },
			accepted: true,
		}));
		const list = vi.fn(async () => []);
		const coordinator = () => ({ create, list }) as unknown as SessionCoordinator;
		const createTool = createSessionCreateTool(coordinator);
		const listTool = createSessionListTool(coordinator);
		const ctx = context({ projectCwd: "/project" });

		const result = await createTool.execute("create", { task: "检查改动" }, undefined, undefined, ctx);
		expect(create).toHaveBeenCalledWith({
			cwd: "/project",
			parentSessionFile: "/sessions/parent.jsonl",
			parentSessionId: "parent",
			task: "检查改动",
			workspaceMode: undefined,
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"parentId":"parent"') });
		await listTool.execute("list", { parentSessionId: "parent" }, undefined, undefined, ctx);
		expect(list).toHaveBeenCalledWith({ cwd: "/project", parentSessionId: "parent" });
	});

	it("普通会话使用当前项目路径创建下级", async () => {
		const create = vi.fn(async (_input: SessionCoordinatorCreateInput) => ({
			session: { id: "child" },
			accepted: true,
		}));
		const tool = createSessionCreateTool(() => ({ create }) as unknown as SessionCoordinator);
		await tool.execute("create", {}, undefined, undefined, context());
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/project", parentSessionId: "parent" }));
	});

	it("每个协作动作注册为独立工具，不保留复合入口", () => {
		const names = createCollaborationTools(() => undefined).map((tool) => tool.name);
		expect(names).toEqual([
			"session_create",
			"session_send",
			"session_wait",
			"session_list",
			"session_profiles",
			"session_stop",
			"room_create",
			"room_join",
			"room_leave",
			"room_list",
			"room_send",
			"room_read",
			"room_task_list",
			"room_task_create",
			"room_task_update",
			"room_claim",
		]);
		expect(new Set(names).size).toBe(names.length);
		expect(names).not.toContain("sessions");
		expect(names).not.toContain("room_tasks");
	});
});
