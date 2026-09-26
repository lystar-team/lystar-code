import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
	SessionRoomApi,
	SessionRoomMessage,
	SessionRoomSendResult,
	SessionRoomSummary,
	SessionRoomTask,
} from "@earendil-works/pi-coding-agent/core";
import { collaborationAlias } from "@lystar/code-web-protocol";
import { resolveSessionRoomTargets, type SessionRoomAvailability } from "./session-room-router.ts";
import type { SessionRoomMessageDraft, SessionRoomStore } from "./session-room-store.ts";

export interface SessionRoomDeliveryInput {
	cwd: string;
	message: SessionRoomMessage;
	targetSessionId: string;
}

export interface SessionRoomCoordinatorOptions {
	store: SessionRoomStore;
	getAvailability?(cwd: string, sessionId: string): SessionRoomAvailability | undefined;
	deliver(input: SessionRoomDeliveryInput): Promise<void>;
}

function roomError(message: string, code: string): Error & { code: string; retryable: boolean } {
	return Object.assign(new Error(message), { code, retryable: false });
}

function checkedBody(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) throw roomError("Room 消息不能为空", "room_message_empty");
	if (trimmed.length > 64 * 1024) throw roomError("Room 消息超过 64 KiB 限制", "room_message_too_large");
	return trimmed;
}

function checkedLimit(limit: number | undefined): number {
	if (limit === undefined) return 50;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw roomError("Room 消息读取数量必须在 1 到 100 之间", "room_read_limit_invalid");
	}
	return limit;
}

function formatRoomMessage(message: SessionRoomMessage): string {
	if (!message.attachments?.length) return message.body;
	const attribute = (value: string) =>
		value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
	return `${message.body}\n\n${message.attachments
		.map(
			({ path, filename, mimeType }) =>
				`<file name="${attribute(path)}" filename="${attribute(filename)}" mimeType="${attribute(mimeType)}"></file>`,
		)
		.join("\n")}`;
}

export class SessionRoomCoordinator {
	private readonly store: SessionRoomStore;
	private readonly getAvailability: (cwd: string, sessionId: string) => SessionRoomAvailability | undefined;
	private readonly deliver: (input: SessionRoomDeliveryInput) => Promise<void>;
	private readonly deliveriesInFlight = new Set<string>();

	constructor(options: SessionRoomCoordinatorOptions) {
		this.store = options.store;
		this.getAvailability = options.getAvailability ?? (() => undefined);
		this.deliver = options.deliver;
		setImmediate(() => {
			void this.resumeDeliveries();
			void this.reclaimStaleTasks().catch((error: unknown) => console.error("Room 任务回收失败", error));
		});
		const timer = setInterval(() => {
			void this.resumeDeliveries();
			void this.reclaimStaleTasks().catch((error: unknown) => console.error("Room 任务回收失败", error));
		}, 60_000);
		timer.unref?.();
	}

	api(): SessionRoomApi {
		return {
			create: (input) => this.create(input),
			join: (input) => this.join(input),
			leave: (input) => this.leave(input),
			rename: (input) => this.rename(input),
			list: (input) => this.list(input),
			listAll: (input) => this.listAll(input),
			send: (input) => this.send(input),
			read: (input) => this.read(input),
			taskCreate: (input) => this.taskCreate(input),
			taskList: (input) => this.taskList(input),
			taskClaim: (input) => this.taskClaim(input),
			taskUpdate: (input) => this.taskUpdate(input),
			taskEdit: (input) => this.taskEdit(input),
			taskComment: (input) => this.taskComment(input),
		};
	}

	private async create(input: Parameters<SessionRoomApi["create"]>[0]): Promise<SessionRoomSummary> {
		const cwd = resolve(input.cwd);
		const now = new Date().toISOString();
		const room = {
			id: randomUUID(),
			cwd,
			title: input.title?.trim() || "协作 Room",
			ownerSessionId: input.ownerSessionId,
			mode: input.mode ?? "group",
			createdAt: now,
			updatedAt: now,
		} as const;
		const owner = {
			roomId: room.id,
			sessionId: input.ownerSessionId,
			role: "owner" as const,
			joinedAt: now,
			lastReadSeq: 0,
		};
		return this.store.createRoom(room, owner);
	}

