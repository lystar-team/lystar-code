import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
	SessionCollaborationResult,
	SessionWorkspaceMode,
	SessionWorkspaceSnapshot,
} from "@earendil-works/pi-coding-agent/core";

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 32 * 1024 * 1024;
const IGNORED_COPY_DIRECTORIES = new Set([".git", "node_modules"]);

type GitCommandError = Error & { code?: string | number; stdout?: string; stderr?: string };

export interface CollaborationWorkspaceDelivery {
	workspace: SessionWorkspaceSnapshot;
	changedFiles: string[];
	deliveryCommit?: string;
	patchPath?: string;
}

function workspaceError(message: string, code: string): Error & { code: string; retryable: boolean } {
	return Object.assign(new Error(message), { code, retryable: false });
}

function canonicalPath(path: string): string {
	return existsSync(path) ? realpathSync(path) : resolve(path);
}

function copyFilter(sourceRoot: string, candidate: string): boolean {
	const relativePath = relative(sourceRoot, candidate);
	return !relativePath.split(sep).some((part) => IGNORED_COPY_DIRECTORIES.has(part));
}

async function copyProject(source: string, target: string): Promise<void> {
	await cp(source, target, {
		recursive: true,
		force: true,
		filter: (candidate) => copyFilter(canonicalPath(source), candidate),
	});
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	try {
		const result = await execFileAsync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: COMMAND_MAX_BUFFER,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" },
		});
		return result.stdout;
	} catch (error) {
		const candidate = error as GitCommandError;
		const message = candidate.stderr?.trim() || candidate.stdout?.trim() || candidate.message;
		throw Object.assign(new Error(message), { code: "git_command_failed", retryable: false });
	}
}

async function runGitWrite(cwd: string, args: string[]): Promise<string> {
	try {
		const result = await execFileAsync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: COMMAND_MAX_BUFFER,
			env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
		});
		return result.stdout;
	} catch (error) {
		const candidate = error as GitCommandError;
		const message =
			[candidate.stdout?.trim(), candidate.stderr?.trim()].filter(Boolean).join("\n") || candidate.message;
		throw Object.assign(new Error(message), { code: "git_command_failed", retryable: false });
	}
}

