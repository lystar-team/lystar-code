import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionResultState, SessionSummary } from "@lystar/code-web-protocol";
import type { ProjectGroup } from "./project-group-registry.ts";
import type { WebProject } from "./project-registry.ts";
import { readLegacyWorkspace } from "./workspace-migration.ts";

export interface ProjectState {
	projects: WebProject[];
}
export interface GroupState {
	groups: ProjectGroup[];
}
export interface ResultState {
	initializedAt: number;
	results: Record<string, SessionResultState>;
}
interface DataRow {
	data: string;
}

export type SessionSummaryUpdate = {
	projectId: string;
	sessionId: string;
	update: Partial<Pick<SessionSummary, "name" | "activity" | "updatedAt" | "operationUpdatedAt">>;
};
export type WorkspaceWrite =
	| { type: "projects"; revision: number; projects: WebProject[] }
	| { type: "groups"; revision: number; groups: ProjectGroup[] }
	| { type: "results"; revision: number; results: ResultState["results"] }
	| { type: "summaries"; updates: SessionSummaryUpdate[] };
export interface WorkspaceWriteMetrics {
	beginMs: number;
	writeMs: number;
	commitMs: number;
	changes: number;
}

export class WorkspaceDatabaseStorage {
	readonly path: string;
	private readonly agentDir: string;
	private database?: DatabaseSync;
	private inTransaction = false;
	private writeMetrics?: WorkspaceWriteMetrics;
	private projectSnapshots = new Map<string, { data: string; sessionsRevision: number; project: WebProject }>();

	constructor(agentDir: string) {
		this.agentDir = agentDir;
		this.path = join(agentDir, "web", "workspace.sqlite");
	}

	load(): void {
		if (this.database) return;
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(this.path, { timeout: 5000 });
		try {
			db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
			const version = db.prepare("PRAGMA user_version").get()?.user_version;
			if (version !== 0 && version !== 1) throw new Error(`工作区数据库版本不支持：${version}`);
			if (version === 0) {
				const legacy = readLegacyWorkspace(this.agentDir);
				db.exec(`
					CREATE TABLE workspace_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, initialized_at REAL NOT NULL);
					CREATE TABLE projects (id TEXT PRIMARY KEY, cwd TEXT NOT NULL UNIQUE, position INTEGER NOT NULL, data TEXT NOT NULL, sessions_revision INTEGER NOT NULL DEFAULT 0);
					CREATE TABLE sessions (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL, position INTEGER NOT NULL, updated_at REAL NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id,id));
					CREATE INDEX sessions_updated ON sessions(updated_at DESC,id);
					CREATE TABLE project_groups (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL);
					CREATE TABLE session_results (id TEXT PRIMARY KEY, data TEXT NOT NULL);
				`);
				db.prepare("INSERT INTO workspace_state VALUES(1,1,?)").run(legacy.initializedAt);
				this.writeProjects(db, [], legacy.projects);
				this.writeGroups(db, [], legacy.groups);
				this.writeResults(db, {}, legacy.results);
				const projectIds = new Set(legacy.projects.map((project) => project.id));
				const missing = legacy.groups.flatMap((group) =>
					group.projectIds
						.filter((id) => !projectIds.has(id))
						.map((projectId) => ({ groupId: group.id, projectId })),
				);
				if (missing.length)
					process.stderr.write(
						`${JSON.stringify({ event: "workspace_migration_missing_projects", references: missing })}\n`,
					);
				db.exec("PRAGMA user_version=1");
			}
			db.exec("COMMIT");
			if (process.platform !== "win32") chmodSync(this.path, 0o600);
			this.database = db;
		} catch (error) {
			if (db.isTransaction) db.exec("ROLLBACK");
			db.close();
			throw error;
		}
	}

	close(): void {
		this.database?.close();
		this.database = undefined;
		this.projectSnapshots.clear();
	}

	private transaction<T>(write: boolean, operation: (db: DatabaseSync) => T): T {
		this.load();
		const db = this.database!;
		if (this.inTransaction) return operation(db);
		const startedAt = performance.now();
		db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
		const acquiredAt = performance.now();
		this.inTransaction = true;
		try {
			const before = write ? db.prepare("SELECT total_changes() AS count").get()?.count : undefined;
			const result = operation(db);
			if (write && db.prepare("SELECT total_changes() AS count").get()?.count !== before)
				db.exec("UPDATE workspace_state SET revision=revision+1 WHERE id=1");
			const writtenAt = performance.now();
			db.exec("COMMIT");
			if (write)
				this.writeMetrics = {
					beginMs: acquiredAt - startedAt,
					writeMs: writtenAt - acquiredAt,
					commitMs: performance.now() - writtenAt,
					changes: Number(db.prepare("SELECT total_changes() AS count").get()?.count) - Number(before),
				};
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		} finally {
			this.inTransaction = false;
		}
	}

	configureWriter(): void {
		this.load();
		this.database!.exec("PRAGMA wal_autocheckpoint=0");
	}

