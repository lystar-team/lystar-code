export interface RoomSessionMembership {
	members: readonly { sessionId: string; role: "owner" | "member"; leftAt?: string }[];
}

export function markRoomAgentSessions<T extends { id: string }>(
	sessions: readonly T[],
	rooms: readonly RoomSessionMembership[],
): Array<T & { roomMember?: true }> {
	const roomMemberSessionIds = new Set(
		rooms.flatMap((room) =>
			room.members.filter((member) => member.role === "member").map((member) => member.sessionId),
		),
	);
	return sessions.map((session) =>
		roomMemberSessionIds.has(session.id) ? { ...session, roomMember: true as const } : session,
	);
}
