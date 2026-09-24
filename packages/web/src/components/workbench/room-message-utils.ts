import type { WebRoomMessage } from "../../types";

export interface PendingRoomAgentReply {
	projectId: string;
	roomId: string;
	requestMessageId: string;
	sessionId: string;
	createdAt: string;
}

function isTerminalRoomReply(message: WebRoomMessage, pending: PendingRoomAgentReply): boolean {
	return (
		message.roomId === pending.roomId &&
		message.senderSessionId === pending.sessionId &&
		message.replyToMessageId === pending.requestMessageId &&
		(message.kind === "answer" || message.kind === "result" || message.kind === "system")
	);
}

export function addPendingRoomAgentReplies(
	current: readonly PendingRoomAgentReply[],
	projectId: string,
	request: WebRoomMessage,
	observedMessages: readonly WebRoomMessage[],
	failedSessionIds: readonly string[] = [],
): PendingRoomAgentReply[] {
	if (request.senderType !== "user") return [...current];
	const failed = new Set(failedSessionIds);
	const next = [...current];
	for (const sessionId of request.targetSessionIds) {
		const pending: PendingRoomAgentReply = {
			projectId,
			roomId: request.roomId,
			requestMessageId: request.id,
			sessionId,
			createdAt: request.createdAt,
		};
		if (
			failed.has(sessionId) ||
			observedMessages.some((message) => isTerminalRoomReply(message, pending)) ||
				next.some(
					(candidate) =>
						candidate.projectId === pending.projectId &&
						candidate.roomId === pending.roomId &&
						candidate.requestMessageId === pending.requestMessageId &&
					candidate.sessionId === pending.sessionId,
			)
		) {
			continue;
		}
		next.push(pending);
	}
	return next;
}

export function settlePendingRoomAgentReplies(
	current: readonly PendingRoomAgentReply[],
	incomingMessages: readonly WebRoomMessage[],
): PendingRoomAgentReply[] {
	return current.filter(
		(pending) => !incomingMessages.some((message) => isTerminalRoomReply(message, pending)),
	);
}

export function mergeRoomMessages(
	current: readonly WebRoomMessage[],
	incoming: readonly WebRoomMessage[],
): WebRoomMessage[] {
	const messagesById = new Map(current.map((message) => [message.id, message]));
	for (const message of incoming) {
		if (!messagesById.has(message.id)) messagesById.set(message.id, message);
	}
	return [...messagesById.values()].sort((left, right) => left.seq - right.seq);
}