	commit(write: WorkspaceWrite): { applied: boolean; metrics?: WorkspaceWriteMetrics } {
		this.writeMetrics = undefined;
		const applied = this.transaction(true, () => {
			if (write.type === "summaries") {
				for (const item of write.updates) this.updateSessionSummary(item.projectId, item.sessionId, item.update);
			} else {
				// 用同一事务内的修订检查保留其他 Gateway 在此期间写入的字段。
				if (this.revision !== write.revision) return false;
				if (write.type === "projects")
					this.updateProjects((state) => {
						state.projects = write.projects;
					});
				else if (write.type === "groups")
					this.updateGroups((state) => {
						state.groups = write.groups;
					});
				else
					this.updateResults((state) => {
						state.results = write.results;
					});
			}
			return true;
		});
		return { applied, metrics: this.writeMetrics };
	}

	checkpoint(): { busy: number; log: number; checkpointed: number } {
		this.load();
		return this.database!.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as unknown as {
			busy: number;
			log: number;
			checkpointed: number;
		};
	}

	get revision(): number {
		return this.transaction(false, (db) =>
			Number(db.prepare("SELECT revision FROM workspace_state WHERE id=1").get()!.revision),
		);
	}

	readProjects(projectId?: string): ProjectState {
		return this.transaction(false, (db) => {
			const projects = (
				db
					.prepare(
						projectId === undefined
							? "SELECT data FROM projects ORDER BY position,id"
							: "SELECT data FROM projects WHERE id=?",
					)
					.all(...(projectId === undefined ? [] : [projectId])) as unknown as DataRow[]
			).map((row) => JSON.parse(row.data) as WebProject);
			const byId = new Map(
				projects.map((project) => {
					project.recentSessions = [];
					return [project.id, project];
				}),
			);
			for (const row of db
				.prepare(
					projectId === undefined
						? "SELECT project_id,data FROM sessions ORDER BY project_id,position,id"
						: "SELECT project_id,data FROM sessions WHERE project_id=? ORDER BY position,id",
				)
				.all(...(projectId === undefined ? [] : [projectId])))
				byId.get(String(row.project_id))?.recentSessions?.push(JSON.parse(String(row.data)) as SessionSummary);
			return { projects };
		});
	}

	updateProjects<T>(mutate: (state: ProjectState) => T): T {
		return this.transaction(true, (db) => {
			const previous = this.readProjects();
			const next = structuredClone(previous);
			const result = mutate(next);
			this.writeProjects(db, previous.projects, next.projects);
			const remaining = new Set(next.projects.map((project) => project.id));
			const removed = previous.projects.filter((project) => !remaining.has(project.id));
			if (removed.length) {
				const previousGroups = this.readGroups().groups;
				const ids = new Set(removed.map((project) => project.id));
				this.writeGroups(
					db,
					previousGroups,
					previousGroups.map((group) => ({ ...group, projectIds: group.projectIds.filter((id) => !ids.has(id)) })),
				);
			}
			return result;
		});
	}

	updateSessionSummary(
		projectId: string,
		sessionId: string,
		update: Partial<Pick<SessionSummary, "name" | "activity" | "updatedAt" | "operationUpdatedAt">>,
	): void {
		if (Object.keys(update).length === 0) return;
		this.transaction(true, (db) => {
			const row = db.prepare("SELECT data FROM sessions WHERE project_id=? AND id=?").get(projectId, sessionId);
			if (!row) return;
			const previous = JSON.parse(String(row.data)) as SessionSummary;
			if (update.updatedAt !== undefined && update.updatedAt < previous.updatedAt) return;
			const next = { ...previous, ...update };
			const data = JSON.stringify(next);
			if (data === row.data) return;
			db.prepare("UPDATE sessions SET updated_at=?,data=? WHERE project_id=? AND id=?").run(
				next.updatedAt,
				data,
				projectId,
				sessionId,
			);
			db.prepare("UPDATE projects SET sessions_revision=sessions_revision+1 WHERE id=?").run(projectId);
		});
	}

	getSessionsRevision(projectId: string): number {
		return this.transaction(false, (db) =>
			Number(db.prepare("SELECT sessions_revision FROM projects WHERE id=?").get(projectId)?.sessions_revision ?? 0),
		);
	}

