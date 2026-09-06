import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionSummary } from "@lystar/code-web-protocol";

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
}

interface ProjectIndexFile {
	version: 1;
	projects: WebProject[];
	migration?: { tauriImported: boolean };
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validDirectory(value: string): string | undefined {
	try {
		const path = realpathSync(resolve(value));
		return statSync(path).isDirectory() ? path : undefined;
	} catch {
		return undefined;
	}
}

function normalizeRecentSessions(value: unknown): SessionSummary[] {
	if (!Array.isArray(value)) return [];
	const activities = new Set<SessionSummary["activity"]>([
		"idle",
		"running",
		"waiting_for_input",
		"completed",
		"failed",
		"aborted",
		"interrupted",
	]);
	const writeAccesses = new Set<SessionSummary["writeAccess"]>([
		"available",
		"owned",
		"controlled_elsewhere",
		"locked_externally",
	]);
	return value
		.flatMap((candidate) => {
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
			const source = candidate as Record<string, unknown>;
			const path = stringValue(source.path);
			const id = stringValue(source.id);
			const cwd = stringValue(source.cwd);
			const firstMessage = typeof source.firstMessage === "string" ? source.firstMessage : undefined;
			const createdAt = source.createdAt;
			const updatedAt = source.updatedAt;
			const messageCount = source.messageCount;
			const activity = source.activity;
			const writeAccess = source.writeAccess;
			if (
				!path ||
				!id ||
				!cwd ||
				firstMessage === undefined ||
				typeof createdAt !== "number" ||
				!Number.isInteger(createdAt) ||
				createdAt < 0 ||
				typeof updatedAt !== "number" ||
				!Number.isInteger(updatedAt) ||
				updatedAt < 0 ||
				typeof messageCount !== "number" ||
				!Number.isInteger(messageCount) ||
				messageCount < 0 ||
				typeof activity !== "string" ||
				!activities.has(activity as SessionSummary["activity"]) ||
				typeof writeAccess !== "string" ||
				!writeAccesses.has(writeAccess as SessionSummary["writeAccess"])
			)
				return [];
			const operationUpdatedAt = source.operationUpdatedAt;
			return [
				{
					path,
					id,
					cwd,
					...(typeof source.name === "string" ? { name: source.name } : {}),
					createdAt,
					updatedAt,
					messageCount,
					firstMessage,
					activity: activity as SessionSummary["activity"],
					writeAccess: writeAccess as SessionSummary["writeAccess"],
					...(typeof operationUpdatedAt === "number" &&
					Number.isInteger(operationUpdatedAt) &&
					operationUpdatedAt >= 0
						? { operationUpdatedAt }
						: {}),
				},
			];
		})
		.slice(0, 100);
}

function normalizedStringIds(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const ids = [
		...new Set(
			value.filter((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate.trim())),
		),
	];
	return ids.length > 0 ? ids : undefined;
}

function normalizeProject(value: unknown): WebProject | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const id = stringValue(source.id);
	const name = stringValue(source.name);
	const cwd = stringValue(source.cwd);
	if (!id || !name || !cwd) return undefined;
	const directory = validDirectory(cwd);
	if (!directory) return undefined;
	const color = ["red", "orange", "green", "blue", "purple", "gray"].includes(String(source.color))
		? (source.color as WebProject["color"])
		: undefined;
	const pinnedSessionIds = normalizedStringIds(source.pinnedSessionIds);
	const sessionOrder = normalizedStringIds(source.sessionOrder);
	return {
		id,
		name,
		cwd: directory,
		...(source.pinned === true ? { pinned: true } : {}),
		...(color ? { color } : {}),
		...(source.archived === true ? { archived: true } : {}),
		...(pinnedSessionIds ? { pinnedSessionIds } : {}),
		...(sessionOrder ? { sessionOrder } : {}),
		...(Array.isArray(source.recentSessions)
			? { recentSessions: normalizeRecentSessions(source.recentSessions) }
			: {}),
	};
}

