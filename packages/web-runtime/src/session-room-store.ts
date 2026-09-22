import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
	SessionRoom,
	SessionRoomCursor,
	SessionRoomMember,
	SessionRoomMessage,
	SessionRoomSummary,
} from "@earendil-works/pi-coding-agent/core";

type RoomJournalRecord =
	| { type: "room_created"; room: SessionRoom }
	| { type: "room_updated"; room: SessionRoom }
	| { type: "member_joined"; member: SessionRoomMember }
	| { type: "member_left"; roomId: string; sessionId: string; leftAt: string }
	| { type: "cursor_advanced"; roomId: string; sessionId: string; lastReadSeq: number }
	| { type: "message_appended"; message: SessionRoomMessage };

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
		message.route === draft.route &&
		message.kind === draft.kind &&
		message.body === draft.body &&
		message.taskId === draft.taskId &&
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
		value.type !== "message_appended"
	) {
		throw roomError(`Room 记录类型未知：${value.type}`, "room_store_corrupt");
	}
	return value as unknown as RoomJournalRecord;
}

export interface SessionRoomMessageDraft {
	roomId: string;
	senderSessionId: string;
	targetSessionIds: readonly string[];
	route: SessionRoomMessage["route"];
	kind: SessionRoomMessage["kind"];
	body: string;
	taskId?: string;
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
	private readonly idempotency = new Map<string, SessionRoomMessage>();

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
		this.commit([
			{ type: "room_updated", room: { ...room, updatedAt: leftAt } },
			{ type: "member_left", roomId, sessionId, leftAt },
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
		const message: SessionRoomMessage = {
			id: randomUUID(),
			seq: (roomMessages.at(-1)?.seq ?? 0) + 1,
			roomId: draft.roomId,
			senderSessionId: draft.senderSessionId,
			targetSessionIds: [...draft.targetSessionIds],
			route: draft.route,
			kind: draft.kind,
			body: draft.body,
			...(draft.taskId ? { taskId: draft.taskId } : {}),
			...(draft.replyToMessageId ? { replyToMessageId: draft.replyToMessageId } : {}),
			...(draft.basedOnSeq !== undefined ? { basedOnSeq: draft.basedOnSeq } : {}),
			idempotencyKey: draft.idempotencyKey,
			createdAt: draft.createdAt,
		};
		this.commit([
			{ type: "room_updated", room: { ...room, updatedAt: message.createdAt } },
			{ type: "message_appended", message },
		]);
		return { message: clone(message), deduplicated: false };
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
			case "message_appended": {
				let messages = this.messages.get(record.message.roomId);
				if (!messages) {
					messages = [];
					this.messages.set(record.message.roomId, messages);
				}
				messages.push(clone(record.message));
				this.idempotency.set(
					`${record.message.roomId}:${record.message.senderSessionId}:${record.message.idempotencyKey}`,
					clone(record.message),
				);
				return;
			}
		}
	}
}
