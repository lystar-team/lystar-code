import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	SessionManager,
	type SessionRoom,
	type SessionRoomCursor,
	type SessionRoomExecutionState,
	type SessionRoomMember,
	type SessionRoomMessage,
	type SessionRoomSummary,
	type SessionRoomTask,
	type SessionRoomTaskStatus,
} from "@earendil-works/pi-coding-agent/core";
import { collaborationAlias } from "@lystar/code-web-protocol";

export const SESSION_ROOM_EXECUTION_LEASE_MS = 15 * 60_000;
export const SESSION_ROOM_EXECUTION_RENEW_MS = 60_000;

type RoomJournalRecord =
	| { type: "room_created"; room: SessionRoom }
	| { type: "room_updated"; room: SessionRoom }
	| { type: "member_joined"; member: SessionRoomMember }
	| { type: "member_left"; roomId: string; sessionId: string; leftAt: string }
	| { type: "member_renamed"; roomId: string; sessionId: string; nickname: string }
	| { type: "cursor_advanced"; roomId: string; sessionId: string; lastReadSeq: number }
	| { type: "message_appended"; message: SessionRoomMessage }
	| { type: "delivery_pending"; roomId: string; messageId: string; targetSessionId: string }
	| { type: "delivery_done"; messageId: string; targetSessionId: string }
	| { type: "delivery_retry"; messageId: string; targetSessionId: string; attempts: number; nextAttemptAt: number }
	| { type: "task_created"; task: SessionRoomTask }
	| { type: "task_updated"; task: SessionRoomTask };

function clone<T>(value: T): T {
	return structuredClone(value);
}

