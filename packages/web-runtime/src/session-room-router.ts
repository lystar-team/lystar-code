import type { SessionRoomMember, SessionRoomRoute, SessionRoomSenderType } from "@earendil-works/pi-coding-agent/core";

export type SessionRoomAvailability =
	| "idle"
	| "running"
	| "waiting_for_input"
	| "completed"
	| "failed"
	| "aborted"
	| "interrupted"
	| "offline";

export interface SessionRoomRoutingInput {
	route: SessionRoomRoute;
	senderSessionId: string;
	senderType?: SessionRoomSenderType;
	targetSessionIds?: readonly string[];
	members: readonly SessionRoomMember[];
	availability?: ReadonlyMap<string, SessionRoomAvailability>;
}

function routingError(message: string, code: string): Error & { code: string; retryable: boolean } {
	return Object.assign(new Error(message), { code, retryable: false });
}

function activeMembers(members: readonly SessionRoomMember[]): SessionRoomMember[] {
	return members.filter((member) => member.leftAt === undefined);
}

function uniqueTargetIds(targetSessionIds: readonly string[] | undefined): string[] {
	return [...new Set((targetSessionIds ?? []).map((sessionId) => sessionId.trim()).filter(Boolean))];
}

function availabilityRank(availability: SessionRoomAvailability | undefined): number {
	switch (availability) {
		case "idle":
			return 0;
		case "waiting_for_input":
			return 1;
		case "completed":
		case "failed":
		case "aborted":
		case "interrupted":
			return 2;
		case "running":
			return 3;
		case "offline":
			return 4;
		default:
			return 2;
	}
}

function assertActiveTarget(
	targetSessionId: string,
	senderSessionId: string,
	senderType: SessionRoomSenderType,
	members: readonly SessionRoomMember[],
): void {
	if (targetSessionId === senderSessionId && senderType !== "user") {
		throw routingError("Room 消息不能定向发送给发送者自己", "room_target_sender");
	}
	const target = members.find((member) => member.sessionId === targetSessionId && member.leftAt === undefined);
	if (!target) throw routingError(`Room 成员不存在或已退出：${targetSessionId}`, "room_target_not_member");
}

export function resolveSessionRoomTargets(input: SessionRoomRoutingInput): string[] {
	const active = activeMembers(input.members);
	const requested = uniqueTargetIds(input.targetSessionIds);
	const senderType = input.senderType ?? "agent";
	if (input.route === "direct") {
		if (requested.length !== 1) {
			throw routingError("direct 路由必须指定一个目标成员", "room_direct_target_required");
		}
		assertActiveTarget(requested[0], input.senderSessionId, senderType, active);
		return requested;
	}
	if (input.route === "broadcast") {
		const candidates =
			requested.length > 0
				? requested
				: active
						.filter((member) => senderType === "user" || member.sessionId !== input.senderSessionId)
						.map((member) => member.sessionId);
		for (const sessionId of candidates) assertActiveTarget(sessionId, input.senderSessionId, senderType, active);
		const memberById = new Map(active.map((member) => [member.sessionId, member]));
		return candidates.sort(
			(left, right) =>
				(memberById.get(left)?.joinedAt ?? "").localeCompare(memberById.get(right)?.joinedAt ?? "") ||
				left.localeCompare(right),
		);
	}
	const candidates = (requested.length > 0 ? requested : active.map((member) => member.sessionId)).filter(
		(sessionId) => senderType === "user" || sessionId !== input.senderSessionId,
	);
	for (const sessionId of candidates) assertActiveTarget(sessionId, input.senderSessionId, senderType, active);
	if (candidates.length === 0) throw routingError("one-of-us 路由没有可用成员", "room_one_of_us_target_required");
	const memberById = new Map(active.map((member) => [member.sessionId, member]));
	candidates.sort((left, right) => {
		const leftMember = memberById.get(left)!;
		const rightMember = memberById.get(right)!;
		return (
			availabilityRank(input.availability?.get(left)) - availabilityRank(input.availability?.get(right)) ||
			leftMember.joinedAt.localeCompare(rightMember.joinedAt) ||
			left.localeCompare(right)
		);
	});
	return [candidates[0]];
}
