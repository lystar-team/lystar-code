import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { JsonFileRegistry } from "./json-file-registry.ts";

export interface ProjectGroup {
	id: string;
	name: string;
	projectIds: string[];
}

interface ProjectGroupIndexFile {
	version: 1;
	groups: ProjectGroup[];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value.filter((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate.trim())),
		),
	];
}

function normalizeGroup(value: unknown): ProjectGroup | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const id = stringValue(source.id);
	const name = stringValue(source.name);
	if (!id || !name) return undefined;
	return { id, name, projectIds: stringIds(source.projectIds) };
}

function defaultIndex(): ProjectGroupIndexFile {
	return { version: 1, groups: [] };
}

export class ProjectGroupRegistry {
	readonly path: string;
	private readonly storage: JsonFileRegistry<ProjectGroupIndexFile>;

	constructor(agentDir: string) {
		this.path = join(agentDir, "project-groups.json");
		this.storage = new JsonFileRegistry(
			this.path,
			defaultIndex,
			(raw) => ({
				version: 1,
				groups: Array.isArray(raw.groups) ? raw.groups.flatMap((value) => normalizeGroup(value) ?? []) : [],
			}),
			"Web 项目组索引损坏",
		);
	}

	async load(): Promise<void> {
		await this.storage.load();
	}

	list(): ProjectGroup[] {
		return this.storage.read().groups.map((group) => ({ ...group, projectIds: group.projectIds.slice() }));
	}

	async create(name: string): Promise<ProjectGroup> {
		return this.storage.update((state) => {
			const normalizedName = stringValue(name);
			if (!normalizedName)
				throw Object.assign(new Error("项目组名称不能为空"), { code: "project_group_name_required", status: 400 });
			const group: ProjectGroup = { id: randomUUID(), name: normalizedName, projectIds: [] };
			state.groups = [...state.groups, group];
			return { ...group, projectIds: [] };
		});
	}

	async update(id: string, name: string): Promise<ProjectGroup> {
		return this.storage.update((state) => {
			const group = state.groups.find((candidate) => candidate.id === id);
			if (!group) throw Object.assign(new Error("未找到项目组"), { code: "project_group_not_found", status: 404 });
			const normalizedName = stringValue(name);
			if (!normalizedName)
				throw Object.assign(new Error("项目组名称不能为空"), { code: "project_group_name_required", status: 400 });
			const next = { ...group, name: normalizedName };
			state.groups = state.groups.map((candidate) => (candidate.id === id ? next : candidate));

			return { ...next, projectIds: next.projectIds.slice() };
		});
	}

	async reorder(groupIds: readonly string[]): Promise<void> {
		return this.storage.update((state) => {
			const existingIds = new Set(state.groups.map((group) => group.id));
			const orderedIds = [...new Set(groupIds)].filter((id) => existingIds.has(id));
			const orderedSet = new Set(orderedIds);
			const nextGroups = [
				...orderedIds.flatMap((id) => state.groups.filter((group) => group.id === id)),
				...state.groups.filter((group) => !orderedSet.has(group.id)),
			];
			if (nextGroups.every((group, index) => group.id === state.groups[index]?.id)) return;
			state.groups = nextGroups;
		});
	}

	async remove(id: string): Promise<void> {
		return this.storage.update((state) => {
			if (!state.groups.some((group) => group.id === id))
				throw Object.assign(new Error("未找到项目组"), { code: "project_group_not_found", status: 404 });
			state.groups = state.groups.filter((group) => group.id !== id);
		});
	}

	async assignProject(projectId: string, groupId?: string): Promise<void> {
		return this.storage.update((state) => {
			const normalizedProjectId = stringValue(projectId);
			if (!normalizedProjectId)
				throw Object.assign(new Error("项目 ID 不能为空"), { code: "project_id_required", status: 400 });
			if (groupId && !state.groups.some((group) => group.id === groupId))
				throw Object.assign(new Error("未找到项目组"), { code: "project_group_not_found", status: 404 });
			const nextGroups = state.groups.map((group) => {
				const projectIds = group.projectIds.filter((candidate) => candidate !== normalizedProjectId);
				if (group.id === groupId) projectIds.push(normalizedProjectId);
				return { ...group, projectIds };
			});
			if (JSON.stringify(nextGroups) === JSON.stringify(state.groups)) return;
			state.groups = nextGroups;
		});
	}
}
