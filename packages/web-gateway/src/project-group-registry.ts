import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
	private state: ProjectGroupIndexFile = defaultIndex();
	private loaded = false;
	private saveQueue: Promise<void> = Promise.resolve();

	constructor(agentDir: string) {
		this.path = join(agentDir, "project-groups.json");
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
		try {
			const raw = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
			this.state = {
				version: 1,
				groups: Array.isArray(raw.groups) ? raw.groups.flatMap((value) => normalizeGroup(value) ?? []) : [],
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Web 项目组索引损坏：${this.path}`);
			this.state = defaultIndex();
		}
		this.loaded = true;
	}

	list(): ProjectGroup[] {
		return this.state.groups.map((group) => ({ ...group, projectIds: group.projectIds.slice() }));
	}

	async create(name: string): Promise<ProjectGroup> {
		const normalizedName = stringValue(name);
		if (!normalizedName)
			throw Object.assign(new Error("项目组名称不能为空"), { code: "project_group_name_required", status: 400 });
		const group: ProjectGroup = { id: randomUUID(), name: normalizedName, projectIds: [] };
		this.state.groups = [...this.state.groups, group];
		await this.save();
		return { ...group, projectIds: [] };
	}

	async update(id: string, name: string): Promise<ProjectGroup> {
		const group = this.state.groups.find((candidate) => candidate.id === id);
		if (!group) throw Object.assign(new Error("未找到项目组"), { code: "project_group_not_found", status: 404 });
		const normalizedName = stringValue(name);
		if (!normalizedName)
			throw Object.assign(new Error("项目组名称不能为空"), { code: "project_group_name_required", status: 400 });
		const next = { ...group, name: normalizedName };
		this.state.groups = this.state.groups.map((candidate) => (candidate.id === id ? next : candidate));
		if (group.name !== normalizedName) await this.save();
		return { ...next, projectIds: next.projectIds.slice() };
	}

	async remove(id: string): Promise<void> {
		if (!this.state.groups.some((group) => group.id === id))
			throw Object.assign(new Error("未找到项目组"), { code: "project_group_not_found", status: 404 });
		this.state.groups = this.state.groups.filter((group) => group.id !== id);
		await this.save();
	}

	async assignProject(projectId: string, groupId?: string): Promise<void> {
		const normalizedProjectId = stringValue(projectId);
		if (!normalizedProjectId)
			throw Object.assign(new Error("项目 ID 不能为空"), { code: "project_id_required", status: 400 });
		if (groupId && !this.state.groups.some((group) => group.id === groupId))
			throw Object.assign(new Error("未找到项目组"), { code: "project_group_not_found", status: 404 });
		const nextGroups = this.state.groups.map((group) => {
			const projectIds = group.projectIds.filter((candidate) => candidate !== normalizedProjectId);
			if (group.id === groupId) projectIds.push(normalizedProjectId);
			return { ...group, projectIds };
		});
		if (JSON.stringify(nextGroups) === JSON.stringify(this.state.groups)) return;
		this.state.groups = nextGroups;
		await this.save();
	}

	private async save(): Promise<void> {
		const save = this.saveQueue.then(async () => {
			const payload = `${JSON.stringify(this.state, null, 2)}\n`;
			await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
			const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
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
