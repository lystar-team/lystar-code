import { randomUUID } from "node:crypto";
import { WorkspaceDatabase } from "./workspace-database.ts";

export interface ProjectGroup {
	id: string;
	name: string;
	projectIds: string[];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export class ProjectGroupRegistry {
	readonly path: string;
	private readonly storage: WorkspaceDatabase;

	constructor(agentDir: string, storage = new WorkspaceDatabase(agentDir)) {
		this.storage = storage;
		this.path = storage.path;
	}

	async load(): Promise<void> {
		this.storage.load();
	}

	list(): ProjectGroup[] {
		return this.storage.readGroups().groups.map((group) => ({ ...group, projectIds: group.projectIds.slice() }));
	}

	async create(name: string): Promise<ProjectGroup> {
		return this.storage.updateGroups((state) => {
			const normalizedName = stringValue(name);
			if (!normalizedName)
				throw Object.assign(new Error("项目组名称不能为空"), { code: "project_group_name_required", status: 400 });
			const group: ProjectGroup = { id: randomUUID(), name: normalizedName, projectIds: [] };
			state.groups = [...state.groups, group];
			return { ...group, projectIds: [] };
		});
	}

	async update(id: string, name: string, expectedName?: string): Promise<ProjectGroup> {
		return this.storage.updateGroups((state) => {
			const group = state.groups.find((candidate) => candidate.id === id);
			if (!group) throw Object.assign(new Error("未找到项目组"), { code: "project_group_not_found", status: 404 });
			const normalizedName = stringValue(name);
			if (!normalizedName)
				throw Object.assign(new Error("项目组名称不能为空"), { code: "project_group_name_required", status: 400 });
			if (expectedName !== undefined && group.name !== expectedName && group.name !== normalizedName)
				throw Object.assign(new Error("项目组已被其他设备修改，请核对最新内容后重试"), {
					status: 409,
					code: "workspace_conflict",
				});
			const next = { ...group, name: normalizedName };
			state.groups = state.groups.map((candidate) => (candidate.id === id ? next : candidate));

			return { ...next, projectIds: next.projectIds.slice() };
		});
	}

	async reorder(groupIds: readonly string[]): Promise<void> {
		return this.storage.updateGroups((state) => {
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
		return this.storage.updateGroups((state) => {
			if (!state.groups.some((group) => group.id === id))
				throw Object.assign(new Error("未找到项目组"), { code: "project_group_not_found", status: 404 });
			state.groups = state.groups.filter((group) => group.id !== id);
		});
	}

	async assignProject(projectId: string, groupId?: string): Promise<void> {
		return this.storage.updateGroups((state) => {
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
