import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class ProjectFileError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export function isInside(root: string, path: string): boolean {
	const value = relative(root, path);
	return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

export function relativePath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

export function projectPath(root: string, input: string): string {
	const value = input.trim();
	if (value.includes("\0") || isAbsolute(value)) {
		throw new ProjectFileError(400, "invalid_project_path", "项目路径必须是相对路径");
	}
	const path = resolve(root, value);
	if (!isInside(root, path)) throw new ProjectFileError(403, "project_path_escape", "目标路径不在当前项目范围内");
	return path;
}

export function validateFileName(name: string): void {
	if (!name) throw new ProjectFileError(400, "file_name_required", "文件名不能为空");
	if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
		throw new ProjectFileError(400, "file_name_invalid", "文件名不能包含路径分隔符");
	}
}

export async function projectEntryPath(
	cwd: string,
	input: string,
): Promise<{ path: string; root: string; kind: "file" | "directory" }> {
	const root = await realpath(resolve(cwd));
	const candidate = projectPath(root, input);
	let path: string;
	try {
		path = await realpath(candidate);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		throw new ProjectFileError(404, "file_not_found", "文件或目录不存在");
	}
	if (!isInside(root, path)) throw new ProjectFileError(403, "project_path_escape", "目标路径不在当前项目范围内");
	const info = await stat(path);
	if (!info.isFile() && !info.isDirectory()) {
		throw new ProjectFileError(400, "file_not_regular", "目标不是普通文件或目录");
	}
	return { path, root, kind: info.isDirectory() ? "directory" : "file" };
}

export async function projectMutableEntryPath(
	cwd: string,
	input: string,
): Promise<{ path: string; root: string; kind: "file" | "directory" }> {
	if (!input.trim()) throw new ProjectFileError(400, "file_path_required", "文件或目录路径不能为空");
	const root = await realpath(resolve(cwd));
	const path = projectPath(root, input);
	let info: Awaited<ReturnType<typeof lstat>>;
	let parent: string;
	try {
		[info, parent] = await Promise.all([lstat(path), realpath(dirname(path))]);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		throw new ProjectFileError(404, "file_not_found", "文件或目录不存在");
	}
	if (!isInside(root, parent)) throw new ProjectFileError(403, "project_path_escape", "目标路径不在当前项目范围内");
	if (info.isSymbolicLink()) return { path, root, kind: "file" };
	let canonical: string;
	try {
		canonical = await realpath(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		throw new ProjectFileError(404, "file_not_found", "文件或目录不存在");
	}
	if (!isInside(root, canonical)) throw new ProjectFileError(403, "project_path_escape", "目标路径不在当前项目范围内");
	if (!info.isFile() && !info.isDirectory()) {
		throw new ProjectFileError(400, "file_not_regular", "目标不是普通文件或目录");
	}
	return { path, root, kind: info.isDirectory() ? "directory" : "file" };
}
