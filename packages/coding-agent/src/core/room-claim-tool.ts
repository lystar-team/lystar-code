import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "./extensions/types.ts";
import type { SessionCoordinator } from "./session-coordinator.ts";

const ClaimParams = Type.Object({
	roomId: Type.String({ minLength: 1, maxLength: 256 }),
	taskId: Type.String({ minLength: 1, maxLength: 256 }),
});

export function createRoomClaimTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof ClaimParams> {
	return {
		name: "room_claim",
		label: "认领 Room 任务",
		description: "认领一张待认领的 Room 任务卡。认领失败时不要执行该任务。",
		parameters: ClaimParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext): Promise<AgentToolResult> {
			const coordinator = getCoordinator();
			if (!coordinator)
				return { content: [{ type: "text", text: "当前运行环境没有启用会话协作能力。" }], details: null };
			const cwd = ctx.sessionManager.getHeader()?.collaborationWorkspace?.projectCwd ?? ctx.cwd;
			const result = await coordinator.room.taskClaim({
				cwd,
				roomId: params.roomId,
				taskId: params.taskId,
				sessionId: ctx.sessionManager.getSessionId(),
			});
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: null };
		},
	};
}
