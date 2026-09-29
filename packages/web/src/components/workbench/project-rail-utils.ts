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

type SessionTreeFields = {
	id: string;
	relation?: WebSessionSummary["relation"];
	parentId?: WebSessionSummary["parentId"];
};

export function isNestedCollaborationSession(session: SessionTreeFields, sessionIds: ReadonlySet<string>): boolean {
	return session.relation === "collaboration" && Boolean(session.parentId) && sessionIds.has(session.parentId!);
}

export function topLevelSessions<T extends SessionTreeFields>(sessions: readonly T[]): T[] {
	const sessionIds = new Set(sessions.map((session) => session.id));
	return sessions.filter((session) => !isNestedCollaborationSession(session, sessionIds));
}

function includeSessionAncestors(
	sessions: readonly WebSessionSummary[],
	matchingIds: ReadonlySet<string>,
): WebSessionSummary[] {
	const sessionIds = new Set(sessions.map((session) => session.id));
	const sessionsById = new Map(sessions.map((session) => [session.id, session]));
	const includedIds = new Set(matchingIds);
	for (const session of sessions) {
		if (!includedIds.has(session.id)) continue;
		let current = session;
		const visited = new Set<string>();
		while (isNestedCollaborationSession(current, sessionIds) && current.parentId && !visited.has(current.parentId)) {
			visited.add(current.parentId);
			const parent = sessionsById.get(current.parentId);
			if (!parent) break;
			includedIds.add(parent.id);
			current = parent;
		}
	}
	return sessions.filter((session) => includedIds.has(session.id));
}

export function filterSessionsByTab(
	sessions: readonly WebSessionSummary[],
	tab: SessionListTab,
	unreadSessionIds: Readonly<Record<string, true>>,
): WebSessionSummary[] {
	const matchingIds = new Set(sessions.filter((session) => sessionMatchesTab(session, tab, unreadSessionIds)).map((session) => session.id));
	return includeSessionAncestors(sessions, matchingIds);
}

export function hasCollaborationChildren(sessions: readonly WebSessionSummary[], parentId: string): boolean {
	return sessions.some((session) => session.relation === "collaboration" && session.parentId === parentId);
}

export interface VisibleSession {
	session: WebSessionSummary;
	depth: number;
}

export function visibleSessionTree(
	sessions: readonly WebSessionSummary[],
	visibleRootCount: number,
	expandedSessionIds: ReadonlySet<string>,
): VisibleSession[] {
	const sessionIds = new Set(sessions.map((session) => session.id));
	const childrenByParent = new Map<string, WebSessionSummary[]>();
	for (const session of sessions) {
		if (!isNestedCollaborationSession(session, sessionIds) || !session.parentId) continue;
		const children = childrenByParent.get(session.parentId) ?? [];
		children.push(session);
		childrenByParent.set(session.parentId, children);
	}

	const visible: VisibleSession[] = [];
	const included = new Set<string>();
	const append = (session: WebSessionSummary, depth: number) => {
		if (included.has(session.id)) return;
		included.add(session.id);
		visible.push({ session, depth });
		if (!expandedSessionIds.has(session.id)) return;
		for (const child of childrenByParent.get(session.id) ?? []) append(child, depth + 1);
	};
	for (const session of topLevelSessions(sessions).slice(0, visibleRootCount)) append(session, 0);
	return visible;
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
	const sessions = excludeRoomAgentSessions(orderedSessions(project), roomAgentSessionIds);
	const tabSessions = filterSessionsByTab(sessions, tab, unreadSessionIds);
	if (!query || project.name.toLowerCase().includes(query)) return tabSessions;
	const matchingIds = new Set(
		tabSessions.filter((session) => sessionTitle(session).toLowerCase().includes(query)).map((session) => session.id),
	);
	return includeSessionAncestors(tabSessions, matchingIds);
}

export function countSessionsByTab(
	sessionsByProject: ReadonlyMap<string, readonly Pick<WebSessionSummary, "id" | "activity">[]>,
	unreadSessionIds: Readonly<Record<string, true>>,
): Record<SessionListTab, number> {
	const counts = { all: 0, running: 0, completed: 0 };
	for (const sessions of sessionsByProject.values()) {
		for (const session of topLevelSessions(sessions)) {
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
