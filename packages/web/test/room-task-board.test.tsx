import { renderToStaticMarkup } from "react-dom/server";
import { collaborationAlias } from "@lystar/code-web-protocol";
import { describe, expect, it } from "vitest";
import { RoomTaskBoard } from "../src/components/workbench/room-task-board.tsx";
import type { RoomWorkspaceController } from "../src/state/use-room-workspace.ts";

describe("Room 任务看板", () => {
	it("按任务状态分列并显示负责人", () => {
		const controller = {
			selectedRoom: { members: [
				{ roomId: "room-a", sessionId: "worker-a", role: "member", nickname: "霜叶", joinedAt: "2026-09-26T00:00:00.000Z", lastReadSeq: 0 },
				{ roomId: "room-a", sessionId: "worker-b", role: "member", joinedAt: "2026-09-26T00:00:00.000Z", lastReadSeq: 0 },
			] },
			roomTasks: [
				{ id: "task-a", roomId: "room-a", title: "核对项目文件", description: "", status: "todo", createdBySessionId: "owner", updates: [], createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z" },
				{ id: "task-b", roomId: "room-a", title: "检查接口响应", description: "", status: "doing", createdBySessionId: "owner", assigneeSessionId: "worker-a", updates: [], createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z" },
				{ id: "task-c", roomId: "room-a", title: "验证旧成员", description: "", status: "done", createdBySessionId: "owner", assigneeSessionId: "worker-b", updates: [], createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z" },
			],
			roomTasksLoading: false,
		} as unknown as RoomWorkspaceController;
		const html = renderToStaticMarkup(<RoomTaskBoard controller={controller} />);
		expect(html).toContain("任务看板");
		expect(html).toContain("核对项目文件");
		expect(html).toContain("检查接口响应");
		expect(html).toContain("霜叶");
		expect(html).toContain(collaborationAlias("worker-b"));
		expect(html).not.toContain("协作智能体");
		for (const name of ["待认领", "进行中", "阻塞", "已完成"]) expect(html).toContain(name);
	});
});