async function findGitRoot(cwd: string): Promise<string | undefined> {
	try {
		return canonicalPath((await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim());
	} catch {
		return undefined;
	}
}

async function readGitHead(cwd: string): Promise<string | undefined> {
	try {
		return (await runGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim() || undefined;
	} catch {
		return undefined;
	}
}

function effectiveWorktreeCwd(repositoryRoot: string, projectCwd: string, worktreePath: string): string {
	const relativeProjectPath = relative(repositoryRoot, projectCwd);
	return relativeProjectPath ? join(worktreePath, relativeProjectPath) : worktreePath;
}

function parseGitStatusPaths(output: string): string[] {
	const paths: string[] = [];
	const records = output.split("\0").filter(Boolean);
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		const path = record.slice(3);
		if (!path) continue;
		paths.push(path);
		if (record[0] === "R" || record[0] === "C") {
			const renamedPath = records[++index];
			if (renamedPath) paths.push(renamedPath);
		}
	}
	return paths;
}

async function gitChangedFiles(worktreePath: string, baseCommit: string): Promise<string[]> {
	const [diffOutput, statusOutput] = await Promise.all([
		runGit(worktreePath, ["diff", "--name-only", "-z", baseCommit, "--"]),
		runGit(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
	]);
	return [...new Set([...diffOutput.split("\0").filter(Boolean), ...parseGitStatusPaths(statusOutput)])].sort();
}

async function patchGitWorkspace(workspace: SessionWorkspaceSnapshot): Promise<string> {
	if (!workspace.baseCommit || !workspace.worktreePath) {
		throw workspaceError("Patch 工作区缺少 Git 基线", "workspace_patch_base_missing");
	}
	const statusOutput = await runGit(workspace.worktreePath, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
	]);
	const untracked = parseGitStatusPaths(statusOutput).filter((path) => statusOutput.includes(`?? ${path}`));
	if (untracked.length > 0) await runGitWrite(workspace.worktreePath, ["add", "-N", "--", ...untracked]);
	const patch = await runGit(workspace.worktreePath, ["diff", "--binary", workspace.baseCommit, "--"]);
	const patchPath = workspace.patchPath;
	if (!patchPath) throw workspaceError("Patch 工作区缺少补丁路径", "workspace_patch_path_missing");
	await writeFile(patchPath, patch, "utf8");
	return patchPath;
}

async function listDirectoryFiles(root: string, current = root): Promise<string[]> {
	const entries = await readdir(current, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (IGNORED_COPY_DIRECTORIES.has(entry.name)) continue;
		const path = join(current, entry.name);
		if (entry.isDirectory()) files.push(...(await listDirectoryFiles(root, path)));
		else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
	}
	return files;
}

async function changedCopiedFiles(baselinePath: string, worktreePath: string): Promise<string[]> {
	const paths = new Set([...(await listDirectoryFiles(baselinePath)), ...(await listDirectoryFiles(worktreePath))]);
	const changed: string[] = [];
	for (const path of paths) {
		const baseline = join(baselinePath, path);
		const working = join(worktreePath, path);
		const [baselineExists, workingExists] = [existsSync(baseline), existsSync(working)];
		if (baselineExists !== workingExists) {
			changed.push(path);
			continue;
		}
		if (!baselineExists) continue;
		const [baselineStat, workingStat] = await Promise.all([stat(baseline), stat(working)]);
		if (baselineStat.size !== workingStat.size) {
			changed.push(path);
			continue;
		}
		const [baselineContent, workingContent] = await Promise.all([readFile(baseline), readFile(working)]);
		if (!baselineContent.equals(workingContent)) changed.push(path);
	}
	return changed.sort();
}

async function patchCopiedWorkspace(workspace: SessionWorkspaceSnapshot): Promise<string> {
	if (!workspace.baselinePath || !workspace.worktreePath || !workspace.patchPath) {
		throw workspaceError("Patch 工作区缺少副本路径", "workspace_patch_copy_missing");
	}
	const result = await execFileAsync("diff", ["-ruN", workspace.baselinePath, workspace.worktreePath], {
		encoding: "utf8",
		maxBuffer: COMMAND_MAX_BUFFER,
	}).catch((error: unknown) => {
		const candidate = error as GitCommandError;
		if (candidate.code === 1) return { stdout: candidate.stdout ?? "", stderr: "" };
		throw workspaceError(candidate.stderr?.trim() || candidate.message, "workspace_patch_diff_failed");
	});
	await writeFile(workspace.patchPath, result.stdout, "utf8");
	return workspace.patchPath;
}

export class CollaborationWorkspaceManager {
	private readonly root: string;

	constructor(agentDir: string) {
		this.root = join(agentDir, "collaboration-workspaces");
	}

	async create(
		projectCwd: string,
		mode: SessionWorkspaceMode,
		workspaceId: string,
	): Promise<SessionWorkspaceSnapshot> {
		const source = canonicalPath(projectCwd);
		if (mode === "shared") {
			return { id: workspaceId, mode, projectCwd: source, cwd: source, status: "active" };
		}
		const workspaceRoot = join(this.root, workspaceId);
		await mkdir(workspaceRoot, { recursive: true });

		const repositoryRoot = await findGitRoot(source);
		const baseCommit = repositoryRoot ? await readGitHead(repositoryRoot) : undefined;
		if (mode === "worktree" && (!repositoryRoot || !baseCommit)) {
			await rm(workspaceRoot, { recursive: true, force: true });
			throw workspaceError("Worktree 模式需要有提交记录的 Git 仓库", "workspace_git_required");
		}

		if (repositoryRoot && baseCommit) {
			const worktreePath = join(workspaceRoot, "worktree");
			const branch = `lystar/task/${workspaceId}`;
			try {
				if (mode === "worktree")
					await runGitWrite(repositoryRoot, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
				else await runGitWrite(repositoryRoot, ["worktree", "add", "--detach", worktreePath, baseCommit]);
			} catch (error) {
				await rm(workspaceRoot, { recursive: true, force: true });
				throw error;
			}
			return {
				id: workspaceId,
				mode,
				projectCwd: source,
				cwd: effectiveWorktreeCwd(repositoryRoot, source, worktreePath),
				status: "active",
				repositoryRoot,
				baseCommit,
				...(mode === "worktree" ? { branch } : {}),
				worktreePath,
				...(mode === "patch" ? { patchPath: join(workspaceRoot, "result.patch") } : {}),
			};
		}

		if (mode === "worktree") {
			await rm(workspaceRoot, { recursive: true, force: true });
			throw workspaceError("Worktree 模式需要 Git 仓库", "workspace_git_required");
		}
		const baselinePath = join(workspaceRoot, "baseline");
		const worktreePath = join(workspaceRoot, "worktree");
		await copyProject(source, baselinePath);
		await copyProject(baselinePath, worktreePath);
		return {
			id: workspaceId,
			mode,
			projectCwd: source,
			cwd: worktreePath,
			status: "active",
			worktreePath,
			baselinePath,
			patchPath: join(workspaceRoot, "result.patch"),
		};
	}

	async collect(
		workspace: SessionWorkspaceSnapshot,
		outcome: SessionCollaborationResult["outcome"],
	): Promise<CollaborationWorkspaceDelivery> {
		if (workspace.mode === "shared") {
			return {
				workspace: { ...workspace, status: outcome === "completed" ? "delivered" : "failed" },
				changedFiles: [],
			};
		}
		const changedFiles =
			workspace.repositoryRoot && workspace.baseCommit
				? await gitChangedFiles(workspace.cwd, workspace.baseCommit)
				: workspace.baselinePath && workspace.worktreePath
					? await changedCopiedFiles(workspace.baselinePath, workspace.worktreePath)
					: [];
		const deliveryCommit =
			workspace.repositoryRoot && workspace.baseCommit
				? (await readGitHead(workspace.cwd)) !== workspace.baseCommit
					? await readGitHead(workspace.cwd)
					: undefined
				: undefined;
		const patchPath =
			workspace.mode === "patch"
				? workspace.repositoryRoot
					? await patchGitWorkspace(workspace)
					: await patchCopiedWorkspace(workspace)
				: undefined;
		return {
			workspace: {
				...workspace,
				status: outcome === "completed" ? "delivered" : "failed",
				...(patchPath ? { patchPath } : {}),
			},
			changedFiles,
			...(deliveryCommit ? { deliveryCommit } : {}),
			...(patchPath ? { patchPath } : {}),
		};
	}

	async release(workspace: SessionWorkspaceSnapshot): Promise<SessionWorkspaceSnapshot> {
		if (workspace.mode !== "shared" && workspace.repositoryRoot && workspace.worktreePath) {
			try {
				await runGitWrite(workspace.repositoryRoot, ["worktree", "remove", "--force", workspace.worktreePath]);
			} catch (error) {
				if (existsSync(workspace.worktreePath)) throw error;
			}
		}
		if (workspace.mode !== "shared") await rm(join(this.root, workspace.id), { recursive: true, force: true });
		return { ...workspace, cwd: workspace.projectCwd, status: "released" };
	}
}
