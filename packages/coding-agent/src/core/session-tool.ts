import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "./extensions/types.ts";
import { createRoomClaimTool } from "./room-claim-tool.ts";
import type { SessionCoordinator, SessionSendMode } from "./session-coordinator.ts";

const SessionSendModeSchema = Type.Union([Type.Literal("auto"), Type.Literal("steer"), Type.Literal("follow_up")]);
const SessionWorkspaceModeSchema = Type.Union([
	Type.Literal("shared"),
	Type.Literal("worktree"),
	Type.Literal("patch"),
]);
const SessionRoomRouteSchema = Type.Union([
	Type.Literal("direct"),
	Type.Literal("broadcast"),
	Type.Literal("one_of_us"),
]);
const SessionRoomKindSchema = Type.Union([
	Type.Literal("task"),
	Type.Literal("message"),
	Type.Literal("question"),
	Type.Literal("answer"),
	Type.Literal("status"),
	Type.Literal("result"),
	Type.Literal("system"),
]);

const SessionCreateParams = Type.Object({
	profileId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	task: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
	workspaceMode: Type.Optional(SessionWorkspaceModeSchema),
});

const SessionSendParams = Type.Object({
	sessionId: Type.String({ minLength: 1, maxLength: 256 }),
	text: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
	mode: Type.Optional(SessionSendModeSchema),
});

const SessionWaitParams = Type.Object({
	sessionIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 32 }),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 * 60 * 1000 })),
});

const SessionListParams = Type.Object({
	parentSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

const SessionProfilesParams = Type.Object({});

const SessionStopParams = Type.Object({
	sessionId: Type.String({ minLength: 1, maxLength: 256 }),
});

const RoomCreateParams = Type.Object({
	title: Type.Optional(Type.String({ maxLength: 256 })),
	mode: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("group")])),
});

const RoomIdParams = Type.Object({
	roomId: Type.String({ minLength: 1, maxLength: 256 }),
});

const RoomJoinParams = Type.Object({
	roomId: Type.String({ minLength: 1, maxLength: 256 }),
	profileId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	nickname: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

const RoomListParams = Type.Object({});

const RoomSendParams = Type.Object({
	roomId: Type.String({ minLength: 1, maxLength: 256 }),
	route: SessionRoomRouteSchema,
	targetSessionIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 })),
	kind: Type.Optional(SessionRoomKindSchema),
	body: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
	taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	capabilities: Type.Optional(
		Type.Object(
			{
				allowedTools: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 32 }),
				readRoots: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 32 })),
				writeRoots: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 32 })),
				shell: Type.Optional(Type.Union([Type.Literal("disabled"), Type.Literal("sandboxed")])),
			},
			{ additionalProperties: false },
		),
	),
	replyToMessageId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	basedOnSeq: Type.Optional(Type.Integer({ minimum: 0 })),
	idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

const RoomReadParams = Type.Object({
	roomId: Type.String({ minLength: 1, maxLength: 256 }),
	afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	markRead: Type.Optional(Type.Boolean()),
});

const RoomTaskListParams = Type.Object({
	roomId: Type.String({ minLength: 1, maxLength: 256 }),
});

const RoomTaskCreateParams = Type.Object({
	roomId: Type.String({ minLength: 1, maxLength: 256 }),
	title: Type.String({ minLength: 1, maxLength: 200 }),
	description: Type.Optional(Type.String({ maxLength: 8000 })),
});

const RoomTaskUpdateParams = Type.Object({
	roomId: Type.String({ minLength: 1, maxLength: 256 }),
	taskId: Type.String({ minLength: 1, maxLength: 256 }),
	status: Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("blocked"), Type.Literal("done")]),
	note: Type.Optional(Type.String({ maxLength: 8000 })),
});

function coordinatorUnavailable(): AgentToolResult {
	return {
		content: [{ type: "text", text: "当前运行环境没有启用会话协作能力。" }],
		details: null,
	};
}

function resultText(value: unknown): AgentToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }], details: null };
}

function collaborationCwd(ctx: ExtensionContext): string {
	return ctx.sessionManager.getHeader()?.collaborationWorkspace?.projectCwd ?? ctx.cwd;
}

