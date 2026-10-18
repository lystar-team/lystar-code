import { constants, copyFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSessionResultActivity, type SessionResultState, type SessionSummary } from "@lystar/code-web-protocol";
import type { ProjectGroup } from "./project-group-registry.ts";
import type { WebProject } from "./project-registry.ts";

export interface LegacyWorkspace {
	projects: WebProject[];
	groups: ProjectGroup[];
	results: Record<string, SessionResultState>;
	initializedAt: number;
}

function readLegacyFile(path: string): Record<string, unknown> | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`工作区迁移失败，文件格式无效：${path}`);
	// 原文件继续保留；副本只在首次迁移时创建，重试不覆盖此前的恢复依据。
	try {
		copyFileSync(path, `${path}.pre-sqlite`, constants.COPYFILE_EXCL);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return value as Record<string, unknown>;
}

function stringIds(value: unknown): string[] {
	return Array.isArray(value)
		? [...new Set(value.filter((id): id is string => typeof id === "string" && Boolean(id.trim())))]
		: [];
}

function project(value: unknown): WebProject {
	if (!value || typeof value !== "object") throw new Error("工作区迁移失败，项目格式无效");
	const source = value as Record<string, unknown>;
	if (![source.id, source.name, source.cwd].every((field) => typeof field === "string" && field.trim()))
		throw new Error("工作区迁移失败，项目缺少 ID、名称或目录");
	const sessions = source.recentSessions;
	if (sessions !== undefined && !Array.isArray(sessions)) throw new Error("工作区迁移失败，会话列表格式无效");
	for (const candidate of (sessions ?? []) as unknown[]) {
		const summary = candidate as Partial<SessionSummary> | null;
		if (
			!summary ||
			typeof summary.id !== "string" ||
			typeof summary.path !== "string" ||
			typeof summary.cwd !== "string" ||
			!Number.isFinite(summary.createdAt) ||
			!Number.isFinite(summary.updatedAt) ||
			typeof summary.firstMessage !== "string" ||
			typeof summary.activity !== "string" ||
			typeof summary.writeAccess !== "string"
		)
			throw new Error("工作区迁移失败，会话摘要格式无效");
	}
	return {
		id: (source.id as string).trim(),
		name: (source.name as string).trim(),
		cwd: (source.cwd as string).trim(),
		...(source.pinned === true ? { pinned: true } : {}),
		...(["red", "orange", "green", "blue", "purple", "gray"].includes(String(source.color))
			? { color: source.color as WebProject["color"] }
			: {}),
		...(source.archived === true ? { archived: true } : {}),
		pinnedSessionIds: stringIds(source.pinnedSessionIds),
		sessionOrder: stringIds(source.sessionOrder),
		recentSessions: (sessions ?? []) as SessionSummary[],
	};
}

export function readLegacyWorkspace(agentDir: string): LegacyWorkspace {
	const savedProjects = readLegacyFile(join(agentDir, "web", "projects.json"));
	if (savedProjects && !Array.isArray(savedProjects.projects)) throw new Error("工作区迁移失败，项目列表格式无效");
	const projects = ((savedProjects?.projects ?? []) as unknown[]).map(project);
	if (!(savedProjects?.migration as { tauriImported?: boolean } | undefined)?.tauriImported) {
		const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
		const candidates = [
			join(configHome, "com.lystar.code", "desktop-state.json"),
			join(configHome, "lystar-code", "desktop-state.json"),
			join(homedir(), "Library", "Application Support", "com.lystar.code", "desktop-state.json"),
			...(process.env.APPDATA ? [join(process.env.APPDATA, "com.lystar.code", "desktop-state.json")] : []),
		];
		for (const path of candidates) {
			const desktop = readLegacyFile(path);
			if (!Array.isArray(desktop?.projects)) continue;
			for (const entry of desktop.projects) {
				if (entry && typeof entry === "object" && "connectionId" in entry && entry.connectionId !== "local")
					continue;
				const imported = project(entry);
				if (!projects.some((existing) => existing.cwd === imported.cwd)) projects.push(imported);
			}
			break;
		}
	}
	const savedGroups = readLegacyFile(join(agentDir, "project-groups.json"));
	if (savedGroups && !Array.isArray(savedGroups.groups)) throw new Error("工作区迁移失败，项目组列表格式无效");
	const groups = ((savedGroups?.groups ?? []) as unknown[]).map((value): ProjectGroup => {
		const source = value as Partial<ProjectGroup> | null;
		if (
			!source ||
			typeof source.id !== "string" ||
			!source.id.trim() ||
			typeof source.name !== "string" ||
			!source.name.trim() ||
			!Array.isArray(source.projectIds)
		)
			throw new Error("工作区迁移失败，项目组格式无效");
		return { id: source.id, name: source.name, projectIds: stringIds(source.projectIds) };
	});
	const savedResults = readLegacyFile(join(agentDir, "web", "session-results.json"));
	const results: Record<string, SessionResultState> = {};
	if (savedResults) {
		if (
			typeof savedResults.initializedAt !== "number" ||
			!Number.isFinite(savedResults.initializedAt) ||
			!savedResults.results ||
			typeof savedResults.results !== "object" ||
			Array.isArray(savedResults.results)
		)
			throw new Error("工作区迁移失败，会话查看记录格式无效");
		for (const [id, candidate] of Object.entries(savedResults.results)) {
			const entry = candidate as Partial<SessionResultState> | null;
			if (
				!entry ||
				entry.sessionId !== id ||
				!Number.isSafeInteger(entry.revision) ||
				(entry.revision ?? 0) < 1 ||
				!Number.isSafeInteger(entry.readRevision) ||
				(entry.readRevision ?? -1) < 0 ||
				(entry.readRevision ?? 0) > (entry.revision ?? 0) ||
				typeof entry.updatedAt !== "number" ||
				!Number.isFinite(entry.updatedAt) ||
				typeof entry.activity !== "string" ||
				!isSessionResultActivity(entry.activity) ||
				!Number.isSafeInteger(entry.version) ||
				(entry.version ?? 0) < 1 ||
				(entry.viewedAt !== undefined && !Number.isFinite(entry.viewedAt))
			)
				throw new Error("工作区迁移失败，会话查看记录格式无效");
			results[id] = entry as SessionResultState;
		}
	}
	return {
		projects,
		groups,
		results,
		initializedAt: (savedResults?.initializedAt as number | undefined) ?? Date.now(),
	};
}
