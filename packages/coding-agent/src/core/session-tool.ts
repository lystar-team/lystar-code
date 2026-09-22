import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "./extensions/types.ts";
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

const SessionsParams = Type.Union([
	Type.Object({
		action: Type.Literal("create"),
		profileId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		task: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
		workspaceMode: Type.Optional(SessionWorkspaceModeSchema),
	}),
	Type.Object({
		action: Type.Literal("send"),
		sessionId: Type.String({ minLength: 1, maxLength: 256 }),
		text: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
		mode: Type.Optional(SessionSendModeSchema),
	}),
	Type.Object({
		action: Type.Literal("wait"),
		sessionIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 32 }),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 * 60 * 1000 })),
	}),
	Type.Object({
		action: Type.Literal("list"),
		parentSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	}),
	Type.Object({ action: Type.Literal("profiles") }),
	Type.Object({
		action: Type.Literal("stop"),
		sessionId: Type.String({ minLength: 1, maxLength: 256 }),
	}),
	Type.Object({
		action: Type.Literal("room_create"),
		title: Type.Optional(Type.String({ maxLength: 256 })),
		mode: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("group")])),
	}),
	Type.Object({
		action: Type.Literal("room_join"),
		roomId: Type.String({ minLength: 1, maxLength: 256 }),
	}),
	Type.Object({
		action: Type.Literal("room_leave"),
		roomId: Type.String({ minLength: 1, maxLength: 256 }),
	}),
	Type.Object({ action: Type.Literal("room_list") }),
	Type.Object({
		action: Type.Literal("room_send"),
		roomId: Type.String({ minLength: 1, maxLength: 256 }),
		route: SessionRoomRouteSchema,
		targetSessionIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 })),
		kind: Type.Optional(SessionRoomKindSchema),
		body: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
		taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		replyToMessageId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		basedOnSeq: Type.Optional(Type.Integer({ minimum: 0 })),
		idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	}),
	Type.Object({
		action: Type.Literal("room_read"),
		roomId: Type.String({ minLength: 1, maxLength: 256 }),
		afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		markRead: Type.Optional(Type.Boolean()),
	}),
]);

function coordinatorUnavailable(): AgentToolResult {
	return {
		content: [{ type: "text", text: "当前运行环境没有启用会话协作能力。" }],
		details: null,
	};
}

function resultText(value: unknown): AgentToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }], details: null };
}

export function createSessionsTool(
	getCoordinator: () => SessionCoordinator | undefined,
): ToolDefinition<typeof SessionsParams> {
	return {
		name: "sessions",
		label: "Sessions",
		description:
			"创建和协调同一项目中的普通会话与 Room。带任务的会话默认使用独立 Git Worktree；只读分析可使用 shared，非 Git 项目可使用 patch。Room 支持定向、广播、one-of-us 路由和增量读取。",
		promptSnippet: "创建和协调同一项目中的普通会话",
		parameters: SessionsParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const coordinator = getCoordinator();
			if (!coordinator) return coordinatorUnavailable();
			const cwd = ctx.cwd;

			switch (params.action) {
				case "create": {
					const parentSessionFile = ctx.sessionManager.getSessionFile();
					if (!parentSessionFile) {
						return {
							content: [{ type: "text", text: "当前会话尚未持久化，无法创建协作会话。" }],
							details: null,
						};
					}
					return resultText(
						await coordinator.create({
							cwd,
							parentSessionFile,
							parentSessionId: ctx.sessionManager.getSessionId(),
							...(params.profileId ? { profileId: params.profileId } : {}),
							task: params.task,
							workspaceMode: params.workspaceMode,
						}),
					);
				}
				case "send":
					return resultText(
						await coordinator.send({
							cwd,
							sessionId: params.sessionId,
							text: params.text,
							mode: params.mode as SessionSendMode | undefined,
						}),
					);
				case "wait":
					return resultText(
						await coordinator.wait({ cwd, sessionIds: params.sessionIds, timeoutMs: params.timeoutMs }),
					);
				case "list":
					return resultText(await coordinator.list({ cwd, parentSessionId: params.parentSessionId }));
				case "profiles":
					return resultText(await coordinator.profiles({ cwd }));
				case "stop":
					return resultText(await coordinator.stop({ cwd, sessionId: params.sessionId }));
				case "room_create":
					return resultText(
						await coordinator.room.create({
							cwd,
							ownerSessionId: ctx.sessionManager.getSessionId(),
							...(params.title ? { title: params.title } : {}),
							...(params.mode ? { mode: params.mode } : {}),
						}),
					);
				case "room_join":
					return resultText(
						await coordinator.room.join({
							cwd,
							roomId: params.roomId,
							sessionId: ctx.sessionManager.getSessionId(),
						}),
					);
				case "room_leave":
					return resultText(
						await coordinator.room.leave({
							cwd,
							roomId: params.roomId,
							sessionId: ctx.sessionManager.getSessionId(),
						}),
					);
				case "room_list":
					return resultText(await coordinator.room.list({ cwd, sessionId: ctx.sessionManager.getSessionId() }));
				case "room_send":
					return resultText(
						await coordinator.room.send({
							cwd,
							roomId: params.roomId,
							senderSessionId: ctx.sessionManager.getSessionId(),
							route: params.route,
							...(params.targetSessionIds ? { targetSessionIds: params.targetSessionIds } : {}),
							...(params.kind ? { kind: params.kind } : {}),
							body: params.body,
							...(params.taskId ? { taskId: params.taskId } : {}),
							...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
							...(params.basedOnSeq !== undefined ? { basedOnSeq: params.basedOnSeq } : {}),
							...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
						}),
					);
				case "room_read":
					return resultText(
						await coordinator.room.read({
							cwd,
							roomId: params.roomId,
							sessionId: ctx.sessionManager.getSessionId(),
							...(params.afterSeq !== undefined ? { afterSeq: params.afterSeq } : {}),
							...(params.limit !== undefined ? { limit: params.limit } : {}),
							...(params.markRead !== undefined ? { markRead: params.markRead } : {}),
						}),
					);
			}
		},
	};
}