export function createSessionCreateTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof SessionCreateParams> {
	return {
		name: "session_create",
		label: "创建下级会话",
		description:
			"以当前会话为父会话创建下级会话，可同时派发任务。带任务的会话默认使用独立 Git Worktree；只读分析可使用 shared，非 Git 项目可使用 patch。",
		promptSnippet: "创建下级会话并派发任务",
		parameters: SessionCreateParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			const parentSessionFile = ctx.sessionManager.getSessionFile();
			if (!parentSessionFile) {
				return {
					content: [{ type: "text", text: "当前会话尚未持久化，无法创建协作会话。" }],
					details: null,
				};
			}
			return resultText(
				await coordinator.create({
					cwd: collaborationCwd(ctx),
					parentSessionFile,
					parentSessionId: ctx.sessionManager.getSessionId(),
					...(params.profileId ? { profileId: params.profileId } : {}),
					task: params.task,
					workspaceMode: params.workspaceMode,
				}),
			);
		},
	};
}

export function createSessionSendTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof SessionSendParams> {
	return {
		name: "session_send",
		label: "发送会话消息",
		description: "向指定下级会话发送消息。会话运行中可用 steer，等待输入时可用 follow_up，其余情况用 auto。",
		parameters: SessionSendParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(
				await coordinator.send({
					cwd: collaborationCwd(ctx),
					sessionId: params.sessionId,
					text: params.text,
					mode: params.mode as SessionSendMode | undefined,
				}),
			);
		},
	};
}

export function createSessionWaitTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof SessionWaitParams> {
	return {
		name: "session_wait",
		label: "等待子会话",
		description: "等待一个或多个下级会话结束，返回会话摘要与持久化结果。",
		promptSnippet: "等待子会话返回结果",
		parameters: SessionWaitParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(
				await coordinator.wait({
					cwd: collaborationCwd(ctx),
					sessionIds: params.sessionIds,
					timeoutMs: params.timeoutMs,
				}),
			);
		},
	};
}

export function createSessionListTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof SessionListParams> {
	return {
		name: "session_list",
		label: "查看会话",
		description: "查看当前项目的会话列表；传入 parentSessionId 可只看该会话的下级。",
		parameters: SessionListParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(
				await coordinator.list({ cwd: collaborationCwd(ctx), parentSessionId: params.parentSessionId }),
			);
		},
	};
}

export function createSessionProfilesTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof SessionProfilesParams> {
	return {
		name: "session_profiles",
		label: "查看智能体配置",
		description: "查看当前项目可用的智能体配置，创建下级会话前用它选择 profileId。",
		parameters: SessionProfilesParams,
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(await coordinator.profiles({ cwd: collaborationCwd(ctx) }));
		},
	};
}

export function createSessionStopTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof SessionStopParams> {
	return {
		name: "session_stop",
		label: "停止子会话",
		description: "停止指定下级会话；正在运行的任务会记录为中断结果。",
		parameters: SessionStopParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(await coordinator.stop({ cwd: collaborationCwd(ctx), sessionId: params.sessionId }));
		},
	};
}

export function createRoomCreateTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof RoomCreateParams> {
	return {
		name: "room_create",
		label: "创建协作空间",
		description: "创建一个智能体协作空间，当前会话成为负责人。",
		parameters: RoomCreateParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(
				await coordinator.room.create({
					cwd: collaborationCwd(ctx),
					ownerSessionId: ctx.sessionManager.getSessionId(),
					...(params.title ? { title: params.title } : {}),
					...(params.mode ? { mode: params.mode } : {}),
				}),
			);
		},
	};
}

export function createRoomJoinTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof RoomJoinParams> {
	return {
		name: "room_join",
		label: "加入协作空间",
		description: "以当前会话及角色加入智能体协作空间；未选择角色的会话需要提供 profileId。",
		parameters: RoomJoinParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(
				await coordinator.room.join({
					cwd: collaborationCwd(ctx),
					roomId: params.roomId,
					sessionId: ctx.sessionManager.getSessionId(),
					profileId: params.profileId ?? ctx.sessionManager.getHeader()?.profile?.id,
					profileName: ctx.sessionManager.getHeader()?.profile?.name,
					...(params.nickname ? { nickname: params.nickname } : {}),
				}),
			);
		},
	};
}

export function createRoomLeaveTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof RoomIdParams> {
	return {
		name: "room_leave",
		label: "退出协作空间",
		description: "退出智能体协作空间；未完成任务会重新开放给其他成员。",
		parameters: RoomIdParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(
				await coordinator.room.leave({
					cwd: collaborationCwd(ctx),
					roomId: params.roomId,
					sessionId: ctx.sessionManager.getSessionId(),
				}),
			);
		},
	};
}

