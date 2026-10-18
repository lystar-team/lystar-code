import type { GatewayEvent, ProjectGroup, WebProject } from "../types.ts";
import { mergeProjectSessions, mergeSessionSummaries } from "./workbench-state.ts";
import type { WorkbenchState } from "./workbench-types.ts";

export interface WorkspaceSnapshot {
	workspaceRevision: number;
	projects: WebProject[];
	projectGroups: ProjectGroup[];
}

export function applyWorkspaceSnapshot(
	current: WorkbenchState,
	snapshot: WorkspaceSnapshot | Extract<GatewayEvent, { type: "workspace_updated" }>,
): WorkbenchState {
	if (current.workspaceRevision !== undefined && snapshot.workspaceRevision < current.workspaceRevision) return current;
	let projects = mergeProjectSessions(current.projects, snapshot.projects);
	if ("projectIds" in snapshot) {
		const byId = new Map(current.projects.map((project) => [project.id, project]));
		for (const project of projects) byId.set(project.id, project);
		for (const update of snapshot.sessionSummaries) {
			const project = byId.get(update.projectId);
			if (!project) continue;
			const incoming = new Map(update.sessions.map((session) => [session.id, session]));
			const sessions = mergeSessionSummaries(project.sessions, project.sessions.map((session) => incoming.get(session.id) ?? session));
			if (sessions !== project.sessions) byId.set(project.id, { ...project, sessions });
		}
		projects = snapshot.projectIds.flatMap((id) => {
			const project = byId.get(id);
			return project ? [project] : [];
		});
		if (projects.length === current.projects.length && projects.every((project, index) => project === current.projects[index]))
			projects = current.projects;
	}
	const previousGroups = new Map(current.projectGroups.map((group) => [group.id, group]));
	let projectGroups = snapshot.projectGroups.map((group) => {
		const previous = previousGroups.get(group.id);
		return previous && previous.name === group.name && previous.projectIds.length === group.projectIds.length &&
			previous.projectIds.every((id, index) => id === group.projectIds[index]) ? previous : group;
	});
	if (projectGroups.length === current.projectGroups.length && projectGroups.every((group, index) => group === current.projectGroups[index]))
		projectGroups = current.projectGroups;
	if (snapshot.workspaceRevision === current.workspaceRevision && projects === current.projects && projectGroups === current.projectGroups)
		return current;
	return {
		...current,
		workspaceRevision: snapshot.workspaceRevision,
		projects,
		projectGroups,
	};
}