function roomError(message: string, code: string): Error & { code: string; retryable: boolean } {
	return Object.assign(new Error(message), { code, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageMatchesDraft(message: SessionRoomMessage, draft: SessionRoomMessageDraft): boolean {
	return (
		message.targetSessionIds.length === draft.targetSessionIds.length &&
		message.targetSessionIds.every((target, index) => target === draft.targetSessionIds[index]) &&
		message.senderType === (draft.senderType ?? "agent") &&
		message.route === draft.route &&
		message.kind === draft.kind &&
		message.body === draft.body &&
		JSON.stringify(message.attachments ?? []) === JSON.stringify(draft.attachments ?? []) &&
		message.taskId === draft.taskId &&
		JSON.stringify(message.capabilities ?? null) === JSON.stringify(draft.capabilities ?? null) &&
		message.replyToMessageId === draft.replyToMessageId &&
		message.basedOnSeq === draft.basedOnSeq
	);
}

function parseJournalRecord(line: string): RoomJournalRecord {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw roomError(
			`智能体协作记录不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
			"room_store_corrupt",
		);
	}
	if (!isRecord(value) || typeof value.type !== "string")
		throw roomError("智能体协作记录缺少类型", "room_store_corrupt");
	if (
		![
			"room_created",
			"room_updated",
			"member_joined",
			"member_left",
			"member_renamed",
			"cursor_advanced",
			"message_appended",
			"delivery_pending",
			"delivery_done",
			"delivery_retry",
			"task_created",
			"task_updated",
		].includes(value.type)
	) {
		throw roomError(`智能体协作记录类型未知：${value.type}`, "room_store_corrupt");
	}
	return value as unknown as RoomJournalRecord;
}

export interface SessionRoomMessageDraft {
	roomId: string;
	senderSessionId: string;
	senderType?: SessionRoomMessage["senderType"];
	targetSessionIds: readonly string[];
	route: SessionRoomMessage["route"];
	kind: SessionRoomMessage["kind"];
	body: string;
	attachments?: SessionRoomMessage["attachments"];
	taskId?: string;
	capabilities?: SessionRoomMessage["capabilities"];
	replyToMessageId?: string;
	basedOnSeq?: number;
	idempotencyKey: string;
	createdAt: string;
}

export interface SessionRoomStoreChange {
	cwd: string;
	roomId: string;
	latestSeq: number;
	messagesChanged: boolean;
	tasksChanged: boolean;
	membersChanged: boolean;
}

export interface SessionRoomPendingDelivery {
	message: SessionRoomMessage;
	targetSessionId: string;
	attempts: number;
	nextAttemptAt: number;
}

export class SessionRoomStore {
	private readonly path: string;
	private readonly onChange?: (change: SessionRoomStoreChange) => void;
	private readonly rooms = new Map<string, SessionRoom>();
	private readonly membersByRoom = new Map<string, Map<string, SessionRoomMember>>();
	private readonly messages = new Map<string, SessionRoomMessage[]>();
	private readonly messagesById = new Map<string, SessionRoomMessage>();
	private readonly idempotency = new Map<string, SessionRoomMessage>();
	private readonly tasksByRoom = new Map<string, Map<string, SessionRoomTask>>();
	private readonly pendingDeliveries = new Map<string, SessionRoomPendingDelivery>();
	private loadedBytes = 0;
	private writing = false;

	constructor(path: string, onChange?: (change: SessionRoomStoreChange) => void) {
		this.path = resolve(path);
		this.onChange = onChange;
		mkdirSync(dirname(this.path), { recursive: true });
		this.refresh();
	}

	getPath(): string {
		return this.path;
	}

	createRoom(room: SessionRoom, owner: SessionRoomMember): SessionRoomSummary {
		return this.transaction(() => {
			if (this.rooms.has(room.id)) throw roomError(`智能体协作已存在：${room.id}`, "room_exists");
			if (owner.roomId !== room.id || owner.sessionId !== room.ownerSessionId)
				throw roomError("智能体协作的创建者与协作不一致", "room_owner_invalid");
			this.commit([
				{ type: "room_created", room },
				{ type: "member_joined", member: owner },
			]);
			return this.summary(room.id);
		});
	}

	roomIds(): string[] {
		this.refresh();
		return [...this.rooms.keys()];
	}

	room(roomId: string): SessionRoom {
		this.refresh();
		const room = this.rooms.get(roomId);
		if (!room) throw roomError(`未找到智能体协作：${roomId}`, "room_not_found");
		return clone(room);
	}

	joinMember(member: SessionRoomMember): SessionRoomSummary {
		return this.transaction(() => {
			const room = this.room(member.roomId);
			const current = this.membersByRoom.get(member.roomId)!.get(member.sessionId);
			if (current && current.leftAt === undefined) return this.summary(room.id);
			const joined = { ...member, lastReadSeq: current?.lastReadSeq ?? member.lastReadSeq };
			this.commit([
				{ type: "room_updated", room: { ...room, updatedAt: joined.joinedAt } },
				{ type: "member_joined", member: joined },
			]);
			return this.summary(room.id);
		});
	}

	renameMember(roomId: string, sessionId: string, nickname: string): SessionRoomSummary {
		return this.transaction(() => {
			const room = this.room(roomId);
			const member = this.member(roomId, sessionId);
			if (member.leftAt !== undefined || member.role !== "member")
				throw roomError("只能修改智能体协作中智能体的昵称", "room_member_rename_forbidden");
			const name = nickname.trim();
			if (!name || name.length > 128 || !/^[\p{L}\p{N}_-]+$/u.test(name))
				throw roomError(
					"昵称只能包含文字、数字、下划线或连字符，且不能超过 128 字符",
					"room_member_nickname_invalid",
				);
			if (
				name === "你" ||
				this.members(roomId).some(
					(candidate) =>
						candidate.sessionId !== sessionId &&
						candidate.leftAt === undefined &&
						(candidate.nickname?.trim() || collaborationAlias(candidate.sessionId)) === name,
				)
			)
				throw roomError("智能体协作中已有同名成员", "room_member_nickname_conflict");
			if (member.nickname === name) return this.summary(roomId);
			this.commit([
				{ type: "room_updated", room: { ...room, updatedAt: new Date().toISOString() } },
				{ type: "member_renamed", roomId, sessionId, nickname: name },
			]);
			return this.summary(roomId);
		});
	}

	leaveMember(roomId: string, sessionId: string, leftAt: string): SessionRoomSummary {
		return this.transaction(() => {
			const room = this.room(roomId);
			const member = this.membersByRoom.get(roomId)?.get(sessionId);
			if (!member || member.leftAt !== undefined) return this.summary(room.id);
			const released = this.listTasks(roomId)
				.filter((task) => task.assigneeSessionId === sessionId && task.status !== "done")
				.map(
					(task): RoomJournalRecord => ({
						type: "task_updated",
						task: {
							...task,
							status: "todo",
							assigneeSessionId: undefined,
							resultMessageId: undefined,
							resultText: undefined,
							execution: undefined,
							updatedAt: leftAt,
							updates: [...task.updates, { actorSessionId: sessionId, status: "todo", createdAt: leftAt }],
						},
					}),
				);
			this.commit([
				{ type: "room_updated", room: { ...room, updatedAt: leftAt } },
				{ type: "member_left", roomId, sessionId, leftAt },
				...released,
			]);
			return this.summary(room.id);
		});
	}

	appendMessage(draft: SessionRoomMessageDraft): { message: SessionRoomMessage; deduplicated: boolean } {
		return this.transaction(() => {
			const room = this.room(draft.roomId);
			const sender = this.membersByRoom.get(draft.roomId)?.get(draft.senderSessionId);
			if (!sender || sender.leftAt !== undefined)
				throw roomError(`发送者不是智能体协作的活跃成员：${draft.senderSessionId}`, "room_sender_not_member");
			const previous = this.idempotency.get(`${draft.roomId}:${draft.senderSessionId}:${draft.idempotencyKey}`);
			if (previous) {
				if (!messageMatchesDraft(previous, draft))
					throw roomError("相同幂等键对应的智能体协作消息内容不一致", "room_idempotency_conflict");
				return { message: clone(previous), deduplicated: true };
			}
			const roomMessages = this.messages.get(draft.roomId)!;
			if (
				(draft.senderType ?? "agent") === "agent" &&
				draft.basedOnSeq !== undefined &&
				["answer", "message", "result"].includes(draft.kind)
			) {
				const baseline = draft.basedOnSeq;
				const recent = roomMessages.slice(Math.min(Math.max(baseline, 0), roomMessages.length));
				if (
					recent.some(
						(message) =>
							message.seq > baseline &&
							message.senderType === "user" &&
							message.targetSessionIds.includes(draft.senderSessionId) &&
							message.kind === "message",
					)
				)
					throw roomError("智能体协作有新消息，请读取后重新回复", "room_reply_stale");
				if (
					recent.some(
						(message) =>
							message.seq > baseline &&
							message.senderType === "agent" &&
							message.senderSessionId !== draft.senderSessionId &&
							message.kind === draft.kind &&
							message.body.trim() === draft.body.trim(),
					)
				)
					throw roomError("其他智能体已发出相同回复", "room_reply_duplicate");
			}
			const latestWorkRequest =
				draft.kind === "answer" && draft.taskId && draft.replyToMessageId
					? [...roomMessages]
							.reverse()
							.find(
								(item) =>
									item.taskId === draft.taskId &&
									item.kind === "task" &&
									item.targetSessionIds.includes(draft.senderSessionId) &&
									item.capabilities?.allowedTools.includes("room_task_update"),
							)
					: undefined;
			const isTaskResult =
				draft.kind === "result" || (draft.kind === "answer" && latestWorkRequest?.id === draft.replyToMessageId);
			const message: SessionRoomMessage = {
				id: randomUUID(),
				seq: (roomMessages.at(-1)?.seq ?? 0) + 1,
				roomId: draft.roomId,
				senderSessionId: draft.senderSessionId,
				senderType: draft.senderType ?? "agent",
				targetSessionIds: [...draft.targetSessionIds],
				route: draft.route,
				kind: draft.kind,
				body: draft.body,
				...(draft.attachments?.length ? { attachments: clone(draft.attachments) } : {}),
				...(draft.taskId ? { taskId: draft.taskId } : {}),
				...(draft.capabilities ? { capabilities: clone(draft.capabilities) } : {}),
				...(draft.replyToMessageId ? { replyToMessageId: draft.replyToMessageId } : {}),
				...(draft.basedOnSeq !== undefined ? { basedOnSeq: draft.basedOnSeq } : {}),
				idempotencyKey: draft.idempotencyKey,
				createdAt: draft.createdAt,
			};
			this.commit([
				{ type: "room_updated", room: { ...room, updatedAt: message.createdAt } },
				{ type: "message_appended", message },
				...(message.kind === "system"
					? []
					: message.targetSessionIds
							.filter((target) => target !== message.senderSessionId || message.senderType === "user")
							.map(
								(targetSessionId): RoomJournalRecord => ({
									type: "delivery_pending",
									roomId: message.roomId,
									messageId: message.id,
									targetSessionId,
								}),
							)),
				...(message.taskId &&
				isTaskResult &&
				this.tasksByRoom.get(message.roomId)?.get(message.taskId)?.assigneeSessionId === message.senderSessionId
					? [
							{
								type: "task_updated",
								task: {
									...this.task(message.roomId, message.taskId),
									resultMessageId: message.id,
									resultText: message.body,
								},
							} satisfies RoomJournalRecord,
						]
					: []),
			]);
			return { message: clone(message), deduplicated: false };
		});
	}

	pending(): SessionRoomPendingDelivery[] {
		this.refresh();
		return [...this.pendingDeliveries.values()].map((delivery) => clone(delivery));
	}

	hasPendingDelivery(messageId: string, targetSessionId: string): boolean {
		this.refresh();
		return this.pendingDeliveries.has(`${messageId}:${targetSessionId}`);
	}

	completeDelivery(messageId: string, targetSessionId: string, processedSeq?: number): void {
		this.transaction(() => {
			const pending = this.pendingDeliveries.get(`${messageId}:${targetSessionId}`);
			if (!pending) return;
			const member = this.member(pending.message.roomId, targetSessionId);
			this.commit([
				{ type: "delivery_done", messageId, targetSessionId },
				...(processedSeq !== undefined && !member.leftAt && processedSeq > member.lastReadSeq
					? [
							{
								type: "cursor_advanced" as const,
								roomId: pending.message.roomId,
								sessionId: targetSessionId,
								lastReadSeq: processedSeq,
							},
						]
					: []),
			]);
		});
	}

	retryDelivery(messageId: string, targetSessionId: string): void {
		this.transaction(() => {
			const pending = this.pendingDeliveries.get(`${messageId}:${targetSessionId}`);
			if (!pending) return;
			const attempts = pending.attempts + 1;
			this.commit([
				{
					type: "delivery_retry",
					messageId,
					targetSessionId,
					attempts,
					nextAttemptAt: Date.now() + Math.min(1_000 * 2 ** Math.min(attempts - 1, 6), 60_000),
				},
			]);
		});
	}

	members(roomId: string): SessionRoomMember[] {
		this.room(roomId);
		return [...(this.membersByRoom.get(roomId)?.values() ?? [])]
			.sort(
				(left, right) =>
					left.joinedAt.localeCompare(right.joinedAt) || left.sessionId.localeCompare(right.sessionId),
			)
			.map((member) => clone(member));
	}

	member(roomId: string, sessionId: string): SessionRoomMember {
		this.room(roomId);
		const member = this.membersByRoom.get(roomId)?.get(sessionId);
		if (!member) throw roomError(`不是智能体协作成员：${sessionId}`, "room_member_not_found");
		return clone(member);
	}

	listRooms(cwd: string, sessionId: string): SessionRoomSummary[] {
		return this.listAllRooms(cwd).filter((summary) =>
			summary.members.some((member) => member.sessionId === sessionId && member.leftAt === undefined),
		);
	}

	listAllRooms(cwd: string): SessionRoomSummary[] {
		this.refresh();
		return [...this.rooms.values()]
			.filter((room) => room.cwd === cwd)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
			.map((room) => this.summary(room.id));
	}

	createTask(
		roomId: string,
		sessionId: string,
		title: string,
		description: string,
		workspaceMode: SessionRoomTask["workspaceMode"] = "shared",
	): SessionRoomTask {
		return this.transaction(() => {
			this.activeMember(roomId, sessionId);
			const now = new Date().toISOString();
			const task: SessionRoomTask = {
				id: randomUUID(),
				roomId,
				title,
				description,
				workspaceMode,
				status: "todo",
				createdBySessionId: sessionId,
				updates: [],
				createdAt: now,
				updatedAt: now,
			};
			this.commit([{ type: "task_created", task }]);
			return clone(task);
		});
	}

	listTasks(roomId: string): SessionRoomTask[] {
		this.room(roomId);
		return [...(this.tasksByRoom.get(roomId)?.values() ?? [])].map((task) => clone(task));
	}

	task(roomId: string, taskId: string): SessionRoomTask {
		this.room(roomId);
		const task = this.tasksByRoom.get(roomId)?.get(taskId);
		if (!task) throw roomError(`未找到智能体协作任务：${taskId}`, "room_task_not_found");
		return clone(task);
	}

	claimTask(roomId: string, taskId: string, sessionId: string): SessionRoomTask {
		return this.transaction(() => {
			const member = this.activeMember(roomId, sessionId);
			if (member.role !== "member")
				throw roomError("只有智能体协作中的智能体可以认领任务", "room_task_agent_required");
			const task = this.task(roomId, taskId);
			if (task.assigneeSessionId === sessionId && task.status === "doing") return task;
			if (task.status !== "todo" || task.assigneeSessionId) {
				const holder = task.assigneeSessionId ? this.member(roomId, task.assigneeSessionId) : undefined;
				throw roomError(
					holder
						? `任务已由 ${holder.nickname || holder.profileName || holder.sessionId} 认领`
						: "任务不在待认领状态",
					"room_task_claim_conflict",
				);
			}
			const now = new Date().toISOString();
			const next: SessionRoomTask = {
				...task,
				status: "doing",
				assigneeSessionId: sessionId,
				updatedAt: now,
				updates: [...task.updates, { actorSessionId: sessionId, status: "doing", createdAt: now }],
			};
			this.commit([{ type: "task_updated", task: next }]);
			return clone(next);
		});
	}

	updateTask(
		roomId: string,
		taskId: string,
		sessionId: string,
		status: SessionRoomTaskStatus,
		note?: string,
	): SessionRoomTask {
		return this.transaction(() => {
			const member = this.activeMember(roomId, sessionId);
			const task = this.task(roomId, taskId);
			if (member.role !== "owner" && task.assigneeSessionId !== sessionId)
				throw roomError("任务只能由负责人或智能体协作的创建者更新", "room_task_not_assignee");
			if (status !== "todo" && !task.assigneeSessionId) throw roomError("任务尚未认领", "room_task_unclaimed");
			if (task.status === "done" && member.role !== "owner")
				throw roomError("已完成任务只能由智能体协作的创建者调整", "room_task_done");
			if (status === "done" && !task.resultText?.trim() && !note?.trim())
				throw roomError("完成任务前必须提交结果", "room_task_result_required");
			if (status === "done" && task.execution && !task.execution.result)
				throw roomError("任务执行尚未结束", "room_task_execution_active");
			if (
				status === "done" &&
				task.execution?.result &&
				(task.execution.result.outcome !== "completed" || task.execution.result.error)
			)
				throw roomError("任务执行未成功，不能标记完成", "room_task_execution_failed");
			if (status === task.status && !note) return task;
			const now = new Date().toISOString();
			const next: SessionRoomTask = {
				...task,
				status,
				...(status === "todo"
					? {
							assigneeSessionId: undefined,
							resultMessageId: undefined,
							resultText: undefined,
							execution: undefined,
						}
					: status === "done" && !task.resultText
						? { resultText: note }
						: {}),
				updatedAt: now,
				updates: [
					...task.updates,
					{ actorSessionId: sessionId, status, ...(note ? { note } : {}), createdAt: now },
				],
			};
			this.commit([{ type: "task_updated", task: next }]);
			return clone(next);
		});
	}

	claimTaskExecution(
		roomId: string,
		taskId: string,
		sessionId: string,
		messageId: string,
		ownerId: string,
		allowRecovery = false,
	): SessionRoomTask {
		return this.transaction(() => {
			const task = this.task(roomId, taskId);
			if (task.assigneeSessionId !== sessionId || task.status !== "doing")
				throw roomError("任务负责人或状态已变化", "room_task_claim_conflict");
			const previous = task.execution;
			if (previous?.messageId === messageId && previous.result?.outcome === "completed" && !previous.result.error)
				return task;
			const now = Date.now();
			if (
				previous?.leaseExpiresAt &&
				previous.leaseExpiresAt > now &&
				previous.ownerId &&
				previous.ownerId !== ownerId &&
				!allowRecovery
			)
				throw Object.assign(new Error("任务正在由其他 Runtime 执行"), {
					code: "room_task_execution_claimed",
					retryable: true,
				});
			if (
				previous?.ownerId === ownerId &&
				previous.messageId === messageId &&
				previous.leaseExpiresAt &&
				previous.leaseExpiresAt > now
			)
				return task;
			const execution = {
				...(previous?.workspace ? { workspace: clone(previous.workspace) } : {}),
				...(previous?.sessionId ? { sessionId: previous.sessionId } : {}),
				...(previous?.taskId ? { taskId: previous.taskId } : {}),
				leaseId: randomUUID(),
				ownerId,
				state: "starting" as const satisfies SessionRoomExecutionState,
				leaseExpiresAt: now + SESSION_ROOM_EXECUTION_LEASE_MS,
				attempt: (previous?.attempt ?? 0) + 1,
				messageId,
			};
			const next: SessionRoomTask = {
				...task,
				execution,
				resultMessageId: undefined,
				resultText: undefined,
				updatedAt: new Date(now).toISOString(),
			};
			this.commit([{ type: "task_updated", task: next }]);
			return clone(next);
		});
	}

	bindTaskExecution(
		roomId: string,
		taskId: string,
		sessionId: string,
		execution: NonNullable<SessionRoomTask["execution"]>,
		ownerId?: string,
	): SessionRoomTask {
		return this.transaction(() => {
			const task = this.task(roomId, taskId);
			if (task.assigneeSessionId !== sessionId || task.status !== "doing")
				throw roomError("任务负责人或状态已变化", "room_task_claim_conflict");
			if (ownerId && task.execution?.ownerId && task.execution.ownerId !== ownerId)
				throw Object.assign(new Error("任务执行租约已被其他 Runtime 接管"), {
					code: "room_task_execution_claimed",
					retryable: true,
				});
			if (task.execution?.leaseId && execution.leaseId && task.execution.leaseId !== execution.leaseId)
				throw Object.assign(new Error("任务执行租约已被其他 Runtime 接管"), {
					code: "room_task_execution_claimed",
					retryable: true,
				});
			if (
				task.execution &&
				task.execution.messageId === execution.messageId &&
				task.execution.sessionId === execution.sessionId &&
				task.execution.state === "running" &&
				task.execution.workspace?.id === execution.workspace?.id
			)
				return task;
			const next = {
				...task,
				execution: {
					...clone(execution),
					state: "running" as const,
					leaseExpiresAt: Date.now() + SESSION_ROOM_EXECUTION_LEASE_MS,
				},
				resultText: undefined,
				resultMessageId: undefined,
			};
			this.commit([{ type: "task_updated", task: next }]);
			return clone(next);
		});
	}

	renewTaskExecution(
		roomId: string,
		taskId: string,
		executionSessionId: string,
		ownerId: string,
		leaseId: string,
	): boolean {
		return this.transaction(() => {
			const task = this.task(roomId, taskId);
			const execution = task.execution;
			if (
				task.status !== "doing" ||
				execution?.sessionId !== executionSessionId ||
				execution.ownerId !== ownerId ||
				execution.leaseId !== leaseId ||
				execution.state !== "running"
			)
				return false;
			const next: SessionRoomTask = {
				...task,
				execution: { ...execution, leaseExpiresAt: Date.now() + SESSION_ROOM_EXECUTION_LEASE_MS },
				updatedAt: new Date().toISOString(),
			};
			this.commit([{ type: "task_updated", task: next }]);
			return true;
		});
	}
	recordTaskAcceptance(
		roomId: string,
		taskId: string,
		ownerSessionId: string,
		result: NonNullable<NonNullable<SessionRoomTask["execution"]>["result"]>,
	): SessionRoomTask {
		return this.transaction(() => {
			const task = this.task(roomId, taskId);
			if (this.room(roomId).ownerSessionId !== ownerSessionId)
				throw roomError("只有协作负责人可以接收任务产物", "room_task_owner_required");
			if (!task.execution?.result || task.execution.result.taskId !== result.taskId)
				throw roomError("任务执行结果已变化", "room_task_execution_conflict");
			const next: SessionRoomTask = {
				...task,
				execution: {
					...task.execution,
					state: "completed",
					result: clone(result),
					...(result.workspace ? { workspace: clone(result.workspace) } : {}),
				},
				updatedAt: new Date().toISOString(),
			};
			this.commit([{ type: "task_updated", task: next }]);
			return clone(next);
		});
	}

	recordTaskExecution(
		roomId: string,
		taskId: string,
		executionSessionId: string,
		result: NonNullable<NonNullable<SessionRoomTask["execution"]>["result"]>,
		ownerId?: string,
		leaseId?: string,
	): boolean {
		return this.transaction(() => {
			const task = this.task(roomId, taskId);
			if (
				task.execution?.sessionId !== executionSessionId ||
				(ownerId !== undefined && task.execution.ownerId !== ownerId) ||
				(leaseId !== undefined && task.execution.leaseId !== leaseId) ||
				task.status !== "doing"
			)
				return false;
			const success = result.outcome === "completed" && !result.error;
			const now = new Date().toISOString();
			const next: SessionRoomTask = {
				...task,
				execution: {
					...task.execution,
					state: success ? "completed" : result.outcome === "interrupted" ? "interrupted" : "failed",
					leaseExpiresAt: 0,
					result: clone(result),
				},
				status: success ? "doing" : "blocked",
				...(success && result.resultText ? { resultText: result.resultText } : {}),
				updatedAt: now,
				updates: [
					...task.updates,
					{
						actorSessionId: task.assigneeSessionId!,
						status: success ? "doing" : "blocked",
						note: success ? "结果已提交，等待验收" : (result.error ?? `任务执行${result.outcome}`),
						createdAt: now,
					},
				],
			};
			this.commit([{ type: "task_updated", task: next }]);
			return true;
		});
	}

	editTask(
		roomId: string,
		taskId: string,
		sessionId: string,
		edit: { title?: string; description?: string; assigneeSessionId?: string | null },
	): SessionRoomTask {
		return this.transaction(() => {
			const room = this.room(roomId);
			if (sessionId !== room.ownerSessionId)
				throw roomError("只有智能体协作的创建者可以编辑或指派任务", "room_task_owner_required");
			this.activeMember(roomId, sessionId);
			const task = this.task(roomId, taskId);
			const title = edit.title === undefined ? task.title : edit.title.trim();
			const description = edit.description === undefined ? task.description : edit.description.trim();
			if (!title || title.length > 200 || description.length > 8000)
				throw roomError("任务标题或内容长度无效", "room_task_content_invalid");
			if (
				task.status === "done" &&
				edit.assigneeSessionId !== undefined &&
				edit.assigneeSessionId !== task.assigneeSessionId
			)
				throw roomError("已完成任务不能重新指派，请先调整状态", "room_task_done");
			const assigneeSessionId =
				edit.assigneeSessionId === undefined ? task.assigneeSessionId : edit.assigneeSessionId || undefined;
			if (
				assigneeSessionId &&
				!this.members(roomId).some(
					(member) => member.sessionId === assigneeSessionId && member.role === "member" && !member.leftAt,
				)
			)
				throw roomError("负责人不是智能体协作中的智能体", "room_task_assignee_invalid");
			if (title === task.title && description === task.description && assigneeSessionId === task.assigneeSessionId)
				return task;
			const now = new Date().toISOString();
			const status = assigneeSessionId ? (task.status === "todo" ? "doing" : task.status) : "todo";
			const next: SessionRoomTask = {
				...task,
				title,
				description,
				status,
				assigneeSessionId,
				updatedAt: now,
				...(assigneeSessionId !== task.assigneeSessionId || title !== task.title || description !== task.description
					? { resultMessageId: undefined, resultText: undefined, execution: undefined }
					: {}),
				updates:
					assigneeSessionId === task.assigneeSessionId
						? task.updates
						: [...task.updates, { actorSessionId: sessionId, status, createdAt: now }],
			};
			this.commit([{ type: "task_updated", task: next }]);
			return clone(next);
		});
	}

	commentTask(roomId: string, taskId: string, sessionId: string, body: string): SessionRoomTask {
		return this.transaction(() => {
			this.activeMember(roomId, sessionId);
			const task = this.task(roomId, taskId);
			const note = body.trim();
			if (!note || note.length > 8000) throw roomError("评论内容长度无效", "room_task_comment_invalid");
			const now = new Date().toISOString();
			const next: SessionRoomTask = {
				...task,
				updatedAt: now,
				updates: [
					...task.updates,
					{ actorSessionId: sessionId, status: task.status, note, kind: "comment", createdAt: now },
				],
			};
			this.commit([{ type: "task_updated", task: next }]);
			return clone(next);
		});
	}

	releaseStaleTask(roomId: string, taskId: string, before: number): SessionRoomTask | undefined {
		return this.transaction(() => {
			const task = this.task(roomId, taskId);
			if (
				task.status !== "doing" ||
				!task.assigneeSessionId ||
				task.resultText ||
				Date.parse(task.updatedAt) > before
			)
				return undefined;
			return this.updateTask(
				roomId,
				taskId,
				this.room(roomId).ownerSessionId,
				"todo",
				"负责人长时间无进展，任务已重新开放认领",
			);
		});
	}

	readMessages(
		roomId: string,
		sessionId: string,
		afterSeq: number,
		limit: number,
	): { messages: SessionRoomMessage[]; nextSeq?: number } {
		this.activeMember(roomId, sessionId);
		const visible = (this.messages.get(roomId) ?? []).filter((message) => message.seq > afterSeq);
		const messages = visible.slice(0, limit).map((message) => clone(message));
		return { messages, ...(visible.length > messages.length ? { nextSeq: messages.at(-1)?.seq } : {}) };
	}

	cursor(roomId: string, sessionId: string): SessionRoomCursor {
		const member = this.member(roomId, sessionId);
		return { roomId, sessionId, lastReadSeq: member.lastReadSeq };
	}

	advanceCursor(roomId: string, sessionId: string, lastReadSeq: number): SessionRoomCursor {
		return this.transaction(() => {
			const member = this.activeMember(roomId, sessionId);
			if (!Number.isSafeInteger(lastReadSeq) || lastReadSeq <= member.lastReadSeq)
				return this.cursor(roomId, sessionId);
			if (lastReadSeq > this.summary(roomId).latestSeq)
				throw roomError("读取游标超出消息范围", "room_cursor_invalid");
			this.commit([{ type: "cursor_advanced", roomId, sessionId, lastReadSeq }]);
			return this.cursor(roomId, sessionId);
		});
	}

	summary(roomId: string): SessionRoomSummary {
		return {
			room: this.room(roomId),
			members: this.members(roomId),
			latestSeq: this.messages.get(roomId)?.at(-1)?.seq ?? 0,
		};
	}

	private activeMember(roomId: string, sessionId: string): SessionRoomMember {
		const member = this.member(roomId, sessionId);
		if (member.leftAt !== undefined) throw roomError(`智能体协作成员已退出：${sessionId}`, "room_member_left");
		return member;
	}

	private transaction<T>(run: () => T): T {
		if (this.writing) return run();
		return SessionManager.withWriterLock(this.path, () => {
			this.refresh();
			this.writing = true;
			try {
				return run();
			} finally {
				this.writing = false;
			}
		});
	}

	private refresh(): void {
		if (this.writing || !existsSync(this.path)) return;
		const fd = openSync(this.path, "r");
		try {
			const size = fstatSync(fd).size;
			if (size < this.loadedBytes) throw roomError("智能体协作记录被截断", "room_store_corrupt");
			if (size === this.loadedBytes) return;
			const buffer = Buffer.alloc(size - this.loadedBytes);
			let offset = 0;
			while (offset < buffer.length) {
				const bytes = readSync(fd, buffer, offset, buffer.length - offset, this.loadedBytes + offset);
				if (!bytes) throw roomError("智能体协作记录读取不完整", "room_store_corrupt");
				offset += bytes;
			}
			const content = buffer.toString("utf8");
			if (!content.endsWith("\n")) throw roomError("智能体协作记录缺少完整行", "room_store_corrupt");
			for (const line of content.split("\n")) if (line.trim()) this.apply(parseJournalRecord(line));
			this.loadedBytes = size;
		} finally {
			closeSync(fd);
		}
	}

	private commit(records: readonly RoomJournalRecord[]): void {
		const content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
		appendFileSync(this.path, content, "utf8");
		this.loadedBytes += Buffer.byteLength(content);
		for (const record of records) this.apply(record);
		if (!this.onChange) return;
		const changed = new Map<string, Omit<SessionRoomStoreChange, "cwd" | "roomId" | "latestSeq">>();
		for (const record of records) {
			if (
				record.type === "cursor_advanced" ||
				record.type === "delivery_pending" ||
				record.type === "delivery_done" ||
				record.type === "delivery_retry"
			)
				continue;
			const roomId =
				record.type === "room_created" || record.type === "room_updated"
					? record.room.id
					: record.type === "member_joined"
						? record.member.roomId
						: record.type === "message_appended"
							? record.message.roomId
							: record.type === "task_created" || record.type === "task_updated"
								? record.task.roomId
								: record.roomId;
			const flags = changed.get(roomId) ?? { messagesChanged: false, tasksChanged: false, membersChanged: false };
			if (record.type === "message_appended") flags.messagesChanged = true;
			if (record.type === "task_created" || record.type === "task_updated") flags.tasksChanged = true;
			if (["room_created", "member_joined", "member_left", "member_renamed"].includes(record.type))
				flags.membersChanged = true;
			changed.set(roomId, flags);
		}
		for (const [roomId, flags] of changed) {
			const room = this.rooms.get(roomId);
			if (!room) continue;
			try {
				this.onChange({ cwd: room.cwd, roomId, latestSeq: this.messages.get(roomId)?.at(-1)?.seq ?? 0, ...flags });
			} catch {
				// 通知失败不能把已写入的智能体协作记录当作失败操作重试。
			}
		}
	}

	private apply(record: RoomJournalRecord): void {
		switch (record.type) {
			case "room_created":
				this.rooms.set(record.room.id, clone(record.room));
				this.membersByRoom.set(record.room.id, new Map());
				this.messages.set(record.room.id, []);
				this.tasksByRoom.set(record.room.id, new Map());
				return;
			case "room_updated":
				this.rooms.set(record.room.id, clone(record.room));
				return;
			case "member_joined": {
				let members = this.membersByRoom.get(record.member.roomId);
				if (!members) {
					members = new Map();
					this.membersByRoom.set(record.member.roomId, members);
				}
				members.set(record.member.sessionId, clone(record.member));
				return;
			}
			case "member_left": {
				const member = this.membersByRoom.get(record.roomId)?.get(record.sessionId);
				if (member)
					this.membersByRoom.get(record.roomId)!.set(record.sessionId, { ...member, leftAt: record.leftAt });
				return;
			}
			case "member_renamed": {
				const member = this.membersByRoom.get(record.roomId)?.get(record.sessionId);
				if (member)
					this.membersByRoom.get(record.roomId)!.set(record.sessionId, { ...member, nickname: record.nickname });
				return;
			}
			case "cursor_advanced": {
				const member = this.membersByRoom.get(record.roomId)?.get(record.sessionId);
				if (member && record.lastReadSeq > member.lastReadSeq)
					this.membersByRoom
						.get(record.roomId)!
						.set(record.sessionId, { ...member, lastReadSeq: record.lastReadSeq });
				return;
			}
			case "task_created":
			case "task_updated": {
				let tasks = this.tasksByRoom.get(record.task.roomId);
				if (!tasks) {
					tasks = new Map();
					this.tasksByRoom.set(record.task.roomId, tasks);
				}
				tasks.set(record.task.id, clone(record.task));
				return;
			}
			case "delivery_pending": {
				const message = this.messagesById.get(record.messageId);
				if (message)
					this.pendingDeliveries.set(`${record.messageId}:${record.targetSessionId}`, {
						message: clone(message),
						targetSessionId: record.targetSessionId,
						attempts: 0,
						nextAttemptAt: 0,
					});
				return;
			}
			case "delivery_retry": {
				const key = `${record.messageId}:${record.targetSessionId}`;
				const pending = this.pendingDeliveries.get(key);
				if (pending)
					this.pendingDeliveries.set(key, {
						...pending,
						attempts: record.attempts,
						nextAttemptAt: record.nextAttemptAt,
					});
				return;
			}
			case "delivery_done":
				this.pendingDeliveries.delete(`${record.messageId}:${record.targetSessionId}`);
				return;
			case "message_appended": {
				const message = { ...record.message, senderType: record.message.senderType ?? "agent" };
				let messages = this.messages.get(message.roomId);
				if (!messages) {
					messages = [];
					this.messages.set(message.roomId, messages);
				}
				messages.push(clone(message));
				this.messagesById.set(message.id, clone(message));
				this.idempotency.set(
					`${message.roomId}:${message.senderSessionId}:${message.idempotencyKey}`,
					clone(message),
				);
				return;
			}
		}
	}
}