	private async join(input: Parameters<SessionRoomApi["join"]>[0]): Promise<SessionRoomSummary> {
		const room = this.store.room(input.roomId);
		if (resolve(input.cwd) !== room.cwd) throw roomError("Room 不属于当前项目", "room_cwd_mismatch");
		const existing = this.store
			.members(input.roomId)
			.find((member) => member.sessionId === input.sessionId && !member.leftAt);
		const isNewAgent = !existing && input.sessionId !== room.ownerSessionId;
		if (isNewAgent && !input.profileId?.trim())
			throw roomError("Room 新成员必须来自智能体配置", "room_profile_required");
		const now = new Date().toISOString();
		const joined = this.store.joinMember({
			roomId: input.roomId,
			sessionId: input.sessionId,
			role: "member",
			joinedAt: now,
			lastReadSeq: 0,
			...(input.nickname?.trim() ? { nickname: input.nickname.trim() } : {}),
			...(input.profileId?.trim() ? { profileId: input.profileId.trim() } : {}),
			...(input.profileName?.trim() ? { profileName: input.profileName.trim() } : {}),
			...(input.profileIcon?.trim() ? { profileIcon: input.profileIcon.trim() } : {}),
		});
		if (isNewAgent) {
			for (const task of this.store.listTasks(input.roomId).filter((item) => item.status === "todo")) {
				await this.offerTask(task, room.ownerSessionId, input.sessionId);
			}
		}
		return joined;
	}

	private async leave(input: Parameters<SessionRoomApi["leave"]>[0]): Promise<SessionRoomSummary> {
		const room = this.store.room(input.roomId);
		if (resolve(input.cwd) !== room.cwd) throw roomError("Room 不属于当前项目", "room_cwd_mismatch");
		const assigned = this.store
			.listTasks(input.roomId)
			.filter((task) => task.assigneeSessionId === input.sessionId && task.status !== "done");
		const summary = this.store.leaveMember(input.roomId, input.sessionId, new Date().toISOString());
		for (const task of assigned) await this.offerTask(this.store.task(input.roomId, task.id), room.ownerSessionId);
		return summary;
	}

	private async rename(input: Parameters<SessionRoomApi["rename"]>[0]): Promise<SessionRoomSummary> {
		const room = this.store.room(input.roomId);
		if (resolve(input.cwd) !== room.cwd) throw roomError("Room 不属于当前项目", "room_cwd_mismatch");
		return this.store.renameMember(input.roomId, input.sessionId, input.nickname);
	}

	private async list(input: Parameters<SessionRoomApi["list"]>[0]): Promise<SessionRoomSummary[]> {
		const rooms = this.store.listRooms(resolve(input.cwd), input.sessionId);
		for (const { room } of rooms) await this.releaseStaleTasks(room.id);
		return rooms;
	}

	private async listAll(input: Parameters<SessionRoomApi["listAll"]>[0]): Promise<SessionRoomSummary[]> {
		const rooms = this.store.listAllRooms(resolve(input.cwd));
		for (const { room } of rooms) await this.releaseStaleTasks(room.id);
		return rooms;
	}

	private async reclaimStaleTasks(): Promise<void> {
		for (const roomId of this.store.roomIds()) await this.releaseStaleTasks(roomId);
	}

	private async releaseStaleTasks(roomId: string): Promise<void> {
		const room = this.store.room(roomId);
		for (const task of this.store.listTasks(roomId)) {
			if (task.status !== "doing" || !task.assigneeSessionId) continue;
			const availability = this.getAvailability(room.cwd, task.assigneeSessionId);
			if (availability === "running" || availability === "waiting_for_input") continue;
			const timeout =
				availability === "failed" ||
				availability === "aborted" ||
				availability === "interrupted" ||
				availability === "offline"
					? 20 * 60_000
					: 24 * 60 * 60_000;
			const before = Date.now() - timeout;
			if (Date.parse(task.updatedAt) > before) continue;
			const released = this.store.releaseStaleTask(roomId, task.id, before);
			if (released) await this.offerTask(released, room.ownerSessionId, undefined, task.assigneeSessionId);
		}
	}

