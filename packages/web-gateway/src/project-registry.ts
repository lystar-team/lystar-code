import { realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { SessionSummary } from "@lystar/code-web-protocol";
import { WorkspaceDatabase } from "./workspace-database.ts";

export interface WebProject {
	id: string;
	name: string;
	cwd: string;
	pinned?: boolean;
	color?: "red" | "orange" | "green" | "blue" | "purple" | "gray";
	archived?: boolean;
	pinnedSessionIds?: string[];
	sessionOrder?: string[];
	recentSessions?: SessionSummary[];
	sessionsIndexed?: boolean;
}

function validDirectory(value: string): string | undefined {
	try {
		const path = realpathSync(resolve(value));
		return statSync(path).isDirectory() ? path : undefined;
	} catch {
		return undefined;
	}
}
export class ProjectRegistry {
	readonly path: string;
	private readonly storage: WorkspaceDatabase;

	constructor(agentDir: string, storage = new WorkspaceDatabase(agentDir)) {
		this.storage = storage;
		this.path = storage.path;
	}

	async load(): Promise<void> {
		this.storage.load();
	}

	list(): WebProject[] {
		return this.storage.readProjects().projects.map((project) => ({
			...project,
			...(project.pinnedSessionIds ? { pinnedSessionIds: project.pinnedSessionIds.slice() } : {}),
			...(project.sessionOrder ? { sessionOrder: project.sessionOrder.slice() } : {}),
			recentSessions: project.recentSessions?.slice(),
		}));
	}

	get(id: string): WebProject | undefined {
		return this.storage.readProjects(id).projects[0];
	}

	async add(input: { id: string; name?: string; cwd: string }): Promise<WebProject> {
		const directory = validDirectory(input.cwd);
		if (!directory)
			throw Object.assign(new Error("项目目录不存在或不是目录"), { code: "invalid_project_directory", status: 400 });
		return this.storage.updateProjects((state) => {
			const existing = state.projects.find((project) => project.cwd === directory);
			const project: WebProject = {
				id: existing?.id ?? input.id,
				name: input.name?.trim() || existing?.name || basename(directory) || directory,
				cwd: directory,
				...(existing?.pinned ? { pinned: true } : {}),
				...(existing?.color ? { color: existing.color } : {}),
				...(existing?.archived ? { archived: true } : {}),
				...(existing?.sessionsIndexed ? { sessionsIndexed: true } : {}),
				...(existing?.recentSessions ? { recentSessions: existing.recentSessions } : {}),
				...(existing?.pinnedSessionIds ? { pinnedSessionIds: existing.pinnedSessionIds } : {}),
				...(existing?.sessionOrder ? { sessionOrder: existing.sessionOrder } : {}),
			};
			state.projects = [project, ...state.projects.filter((candidate) => candidate.id !== project.id)];
			return { ...project };
		});
	}

	async update(
		id: string,
		update: Partial<Pick<WebProject, "name" | "pinned" | "color" | "archived">>,
		expected?: Record<string, unknown>,
	): Promise<WebProject> {
		return this.storage.updateProjects((state) => {
			const project = state.projects.find((project) => project.id === id);
			if (!project) throw Object.assign(new Error("未找到项目"), { code: "project_not_found", status: 404 });
			if (expected)
				for (const key of ["name", "pinned", "color", "archived"] as const) {
					if (!Object.hasOwn(update, key) || !Object.hasOwn(expected, key)) continue;
					const value = key === "pinned" || key === "archived" ? project[key] === true : (project[key] ?? null);
					if (value !== expected[key] && value !== update[key])
						throw Object.assign(new Error("项目已被其他设备修改，请核对最新内容后重试"), {
							status: 409,
							code: "workspace_conflict",
						});
				}
			const name = update.name === undefined ? project.name : update.name.trim();
			if (!name) throw Object.assign(new Error("项目名称不能为空"), { code: "project_name_required", status: 400 });
			const next = {
				...project,
				name,
				...(Object.hasOwn(update, "pinned") ? { pinned: update.pinned || undefined } : {}),
				...(Object.hasOwn(update, "color") ? { color: update.color } : {}),
				...(Object.hasOwn(update, "archived") ? { archived: update.archived || undefined } : {}),
			};
			state.projects = state.projects.map((candidate) => (candidate.id === id ? next : candidate));
			return { ...next };
		});
	}

	async reorderProjects(projectIds: readonly string[]): Promise<void> {
		return this.storage.updateProjects((state) => {
			const existingIds = new Set(state.projects.map((project) => project.id));
			const orderedIds = [...new Set(projectIds)].filter((id) => existingIds.has(id));
			const orderedSet = new Set(orderedIds);
			const nextProjects = [
				...orderedIds.flatMap((id) => state.projects.filter((project) => project.id === id)),
				...state.projects.filter((project) => !orderedSet.has(project.id)),
			];
			if (nextProjects.every((project, index) => project.id === state.projects[index]?.id)) return;
			state.projects = nextProjects;
		});
	}

	async setSessionOrder(id: string, sessionIds: readonly string[]): Promise<void> {
		return this.storage.updateProjects((state) => {
			const project = state.projects.find((project) => project.id === id);
			if (!project) throw Object.assign(new Error("未找到项目"), { code: "project_not_found", status: 404 });
			const nextOrder = [...new Set(sessionIds.filter((sessionId) => Boolean(sessionId.trim())))];
			const currentOrder = project.sessionOrder ?? [];
			if (JSON.stringify(currentOrder) === JSON.stringify(nextOrder)) return;
			const recentById = new Map((project.recentSessions ?? []).map((session) => [session.id, session]));
			const recentSessions = nextOrder.flatMap((sessionId) => {
				const session = recentById.get(sessionId);
				return session ? [session] : [];
			});
			const next = {
				...project,
				...(nextOrder.length > 0 ? { sessionOrder: nextOrder } : { sessionOrder: undefined }),
				...(project.recentSessions ? { recentSessions } : {}),
			};
			state.projects = state.projects.map((candidate) => (candidate.id === id ? next : candidate));
		});
	}

	async setSessionPinned(id: string, sessionId: string, pinned: boolean): Promise<WebProject> {
		return this.storage.updateProjects((state) => {
			const project = state.projects.find((project) => project.id === id);
			if (!project) throw Object.assign(new Error("未找到项目"), { code: "project_not_found", status: 404 });
			const currentIds = project.pinnedSessionIds ?? [];
			const nextIds = pinned
				? [...new Set([...currentIds, sessionId])]
				: currentIds.filter((candidate) => candidate !== sessionId);
			const next = {
				...project,
				...(nextIds.length > 0 ? { pinnedSessionIds: nextIds } : { pinnedSessionIds: undefined }),
			};
			if (JSON.stringify(currentIds) === JSON.stringify(nextIds)) return { ...project };
			state.projects = state.projects.map((candidate) => (candidate.id === id ? next : candidate));
			return { ...next };
		});
	}

	async remove(id: string): Promise<void> {
		return this.storage.updateProjects((state) => {
			if (!state.projects.find((project) => project.id === id))
				throw Object.assign(new Error("未找到项目"), { code: "project_not_found", status: 404 });
			state.projects = state.projects.filter((project) => project.id !== id);
		});
	}

	async setRecentSessions(id: string, sessions: SessionSummary[], expectedRevision?: number): Promise<void> {
		return this.storage.updateProjects((state) => {
			if (expectedRevision !== undefined && expectedRevision !== this.storage.getSessionsRevision(id)) return;
			sessions = sessions.map((session) => ({ ...session, writeAccess: "available" }));
			const project = state.projects.find((project) => project.id === id);
			if (!project) return;
			const previousRecentSessions = project.recentSessions ?? [];
			const previousLatestCreatedAt = previousRecentSessions.reduce(
				(latest, session) => Math.max(latest, session.createdAt),
				-1,
			);
			const freshSessionIds = new Set(
				sessions
					.filter((session) => session.createdAt > previousLatestCreatedAt)
					.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
					.map((session) => session.id),
			);
			const availableSessionIds = new Set(sessions.map((session) => session.id));
			const existingOrder = project.sessionOrder ?? [];
			const sessionOrder = [
				...freshSessionIds,
				...existingOrder.filter(
					(sessionId) => availableSessionIds.has(sessionId) && !freshSessionIds.has(sessionId),
				),
				...sessions
					.map((session) => session.id)
					.filter((sessionId) => !freshSessionIds.has(sessionId) && !existingOrder.includes(sessionId)),
			];
			const sessionsById = new Map(sessions.map((session) => [session.id, session]));
			const orderedSessions = sessionOrder.flatMap((sessionId) => {
				const session = sessionsById.get(sessionId);
				return session ? [session] : [];
			});
			const recentSessions = orderedSessions;
			const recentSessionIds = new Set(recentSessions.map((session) => session.id));
			const pinnedSessionIds = (project.pinnedSessionIds ?? []).filter((sessionId) =>
				recentSessionIds.has(sessionId),
			);
			const next = {
				...project,
				sessionsIndexed: true,
				recentSessions,
				...(sessionOrder.length > 0 ? { sessionOrder } : { sessionOrder: undefined }),
				...(pinnedSessionIds.length > 0 ? { pinnedSessionIds } : { pinnedSessionIds: undefined }),
			};
			if (
				project.sessionsIndexed === true &&
				JSON.stringify(project.recentSessions ?? []) === JSON.stringify(recentSessions) &&
				JSON.stringify(project.sessionOrder ?? []) === JSON.stringify(sessionOrder) &&
				JSON.stringify(project.pinnedSessionIds ?? []) === JSON.stringify(pinnedSessionIds)
			)
				return;
			state.projects = state.projects.map((candidate) => (candidate.id === id ? next : candidate));
		});
	}
	getSessionRevision(id: string): number {
		return this.storage.getSessionsRevision(id);
	}

	updateSessionSummary(
		id: string,
		sessionId: string,
		update: Partial<Pick<SessionSummary, "name" | "activity" | "updatedAt" | "operationUpdatedAt">>,
	): Promise<void> {
		return this.storage.updateSessionSummary(id, sessionId, update);
	}
}
