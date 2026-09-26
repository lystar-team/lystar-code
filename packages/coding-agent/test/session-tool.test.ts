import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { SessionCoordinator, SessionCoordinatorCreateInput } from "../src/core/session-coordinator.ts";
import { createSessionsTool } from "../src/core/session-tool.ts";

function context(workspace?: { projectCwd: string }): ExtensionContext {
	return {
		cwd: workspace ? "/project/worktree" : "/project",
		sessionManager: {
			getSessionId: () => "parent",
			getSessionFile: () => "/sessions/parent.jsonl",
			getHeader: () => (workspace ? { collaborationWorkspace: { projectCwd: workspace.projectCwd } } : {}),
		},
	} as unknown as ExtensionContext;
}

describe("sessions Tool", () => {
	it("将工作区内创建的下级会话归入父会话所在项目", async () => {
		const create = vi.fn(async (_input: SessionCoordinatorCreateInput) => ({
			session: { id: "child", parentId: "parent" },
			accepted: true,
		}));
		const list = vi.fn(async () => []);
		const tool = createSessionsTool(() => ({ create, list }) as unknown as SessionCoordinator);
		const ctx = context({ projectCwd: "/project" });

		const result = await tool.execute("create", { action: "create", task: "检查改动" }, undefined, undefined, ctx);
		expect(create).toHaveBeenCalledWith({
			cwd: "/project",
			parentSessionFile: "/sessions/parent.jsonl",
			parentSessionId: "parent",
			task: "检查改动",
			workspaceMode: undefined,
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"parentId":"parent"') });
		await tool.execute("list", { action: "list", parentSessionId: "parent" }, undefined, undefined, ctx);
		expect(list).toHaveBeenCalledWith({ cwd: "/project", parentSessionId: "parent" });
	});

	it("普通会话使用当前项目路径创建下级", async () => {
		const create = vi.fn(async (_input: SessionCoordinatorCreateInput) => ({
			session: { id: "child" },
			accepted: true,
		}));
		const tool = createSessionsTool(() => ({ create }) as unknown as SessionCoordinator);
		await tool.execute("create", { action: "create" }, undefined, undefined, context());
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/project", parentSessionId: "parent" }));
	});
});
