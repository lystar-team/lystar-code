import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
	SessionCollaborationResult,
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
	messages?: readonly SessionRoomMessage[];
}

export interface SessionRoomCoordinatorOptions {
	store: SessionRoomStore;
	getAvailability?(cwd: string, sessionId: string): SessionRoomAvailability | undefined;
	getProfileDescription?(cwd: string, profileId: string): string | undefined;
	deliver(input: SessionRoomDeliveryInput): Promise<void> | Promise<number>;
	acceptTaskResult?(task: SessionRoomTask, ownerSessionId: string): Promise<SessionCollaborationResult>;
}

function roomError(message: string, code: string): Error & { code: string; retryable: boolean } {
	return Object.assign(new Error(message), { code, retryable: false });
}

function checkedBody(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) throw roomError("智能体协作消息不能为空", "room_message_empty");
	if (trimmed.length > 64 * 1024) throw roomError("智能体协作消息超过 64 KiB 限制", "room_message_too_large");
	return trimmed;
}

function checkedLimit(limit: number | undefined): number {
	if (limit === undefined) return 50;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw roomError("智能体协作消息读取数量必须在 1 到 100 之间", "room_read_limit_invalid");
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
	private readonly getProfileDescription: (cwd: string, profileId: string) => string | undefined;
	private readonly deliver: (input: SessionRoomDeliveryInput) => Promise<void> | Promise<number>;
	private readonly acceptTaskResult?: (
		task: SessionRoomTask,
		ownerSessionId: string,
	) => Promise<SessionCollaborationResult>;
	private readonly deliveriesInFlight = new Set<string>();
	private readonly timer: ReturnType<typeof setInterval>;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private deliveryScheduled = false;
	private disposed = false;
	private operationQueue: Promise<void> = Promise.resolve();
	private readonly scheduledStaleTaskReclaims = new Set<string>();

	constructor(options: SessionRoomCoordinatorOptions) {
		this.store = options.store;
		this.getAvailability = options.getAvailability ?? (() => undefined);
		this.getProfileDescription = options.getProfileDescription ?? (() => undefined);
		this.deliver = options.deliver;
		this.acceptTaskResult = options.acceptTaskResult;
		this.scheduleDeliveries();
		this.timer = setInterval(() => {
			this.scheduleDeliveries();
			this.scheduleStaleTaskReclaim();
		}, 60_000);
		this.timer.unref?.();
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
		if (this.retryTimer) clearTimeout(this.retryTimer);
	}

	contextForSession(roomId: string, sessionId: string): { text: string; seq: number } {
		const summary = this.store.summary(roomId);
		const member = this.store.member(roomId, sessionId);
		const messages = this.store.readMessages(roomId, sessionId, Math.max(0, summary.latestSeq - 100), 100).messages;
		const names = new Map(
			summary.members.map((candidate) => [
				candidate.sessionId,
				candidate.nickname || candidate.profileName || collaborationAlias(candidate.sessionId),
			]),
		);
		let remaining = 32_000;
		const lines: string[] = [];
		for (const message of [...messages].reverse()) {
			const line = JSON.stringify({
				seq: message.seq,
				sender: names.get(message.senderSessionId),
				senderType: message.senderType,
				kind: message.kind,
				body: message.body.slice(0, remaining),
				taskId: message.taskId,
			});
			if (remaining <= 0) break;
			lines.unshift(line);
			remaining -= line.length;
		}
		return {
			seq: summary.latestSeq,
			text: [
				`协作空间：${summary.room.title}（${roomId}）`,
				`你的成员身份：${names.get(sessionId)}（${sessionId}），角色：${member.role}`,
				`读取位置：${member.lastReadSeq}；本轮共享消息边界：${summary.latestSeq}`,
				`成员：${JSON.stringify(summary.members.filter((candidate) => !candidate.leftAt).map((candidate) => ({ sessionId: candidate.sessionId, name: names.get(candidate.sessionId), profile: candidate.profileName || candidate.profileId, responsibility: candidate.profileDescription, role: candidate.role })))}`,
				`任务：${JSON.stringify(this.store.listTasks(roomId).map((task) => ({ id: task.id, title: task.title, status: task.status, assigneeSessionId: task.assigneeSessionId, resultText: task.resultText?.slice(0, 2_000), executionSessionId: task.execution?.sessionId })))}`,
				"以下是已发布的共享消息，不包含其他成员的私有思考。需要更早的消息时使用 room_read。",
				...lines,
				"使用 room_send 向成员提问或发布结论；使用 room_task_create 创建执行任务。成员认领后，Runtime 会建立隔离执行工作区并回收结果，不需要你创建下级会话。不要重复其他成员已经交付的内容。",
			].join("\n"),
		};
	}

	api(): SessionRoomApi {
		return {
			create: (input) => this.enqueueOperation(() => this.create(input)),
			join: (input) => this.enqueueOperation(() => this.join(input)),
			leave: (input) => this.enqueueOperation(() => this.leave(input)),
			rename: (input) => this.enqueueOperation(() => this.rename(input)),
			list: (input) => this.enqueueOperation(() => this.list(input)),
			listAll: (input) => this.enqueueOperation(() => this.listAll(input)),
			send: (input) => this.enqueueOperation(() => this.send(input)),
			read: (input) => this.enqueueOperation(() => this.read(input)),
			taskCreate: (input) => this.enqueueOperation(() => this.taskCreate(input)),
			taskList: (input) => this.enqueueOperation(() => this.taskList(input)),
			taskClaim: (input) => this.enqueueOperation(() => this.taskClaim(input)),
			taskUpdate: (input) => this.enqueueOperation(() => this.taskUpdate(input)),
			taskEdit: (input) => this.enqueueOperation(() => this.taskEdit(input)),
			taskComment: (input) => this.enqueueOperation(() => this.taskComment(input)),
		};
	}

	private async create(input: Parameters<SessionRoomApi["create"]>[0]): Promise<SessionRoomSummary> {
		const cwd = resolve(input.cwd);
		const now = new Date().toISOString();
		const room = {
			id: randomUUID(),
			cwd,
			title: input.title?.trim() || "智能体协作",
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
		if (resolve(input.cwd) !== room.cwd) throw roomError("智能体协作不属于当前项目", "room_cwd_mismatch");
		const existing = this.store
			.members(input.roomId)
			.find((member) => member.sessionId === input.sessionId && !member.leftAt);
		const isNewAgent = !existing && input.sessionId !== room.ownerSessionId;
		if (isNewAgent && !input.profileId?.trim())
			throw roomError("智能体协作的新成员必须来自智能体配置", "room_profile_required");
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
			...(input.profileDescription?.trim() ||
			(input.profileId ? this.getProfileDescription(resolve(input.cwd), input.profileId) : undefined)
				? {
						profileDescription:
							input.profileDescription?.trim() ||
							this.getProfileDescription(resolve(input.cwd), input.profileId!),
					}
				: {}),
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
		if (resolve(input.cwd) !== room.cwd) throw roomError("智能体协作不属于当前项目", "room_cwd_mismatch");
		const assigned = this.store
			.listTasks(input.roomId)
			.filter((task) => task.assigneeSessionId === input.sessionId && task.status !== "done");
		const summary = this.store.leaveMember(input.roomId, input.sessionId, new Date().toISOString());
		for (const task of assigned) await this.offerTask(this.store.task(input.roomId, task.id), room.ownerSessionId);
		return summary;
	}

	private async rename(input: Parameters<SessionRoomApi["rename"]>[0]): Promise<SessionRoomSummary> {
		const room = this.store.room(input.roomId);
		if (resolve(input.cwd) !== room.cwd) throw roomError("智能体协作不属于当前项目", "room_cwd_mismatch");
		return this.store.renameMember(input.roomId, input.sessionId, input.nickname);
	}

	private async list(input: Parameters<SessionRoomApi["list"]>[0]): Promise<SessionRoomSummary[]> {
		const rooms = this.store.listRooms(resolve(input.cwd), input.sessionId);
		for (const { room } of rooms) await this.releaseStaleTasks(room.id);
		return rooms;
	}

	private async listAll(input: Parameters<SessionRoomApi["listAll"]>[0]): Promise<SessionRoomSummary[]> {
		const cwd = resolve(input.cwd);
		const rooms = this.store.listAllRooms(cwd);
		this.scheduleStaleTaskReclaim(cwd);
		return rooms;
	}

	private enqueueOperation<T>(run: () => Promise<T>): Promise<T> {
		const previous = this.operationQueue;
		const execution = previous.catch(() => {}).then(run);
		this.operationQueue = execution.then(
			() => undefined,
			() => undefined,
		);
		return execution;
	}

	private scheduleStaleTaskReclaim(cwd?: string): void {
		const key = cwd ?? "*";
		if (this.scheduledStaleTaskReclaims.has(key)) return;
		this.scheduledStaleTaskReclaims.add(key);
		void this.enqueueOperation(async () => {
			try {
				if (cwd === undefined) await this.reclaimStaleTasks();
				else await this.reclaimStaleTasksForCwd(cwd);
			} finally {
				this.scheduledStaleTaskReclaims.delete(key);
			}
		}).catch((error: unknown) => {
			this.scheduledStaleTaskReclaims.delete(key);
			console.error("智能体协作任务回收失败", error);
		});
	}

	private async reclaimStaleTasksForCwd(cwd: string): Promise<void> {
		for (const { room } of this.store.listAllRooms(cwd)) await this.releaseStaleTasks(room.id);
	}

	private async reclaimStaleTasks(): Promise<void> {
		for (const roomId of this.store.roomIds()) await this.releaseStaleTasks(roomId);
	}

	private async releaseStaleTasks(roomId: string): Promise<void> {
		const room = this.store.room(roomId);
		for (const task of this.store.listTasks(roomId)) {
			if (task.status !== "doing" || !task.assigneeSessionId || task.resultText || task.execution) continue;
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
		if (resolve(cwd) !== room.cwd) throw roomError("智能体协作不属于当前项目", "room_cwd_mismatch");
		const member = this.store.member(roomId, sessionId);
		if (member.leftAt) throw roomError("智能体协作成员已退出", "room_member_left");
	}

	private async offerTask(
		task: SessionRoomTask,
		senderSessionId: string,
		targetSessionId?: string,
		excludedSessionId?: string,
	): Promise<void> {
		const members = this.store
			.members(task.roomId)
			.filter(
				(member) =>
					member.role === "member" &&
					!member.leftAt &&
					member.sessionId !== senderSessionId &&
					member.sessionId !== excludedSessionId &&
					(!targetSessionId || member.sessionId === targetSessionId),
			);
		if (!members.length) return;
		const candidates = members.map((member) => member.sessionId);
		const hasResponsibilities = members.some(
			(member) => member.profileName?.trim() || member.profileDescription?.trim(),
		);
		const route = targetSessionId ? "direct" : hasResponsibilities ? "one_of_us" : "broadcast";
		await this.send({
			cwd: this.store.room(task.roomId).cwd,
			roomId: task.roomId,
			senderSessionId,
			senderType: senderSessionId === this.store.room(task.roomId).ownerSessionId ? "user" : "agent",
			route,
			targetSessionIds: candidates,
			kind: "task",
			taskId: task.id,
			body: `待认领任务：${task.title}\n${task.description}\n任务 ID：${task.id}\n智能体协作 ID：${task.roomId}\n使用 room_claim 认领；未认领不要执行。`,
			capabilities: { allowedTools: ["room_claim"] },
			idempotencyKey: `room-task-offer:${task.id}:${task.updatedAt}:${targetSessionId ?? "role"}`,
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
			body: `任务：${task.title}\n${task.description}\n任务 ID：${task.id}\n智能体协作 ID：${task.roomId}\n此任务由 Runtime 在隔离工作区执行；提交实际产物、验证结果和阻塞，不创建下级会话。`,
			capabilities: {
				allowedTools: [
					"read",
					"grep",
					"find",
					"ls",
					"session_create",
					"session_send",
					"session_wait",
					"session_list",
					"session_profiles",
					"session_stop",
					"room_read",
					"room_send",
					"room_task_list",
					"room_task_update",
				],
			},
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
		if (
			input.status === "done" &&
			previous.execution?.result?.outcome === "completed" &&
			!previous.execution.result.error
		) {
			if (!this.acceptTaskResult)
				throw roomError("当前 Runtime 不支持接收任务产物", "room_task_acceptance_unavailable");
			const acceptedResult = await this.acceptTaskResult(previous, input.sessionId);
			this.store.recordTaskAcceptance(input.roomId, input.taskId, input.sessionId, acceptedResult);
		}
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
		if (cwd !== room.cwd) throw roomError("智能体协作不属于当前项目", "room_cwd_mismatch");
		const members = this.store.members(input.roomId);
		const availability = new Map<string, SessionRoomAvailability>();
		for (const member of members) {
			const value = this.getAvailability(cwd, member.sessionId);
			if (value) availability.set(member.sessionId, value);
		}
		const senderType = input.senderType ?? "agent";
		const userRequest =
			senderType === "agent" &&
			input.kind === "answer" &&
			input.route === "direct" &&
			input.targetSessionIds?.length === 1 &&
			input.targetSessionIds[0] === input.senderSessionId &&
			input.replyToMessageId &&
			input.basedOnSeq !== undefined
				? this.store.readMessages(input.roomId, input.senderSessionId, input.basedOnSeq - 1, 1).messages[0]
				: undefined;
		// 用户借主会话发送广播，主智能体的答案只记录到该用户消息，不构成自发任务。
		const targets =
			userRequest?.id === input.replyToMessageId &&
			userRequest?.senderType === "user" &&
			userRequest.senderSessionId === input.senderSessionId &&
			userRequest.targetSessionIds.includes(input.senderSessionId)
				? [input.senderSessionId]
				: resolveSessionRoomTargets({
						route: input.route,
						senderSessionId: input.senderSessionId,
						senderType,
						targetSessionIds: input.targetSessionIds,
						members,
						availability,
						body: input.body,
					});
		if (targets.length === 0) throw roomError("智能体协作没有其他成员可响应", "room_no_targets");
		if (input.capabilities && input.kind !== "task") {
			throw roomError("只有智能体协作任务可以携带能力租约", "room_capabilities_kind_invalid");
		}
		const capabilities = input.capabilities
			? {
					...input.capabilities,
					allowedTools: [...new Set(input.capabilities.allowedTools)].slice(0, 32),
				}
			: undefined;
		if (capabilities && capabilities.allowedTools.length === 0) {
			throw roomError("智能体协作任务的能力租约不能为空", "room_capabilities_empty");
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
			this.scheduleDeliveries();
			return {
				message: appended.message,
				deduplicated: true,
				deliveredTo: appended.message.targetSessionIds,
				errors: [],
			};
		}
		if (appended.message.kind !== "system") this.scheduleDeliveries();
		return {
			message: appended.message,
			deduplicated: false,
			deliveredTo: appended.message.targetSessionIds,
			errors: [],
		};
	}

	private scheduleDeliveries(): void {
		if (this.disposed || this.deliveryScheduled) return;
		this.deliveryScheduled = true;
		setImmediate(() => {
			this.deliveryScheduled = false;
			if (this.disposed) return;
			void this.resumeDeliveries().catch((error: unknown) => console.error("协作消息恢复失败", error));
		});
	}

	private async resumeDeliveries(): Promise<void> {
		const groups = new Map<string, ReturnType<SessionRoomStore["pending"]>>();
		let retryAt = Infinity;
		for (const pending of this.store.pending()) {
			const key = `${pending.message.roomId}:${pending.targetSessionId}`;
			if (this.deliveriesInFlight.has(key)) continue;
			if (pending.nextAttemptAt > Date.now()) {
				retryAt = Math.min(retryAt, pending.nextAttemptAt);
				continue;
			}
			const group = groups.get(key) ?? [];
			group.push(pending);
			groups.set(key, group);
		}
		if (this.retryTimer) clearTimeout(this.retryTimer);
		if (Number.isFinite(retryAt)) {
			this.retryTimer = setTimeout(() => this.scheduleDeliveries(), Math.max(1, retryAt - Date.now()));
			this.retryTimer.unref?.();
		}
		await Promise.all(
			[...groups].map(async ([key, pending]) => {
				const first = pending[0]!;
				const batch =
					first.message.kind === "task"
						? [first]
						: pending.slice(
								0,
								pending.findIndex((item) => item.message.kind === "task") < 0
									? pending.length
									: pending.findIndex((item) => item.message.kind === "task"),
							);
				const messages = batch.map((item) => item.message);
				const message = messages.at(-1)!;
				const targetSessionId = first.targetSessionId;
				this.deliveriesInFlight.add(key);
				try {
					const seq = await this.deliver({
						cwd: this.store.room(message.roomId).cwd,
						targetSessionId,
						message,
						messages,
					});
					if (!this.disposed)
						for (const item of batch)
							this.store.completeDelivery(
								item.message.id,
								targetSessionId,
								typeof seq === "number" ? seq : message.seq,
							);
				} catch (error) {
					if (this.disposed) return;
					const code = error instanceof Error && "code" in error ? error.code : undefined;
					const permanent =
						code === "room_reply_duplicate" ||
						(error instanceof Error &&
							"retryable" in error &&
							error.retryable === false &&
							code !== "room_reply_stale");
					for (const item of batch) {
						if (permanent) this.store.completeDelivery(item.message.id, targetSessionId);
						else this.store.retryDelivery(item.message.id, targetSessionId);
					}
					if (code !== "room_reply_duplicate") this.appendDeliveryError(message, targetSessionId, error);
				} finally {
					this.deliveriesInFlight.delete(key);
					this.scheduleDeliveries();
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
				? "智能体协作有新消息，旧回复已取消"
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
		if (resolve(input.cwd) !== room.cwd) throw roomError("智能体协作不属于当前项目", "room_cwd_mismatch");
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
