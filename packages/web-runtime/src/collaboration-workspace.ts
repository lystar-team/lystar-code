import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
			timeout: 30_000,
		});
		return result.stdout;
	} catch (error) {
		const candidate = error as GitCommandError;
		const message = candidate.stderr?.trim() || candidate.stdout?.trim() || candidate.message;
		throw Object.assign(new Error(message), { code: "git_command_failed", retryable: false });
	}
}

async function runGitWrite(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	try {
		const result = await execFileAsync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: COMMAND_MAX_BUFFER,
			env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
			timeout: 30_000,
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
		if (record[0] === "R" || record[0] === "C" || record[1] === "R" || record[1] === "C") {
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
	const untracked = statusOutput
		.split("\0")
		.filter((record) => record.startsWith("?? "))
		.map((record) => record.slice(3));
	return [...new Set([...diffOutput.split("\0").filter(Boolean), ...untracked])].sort();
}

async function patchGitWorkspace(workspace: SessionWorkspaceSnapshot): Promise<string> {
	if (!workspace.baseCommit || !workspace.worktreePath) {
		throw workspaceError("Patch 工作区缺少 Git 基线", "workspace_patch_base_missing");
	}
	const base = workspace.baselineTree ?? workspace.baseCommit;
	const patchPath = workspace.patchPath;
	if (!patchPath) throw workspaceError("Patch 工作区缺少补丁路径", "workspace_patch_path_missing");
	const indexPath = join(workspace.worktreePath, "..", `patch-${randomUUID()}.index`);
	const env = { GIT_INDEX_FILE: indexPath };
	try {
		await runGitWrite(workspace.worktreePath, ["read-tree", base], env);
		const paths = await gitChangedFiles(workspace.worktreePath, base);
		for (let offset = 0; offset < paths.length; offset += 100)
			await runGitWrite(workspace.worktreePath, ["add", "--", ...paths.slice(offset, offset + 100)], env);
		const patch = await runGitWrite(workspace.worktreePath, ["diff", "--cached", "--binary", base, "--"], env);
		await writeFile(patchPath, patch, "utf8");
		return patchPath;
	} finally {
		await rm(indexPath, { force: true });
	}
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
			return { id: workspaceId, mode, projectCwd: source, cwd: source, status: "active", sizeBytes: 0 };
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
			const indexPath = join(workspaceRoot, "baseline.index");
			let baselineTree: string;
			try {
				// 只写临时索引，保留主项目已有暂存和未提交成果。
				const env = { GIT_INDEX_FILE: indexPath };
				await runGitWrite(repositoryRoot, ["read-tree", baseCommit], env);
				const status = await runGit(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
				const paths = [...new Set(parseGitStatusPaths(status))];
				for (let offset = 0; offset < paths.length; offset += 100)
					await runGitWrite(repositoryRoot, ["add", "--", ...paths.slice(offset, offset + 100)], env);
				baselineTree = (await runGitWrite(repositoryRoot, ["write-tree"], env)).trim();
				await runGitWrite(repositoryRoot, ["update-ref", `refs/lystar/workspaces/${workspaceId}`, baselineTree]);
				await runGitWrite(worktreePath, ["read-tree", "--reset", "-u", baselineTree]);
			} catch (error) {
				await runGitWrite(repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
				if (mode === "worktree") await runGitWrite(repositoryRoot, ["branch", "-d", branch]);
				await runGitWrite(repositoryRoot, ["update-ref", "-d", `refs/lystar/workspaces/${workspaceId}`]);
				throw error;
			} finally {
				await rm(indexPath, { force: true });
			}
			return {
				id: workspaceId,
				mode,
				projectCwd: source,
				cwd: effectiveWorktreeCwd(repositoryRoot, source, worktreePath),
				status: "active",
				repositoryRoot,
				baseCommit,
				baselineTree,
				...(mode === "worktree" ? { branch } : {}),
				worktreePath,
				patchPath: join(workspaceRoot, "result.patch"),
			};
		}

		if (mode === "worktree") {
			await rm(workspaceRoot, { recursive: true, force: true });
			throw workspaceError("Worktree 模式需要 Git 仓库", "workspace_git_required");
		}
		const baselinePath = join(workspaceRoot, "baseline");
		const worktreePath = join(workspaceRoot, "worktree");
		try {
			await copyProject(source, baselinePath);
			await copyProject(baselinePath, worktreePath);
		} catch (error) {
			await rm(workspaceRoot, { recursive: true, force: true });
			throw error;
		}
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
				? await gitChangedFiles(
						workspace.worktreePath ?? workspace.cwd,
						workspace.baselineTree ?? workspace.baseCommit,
					)
				: workspace.baselinePath && workspace.worktreePath
					? await changedCopiedFiles(workspace.baselinePath, workspace.worktreePath)
					: [];
		const deliveryCommit =
			workspace.repositoryRoot && workspace.baseCommit
				? (await readGitHead(workspace.cwd)) !== workspace.baseCommit
					? await readGitHead(workspace.cwd)
					: undefined
				: undefined;
		const collectedWorkspace = {
			...workspace,
			patchPath: workspace.patchPath ?? join(this.root, workspace.id, `result-${randomUUID()}.patch`),
		};
		const patchPath = workspace.repositoryRoot
			? await patchGitWorkspace(collectedWorkspace)
			: await patchCopiedWorkspace(collectedWorkspace);
		return {
			workspace: {
				...workspace,
				status: outcome === "completed" ? "delivered" : "failed",
				...(patchPath ? { patchPath } : {}),
				...(await this.describe(workspace)),
			},
			changedFiles,
			...(deliveryCommit ? { deliveryCommit } : {}),
			...(patchPath ? { patchPath } : {}),
		};
	}

	async receive(
		workspace: SessionWorkspaceSnapshot,
		changedFiles: readonly string[] = [],
	): Promise<SessionWorkspaceSnapshot> {
		if (workspace.status === "accepted" || workspace.status === "released") return workspace;
		if (workspace.mode === "shared") return { ...workspace, status: "accepted" };
		if (workspace.repositoryRoot && workspace.baseCommit && workspace.worktreePath) {
			const patchPath = await patchGitWorkspace({
				...workspace,
				patchPath: workspace.patchPath ?? join(this.root, workspace.id, "result.patch"),
			});
			const patch = await readFile(patchPath, "utf8");
			if (patch.trim()) {
				// 已接收的补丁可幂等重试；检查冲突后再写，避免失败留下部分成果。
				const reversed = await execFileAsync("git", ["apply", "--reverse", "--check", "--binary", patchPath], {
					cwd: workspace.repositoryRoot,
					timeout: 30_000,
				}).then(
					() => true,
					() => false,
				);
				if (!reversed) {
					await runGitWrite(workspace.repositoryRoot, ["apply", "--check", "--binary", patchPath]);
					await runGitWrite(workspace.repositoryRoot, ["apply", "--binary", patchPath]);
				}
			}
			return { ...workspace, patchPath, status: "accepted" };
		}
		if (workspace.baselinePath && workspace.worktreePath) {
			const paths =
				changedFiles.length > 0
					? changedFiles
					: await changedCopiedFiles(workspace.baselinePath, workspace.worktreePath);
			for (const path of paths) {
				const baseline = resolve(workspace.baselinePath, path);
				const source = resolve(workspace.worktreePath, path);
				const target = resolve(workspace.projectCwd, path);
				const targetExists = existsSync(target);
				const sameBaseline =
					targetExists === existsSync(baseline) &&
					(!targetExists || (await readFile(target)).equals(await readFile(baseline)));
				const alreadyReceived =
					targetExists === existsSync(source) &&
					(!targetExists || (await readFile(target)).equals(await readFile(source)));
				if (!sameBaseline && !alreadyReceived)
					throw workspaceError(`主项目文件已变化：${path}`, "workspace_receive_conflict");
			}
			for (const path of paths) {
				const source = resolve(workspace.worktreePath, path);
				const target = resolve(workspace.projectCwd, path);
				if (existsSync(source)) {
					await mkdir(join(target, ".."), { recursive: true });
					await cp(source, target, { recursive: true, force: true });
				} else {
					await rm(target, { recursive: true, force: true });
				}
			}
		}
		return { ...workspace, status: "accepted" };
	}
	async resume(workspace: SessionWorkspaceSnapshot): Promise<SessionWorkspaceSnapshot> {
		if (workspace.status === "active") return workspace;
		if (workspace.status === "released") throw workspaceError("已回收的工作区需要重新创建", "workspace_released");
		const resumed: SessionWorkspaceSnapshot = {
			...workspace,
			status: "active",
			...(workspace.mode !== "shared"
				? { patchPath: join(this.root, workspace.id, `result-${randomUUID()}.patch`) }
				: {}),
			retainedReason: undefined,
		};
		if (workspace.status !== "accepted" || workspace.mode === "shared") return resumed;
		if (workspace.repositoryRoot && workspace.baseCommit && workspace.worktreePath && workspace.patchPath) {
			const indexPath = join(this.root, workspace.id, `resume-${randomUUID()}.index`);
			const env = { GIT_INDEX_FILE: indexPath };
			try {
				await runGitWrite(
					workspace.worktreePath,
					["read-tree", workspace.baselineTree ?? workspace.baseCommit],
					env,
				);
				if ((await readFile(workspace.patchPath, "utf8")).trim())
					await runGitWrite(workspace.worktreePath, ["apply", "--cached", "--binary", workspace.patchPath], env);
				const baselineTree = (await runGitWrite(workspace.worktreePath, ["write-tree"], env)).trim();
				await runGitWrite(workspace.repositoryRoot, [
					"update-ref",
					`refs/lystar/workspaces/${workspace.id}`,
					baselineTree,
				]);
				return { ...resumed, baselineTree };
			} finally {
				await rm(indexPath, { force: true });
			}
		}
		if (workspace.baselinePath && workspace.worktreePath) {
			const reason = await this.canRelease(workspace);
			if (reason) throw workspaceError(reason, "workspace_resume_conflict");
			const baselinePath = join(this.root, workspace.id, `baseline-${randomUUID()}`);
			await copyProject(workspace.worktreePath, baselinePath);
			return { ...resumed, baselinePath };
		}
		throw workspaceError("工作区缺少已接收的基线", "workspace_resume_base_missing");
	}
	async describe(workspace: SessionWorkspaceSnapshot): Promise<{ sizeBytes: number }> {
		if (workspace.mode === "shared" || workspace.status === "released") return { sizeBytes: 0 };
		const root = join(this.root, workspace.id);
		const directories = [root];
		const seen = new Set<string>();
		let sizeBytes = 0;
		while (directories.length) {
			const directory = directories.pop()!;
			if (!existsSync(directory)) continue;
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				const info = await lstat(path).catch((error: unknown) => {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
					throw error;
				});
				if (!info) continue;
				const inode = `${info.dev}:${info.ino}`;
				if (seen.has(inode)) continue;
				seen.add(inode);
				sizeBytes += info.blocks * 512;
				if (entry.isDirectory()) directories.push(path);
			}
		}
		return { sizeBytes };
	}

	async canRelease(workspace: SessionWorkspaceSnapshot): Promise<string | undefined> {
		if (workspace.mode === "shared" || workspace.status === "released") return "工作区无需回收";
		if (workspace.status !== "accepted")
			return workspace.status === "failed" ? "任务未成功，保留成果用于重试" : "成果尚未接收";
		if (!workspace.worktreePath || !existsSync(workspace.worktreePath)) return undefined;
		if (workspace.repositoryRoot && workspace.baseCommit) {
			if (!workspace.patchPath || !existsSync(workspace.patchPath)) return "缺少已接收的交付补丁";
			const patch = await readFile(workspace.patchPath, "utf8");
			const currentPath = join(this.root, workspace.id, "release.patch");
			try {
				await patchGitWorkspace({ ...workspace, patchPath: currentPath });
				if ((await readFile(currentPath, "utf8")) !== patch) return "接收后又产生了改动";
			} finally {
				await rm(currentPath, { force: true });
			}
		} else if (workspace.baselinePath) {
			for (const path of await changedCopiedFiles(workspace.baselinePath, workspace.worktreePath)) {
				const source = join(workspace.worktreePath, path);
				const target = join(workspace.projectCwd, path);
				if (existsSync(source) !== existsSync(target)) return "接收后文件状态已变化";
				if (existsSync(source) && !(await readFile(source)).equals(await readFile(target)))
					return "接收后文件内容已变化";
			}
		}
		return undefined;
	}

	async release(workspace: SessionWorkspaceSnapshot): Promise<SessionWorkspaceSnapshot> {
		if (workspace.mode === "shared") return { ...workspace, status: "released", sizeBytes: 0 };
		const workspaceRoot = join(this.root, workspace.id);
		if (resolve(workspace.worktreePath ?? "") !== resolve(workspaceRoot, "worktree"))
			throw workspaceError("工作区目录与登记不一致", "workspace_path_mismatch");
		if (workspace.repositoryRoot && workspace.worktreePath) {
			try {
				await runGitWrite(workspace.repositoryRoot, ["worktree", "remove", "--force", workspace.worktreePath]);
			} catch (error) {
				if (existsSync(workspace.worktreePath)) throw error;
			}
			if (
				workspace.branch?.startsWith("lystar/task/") &&
				workspace.baseCommit &&
				(await readGitHead(workspace.repositoryRoot))
			) {
				const merged = await execFileAsync("git", ["merge-base", "--is-ancestor", workspace.branch, "HEAD"], {
					cwd: workspace.repositoryRoot,
					timeout: 30_000,
				}).then(
					() => true,
					() => false,
				);
				if (merged) await runGitWrite(workspace.repositoryRoot, ["branch", "-d", workspace.branch]);
			}
			await runGitWrite(workspace.repositoryRoot, ["update-ref", "-d", `refs/lystar/workspaces/${workspace.id}`]);
		}
		await rm(join(workspaceRoot, "worktree"), { recursive: true, force: true });
		if (existsSync(workspaceRoot)) {
			for (const entry of await readdir(workspaceRoot, { withFileTypes: true })) {
				if (entry.isDirectory() && (entry.name === "baseline" || entry.name.startsWith("baseline-")))
					await rm(join(workspaceRoot, entry.name), { recursive: true, force: true });
			}
		}
		return { ...workspace, cwd: workspace.projectCwd, status: "released", sizeBytes: 0, retainedReason: undefined };
	}
}