	private checkedTaskRoom(cwd: string, roomId: string, sessionId: string): void {
		const room = this.store.room(roomId);
		if (resolve(cwd) !== room.cwd) throw roomError("Room 不属于当前项目", "room_cwd_mismatch");
		const member = this.store.member(roomId, sessionId);
		if (member.leftAt) throw roomError("Room 成员已退出", "room_member_left");
	}

	private async offerTask(
		task: SessionRoomTask,
		senderSessionId: string,
		targetSessionId?: string,
		excludedSessionId?: string,
	): Promise<void> {
		const recipients = this.store
			.members(task.roomId)
			.filter(
				(member) =>
					member.role === "member" &&
					!member.leftAt &&
					member.sessionId !== senderSessionId &&
					member.sessionId !== excludedSessionId,
			)
			.filter((member) => !targetSessionId || member.sessionId === targetSessionId)
			.map((member) => member.sessionId);
		if (!recipients.length) return;
		await this.send({
			cwd: this.store.room(task.roomId).cwd,
			roomId: task.roomId,
			senderSessionId,
			senderType: senderSessionId === this.store.room(task.roomId).ownerSessionId ? "user" : "agent",
			route: "broadcast",
			targetSessionIds: recipients,
			kind: "task",
			taskId: task.id,
			body: `待认领任务：${task.title}\n${task.description}\n任务 ID：${task.id}\nRoom ID：${task.roomId}\n使用 room_claim 认领；未认领不要执行。`,
			capabilities: { allowedTools: ["room_claim"] },
			idempotencyKey: `room-task-offer:${task.id}:${task.updatedAt}:${targetSessionId ?? "room"}`,
		});
	}

	private async taskCreate(input: Parameters<SessionRoomApi["taskCreate"]>[0]): Promise<SessionRoomTask> {
		this.checkedTaskRoom(input.cwd, input.roomId, input.sessionId);
		const title = input.title.trim();
		const description = input.description?.trim() ?? "";
		if (!title || title.length > 200 || description.length > 8000) {
			throw roomError("任务标题或内容长度无效", "room_task_content_invalid");
		}
		const task = this.store.createTask(input.roomId, input.sessionId, title, description);
		await this.offerTask(task, input.sessionId);
		return task;
	}

	private async taskList(input: Parameters<SessionRoomApi["taskList"]>[0]): Promise<SessionRoomTask[]> {
		this.checkedTaskRoom(input.cwd, input.roomId, input.sessionId);
		await this.releaseStaleTasks(input.roomId);
		return this.store.listTasks(input.roomId);
	}

	private async dispatchTask(task: SessionRoomTask): Promise<void> {
		if (!task.assigneeSessionId) return;
		const room = this.store.room(task.roomId);
		await this.send({
			cwd: room.cwd,
			roomId: task.roomId,
			senderSessionId: room.ownerSessionId,
			route: "direct",
			targetSessionIds: [task.assigneeSessionId],
			kind: "task",
			taskId: task.id,
			body: `任务：${task.title}\n${task.description}\n任务 ID：${task.id}\nRoom ID：${task.roomId}\n如需修改项目文件，使用 sessions 创建独立 worktree 子会话。完成后使用 room_tasks 更新任务状态。`,
			capabilities: { allowedTools: ["read", "grep", "find", "ls", "sessions", "room_tasks"] },
			idempotencyKey: `room-task-work:${task.id}:${task.updatedAt}`,
		});
	}

	private async taskClaim(input: Parameters<SessionRoomApi["taskClaim"]>[0]): Promise<SessionRoomTask> {
		this.checkedTaskRoom(input.cwd, input.roomId, input.sessionId);
		await this.releaseStaleTasks(input.roomId);
		const previous = this.store.task(input.roomId, input.taskId);
		const task = this.store.claimTask(input.roomId, input.taskId, input.sessionId);
		if (previous.assigneeSessionId !== input.sessionId || previous.status !== "doing") await this.dispatchTask(task);
		return task;
	}

	private async taskUpdate(input: Parameters<SessionRoomApi["taskUpdate"]>[0]): Promise<SessionRoomTask> {
		this.checkedTaskRoom(input.cwd, input.roomId, input.sessionId);
		const note = input.note?.trim();
		if (note && note.length > 8000) throw roomError("任务进展超过长度限制", "room_task_note_too_large");
		const previous = this.store.task(input.roomId, input.taskId);
		const task = this.store.updateTask(input.roomId, input.taskId, input.sessionId, input.status, note);
		if (task.status === "todo" && task.updates.length !== previous.updates.length) {
			await this.offerTask(task, input.sessionId);
		} else if (task.status === "doing" && (previous.status === "blocked" || previous.status === "done")) {
			await this.dispatchTask(task);
		}
		return task;
	}

