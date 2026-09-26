import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RoomWorkspace } from "../src/components/workbench/room-workspace.tsx";
import type { WorkbenchActions } from "../src/components/workbench/types.ts";
import type { RoomWorkspaceController } from "../src/state/use-room-workspace.ts";
import type { WorkbenchState } from "../src/state/use-workbench.ts";

const controller = {
	selectedRoomProjectId: "project-a",
	selectedRoom: {
		room: { id: "room-a", cwd: "/project", title: "协作室", ownerSessionId: "owner", mode: "group", createdAt: "", updatedAt: "" },
		members: [{ roomId: "room-a", sessionId: "owner", role: "owner", joinedAt: "", lastReadSeq: 0 }],
		latestSeq: 0,
	},
	selectedRoomMessages: [],
	pendingAgentReplies: [],
	agentProfiles: [],
	agentProfilesLoading: false,
	roomTasks: [],
	roomTasksLoading: false,
} as unknown as RoomWorkspaceController;

function markup(section: "chat" | "board", roomController = controller): string {
	return renderToStaticMarkup(
		<RoomWorkspace
			state={{ projects: [] } as WorkbenchState}
			controller={roomController}
			onModeChange={() => {}}
			openResource={(() => {}) as WorkbenchActions["openResource"]}
			section={section}
			onSectionChange={() => {}}
		/>,
	);
}

describe("Room 视图切换", () => {
	it("在 Room 头部居中使用会话列表的标签样式", () => {
		const html = markup("chat");
		expect(html).toContain('aria-label="Room 视图"');
		expect(html).toContain("grid-cols-[minmax(0,1fr)_auto]");
		expect(html).toContain("@min-[48rem]/room-workspace:grid-cols-[minmax(0,1fr)_minmax(13rem,18rem)_minmax(0,1fr)]");
		expect(html).toContain("col-span-2 row-start-2 w-full max-w-72 justify-self-center");
		expect(html).toContain('aria-label="添加智能体"');
		expect(html).toContain("添加智能体");
		expect(html).not.toContain("邀请 Agent");
		expect(html.match(/data-slot="tabs-trigger"/g)).toHaveLength(2);
		expect(html).toContain('aria-label="对话"');
		expect(html).toContain('aria-label="看板"');
		expect(html).toContain('data-slot="tabs-content"');
		expect(html).toContain("还没有消息，发送第一条协作消息。");
	});

	it("相同配置的成员分别有移除入口，主智能体没有", () => {
		const owner = controller.selectedRoom!.members[0]!;
		const html = markup("chat", {
			...controller,
			selectedRoom: {
				...controller.selectedRoom!,
				members: [
					owner,
					{ ...owner, sessionId: "worker-1", role: "member", nickname: "星河", profileId: "worker", profileName: "worker" },
					{ ...owner, sessionId: "worker-2", role: "member", nickname: "云杉", profileId: "worker", profileName: "worker" },
				],
			},
		});
		expect(html).toContain('aria-label="管理智能体 星河（worker）"');
		expect(html).toContain('aria-label="管理智能体 云杉（worker）"');
		expect(html).not.toContain('aria-label="管理智能体 你');
		expect(html.match(/data-slot="dropdown-menu-trigger"/g)).toHaveLength(2);
	});

	it("切换到看板时展示任务列", () => {
		const html = markup("board");
		expect(html).toContain("任务看板");
		expect(html).toContain('aria-label="待认领"');
		expect(html).toContain('aria-label="进行中"');
		expect(html).toContain('aria-label="阻塞"');
		expect(html).toContain('aria-label="已完成"');
		expect(html).not.toContain("还没有消息，发送第一条协作消息。");
	});
});
