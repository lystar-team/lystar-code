import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
	SessionRoomApi,
	SessionRoomMessage,
	SessionRoomSendResult,
	SessionRoomSummary,
} from "@earendil-works/pi-coding-agent/core";
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
	return `[Room ${message.roomId} #${message.seq} ${message.kind} from ${message.senderSessionId}]\n${message.body}`;
}

export class SessionRoomCoordinator {
	private readonly store: SessionRoomStore;
	private readonly getAvailability: (cwd: string, sessionId: string) => SessionRoomAvailability | undefined;
	private readonly deliver: (input: SessionRoomDeliveryInput) => Promise<void>;

	constructor(options: SessionRoomCoordinatorOptions) {
		this.store = options.store;
		this.getAvailability = options.getAvailability ?? (() => undefined);
		this.deliver = options.deliver;
	}

	api(): SessionRoomApi {
		return {
			create: (input) => this.create(input),
			join: (input) => this.join(input),
			leave: (input) => this.leave(input),
			list: (input) => this.list(input),
			listAll: (input) => this.listAll(input),
			send: (input) => this.send(input),
			read: (input) => this.read(input),
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
		const now = new Date().toISOString();
		return this.store.joinMember({
			roomId: input.roomId,
			sessionId: input.sessionId,
			role: "member",
			joinedAt: now,
			lastReadSeq: 0,
		});
	}

	private async leave(input: Parameters<SessionRoomApi["leave"]>[0]): Promise<SessionRoomSummary> {
		const room = this.store.room(input.roomId);
		if (resolve(input.cwd) !== room.cwd) throw roomError("Room 不属于当前项目", "room_cwd_mismatch");
		return this.store.leaveMember(input.roomId, input.sessionId, new Date().toISOString());
	}

	private async list(input: Parameters<SessionRoomApi["list"]>[0]): Promise<SessionRoomSummary[]> {
		return this.store.listRooms(resolve(input.cwd), input.sessionId);
	}

	private async listAll(input: Parameters<SessionRoomApi["listAll"]>[0]): Promise<SessionRoomSummary[]> {
		return this.store.listAllRooms(resolve(input.cwd));
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
		const targets = resolveSessionRoomTargets({
			route: input.route,
			senderSessionId: input.senderSessionId,
			targetSessionIds: input.targetSessionIds,
			members,
			availability,
		});
		if (targets.length === 0) throw roomError("Room 没有其他成员可响应", "room_no_targets");
		const draft: SessionRoomMessageDraft = {
			roomId: input.roomId,
			senderSessionId: input.senderSessionId,
			targetSessionIds: targets,
			route: input.route,
			kind: input.kind ?? "message",
			body: checkedBody(input.body),
			...(input.taskId ? { taskId: input.taskId } : {}),
			...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
			...(input.basedOnSeq !== undefined ? { basedOnSeq: input.basedOnSeq } : {}),
			idempotencyKey: input.idempotencyKey?.trim() || randomUUID(),
			createdAt: new Date().toISOString(),
		};
		const appended = this.store.appendMessage(draft);
		if (appended.deduplicated) {
			return {
				message: appended.message,
				deduplicated: true,
				deliveredTo: appended.message.targetSessionIds,
				errors: [],
			};
		}
		setImmediate(() => void this.deliverTargets(cwd, appended.message));
		return {
			message: appended.message,
			deduplicated: false,
			deliveredTo: appended.message.targetSessionIds,
			errors: [],
		};
	}

	private async deliverTargets(cwd: string, message: SessionRoomMessage): Promise<void> {
		await Promise.all(
			message.targetSessionIds.map(async (targetSessionId) => {
				try {
					await this.deliver({ cwd, targetSessionId, message });
				} catch (error) {
					try {
						this.appendDeliveryError(message, targetSessionId, error);
					} catch {
						// Room 已经记录原消息，投递失败不应产生未处理的后台拒绝。
					}
				}
			}),
		);
	}

	private appendDeliveryError(message: SessionRoomMessage, targetSessionId: string, error: unknown): void {
		const target = this.store
			.members(message.roomId)
			.find((member) => member.sessionId === targetSessionId && member.leftAt === undefined);
		if (!target) return;
		const detail = error instanceof Error ? error.message : String(error);
		this.store.appendMessage({
			roomId: message.roomId,
			senderSessionId: targetSessionId,
			targetSessionIds: [message.senderSessionId],
			route: "direct",
			kind: "system",
			body: `智能体未响应：${detail}`,
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
