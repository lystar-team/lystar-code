import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
	SessionRoom,
	SessionRoomCursor,
	SessionRoomMember,
	SessionRoomMessage,
	SessionRoomSummary,
	SessionRoomTask,
	SessionRoomTaskStatus,
} from "@earendil-works/pi-coding-agent/core";

type RoomJournalRecord =
	| { type: "room_created"; room: SessionRoom }
	| { type: "room_updated"; room: SessionRoom }
	| { type: "member_joined"; member: SessionRoomMember }
	| { type: "member_left"; roomId: string; sessionId: string; leftAt: string }
	| { type: "cursor_advanced"; roomId: string; sessionId: string; lastReadSeq: number }
	| { type: "message_appended"; message: SessionRoomMessage }
	| { type: "delivery_pending"; roomId: string; messageId: string; targetSessionId: string }
	| { type: "delivery_done"; messageId: string; targetSessionId: string }
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
			`Room 记录不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
			"room_store_corrupt",
		);
	}
	if (!isRecord(value) || typeof value.type !== "string") {
		throw roomError("Room 记录缺少类型", "room_store_corrupt");
	}
	if (
		value.type !== "room_created" &&
		value.type !== "room_updated" &&
		value.type !== "member_joined" &&
		value.type !== "member_left" &&
		value.type !== "cursor_advanced" &&
		value.type !== "message_appended" &&
		value.type !== "delivery_pending" &&
		value.type !== "delivery_done" &&
		value.type !== "task_created" &&
		value.type !== "task_updated"
	) {
		throw roomError(`Room 记录类型未知：${value.type}`, "room_store_corrupt");
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

export class SessionRoomStore {
	private readonly path: string;
	private readonly rooms = new Map<string, SessionRoom>();
	private readonly membersByRoom = new Map<string, Map<string, SessionRoomMember>>();
	private readonly messages = new Map<string, SessionRoomMessage[]>();
	private readonly messagesById = new Map<string, SessionRoomMessage>();
	private readonly idempotency = new Map<string, SessionRoomMessage>();
	private readonly tasksByRoom = new Map<string, Map<string, SessionRoomTask>>();
	private readonly pendingDeliveries = new Map<string, { message: SessionRoomMessage; targetSessionId: string }>();

	constructor(path: string) {
		this.path = resolve(path);
		mkdirSync(dirname(this.path), { recursive: true });
		if (!existsSync(this.path)) return;
		const content = readFileSync(this.path, "utf8");
		for (const line of content.split("\n")) {
			if (line.trim()) this.apply(parseJournalRecord(line));
		}
	}

	getPath(): string {
		return this.path;
	}

	createRoom(room: SessionRoom, owner: SessionRoomMember): SessionRoomSummary {
		if (this.rooms.has(room.id)) throw roomError(`Room 已存在：${room.id}`, "room_exists");
		if (owner.roomId !== room.id || owner.sessionId !== room.ownerSessionId) {
			throw roomError("Room Owner 与 Room 不一致", "room_owner_invalid");
		}
		this.commit([
			{ type: "room_created", room },
			{ type: "member_joined", member: owner },
		]);
		return this.summary(room.id);
	}

	roomIds(): string[] {
		return [...this.rooms.keys()];
	}

	room(roomId: string): SessionRoom {
		const room = this.rooms.get(roomId);
		if (!room) throw roomError(`未找到 Room：${roomId}`, "room_not_found");
		return clone(room);
	}

	joinMember(member: SessionRoomMember): SessionRoomSummary {
		const room = this.room(member.roomId);
		const members = this.membersByRoom.get(member.roomId)!;
		const current = members.get(member.sessionId);
		if (current && current.leftAt === undefined) return this.summary(room.id);
		const joined: SessionRoomMember = {
			...member,
			lastReadSeq: current?.lastReadSeq ?? member.lastReadSeq,
		};
		const updatedRoom = { ...room, updatedAt: joined.joinedAt };
		this.commit([
			{ type: "room_updated", room: updatedRoom },
			{ type: "member_joined", member: joined },
		]);
		return this.summary(room.id);
	}

	leaveMember(roomId: string, sessionId: string, leftAt: string): SessionRoomSummary {
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
	}

	appendMessage(draft: SessionRoomMessageDraft): { message: SessionRoomMessage; deduplicated: boolean } {
		const room = this.room(draft.roomId);
		const sender = this.membersByRoom.get(draft.roomId)?.get(draft.senderSessionId);
		if (!sender || sender.leftAt !== undefined) {
			throw roomError(`发送者不是 Room 活跃成员：${draft.senderSessionId}`, "room_sender_not_member");
		}
		const idempotencyKey = `${draft.roomId}:${draft.senderSessionId}:${draft.idempotencyKey}`;
		const previous = this.idempotency.get(idempotencyKey);
		if (previous) {
			if (!messageMatchesDraft(previous, draft)) {
				throw roomError("相同幂等键对应的 Room 消息内容不一致", "room_idempotency_conflict");
			}
			return { message: clone(previous), deduplicated: true };
		}
		const roomMessages = this.messages.get(draft.roomId)!;
		if (
			(draft.senderType ?? "agent") === "agent" &&
			draft.basedOnSeq !== undefined &&
			(draft.kind === "answer" || draft.kind === "message" || draft.kind === "result")
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
			) {
				throw roomError("Room 有新消息，请读取后重新回复", "room_reply_stale");
			}
			if (
				recent.some(
					(message) =>
						message.seq > baseline &&
						message.senderType === "agent" &&
						message.senderSessionId !== draft.senderSessionId &&
						message.kind === draft.kind &&
						message.body.trim() === draft.body.trim(),
				)
			) {
				throw roomError("其他智能体已发出相同回复", "room_reply_duplicate");
			}
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
								item.capabilities?.allowedTools.includes("room_tasks"),
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
			...(!["task", "message", "question", "status"].includes(message.kind)
				? []
				: message.targetSessionIds.map(
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
	}

	pending(): Array<{ message: SessionRoomMessage; targetSessionId: string }> {
		return [...this.pendingDeliveries.values()].map((delivery) => clone(delivery));
	}

	hasPendingDelivery(messageId: string, targetSessionId: string): boolean {
		return this.pendingDeliveries.has(`${messageId}:${targetSessionId}`);
	}

	completeDelivery(messageId: string, targetSessionId: string): void {
		if (this.pendingDeliveries.has(`${messageId}:${targetSessionId}`)) {
			this.commit([{ type: "delivery_done", messageId, targetSessionId }]);
		}
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
		if (!member) throw roomError(`不是 Room 成员：${sessionId}`, "room_member_not_found");
		return clone(member);
	}

	listRooms(cwd: string, sessionId: string): SessionRoomSummary[] {
		return this.listAllRooms(cwd).filter((summary) =>
			summary.members.some((member) => member.sessionId === sessionId && member.leftAt === undefined),
		);
	}

	listAllRooms(cwd: string): SessionRoomSummary[] {
		return [...this.rooms.values()]
			.filter((room) => room.cwd === cwd)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
			.map((room) => this.summary(room.id));
	}

	createTask(roomId: string, sessionId: string, title: string, description: string): SessionRoomTask {
		this.activeMember(roomId, sessionId);
		const now = new Date().toISOString();
		const task: SessionRoomTask = {
			id: randomUUID(),
			roomId,
			title,
			description,
			status: "todo",
			createdBySessionId: sessionId,
			updates: [],
			createdAt: now,
			updatedAt: now,
		};
		this.commit([{ type: "task_created", task }]);
		return clone(task);
	}

	listTasks(roomId: string): SessionRoomTask[] {
		this.room(roomId);
		return [...(this.tasksByRoom.get(roomId)?.values() ?? [])].map((task) => clone(task));
	}

	task(roomId: string, taskId: string): SessionRoomTask {
		this.room(roomId);
		const task = this.tasksByRoom.get(roomId)?.get(taskId);
		if (!task) throw roomError(`未找到 Room 任务：${taskId}`, "room_task_not_found");
		return clone(task);
	}

	claimTask(roomId: string, taskId: string, sessionId: string): SessionRoomTask {
		const member = this.activeMember(roomId, sessionId);
		if (member.role !== "member") throw roomError("只有 Room Agent 可以认领任务", "room_task_agent_required");
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
	}

	updateTask(
		roomId: string,
		taskId: string,
		sessionId: string,
		status: SessionRoomTaskStatus,
		note?: string,
	): SessionRoomTask {
		const member = this.activeMember(roomId, sessionId);
		const task = this.task(roomId, taskId);
		if (member.role !== "owner" && task.assigneeSessionId !== sessionId) {
			throw roomError("任务只能由负责人或 Room Owner 更新", "room_task_not_assignee");
		}
		if (status !== "todo" && !task.assigneeSessionId) {
			throw roomError("任务尚未认领", "room_task_unclaimed");
		}
		if (task.status === "done" && member.role !== "owner") {
			throw roomError("已完成任务只能由 Room Owner 调整", "room_task_done");
		}
		if (status === task.status && !note) return task;
		const now = new Date().toISOString();
		const next: SessionRoomTask = {
			...task,
			status,
			...(status === "todo"
				? { assigneeSessionId: undefined, resultMessageId: undefined, resultText: undefined }
				: {}),
			updatedAt: now,
			updates: [...task.updates, { actorSessionId: sessionId, status, ...(note ? { note } : {}), createdAt: now }],
		};
		this.commit([{ type: "task_updated", task: next }]);
		return clone(next);
	}

	editTask(
		roomId: string,
		taskId: string,
		sessionId: string,
		edit: { title?: string; description?: string; assigneeSessionId?: string | null },
	): SessionRoomTask {
		const room = this.room(roomId);
		if (sessionId !== room.ownerSessionId)
			throw roomError("只有 Room Owner 可以编辑或指派任务", "room_task_owner_required");
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
		) {
			throw roomError("负责人不是 Room 中的智能体", "room_task_assignee_invalid");
		}
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
			...(assigneeSessionId !== task.assigneeSessionId ? { resultMessageId: undefined, resultText: undefined } : {}),
			updates:
				assigneeSessionId === task.assigneeSessionId
					? task.updates
					: [...task.updates, { actorSessionId: sessionId, status, createdAt: now }],
		};
		this.commit([{ type: "task_updated", task: next }]);
		return clone(next);
	}

	commentTask(roomId: string, taskId: string, sessionId: string, body: string): SessionRoomTask {
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
	}

	releaseStaleTask(roomId: string, taskId: string, before: number): SessionRoomTask | undefined {
		const task = this.task(roomId, taskId);
		if (task.status !== "doing" || !task.assigneeSessionId || Date.parse(task.updatedAt) > before) return undefined;
		return this.updateTask(
			roomId,
			taskId,
			this.room(roomId).ownerSessionId,
			"todo",
			"负责人长时间无进展，任务已重新开放认领",
		);
	}

	readMessages(
		roomId: string,
		sessionId: string,
		afterSeq: number,
		limit: number,
	): { messages: SessionRoomMessage[]; nextSeq?: number } {
		this.activeMember(roomId, sessionId);
		const visible = (this.messages.get(roomId) ?? []).filter(
			(message) =>
				message.seq > afterSeq &&
				(message.senderSessionId === sessionId || message.targetSessionIds.includes(sessionId)),
		);
		const messages = visible.slice(0, limit).map((message) => clone(message));
		return {
			messages,
			...(visible.length > messages.length ? { nextSeq: messages.at(-1)?.seq } : {}),
		};
	}

	cursor(roomId: string, sessionId: string): SessionRoomCursor {
		const member = this.member(roomId, sessionId);
		return { roomId, sessionId, lastReadSeq: member.lastReadSeq };
	}

	advanceCursor(roomId: string, sessionId: string, lastReadSeq: number): SessionRoomCursor {
		const member = this.activeMember(roomId, sessionId);
		if (!Number.isSafeInteger(lastReadSeq) || lastReadSeq < member.lastReadSeq) return this.cursor(roomId, sessionId);
		this.commit([{ type: "cursor_advanced", roomId, sessionId, lastReadSeq }]);
		return this.cursor(roomId, sessionId);
	}

	summary(roomId: string): SessionRoomSummary {
		const room = this.room(roomId);
		return {
			room,
			members: this.members(roomId),
			latestSeq: this.messages.get(roomId)?.at(-1)?.seq ?? 0,
		};
	}

	private activeMember(roomId: string, sessionId: string): SessionRoomMember {
		const member = this.member(roomId, sessionId);
		if (member.leftAt !== undefined) throw roomError(`Room 成员已退出：${sessionId}`, "room_member_left");
		return member;
	}

	private commit(records: readonly RoomJournalRecord[]): void {
		appendFileSync(this.path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
		for (const record of records) this.apply(record);
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
			case "cursor_advanced": {
				const member = this.membersByRoom.get(record.roomId)?.get(record.sessionId);
				if (member && record.lastReadSeq >= member.lastReadSeq) {
					this.membersByRoom.get(record.roomId)!.set(record.sessionId, {
						...member,
						lastReadSeq: record.lastReadSeq,
					});
				}
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
					});
				return;
			}
			case "delivery_done":
				this.pendingDeliveries.delete(`${record.messageId}:${record.targetSessionId}`);
				return;
			case "message_appended": {
				const message = {
					...record.message,
					senderType: record.message.senderType ?? "agent",
				};
				let messages = this.messages.get(record.message.roomId);
				if (!messages) {
					messages = [];
					this.messages.set(record.message.roomId, messages);
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
