import { sessionTitle } from "../../state/workbench-state.ts";
import type { WebProject, WebSessionSummary } from "../../types";

export type DropPosition = "before" | "after";
export type SessionListTab = "all" | "running" | "completed";

export function isSessionRunning(session: Pick<WebSessionSummary, "activity">): boolean {
	return session.activity === "running" || session.activity === "waiting_for_input";
}

export function isSessionUnread(
	session: Pick<WebSessionSummary, "id" | "activity">,
	unreadSessionIds: Readonly<Record<string, true>>,
): boolean {
	return Boolean(unreadSessionIds?.[session.id]) && !isSessionRunning(session);
}

export function sessionMatchesTab(
	session: Pick<WebSessionSummary, "id" | "activity">,
	tab: SessionListTab,
	unreadSessionIds: Readonly<Record<string, true>>,
): boolean {
	return tab === "all" || (tab === "running" ? isSessionRunning(session) : isSessionUnread(session, unreadSessionIds));
}

export function isResumedCompletedSession(
	previous: { id?: string; activity?: WebSessionSummary["activity"] },
	current: { id?: string; activity?: WebSessionSummary["activity"] },
): boolean {
	return Boolean(
		previous.id &&
		previous.id === current.id &&
		previous.activity === "completed" &&
		(current.activity === "running" || current.activity === "waiting_for_input"),
	);
}

export function excludeRoomAgentSessions(
	sessions: readonly WebSessionSummary[],
	roomAgentSessionIds: ReadonlySet<string>,
): WebSessionSummary[] {
	return sessions.filter((session) => !session.roomMember && !roomAgentSessionIds.has(session.id));
}

export function orderedSessions(project: WebProject): WebSessionSummary[] {
	const base = [
		...project.sessions.filter((session) => session.pinned),
		...project.sessions.filter((session) => !session.pinned),
	];
	const ids = new Set(base.map((session) => session.id));
	const childrenByParent = new Map<string, WebSessionSummary[]>();
	for (const session of base) {
		if (session.relation !== "collaboration" || !session.parentId || !ids.has(session.parentId)) continue;
		const children = childrenByParent.get(session.parentId) ?? [];
		children.push(session);
		childrenByParent.set(session.parentId, children);
	}
	const nested: WebSessionSummary[] = [];
	const included = new Set<string>();
	const appendBranch = (root: WebSessionSummary) => {
		const stack = [root];
		while (stack.length) {
			const session = stack.pop()!;
			if (included.has(session.id)) continue;
			included.add(session.id);
			nested.push(session);
			const children = childrenByParent.get(session.id) ?? [];
			for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
		}
	};
	for (const session of base) {
		if (session.relation === "collaboration" && session.parentId && ids.has(session.parentId)) continue;
		appendBranch(session);
	}
	for (const session of base) appendBranch(session);
	return nested;
}

export function searchProjectSessions(
	project: WebProject,
	tab: SessionListTab,
	query: string,
	roomAgentSessionIds: ReadonlySet<string>,
	unreadSessionIds: Readonly<Record<string, true>>,
): WebSessionSummary[] {
	const sessions = excludeRoomAgentSessions(orderedSessions(project), roomAgentSessionIds)
		.filter((session) => sessionMatchesTab(session, tab, unreadSessionIds));
	return !query || project.name.toLowerCase().includes(query)
		? sessions
		: sessions.filter((session) => sessionTitle(session).toLowerCase().includes(query));
}

export function countSessionsByTab(
	sessionsByProject: ReadonlyMap<string, readonly Pick<WebSessionSummary, "id" | "activity">[]>,
	unreadSessionIds: Readonly<Record<string, true>>,
): Record<SessionListTab, number> {
	const counts = { all: 0, running: 0, completed: 0 };
	for (const sessions of sessionsByProject.values()) {
		for (const session of sessions) {
			counts.all += 1;
			if (isSessionRunning(session)) counts.running += 1;
			else if (isSessionUnread(session, unreadSessionIds)) counts.completed += 1;
		}
	}
	return counts;
}

export function hasUnreadSessions(
	sessions: readonly Pick<WebSessionSummary, "id" | "activity">[],
	unreadSessionIds: Readonly<Record<string, true>>,
): boolean {
	return sessions.some((session) => isSessionUnread(session, unreadSessionIds));
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
