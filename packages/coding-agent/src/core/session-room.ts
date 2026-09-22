export type SessionRoomMode = "direct" | "group";
export type SessionRoomRoute = "direct" | "broadcast" | "one_of_us";
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
}

export interface SessionRoomCursor {
	roomId: string;
	sessionId: string;
	lastReadSeq: number;
}

export interface SessionRoomMessage {
	id: string;
	roomId: string;
	seq: number;
	senderSessionId: string;
	targetSessionIds: readonly string[];
	route: SessionRoomRoute;
	kind: SessionRoomMessageKind;
	body: string;
	taskId?: string;
	replyToMessageId?: string;
	basedOnSeq?: number;
	idempotencyKey: string;
	createdAt: string;
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
	join(input: { cwd: string; roomId: string; sessionId: string }): Promise<SessionRoomSummary>;
	leave(input: { cwd: string; roomId: string; sessionId: string }): Promise<SessionRoomSummary>;
	list(input: { cwd: string; sessionId: string }): Promise<SessionRoomSummary[]>;
	listAll(input: { cwd: string }): Promise<SessionRoomSummary[]>;
	send(input: {
		cwd: string;
		roomId: string;
		senderSessionId: string;
		route: SessionRoomRoute;
		targetSessionIds?: readonly string[];
		kind?: SessionRoomMessageKind;
		body: string;
		taskId?: string;
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
}
