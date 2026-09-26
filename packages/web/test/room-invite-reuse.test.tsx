import type { PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RoomWorkspace } from "../src/components/workbench/room-workspace.tsx";
import type { WorkbenchActions } from "../src/components/workbench/types.ts";
import type { RoomWorkspaceController } from "../src/state/use-room-workspace.ts";
import type { WorkbenchState } from "../src/state/use-workbench.ts";

vi.mock("../src/components/ui/dialog.tsx", () => {
	const Container = ({ children }: PropsWithChildren) => <div>{children}</div>;
	return {
		Dialog: Container,
		DialogContent: Container,
		DialogDescription: Container,
		DialogFooter: Container,
		DialogHeader: Container,
		DialogTitle: Container,
	};
});

vi.mock("../src/components/ui/dropdown-menu.tsx", () => {
	const Container = ({ children }: PropsWithChildren) => <div>{children}</div>;
	return {
		DropdownMenu: Container,
		DropdownMenuContent: Container,
		DropdownMenuItem: Container,
		DropdownMenuLabel: Container,
		DropdownMenuTrigger: Container,
	};
});

describe("Room 添加智能体", () => {
	it("已有同配置成员时仍可选择该配置", () => {
		const controller = {
			selectedRoomProjectId: "project-a",
			selectedRoom: {
				room: { id: "room-a", cwd: "/project", title: "协作室", ownerSessionId: "owner", mode: "group", createdAt: "", updatedAt: "" },
				members: [
					{ roomId: "room-a", sessionId: "owner", role: "owner", joinedAt: "", lastReadSeq: 0 },
					{ roomId: "room-a", sessionId: "member-a", role: "member", profileId: "worker", joinedAt: "", lastReadSeq: 0 },
				],
				latestSeq: 0,
			},
			selectedRoomMessages: [],
			pendingAgentReplies: [],
			agentProfiles: [{ name: "worker", description: "完成任务", scope: "user", content: "", editable: true }],
			agentProfilesLoading: false,
			roomTasks: [],
			roomTasksLoading: false,
		} as unknown as RoomWorkspaceController;
		const html = renderToStaticMarkup(
			<RoomWorkspace
				state={{ projects: [] } as WorkbenchState}
				controller={controller}
				onModeChange={() => {}}
				openResource={(() => {}) as WorkbenchActions["openResource"]}
				section="chat"
				onSectionChange={() => {}}
			/>,
		);
		const profileButtons = html.match(/<button(?=[^>]*aria-pressed)[^>]*>/g);
		expect(profileButtons).toHaveLength(1);
		expect(profileButtons?.[0]).not.toContain("disabled");
		expect(html).not.toContain("已加入");
	});

	it("成员卡片使用相同字号，菜单显示真实配置文件名和改名入口", () => {
		const owner = { roomId: "room-a", sessionId: "owner", role: "owner" as const, joinedAt: "", lastReadSeq: 0 };
		const controller = {
			selectedRoomProjectId: "project-a",
			selectedRoom: {
				room: { id: "room-a", cwd: "/project", title: "协作室", ownerSessionId: "owner", mode: "group", createdAt: "", updatedAt: "" },
				members: [owner, { ...owner, sessionId: "worker-a", role: "member", nickname: "霜叶", profileId: "worker" }],
				latestSeq: 0,
			},
			selectedRoomMessages: [],
			pendingAgentReplies: [],
			agentProfiles: [{ name: "worker", fileName: "actual-worker.md", description: "完成任务", scope: "user", content: "", editable: true }],
			agentProfilesLoading: false,
			roomTasks: [],
			roomTasksLoading: false,
		} as unknown as RoomWorkspaceController;
		const html = renderToStaticMarkup(
			<RoomWorkspace
				state={{ projects: [] } as WorkbenchState}
				controller={controller}
				onModeChange={() => {}}
				openResource={(() => {}) as WorkbenchActions["openResource"]}
				section="chat"
				onSectionChange={() => {}}
			/>,
		);
		expect(html.match(/room-member-chip/g)).toHaveLength(2);
		expect(html).toContain("配置文件：actual-worker.md");
		expect(html).toContain("改名");
	});

	it("配置列表没有文件名时展示已记录的 luna-worker 配置名称", () => {
		const owner = { roomId: "room-a", sessionId: "owner", role: "owner" as const, joinedAt: "", lastReadSeq: 0 };
		const controller = {
			selectedRoomProjectId: "project-a",
			selectedRoom: {
				room: { id: "room-a", cwd: "/project", title: "协作室", ownerSessionId: "owner", mode: "group", createdAt: "", updatedAt: "" },
				members: [owner, { ...owner, sessionId: "worker-a", role: "member", nickname: "霜叶", profileId: "luna-worker", profileName: "luna-worker" }],
				latestSeq: 0,
			},
			selectedRoomMessages: [],
			pendingAgentReplies: [],
			agentProfiles: [{ name: "luna-worker", description: "完成任务", scope: "user", content: "", editable: true }],
			agentProfilesLoading: false,
			roomTasks: [],
			roomTasksLoading: false,
		} as unknown as RoomWorkspaceController;
		const html = renderToStaticMarkup(
			<RoomWorkspace
				state={{ projects: [] } as WorkbenchState}
				controller={controller}
				onModeChange={() => {}}
				openResource={(() => {}) as WorkbenchActions["openResource"]}
				section="chat"
				onSectionChange={() => {}}
			/>,
		);
		expect(html).toContain("配置名称：luna-worker");
		expect(html).not.toContain("配置文件：未找到");
	});
});
