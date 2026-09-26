import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createRoomClaimTool } from "../src/core/room-claim-tool.ts";
import type { SessionCoordinator } from "../src/core/session-coordinator.ts";
import { createRoomTasksTool } from "../src/core/session-tool.ts";

const context = {
	cwd: "/project",
	sessionManager: {
		getSessionId: () => "agent-a",
		getHeader: () => ({}),
	},
} as unknown as ExtensionContext;

describe("Room 任务工具", () => {
	it("候选 Agent 通过专用工具认领，身份由当前会话提供", async () => {
		const taskClaim = vi.fn(async () => ({ id: "task-a", status: "doing" }));
		const tool = createRoomClaimTool(() => ({ room: { taskClaim } }) as unknown as SessionCoordinator);
		const result = await tool.execute("claim", { roomId: "room-a", taskId: "task-a" }, undefined, undefined, context);
		expect(taskClaim).toHaveBeenCalledWith({
			cwd: "/project",
			roomId: "room-a",
			taskId: "task-a",
			sessionId: "agent-a",
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"status":"doing"') });
	});

	it("任务更新不接受调用方指定负责人身份", async () => {
		const taskUpdate = vi.fn(async () => ({ id: "task-a", status: "done" }));
		const tool = createRoomTasksTool(() => ({ room: { taskUpdate } }) as unknown as SessionCoordinator);
		await tool.execute(
			"update",
			{ action: "update", roomId: "room-a", taskId: "task-a", status: "done", note: "核对完成" },
			undefined,
			undefined,
			context,
		);
		expect(taskUpdate).toHaveBeenCalledWith({
			cwd: "/project",
			roomId: "room-a",
			taskId: "task-a",
			sessionId: "agent-a",
			status: "done",
			note: "核对完成",
		});
	});
});