	private async taskEdit(input: Parameters<SessionRoomApi["taskEdit"]>[0]): Promise<SessionRoomTask> {
		this.checkedTaskRoom(input.cwd, input.roomId, input.sessionId);
		const previous = this.store.task(input.roomId, input.taskId);
		const task = this.store.editTask(input.roomId, input.taskId, input.sessionId, input);
		if (task.updatedAt === previous.updatedAt) return task;
		if (task.status === "todo") await this.offerTask(task, input.sessionId);
		else if (
			task.assigneeSessionId &&
			task.status === "doing" &&
			(task.assigneeSessionId !== previous.assigneeSessionId ||
				task.title !== previous.title ||
				task.description !== previous.description)
		)
			await this.dispatchTask(task);
		return task;
	}

	private async taskComment(input: Parameters<SessionRoomApi["taskComment"]>[0]): Promise<SessionRoomTask> {
		this.checkedTaskRoom(input.cwd, input.roomId, input.sessionId);
		const task = this.store.commentTask(input.roomId, input.taskId, input.sessionId, input.body);
		const mentions = new Set(input.body.match(/@[\p{L}\p{N}_-]+/gu) ?? []);
		const targets = this.store
			.members(input.roomId)
			.filter(
				(member) =>
					member.role === "member" &&
					!member.leftAt &&
					member.sessionId !== input.sessionId &&
					(mentions.has(`@${member.nickname?.trim() || collaborationAlias(member.sessionId)}`) ||
						Boolean(member.profileName?.trim() && mentions.has(`@${member.profileName.trim()}`))),
			)
			.map((member) => member.sessionId);
		if (targets.length)
			await this.send({
				cwd: input.cwd,
				roomId: input.roomId,
				senderSessionId: input.sessionId,
				senderType: input.sessionId === this.store.room(input.roomId).ownerSessionId ? "user" : "agent",
				route: "broadcast",
				targetSessionIds: targets,
				kind: "message",
				taskId: task.id,
				body: `任务「${task.title}」中提到了你：${input.body.trim()}`,
				idempotencyKey: `room-task-mention:${task.id}:${task.updates.length}`,
			});
		return task;
	}

	private async send(input: Parameters<SessionRoomApi["send"]>[0]): Promise<SessionRoomSendResult> {
		const room = this.store.room(input.roomId);
		const cwd = resolve(input.cwd);
		if (cwd !== room.cwd) throw roomError("Room 不属于当前项目", "room_cwd_mismatch");
		const members = this.store.members(input.roomId);
		const availability = new Map<string, SessionRoomAvailability>();
		for (const member of members) {
			const value = this.getAvailability(cwd, member.sessionId);
			if (value) availability.set(member.sessionId, value);
		}
		const senderType = input.senderType ?? "agent";
		const targets = resolveSessionRoomTargets({
			route: input.route,
			senderSessionId: input.senderSessionId,
			senderType,
			targetSessionIds: input.targetSessionIds,
			members,
			availability,
		});
		if (targets.length === 0) throw roomError("Room 没有其他成员可响应", "room_no_targets");
		if (input.capabilities && input.kind !== "task") {
			throw roomError("只有 Room task 可以携带能力租约", "room_capabilities_kind_invalid");
		}
		const capabilities = input.capabilities
			? {
					...input.capabilities,
					allowedTools: [...new Set(input.capabilities.allowedTools)].slice(0, 32),
				}
			: undefined;
		if (capabilities && capabilities.allowedTools.length === 0) {
			throw roomError("Room task 的能力租约不能为空", "room_capabilities_empty");
		}
		const draft: SessionRoomMessageDraft = {
			roomId: input.roomId,
			senderSessionId: input.senderSessionId,
			senderType,
			targetSessionIds: targets,
			route: input.route,
			kind: input.kind ?? "message",
			body: checkedBody(input.body),
			...(input.attachments?.length ? { attachments: input.attachments } : {}),
			...(input.taskId ? { taskId: input.taskId } : {}),
			...(capabilities ? { capabilities } : {}),
			...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
			...(input.basedOnSeq !== undefined ? { basedOnSeq: input.basedOnSeq } : {}),
			idempotencyKey: input.idempotencyKey?.trim() || randomUUID(),
			createdAt: new Date().toISOString(),
		};
		const appended = this.store.appendMessage(draft);
		if (appended.deduplicated) {
			setImmediate(() => void this.resumeDeliveries());
			return {
				message: appended.message,
				deduplicated: true,
				deliveredTo: appended.message.targetSessionIds,
				errors: [],
			};
		}
		if (appended.message.kind !== "system") setImmediate(() => void this.deliverTargets(cwd, appended.message));
		return {
			message: appended.message,
			deduplicated: false,
			deliveredTo: appended.message.targetSessionIds,
			errors: [],
		};
	}