	private writeProjects(db: DatabaseSync, previous: WebProject[], next: WebProject[]): void {
		const ids = new Set(next.map((project) => project.id));
		for (const project of previous)
			if (!ids.has(project.id)) db.prepare("DELETE FROM projects WHERE id=?").run(project.id);
		const byId = new Map(previous.map((project, position) => [project.id, { project, position }]));
		for (const [position, project] of next.entries()) {
			const old = byId.get(project.id);
			const { recentSessions, ...settings } = project;
			const { recentSessions: _oldSessions, ...oldSettings } = old?.project ?? {};
			if (!old || position !== old.position || JSON.stringify(settings) !== JSON.stringify(oldSettings))
				db.prepare(
					`INSERT INTO projects(id,cwd,position,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd,position=excluded.position,data=excluded.data`,
				).run(project.id, project.cwd, position, JSON.stringify(settings));
			const oldSessions = new Map(
				(old?.project.recentSessions ?? []).map((session, index) => [session.id, { session, index }]),
			);
			const sessions = recentSessions ?? [];
			const sessionIds = new Set(sessions.map((session) => session.id));
			let changed = false;
			for (const id of oldSessions.keys())
				if (!sessionIds.has(id)) {
					db.prepare("DELETE FROM sessions WHERE project_id=? AND id=?").run(project.id, id);
					changed = true;
				}
			for (const [index, session] of sessions.entries()) {
				const saved = oldSessions.get(session.id);
				if (saved?.index === index && JSON.stringify(saved.session) === JSON.stringify(session)) continue;
				db.prepare(
					`INSERT INTO sessions VALUES(?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET position=excluded.position,updated_at=excluded.updated_at,data=excluded.data`,
				).run(project.id, session.id, index, session.updatedAt, JSON.stringify(session));
				changed = true;
			}
			if (changed)
				db.prepare("UPDATE projects SET sessions_revision=sessions_revision+1 WHERE id=?").run(project.id);
		}
	}

	readGroups(): GroupState {
		return this.transaction(false, (db) => ({
			groups: (db.prepare("SELECT data FROM project_groups ORDER BY position,id").all() as unknown as DataRow[]).map(
				(row) => JSON.parse(row.data) as ProjectGroup,
			),
		}));
	}

	updateGroups<T>(mutate: (state: GroupState) => T): T {
		return this.transaction(true, (db) => {
			const previous = this.readGroups();
			const next = structuredClone(previous);
			const result = mutate(next);
			this.writeGroups(db, previous.groups, next.groups);
			return result;
		});
	}

	private writeGroups(db: DatabaseSync, previous: ProjectGroup[], next: ProjectGroup[]): void {
		const ids = new Set(next.map((group) => group.id));
		for (const group of previous)
			if (!ids.has(group.id)) db.prepare("DELETE FROM project_groups WHERE id=?").run(group.id);
		const byId = new Map(previous.map((group, position) => [group.id, { group, position }]));
		for (const [position, group] of next.entries()) {
			const old = byId.get(group.id);
			if (old?.position === position && JSON.stringify(old.group) === JSON.stringify(group)) continue;
			db.prepare(
				"INSERT INTO project_groups VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,data=excluded.data",
			).run(group.id, position, JSON.stringify(group));
		}
	}

	getResult(sessionId: string): SessionResultState | undefined {
		return this.transaction(false, (db) => {
			const row = db.prepare("SELECT data FROM session_results WHERE id=?").get(sessionId);
			return row ? (JSON.parse(String(row.data)) as SessionResultState) : undefined;
		});
	}

	readResults(): ResultState {
		return this.transaction(false, (db) => ({
			initializedAt: Number(
				db.prepare("SELECT initialized_at FROM workspace_state WHERE id=1").get()!.initialized_at,
			),
			results: Object.fromEntries(
				db
					.prepare("SELECT id,data FROM session_results")
					.all()
					.map((row) => [String(row.id), JSON.parse(String(row.data)) as SessionResultState]),
			),
		}));
	}

	updateResults<T>(mutate: (state: ResultState) => T): T {
		return this.transaction(true, (db) => {
			const previous = this.readResults();
			const next = structuredClone(previous);
			const result = mutate(next);
			this.writeResults(db, previous.results, next.results);
			return result;
		});
	}

	private writeResults(
		db: DatabaseSync,
		previous: Record<string, SessionResultState>,
		next: Record<string, SessionResultState>,
	): void {
		for (const [id, result] of Object.entries(next)) {
			if (JSON.stringify(previous[id]) === JSON.stringify(result)) continue;
			db.prepare("INSERT INTO session_results VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(
				id,
				JSON.stringify(result),
			);
		}
	}

	snapshot(): {
		revision: number;
		projects: WebProject[];
		groups: ProjectGroup[];
		results: Record<string, SessionResultState>;
	} {
		return this.transaction(false, (db) => {
			const next = new Map<string, { data: string; sessionsRevision: number; project: WebProject }>();
			// 项目设置和会话修订都未变化时，沿用已读取的项目，不重新解析全部会话。
			for (const row of db.prepare("SELECT id,data,sessions_revision FROM projects ORDER BY position,id").all()) {
				const id = String(row.id);
				const data = String(row.data);
				const sessionsRevision = Number(row.sessions_revision);
				const cached = this.projectSnapshots.get(id);
				const project =
					cached?.data === data && cached.sessionsRevision === sessionsRevision
						? cached.project
						: this.readProjects(id).projects[0];
				next.set(id, { data, sessionsRevision, project });
			}
			const snapshot = {
				revision: this.revision,
				projects: [...next.values()].map(({ project }) => project),
				groups: this.readGroups().groups,
				results: this.readResults().results,
			};
			this.projectSnapshots = next;
			return snapshot;
		});
	}
}
