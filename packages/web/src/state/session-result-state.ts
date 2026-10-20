import type { SessionResultState } from "@lystar/code-web-protocol";
import type { WebProject } from "../types.ts";
import type { WorkbenchState } from "./workbench-types.ts";

export function sessionUnreadIndex(projects: readonly WebProject[], previous: Record<string, true>): Record<string, true> {
	const unread: Record<string, true> = {};
	for (const project of projects) {
		for (const session of project.sessions) {
			if (session.result && session.result.readRevision < session.result.revision) unread[session.id] = true;
		}
	}
	const ids = Object.keys(unread);
	return ids.length === Object.keys(previous).length && ids.every((id) => previous[id]) ? previous : unread;
}

/** 会话当前的结果版本；没有结果时返回 undefined。 */
export function sessionResultRevision(projects: readonly WebProject[], sessionId: string): number | undefined {
	for (const project of projects) {
		const session = project.sessions.find((candidate) => candidate.id === sessionId);
		if (session) return session.result?.revision;
	}
	return undefined;
}

export function applySessionResult(current: WorkbenchState, result: SessionResultState): WorkbenchState {
	let changed = false;
	const projects = current.projects.map((project) => {
		const index = project.sessions.findIndex((session) => session.id === result.sessionId);
		if (index < 0 || (project.sessions[index]!.result?.version ?? 0) >= result.version) return project;
		const sessions = project.sessions.slice();
		sessions[index] = { ...sessions[index]!, result };
		changed = true;
		return { ...project, sessions };
	});
	return changed ? { ...current, projects, unreadSessionIds: sessionUnreadIndex(projects, current.unreadSessionIds) } : current;
}