	private async resumeDeliveries(): Promise<void> {
		await Promise.all(
			this.store
				.pending()
				.map(({ message, targetSessionId }) =>
					this.deliverTargets(this.store.room(message.roomId).cwd, message, [targetSessionId]),
				),
		);
	}

	private async deliverTargets(
		cwd: string,
		message: SessionRoomMessage,
		targets = message.targetSessionIds,
	): Promise<void> {
		await Promise.all(
			targets.map(async (targetSessionId) => {
				const key = `${message.id}:${targetSessionId}`;
				if (this.deliveriesInFlight.has(key) || !this.store.hasPendingDelivery(message.id, targetSessionId)) return;
				this.deliveriesInFlight.add(key);
				try {
					try {
						await this.deliver({ cwd, targetSessionId, message });
					} catch (error) {
						this.appendDeliveryError(message, targetSessionId, error);
					}
					this.store.completeDelivery(message.id, targetSessionId);
				} catch {
					// 写入投递结果失败时保留待投递记录，下次继续处理。
				} finally {
					this.deliveriesInFlight.delete(key);
				}
			}),
		);
	}

	private appendDeliveryError(message: SessionRoomMessage, targetSessionId: string, error: unknown): void {
		const target = this.store
			.members(message.roomId)
			.find((member) => member.sessionId === targetSessionId && member.leftAt === undefined);
		if (!target) return;
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		const detail =
			code === "room_reply_stale"
				? "Room 有新消息，旧回复已取消"
				: code === "room_reply_duplicate"
					? "相同回复已由其他智能体发送"
					: `智能体未响应：${error instanceof Error ? error.message : String(error)}`;
		this.store.appendMessage({
			roomId: message.roomId,
			senderSessionId: targetSessionId,
			senderType: "agent",
			targetSessionIds: [message.senderSessionId],
			route: "direct",
			kind: "system",
			body: detail,
			replyToMessageId: message.id,
			basedOnSeq: message.seq,
			idempotencyKey: `room-delivery-error:${message.id}:${targetSessionId}`,
			createdAt: new Date().toISOString(),
		});
	}

	private async read(
		input: Parameters<SessionRoomApi["read"]>[0],
	): Promise<Awaited<ReturnType<SessionRoomApi["read"]>>> {
		const room = this.store.room(input.roomId);
		if (resolve(input.cwd) !== room.cwd) throw roomError("Room 不属于当前项目", "room_cwd_mismatch");
		const cursor = this.store.cursor(input.roomId, input.sessionId);
		const result = this.store.readMessages(
			input.roomId,
			input.sessionId,
			input.afterSeq ?? cursor.lastReadSeq,
			checkedLimit(input.limit),
		);
		const lastReadSeq = result.messages.at(-1)?.seq ?? input.afterSeq ?? cursor.lastReadSeq;
		if (input.markRead !== false) this.store.advanceCursor(input.roomId, input.sessionId, lastReadSeq);
		return {
			summary: this.store.summary(input.roomId),
			messages: result.messages,
			cursor: this.store.cursor(input.roomId, input.sessionId),
			...(result.nextSeq !== undefined ? { nextSeq: result.nextSeq } : {}),
		};
	}

	static formatMessageForSession(message: SessionRoomMessage): string {
		return formatRoomMessage(message);
	}
}
