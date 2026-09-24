import type { WebSessionSummary } from "../../types";

export type DropPosition = "before" | "after";

export function excludeRoomAgentSessions(
	sessions: readonly WebSessionSummary[],
	roomAgentSessionIds: ReadonlySet<string>,
): WebSessionSummary[] {
	return sessions.filter((session) => !session.roomMember && !roomAgentSessionIds.has(session.id));
}

export function hasUnreadSessions(
	sessions: readonly Pick<WebSessionSummary, "id" | "activity">[],
	unreadSessionIds: Readonly<Record<string, true>>,
): boolean {
	return sessions.some(
		(session) =>
			Boolean(unreadSessionIds[session.id]) &&
			session.activity !== "running" &&
			session.activity !== "waiting_for_input",
	);
}

export function hasUnreadProjectSessions(
	projects: readonly { readonly sessions: readonly Pick<WebSessionSummary, "id" | "activity">[] }[],
	unreadSessionIds: Readonly<Record<string, true>>,
): boolean {
	return projects.some((project) => hasUnreadSessions(project.sessions, unreadSessionIds));
}

export function reorderIds(
	ids: readonly string[],
	sourceId: string,
	targetId: string,
	position: DropPosition,
): string[] {
	if (sourceId === targetId) return [...ids];
	const next = ids.filter((id) => id !== sourceId);
	const targetIndex = next.indexOf(targetId);
	if (targetIndex < 0) return [...ids];
	next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);
	return next;
}
