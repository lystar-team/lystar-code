import type { AgentCapabilityLease } from "./input-origin.ts";

export type SessionRoomMode = "direct" | "group";
export type SessionRoomRoute = "direct" | "broadcast" | "one_of_us";
export type SessionRoomSenderType = "agent" | "user";
export type SessionRoomMessageKind = "task" | "message" | "question" | "answer" | "status" | "result" | "system";
export type SessionRoomMemberRole = "owner" | "member";

export interface SessionRoom {
	id: string;
	cwd: string;
	title: string;
	ownerSessionId: string;
	mode: SessionRoomMode;
	createdAt: string;
	updatedAt: string;
}

export interface SessionRoomMember {
	roomId: string;
	sessionId: string;
	role: SessionRoomMemberRole;
	joinedAt: string;
	leftAt?: string;
	lastReadSeq: number;
	nickname?: string;
	profileId?: string;
	profileName?: string;
	profileIcon?: string;
}

export interface SessionRoomCursor {
	roomId: string;
	sessionId: string;
	lastReadSeq: number;
}

export interface SessionRoomAttachment {
	path: string;
	filename: string;
	mimeType: string;
}

export interface SessionRoomMessage {
	id: string;
	roomId: string;
	seq: number;
	senderSessionId: string;
	senderType: SessionRoomSenderType;
	targetSessionIds: readonly string[];
	route: SessionRoomRoute;
	kind: SessionRoomMessageKind;
	body: string;
	attachments?: readonly SessionRoomAttachment[];
	taskId?: string;
	capabilities?: AgentCapabilityLease;
	replyToMessageId?: string;
	basedOnSeq?: number;
	idempotencyKey: string;
	createdAt: string;
}

export type SessionRoomTaskStatus = "todo" | "doing" | "blocked" | "done";

export interface SessionRoomTaskUpdate {
	actorSessionId: string;
	status: SessionRoomTaskStatus;
	note?: string;
	kind?: "comment";
	createdAt: string;
}

export interface SessionRoomTask {
	id: string;
	roomId: string;
	title: string;
	description: string;
	status: SessionRoomTaskStatus;
	createdBySessionId: string;
	assigneeSessionId?: string;
	resultMessageId?: string;
	resultText?: string;
	updates: readonly SessionRoomTaskUpdate[];
	createdAt: string;
	updatedAt: string;
}

export interface SessionRoomSummary {
	room: SessionRoom;
	members: readonly SessionRoomMember[];
	latestSeq: number;
}

export interface SessionRoomReadResult {
	summary: SessionRoomSummary;
	messages: readonly SessionRoomMessage[];
	cursor: SessionRoomCursor;
	nextSeq?: number;
}

export interface SessionRoomDeliveryError {
	sessionId: string;
	message: string;
}

export interface SessionRoomSendResult {
	message: SessionRoomMessage;
	deduplicated: boolean;
	deliveredTo: readonly string[];
	errors: readonly SessionRoomDeliveryError[];
}

export interface SessionRoomApi {
	create(input: {
		cwd: string;
		ownerSessionId: string;
		title?: string;
		mode?: SessionRoomMode;
	}): Promise<SessionRoomSummary>;
	join(input: {
		cwd: string;
		roomId: string;
		sessionId: string;
		nickname?: string;
		profileId?: string;
		profileName?: string;
		profileIcon?: string;
	}): Promise<SessionRoomSummary>;
	leave(input: { cwd: string; roomId: string; sessionId: string }): Promise<SessionRoomSummary>;
	rename(input: { cwd: string; roomId: string; sessionId: string; nickname: string }): Promise<SessionRoomSummary>;
	list(input: { cwd: string; sessionId: string }): Promise<SessionRoomSummary[]>;
	listAll(input: { cwd: string }): Promise<SessionRoomSummary[]>;
	send(input: {
		cwd: string;
		roomId: string;
		senderSessionId: string;
		senderType?: SessionRoomSenderType;
		route: SessionRoomRoute;
		targetSessionIds?: readonly string[];
		kind?: SessionRoomMessageKind;
		body: string;
		attachments?: readonly SessionRoomAttachment[];
		taskId?: string;
		capabilities?: AgentCapabilityLease;
		replyToMessageId?: string;
		basedOnSeq?: number;
		idempotencyKey?: string;
	}): Promise<SessionRoomSendResult>;
	read(input: {
		cwd: string;
		roomId: string;
		sessionId: string;
		afterSeq?: number;
		limit?: number;
		markRead?: boolean;
	}): Promise<SessionRoomReadResult>;
	taskCreate(input: {
		cwd: string;
		roomId: string;
		sessionId: string;
		title: string;
		description?: string;
	}): Promise<SessionRoomTask>;
	taskList(input: { cwd: string; roomId: string; sessionId: string }): Promise<SessionRoomTask[]>;
	taskClaim(input: { cwd: string; roomId: string; taskId: string; sessionId: string }): Promise<SessionRoomTask>;
	taskUpdate(input: {
		cwd: string;
		roomId: string;
		taskId: string;
		sessionId: string;
		status: SessionRoomTaskStatus;
		note?: string;
	}): Promise<SessionRoomTask>;
	taskEdit(input: {
		cwd: string;
		roomId: string;
		taskId: string;
		sessionId: string;
		title?: string;
		description?: string;
		assigneeSessionId?: string | null;
	}): Promise<SessionRoomTask>;
	taskComment(input: {
		cwd: string;
		roomId: string;
		taskId: string;
		sessionId: string;
		body: string;
	}): Promise<SessionRoomTask>;
}
