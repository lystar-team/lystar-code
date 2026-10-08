import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "./extensions/types.ts";
import { createRoomClaimTool } from "./room-claim-tool.ts";
import type {
	SessionCoordinator,
	SessionCoordinatorSummary,
	SessionSendMode,
	SessionWaitProgress,
} from "./session-coordinator.ts";

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

const SessionWaitParams = Type.Object(
	{
		sessionIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 32 }),
	},
	{ additionalProperties: false },
);

const SessionListParams = Type.Object({
	parentSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

const SessionProfilesParams = Type.Object({});

const SessionStopParams = Type.Object({
	sessionId: Type.String({ minLength: 1, maxLength: 256 }),
	reason: Type.Union([Type.Literal("user_requested"), Type.Literal("task_cancelled")]),
	note: Type.String({ minLength: 1, maxLength: 2000 }),
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
	workspaceMode: Type.Optional(SessionWorkspaceModeSchema),
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
			"以当前会话为父会话创建下级会话，可同时派发任务。调查和评审默认 shared，只允许读取；代码写入请指定 worktree，非 Git 项目写入使用 patch。接收并验证产物后使用 session_accept_result 完成接收和回收。",
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

function sessionProgressSnapshot(session: SessionCoordinatorSummary) {
	return {
		id: session.id,
		...(session.name ? { name: session.name.slice(0, 64) } : {}),
		...(session.profileName ? { profileName: session.profileName.slice(0, 64) } : {}),
		activity: session.activity,
		...(session.taskDescription ? { taskDescription: session.taskDescription.slice(0, 160) } : {}),
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
		async execute(_toolCallId, params, _signal, onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			return resultText(
				await coordinator.send({
					cwd: collaborationCwd(ctx),
					sessionId: params.sessionId,
					text: params.text,
					mode: params.mode as SessionSendMode | undefined,
					onProgress: (session) => onUpdate?.(resultText(sessionProgressSnapshot(session))),
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
		description:
			"等待下级会话返回结果或需要输入，由系统持续等待并更新进度。取消等待不停止子任务；已有结果返回后，只继续等待仍在运行的会话。",
		promptSnippet: "持续等待子会话返回结果，取消等待不停止子任务",
		promptGuidelines: [
			"session_wait 的等待时长由系统管理，不传 timeoutMs；通过 codemode 调用时不设置 timeout_ms。",
			"任务仍在运行时继续等待，不因暂时没有回复或主会话准备结束调用 session_stop。",
			"返回结果可能同时包含已完成和仍在运行的成员；处理已有结果后只等待剩余会话。",
		],
		parameters: SessionWaitParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			signal?.throwIfAborted();
			let progress: SessionWaitProgress | undefined;
			const sessions = await coordinator.wait({
				cwd: collaborationCwd(ctx),
				sessionIds: params.sessionIds,
				signal,
				onProgress: (next) => {
					progress = next;
					const snapshot = {
						state: next.state,
						elapsedMs: next.elapsedMs,
						sessions: next.sessions.map(sessionProgressSnapshot),
					};
					onUpdate?.({ content: [{ type: "text", text: JSON.stringify(snapshot) }], details: snapshot });
				},
			});
			return { ...resultText(sessions), details: progress ?? null };
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
		description:
			"仅在用户明确要求停止或任务明确撤销时停止下级会话，必须填写原因和说明。等待时间长、没有新回复或主会话结束不构成停止理由。",
		promptGuidelines: ["session_stop 只用于明确取消任务；正常任务完成后直接读取结果，不调用停止工具清理。"],
		parameters: SessionStopParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			signal?.throwIfAborted();
			return resultText(
				await coordinator.stop({
					cwd: collaborationCwd(ctx),
					sessionId: params.sessionId,
					callerSessionId: ctx.sessionManager.getSessionId(),
					reason: params.reason,
					note: params.note,
					onProgress: (session) => onUpdate?.(resultText(sessionProgressSnapshot(session))),
				}),
			);
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
		description:
			"在智能体协作空间创建任务卡并通知成员。调查和评审默认 shared；代码写入指定 worktree，非 Git 项目写入指定 patch。",
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
					workspaceMode: params.workspaceMode,
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

const SessionAcceptParams = Type.Object({ sessionId: Type.String({ minLength: 1, maxLength: 256 }) });
const SessionWorkspacesParams = Type.Object({
	action: Type.Union([Type.Literal("preview"), Type.Literal("cleanup")]),
	sessionIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }))),
});

export function createSessionAcceptTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof SessionAcceptParams> {
	return {
		name: "session_accept_result",
		label: "接收会话产物",
		description: "接收已经核对并验证的子会话产物；没有待执行任务时自动回收工作区，保留会话与记录。",
		parameters: SessionAcceptParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator?.accept) return coordinatorUnavailable();
			return resultText(
				await coordinator.accept({
					cwd: collaborationCwd(ctx),
					sessionId: params.sessionId,
					callerSessionId: ctx.sessionManager.getSessionId(),
				}),
			);
		},
	};
}

export function createSessionWorkspacesTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof SessionWorkspacesParams> {
	return {
		name: "session_workspaces",
		label: "管理协作工作区",
		description: "预览协作工作区占用和保留原因，或回收已接收且没有待执行任务的工作区。失败和未接收成果继续保留。",
		parameters: SessionWorkspacesParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator?.workspaces) return coordinatorUnavailable();
			return resultText(
				await coordinator.workspaces({
					cwd: collaborationCwd(ctx),
					action: params.action,
					sessionIds: params.sessionIds,
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
		createSessionAcceptTool(getCoordinator),
		createSessionWorkspacesTool(getCoordinator),
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