export function createRoomListTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof RoomListParams> {
	return {
		name: "room_list",
		label: "查看协作空间",
		description: "查看当前会话所在的智能体协作空间。",
		parameters: RoomListParams,
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(
				await coordinator.room.list({ cwd: collaborationCwd(ctx), sessionId: ctx.sessionManager.getSessionId() }),
			);
		},
	};
}

export function createRoomSendTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof RoomSendParams> {
	return {
		name: "room_send",
		label: "发送协作消息",
		description: "向智能体协作空间发送消息，支持定向、广播和 one-of-us 路由。",
		parameters: RoomSendParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(
				await coordinator.room.send({
					cwd: collaborationCwd(ctx),
					roomId: params.roomId,
					senderSessionId: ctx.sessionManager.getSessionId(),
					route: params.route,
					...(params.targetSessionIds ? { targetSessionIds: params.targetSessionIds } : {}),
					...(params.kind ? { kind: params.kind } : {}),
					body: params.body,
					...(params.taskId ? { taskId: params.taskId } : {}),
					...(params.capabilities ? { capabilities: params.capabilities } : {}),
					...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
					...(params.basedOnSeq !== undefined ? { basedOnSeq: params.basedOnSeq } : {}),
					...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
				}),
			);
		},
	};
}

export function createRoomReadTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof RoomReadParams> {
	return {
		name: "room_read",
		label: "读取协作消息",
		description: "读取智能体协作空间的增量消息。",
		parameters: RoomReadParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(
				await coordinator.room.read({
					cwd: collaborationCwd(ctx),
					roomId: params.roomId,
					sessionId: ctx.sessionManager.getSessionId(),
					...(params.afterSeq !== undefined ? { afterSeq: params.afterSeq } : {}),
					...(params.limit !== undefined ? { limit: params.limit } : {}),
					...(params.markRead !== undefined ? { markRead: params.markRead } : {}),
				}),
			);
		},
	};
}

export function createRoomTaskListTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof RoomTaskListParams> {
	return {
		name: "room_task_list",
		label: "查看协作任务",
		description: "查看智能体协作看板任务。",
		parameters: RoomTaskListParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(
				await coordinator.room.taskList({
					cwd: collaborationCwd(ctx),
					roomId: params.roomId,
					sessionId: ctx.sessionManager.getSessionId(),
				}),
			);
		},
	};
}

export function createRoomTaskCreateTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof RoomTaskCreateParams> {
	return {
		name: "room_task_create",
		label: "创建协作任务",
		description: "在智能体协作空间创建任务卡；创建后向成员派发待认领通知。",
		parameters: RoomTaskCreateParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(
				await coordinator.room.taskCreate({
					cwd: collaborationCwd(ctx),
					roomId: params.roomId,
					sessionId: ctx.sessionManager.getSessionId(),
					title: params.title,
					description: params.description,
				}),
			);
		},
	};
}

export function createRoomTaskUpdateTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof RoomTaskUpdateParams> {
	return {
		name: "room_task_update",
		label: "更新协作任务",
		description: "更新自己负责的任务状态、阻塞说明或完成情况；释放任务设为 todo。",
		parameters: RoomTaskUpdateParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(
				await coordinator.room.taskUpdate({
					cwd: collaborationCwd(ctx),
					roomId: params.roomId,
					taskId: params.taskId,
					sessionId: ctx.sessionManager.getSessionId(),
					status: params.status,
					note: params.note,
				}),
			);
		},
	};
}

/**
 * 注册全部智能体协作工具。每个动作是独立工具，便于按名称授权或禁用。
 */
export function createCollaborationTools(getCoordinator: () => SessionCoordinator | undefined): ToolDefinition[] {
	return [
		createSessionCreateTool(getCoordinator),
		createSessionSendTool(getCoordinator),
		createSessionWaitTool(getCoordinator),
		createSessionListTool(getCoordinator),
		createSessionProfilesTool(getCoordinator),
		createSessionStopTool(getCoordinator),
		createRoomCreateTool(getCoordinator),
		createRoomJoinTool(getCoordinator),
		createRoomLeaveTool(getCoordinator),
		createRoomListTool(getCoordinator),
		createRoomSendTool(getCoordinator),
		createRoomReadTool(getCoordinator),
		createRoomTaskListTool(getCoordinator),
		createRoomTaskCreateTool(getCoordinator),
		createRoomTaskUpdateTool(getCoordinator),
		createRoomClaimTool(getCoordinator),
	];
}