function defaultIndex(): ProjectIndexFile {
	return { version: 1, projects: [] };
}

function tauriStateCandidates(): string[] {
	const candidates: string[] = [];
	const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
	candidates.push(join(configHome, "com.lystar.code", "desktop-state.json"));
	candidates.push(join(configHome, "lystar-code", "desktop-state.json"));
	candidates.push(join(homedir(), "Library", "Application Support", "com.lystar.code", "desktop-state.json"));
	if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, "com.lystar.code", "desktop-state.json"));
	return [...new Set(candidates)];
}

function importTauriProjects(): WebProject[] {
	for (const path of tauriStateCandidates()) {
		try {
			const source = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			if (!Array.isArray(source.projects)) continue;
			return source.projects.flatMap((value) => {
				const project = normalizeProject(value);
				return project &&
					(!("connectionId" in (value as Record<string, unknown>)) ||
						(value as Record<string, unknown>).connectionId === "local")
					? [project]
					: [];
			});
		} catch {}
	}
	return [];
}

export class ProjectRegistry {
	readonly path: string;
	private state: ProjectIndexFile = defaultIndex();
	private loaded = false;
	private saveQueue: Promise<void> = Promise.resolve();

	constructor(agentDir: string) {
		this.path = join(agentDir, "web", "projects.json");
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		try {
			const raw = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
			this.state = {
				version: 1,
				projects: Array.isArray(raw.projects) ? raw.projects.flatMap((value) => normalizeProject(value) ?? []) : [],
				...(raw.migration && typeof raw.migration === "object" ? { migration: { tauriImported: true } } : {}),
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Web 项目索引损坏：${this.path}`);
			this.state = defaultIndex();
		}
		if (!this.state.migration?.tauriImported) {
			const imported = importTauriProjects();
			const existing = new Set(this.state.projects.map((project) => project.cwd));
			this.state.projects.push(...imported.filter((project) => !existing.has(project.cwd)));
			this.state.migration = { tauriImported: true };
			await this.save();
		}
		this.loaded = true;
	}

	list(): WebProject[] {
		return this.state.projects.map((project) => ({
			...project,
			...(project.pinnedSessionIds ? { pinnedSessionIds: project.pinnedSessionIds.slice() } : {}),
			...(project.sessionOrder ? { sessionOrder: project.sessionOrder.slice() } : {}),
			recentSessions: project.recentSessions?.slice(),
		}));
	}

	get(id: string): WebProject | undefined {
		return this.state.projects.find((project) => project.id === id);
	}

	async add(input: { id: string; name?: string; cwd: string }): Promise<WebProject> {
		const directory = validDirectory(input.cwd);
		if (!directory)
			throw Object.assign(new Error("项目目录不存在或不是目录"), { code: "invalid_project_directory", status: 400 });
		const existing = this.state.projects.find((project) => project.cwd === directory);
		const project: WebProject = {
			id: existing?.id ?? input.id,
			name: input.name?.trim() || existing?.name || basename(directory) || directory,
			cwd: directory,
			...(existing?.pinned ? { pinned: true } : {}),
			...(existing?.color ? { color: existing.color } : {}),
			...(existing?.archived ? { archived: true } : {}),
			...(existing?.recentSessions ? { recentSessions: existing.recentSessions } : {}),
			...(existing?.pinnedSessionIds ? { pinnedSessionIds: existing.pinnedSessionIds } : {}),
			...(existing?.sessionOrder ? { sessionOrder: existing.sessionOrder } : {}),
		};
		this.state.projects = [project, ...this.state.projects.filter((candidate) => candidate.id !== project.id)];
		await this.save();
		return { ...project };
	}

	async update(id: string, update: Pick<WebProject, "name" | "pinned" | "color" | "archived">): Promise<WebProject> {
		const project = this.get(id);
		if (!project) throw Object.assign(new Error("未找到项目"), { code: "project_not_found", status: 404 });
		const name = update.name.trim();
		if (!name) throw Object.assign(new Error("项目名称不能为空"), { code: "project_name_required", status: 400 });
		const next = {
			...project,
			name,
			pinned: update.pinned || undefined,
			color: update.color,
			archived: update.archived || undefined,
		};
		this.state.projects = this.state.projects.map((candidate) => (candidate.id === id ? next : candidate));
		await this.save();
		return { ...next };
	}

	async reorderProjects(projectIds: readonly string[]): Promise<void> {
		const existingIds = new Set(this.state.projects.map((project) => project.id));
		const orderedIds = [...new Set(projectIds)].filter((id) => existingIds.has(id));
		const orderedSet = new Set(orderedIds);
		const nextProjects = [
			...orderedIds.flatMap((id) => this.state.projects.filter((project) => project.id === id)),
			...this.state.projects.filter((project) => !orderedSet.has(project.id)),
		];
		if (nextProjects.every((project, index) => project.id === this.state.projects[index]?.id)) return;
		this.state.projects = nextProjects;
		await this.save();
	}

	async setSessionOrder(id: string, sessionIds: readonly string[]): Promise<void> {
		const project = this.get(id);
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
		this.state.projects = this.state.projects.map((candidate) => (candidate.id === id ? next : candidate));
		await this.save();
	}

	async setSessionPinned(id: string, sessionId: string, pinned: boolean): Promise<WebProject> {
		const project = this.get(id);
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
		this.state.projects = this.state.projects.map((candidate) => (candidate.id === id ? next : candidate));
		await this.save();
		return { ...next };
	}

	async remove(id: string): Promise<void> {
		if (!this.get(id)) throw Object.assign(new Error("未找到项目"), { code: "project_not_found", status: 404 });
		this.state.projects = this.state.projects.filter((project) => project.id !== id);
		await this.save();
	}

	async setRecentSessions(id: string, sessions: SessionSummary[]): Promise<void> {
		const project = this.get(id);
		if (!project) return;
		const recentSessions = sessions.slice(0, 100);
		const availableSessionIds = new Set(sessions.map((session) => session.id));
		const sessionOrder = [
			...(project.sessionOrder ?? []).filter((sessionId) => availableSessionIds.has(sessionId)),
			...sessions
				.map((session) => session.id)
				.filter((sessionId) => !(project.sessionOrder ?? []).includes(sessionId)),
		];
		const recentSessionIds = new Set(recentSessions.map((session) => session.id));
		const pinnedSessionIds = (project.pinnedSessionIds ?? []).filter((sessionId) => recentSessionIds.has(sessionId));
		const next = {
			...project,
			recentSessions,
			...(sessionOrder.length > 0 ? { sessionOrder } : { sessionOrder: undefined }),
			...(pinnedSessionIds.length > 0 ? { pinnedSessionIds } : { pinnedSessionIds: undefined }),
		};
		if (
			JSON.stringify(project.recentSessions ?? []) === JSON.stringify(recentSessions) &&
			JSON.stringify(project.sessionOrder ?? []) === JSON.stringify(sessionOrder) &&
			JSON.stringify(project.pinnedSessionIds ?? []) === JSON.stringify(pinnedSessionIds)
		)
			return;
		this.state.projects = this.state.projects.map((candidate) => (candidate.id === id ? next : candidate));
		await this.save();
	}

	private async save(): Promise<void> {
		const payload = `${JSON.stringify(this.state, null, 2)}\n`;
		const save = this.saveQueue.then(async () => {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporaryPath, payload, {
					encoding: "utf8",
					mode: 0o600,
					flag: "wx",
				});
				await rename(temporaryPath, this.path);
				if (process.platform !== "win32") await chmod(this.path, 0o600);
			} finally {
				await unlink(temporaryPath).catch(() => {});
			}
		});
		this.saveQueue = save.catch(() => {});
		await save;
	}
}
