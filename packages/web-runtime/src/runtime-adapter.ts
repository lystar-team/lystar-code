import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	type Dirent,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { type Api, type AuthResult, contentText, type Model } from "@earendil-works/pi-ai";

import {
	type AgentCapabilityLease,
	type AgentInputOrigin,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type AgentTurnContext,
	type AgentTurnResult,
	APP_TITLE,
	type AuthEvent,
	type AuthPrompt,
	abortSubagent,
	builtInExtensions,
	CONFIG_DIR_NAME,
	type CreateAgentSessionRuntimeFactory,
	clearModelsJsonModelOverride,
	clearModelsJsonProviderCatalogProvider,
	continueSubagentSession,
	copyToClipboard,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createSessionsTool,
	DefaultPackageManager,
	discoverAgentDefinitions,
	discoverHarnessImports,
	type ExtensionCommandContextActions,
	type ExtensionUIContext,
	findSessionProfile,
	formatVersionCheckError,
	getAgentDir,
	getBuiltinThemeNames,
	getCurrentSubagentRuns,
	getDefaultSessionDir,
	getFullChangelogMarkdown,
	getLatestPiRelease,
	getLystarSetting,
	getLystarSettingsForUi,
	getSupportedThinkingLevels,
	getToolRecoveryDoctorReport,
	getToolRecoveryMode,
	hasTrustRequiringProjectResources,
	importHarnessResources,
	isNewerPackageVersion,
	loadProjectContextFiles,
	loadSkills,
	ModelConfig,
	ModelRuntime,
	type ModelsJsonModel,
	type ModelsJsonModelOverride,
	PACKAGE_VERSION,
	type ProjectTrustContext,
	ProjectTrustStore,
	promptDisplayText,
	RELEASE_REPOSITORY,
	readClipboardImage,
	readClipboardText,
	readSessionSnapshot,
	removeModelsJsonModels,
	removeModelsJsonProvider,
	renderSubagentMarkdown,
	renderTerminalRichText,
	requestWebSessionHandoff,
	resolveProjectTrusted,
	rootOriginOf,
	type SessionCollaborationResult,
	type SessionCollaborationTask,
	type SessionCoordinator,
	type SessionEntry,
	type SessionInfoCache,
	SessionLockedError,
	SessionManager,
	type SessionProfile,
	type SessionProfileSnapshot,
	type SessionWorkspaceSnapshot,
	SettingsManager,
	type SubagentDetails,
	type SubagentRunSnapshot,
	saveModelsJsonModel,
	saveModelsJsonModelOverride,
	saveModelsJsonModels,
	saveModelsJsonProvider,
	saveModelsJsonSyncedModels,
	setModelsJsonModelDisabled,
	subscribeSubagentRuns,
	VERSION,
	WebCompanionServer,
} from "@earendil-works/pi-coding-agent/core";
import type {
	AuthType,
	ClipboardImageReadResult,
	CompletionItem,
	CompletionResult,
	ContentChunk,
	GitBranches,
	GitCommit,
	GitDiff,
	GitFileStats,
	GitFileStatus,
	GitHistory,
	GitMutation,
	GitMutationResult,
	GitRepositoryStatus,
	GitStats,
	GitStatus,
	HarnessImportPreview,
	HarnessImportResult,
	HostDirectoryListing,
	JsonValue,
	ModelOptions,
	ModelRef,
	PackageSummary,
	ProjectFileSaveResult,
	ProjectInstruction,
	ProjectResource,
	ProjectTrust,
	ReadProjectImageResult,
	SessionActivity,
	SessionInfoResult,
	SessionProgress,
	SessionStateSnapshot,
	SessionTreeNode,
	SettingSummary,
	SubagentConfig,
	SubagentSnapshot,
	ThinkingLevel,
	TranscriptItem,
} from "@lystar/code-web-protocol";
import { RUNTIME_PROTOCOL_VERSION } from "@lystar/code-web-protocol";
import {
	AGENT_STEP_CUSTOM_TYPE,
	AGENT_STEP_TOOL_NAMES,
	AgentStepController,
	createAgentStepTools,
} from "./agent-steps.ts";
import {
	EXTENSION_ACTIVITY_CUSTOM_TYPE,
	type ExtensionActivityRecord,
	parseExtensionActivityRecord,
} from "./extension-activity.ts";
import { macosGitCredentialError, webGitArguments } from "./git-environment.ts";
import {
	migrateLegacyWebAttachments,
	rebindSessionAttachments,
	sessionAttachmentDirectory,
} from "./session-attachments.ts";
import { isDiffTool, toolCallUpdate, toolPath, toolProgressDiff, toolRecord } from "./tool-progress.ts";
import type {
	ModelProviderInput,
	ModelProviderSummary,
	ModelSummary,
	ProviderModelInput,
	RichTextRenderRequest,
	RuntimeAdapter,
	RuntimeEvent,
	RuntimePromptReservation,
	RuntimeSession,
	SessionSummaryBase,
	SkillSummary,
	ToolRecoveryRuntimeDiagnostics,
	UiRequest,
	UiRequestHandler,
} from "./types.ts";
import { probeUserNodeToolchain } from "./user-execution-environment.ts";
import { projectAgentEvent, WebCompanionProtocolError, WebCompanionRuntime } from "./web-companion-runtime.ts";
import { webSearchProgressFromCall, webSearchProgressSummary } from "./web-search-progress.ts";

export { BUILTIN_SLASH_COMMANDS } from "@earendil-works/pi-coding-agent/core";

function runtimeEngineCheck(): { id: string; status: string; message: string } {
	const bunVersion = process.versions.bun;
	return bunVersion
		? {
				id: "runtime-engine",
				status: "ok",
				message: `LYStar Runtime：Bun ${bunVersion}（Node API 兼容 ${process.versions.node ?? process.version}）`,
			}
		: { id: "runtime-engine", status: "ok", message: `LYStar Runtime：Node.js ${process.version}` };
}

function readHostVersion(): string | undefined {
	for (const path of [
		join(dirname(process.execPath), "web-runtime-package.json"),
		new URL("../package.json", import.meta.url),
	]) {
		try {
			const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
			if (typeof value.version === "string") return value.version;
		} catch {}
	}
	return undefined;
}

const HOST_VERSION = process.env.PI_WEB_RUNTIME_VERSION ?? readHostVersion() ?? "0.0.0";
const execFileAsync = promisify(execFile);
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_EDITOR_CONTENT_MAX_BYTES = 2 * 1024 * 1024;
const PROJECT_TEXT_EDITOR_MAX_BYTES = 2 * 1024 * 1024;
const PROJECT_RESOURCE_MAX_BYTES = 32 * 1024 * 1024;
const PROJECT_INSTRUCTION_NAMES = ["AGENTS.override.md", "AGENTS.md"] as const;
const SUBAGENT_NAME_MAX_LENGTH = 128;
const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
	".bmp": "image/bmp",
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};
const BINARY_MIME_TYPES: Readonly<Record<string, string>> = {
	".doc": "application/msword",
	".docm": "application/vnd.ms-word.document.macroenabled.12",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".pdf": "application/pdf",
	".ppt": "application/vnd.ms-powerpoint",
	".pptm": "application/vnd.ms-powerpoint.presentation.macroenabled.12",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".xls": "application/vnd.ms-excel",
	".xlsm": "application/vnd.ms-excel.sheet.macroenabled.12",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".zip": "application/zip",
};

function contentHash(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function fileContentVersion(path: string): string {
	const stat = statSync(path);
	return contentHash(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
}

function canonicalDirectory(path: string): string {
	const resolved = realpathSync(resolve(path));
	if (!statSync(resolved).isDirectory())
		throw Object.assign(new Error(`项目路径不是目录：${path}`), { code: "invalid_cwd" });
	return resolved;
}

function isInside(root: string, path: string): boolean {
	const value = relative(root, path);
	return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function splitResourceTarget(target: string): { path: string; line?: number; column?: number } {
	const hashMatch = /^(.*)#L(\d+)(?:C(\d+))?$/.exec(target);
	if (hashMatch) {
		return {
			path: hashMatch[1],
			line: Number(hashMatch[2]),
			...(hashMatch[3] ? { column: Number(hashMatch[3]) } : {}),
		};
	}
	const lineMatch = /^(.*):(\d+)(?::(\d+))?$/.exec(target);
	if (lineMatch?.[1]) {
		return {
			path: lineMatch[1],
			line: Number(lineMatch[2]),
			...(lineMatch[3] ? { column: Number(lineMatch[3]) } : {}),
		};
	}
	return { path: target };
}

function canonicalProjectFile(cwd: string, input: string): { root: string; path: string } {
	const root = canonicalDirectory(cwd);
	const resolved = resolve(root, input);
	if (!existsSync(resolved)) throw Object.assign(new Error(`文件不存在：${input}`), { code: "resource_not_found" });
	const path = realpathSync(resolved);
	if (!isInside(root, path)) {
		throw Object.assign(new Error("文件不在当前项目范围内"), { code: "resource_outside_project", retryable: false });
	}
	if (!statSync(path).isFile()) throw Object.assign(new Error("目标不是普通文件"), { code: "resource_not_file" });
	return { root, path };
}

function canonicalExternalFile(input: string): string {
	if (!isAbsolute(input))
		throw Object.assign(new Error("项目外文件必须使用绝对路径"), { code: "resource_path_invalid" });
	if (!existsSync(input)) throw Object.assign(new Error(`文件不存在：${input}`), { code: "resource_not_found" });
	const path = realpathSync(input);
	if (!statSync(path).isFile()) throw Object.assign(new Error("目标不是普通文件"), { code: "resource_not_file" });
	return path;
}

function resolveProfileModel(profile: SessionProfile | undefined, runtime: ModelRuntime): Model<any> | undefined {
	const reference = profile?.model?.trim();
	if (!reference) return undefined;
	const separator = reference.indexOf("/");
	if (separator <= 0) {
		const matches = runtime.getAvailableSnapshot().filter((model) => model.id === reference);
		if (matches.length === 1) return matches[0];
		throw Object.assign(new Error(`智能体模型必须使用 provider/model 格式，或指定唯一模型 ID：${reference}`), {
			code: matches.length === 0 ? "session_profile_model_not_found" : "session_profile_model_ambiguous",
		});
	}
	if (separator === reference.length - 1) {
		throw Object.assign(new Error(`智能体模型无效：${reference}`), { code: "session_profile_model_invalid" });
	}
	const model = runtime.getModel(reference.slice(0, separator), reference.slice(separator + 1));
	if (!model) {
		throw Object.assign(new Error(`未找到智能体模型：${reference}`), { code: "session_profile_model_not_found" });
	}
	return model;
}

function sessionProfileFromHeader(manager: SessionManager, cwd: string, agentDir: string): SessionProfile | undefined {
	const profile = manager.getHeader()?.profile;
	if (!profile) return undefined;
	const current = findSessionProfile(cwd, profile.id, agentDir);
	if (current) return current;
	return {
		id: profile.id,
		name: profile.name,
		description: profile.description,
		...(profile.icon ? { icon: profile.icon } : {}),
		...(profile.model ? { model: profile.model } : {}),
		...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel as SessionProfile["thinkingLevel"] } : {}),
		...(profile.tools ? { tools: [...profile.tools] } : {}),
		...(profile.skillNames ? { skillNames: [...profile.skillNames] } : {}),
		systemPrompt: profile.systemPrompt ?? "",
		...(profile.agentsInstructions ? { agentsInstructions: profile.agentsInstructions } : {}),
		scope: profile.scope,
		sourcePath: "<session-profile>",
	};
}

function sessionProfileSnapshot(profile: SessionProfile): SessionProfileSnapshot {
	return {
		id: profile.id,
		name: profile.name,
		description: profile.description,
		scope: profile.scope,
		...(profile.icon ? { icon: profile.icon } : {}),
		...(profile.model ? { model: profile.model } : {}),
		...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
		...(profile.tools ? { tools: [...profile.tools] } : {}),
		...(profile.skillNames ? { skillNames: [...profile.skillNames] } : {}),
		...(profile.systemPrompt ? { systemPrompt: profile.systemPrompt } : {}),
		...(profile.agentsInstructions ? { agentsInstructions: profile.agentsInstructions } : {}),
	};
}

const READ_ONLY_SESSION_TOOLS = ["read", "sessions"] as const;

function validSubagentName(value: string): string {
	const name = value.trim();
	if (
		!name ||
		name.length > SUBAGENT_NAME_MAX_LENGTH ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0")
	)
		throw Object.assign(new Error("智能体名称无效"), { code: "subagent_name_invalid" });
	return name;
}

function atomicWriteUtf8(path: string, content: string, mode?: number): void {
	const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let file: number | undefined;
	try {
		file = openSync(temporaryPath, "wx", mode);
		writeFileSync(file, content, "utf8");
		fsyncSync(file);
		closeSync(file);
		file = undefined;
		renameSync(temporaryPath, path);
		if (process.platform !== "win32") {
			const directory = openSync(dirname(path), "r");
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
		}
	} finally {
		if (file !== undefined) closeSync(file);
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

function imageMimeType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | undefined {
	if (
		bytes.length >= 8 &&
		bytes.subarray(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])
	)
		return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.length >= 12 &&
		Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
		Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
	)
		return "image/webp";
	if (
		bytes.length >= 6 &&
		(Buffer.from(bytes.subarray(0, 6)).toString("ascii") === "GIF87a" ||
			Buffer.from(bytes.subarray(0, 6)).toString("ascii") === "GIF89a")
	)
		return "image/gif";
	return undefined;
}

function fileMimeType(path: string): { kind: "text" | "image" | "binary"; mimeType: string } {
	const extension = extname(path).toLowerCase();
	const imageMimeType = IMAGE_MIME_TYPES[extension];
	if (imageMimeType) return { kind: "image", mimeType: imageMimeType };
	const binaryMimeType = BINARY_MIME_TYPES[extension];
	if (binaryMimeType) return { kind: "binary", mimeType: binaryMimeType };
	const file = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(Math.min(8192, statSync(path).size));
		const bytesRead = readSync(file, buffer, 0, buffer.length, 0);
		if (buffer.subarray(0, bytesRead).includes(0)) {
			return { kind: "binary", mimeType: "application/octet-stream" };
		}
	} finally {
		closeSync(file);
	}
	return { kind: "text", mimeType: "text/plain; charset=utf-8" };
}

function readResourceFile(path: string, offset: number, limit: number): ContentChunk {
	const stat = statSync(path);
	if (stat.size > PROJECT_RESOURCE_MAX_BYTES)
		throw Object.assign(new Error("文件超过 32 MiB 的桌面查看上限"), { code: "resource_too_large" });
	if (offset > stat.size) throw Object.assign(new Error("文件读取位置超出范围"), { code: "resource_offset_invalid" });
	const nextOffset = Math.min(stat.size, offset + limit);
	const file = openSync(path, "r");
	try {
		const bytes = Buffer.allocUnsafe(nextOffset - offset);
		const bytesRead = readSync(file, bytes, 0, bytes.length, offset);
		return {
			contentRef: createHash("sha256").update(path).digest("hex"),
			offset,
			nextOffset: offset + bytesRead,
			byteLength: stat.size,
			data: bytes.subarray(0, bytesRead).toString("base64"),
			encoding: "base64",
			done: offset + bytesRead === stat.size,
		};
	} finally {
		closeSync(file);
	}
}

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const result = await execFileAsync("git", webGitArguments(cwd, args), {
			encoding: "utf8",
			maxBuffer: GIT_MAX_OUTPUT_BYTES,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" },
		});
		return result.stdout;
	} catch (error) {
		const candidate = error as Error & { code?: string | number; stderr?: string };
		const message = candidate.stderr?.trim() || candidate.message;
		throw Object.assign(new Error(message), {
			code: message.includes("not a git repository") ? "git_not_repository" : "git_command_failed",
			retryable: false,
		});
	}
}

async function gitWrite(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	try {
		const result = await execFileAsync("git", webGitArguments(cwd, args), {
			encoding: "utf8",
			maxBuffer: GIT_MAX_OUTPUT_BYTES,
			signal,
			env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
		});
		return result.stdout;
	} catch (error) {
		const candidate = error as Error & { code?: string | number; stdout?: string; stderr?: string };
		const output = [candidate.stdout?.trim(), candidate.stderr?.trim()].filter(Boolean).join("\n");
		if (args[0] === "merge" && (output.includes("CONFLICT") || output.includes("Automatic merge failed"))) {
			throw Object.assign(new Error("合并产生冲突，请解决冲突后提交，或中止合并"), {
				code: "git_merge_conflict",
				retryable: false,
			});
		}
		if (args[0] === "pull" && output.includes("Not possible to fast-forward")) {
			throw Object.assign(new Error("当前分支与远端已分叉，不能快进拉取；请明确执行分支合并"), {
				code: "git_fast_forward_required",
				retryable: false,
			});
		}
		const credentialError = macosGitCredentialError(output);
		if (credentialError) {
			throw Object.assign(new Error(credentialError.message), {
				code: credentialError.code,
				retryable: false,
			});
		}
		throw Object.assign(new Error(output || candidate.message), {
			code: "git_command_failed",
			retryable: false,
		});
	}
}

async function gitHasHead(cwd: string): Promise<boolean> {
	try {
		await git(cwd, ["rev-parse", "--verify", "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

async function currentGitBranch(cwd: string): Promise<string | undefined> {
	try {
		return (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() || undefined;
	} catch {
		return undefined;
	}
}

async function gitMergeInProgress(cwd: string): Promise<boolean> {
	try {
		const mergeHead = (await git(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"])).trim();
		return Boolean(mergeHead && existsSync(isAbsolute(mergeHead) ? mergeHead : resolve(cwd, mergeHead)));
	} catch {
		return false;
	}
}

async function validateGitBranchName(cwd: string, value: string): Promise<string> {
	if (value.trim() !== value || value.startsWith("-") || value.includes("\0")) {
		throw Object.assign(new Error("Git 分支名称无效"), { code: "git_branch_name_invalid", retryable: false });
	}
	try {
		await git(cwd, ["check-ref-format", "--branch", value]);
		return value;
	} catch {
		throw Object.assign(new Error("Git 分支名称无效"), { code: "git_branch_name_invalid", retryable: false });
	}
}

function boundedGitEditorContent(content: string): string | undefined {
	if (content.includes("\0") || Buffer.byteLength(content, "utf8") > GIT_EDITOR_CONTENT_MAX_BYTES) return undefined;
	return content;
}

async function readGitRevisionContent(cwd: string, revision: string, path: string): Promise<string | undefined> {
	const objectPath = `${revision}:${path}`;
	try {
		await git(cwd, ["cat-file", "-e", objectPath]);
	} catch {
		return "";
	}
	try {
		return boundedGitEditorContent(await git(cwd, ["show", objectPath]));
	} catch {
		return undefined;
	}
}

function readWorkingTreeGitContent(cwd: string, path: string): string | undefined {
	const root = canonicalDirectory(cwd);
	const candidate = resolve(root, path);
	if (!isInside(root, candidate)) {
		throw Object.assign(new Error("Git 文件不在当前项目范围内"), { code: "resource_outside_project" });
	}
	if (!existsSync(candidate)) return "";
	const resolved = realpathSync(candidate);
	if (!isInside(root, resolved)) {
		throw Object.assign(new Error("Git 文件不在当前项目范围内"), { code: "resource_outside_project" });
	}
	const stat = statSync(resolved);
	if (!stat.isFile()) return "";
	if (stat.size > GIT_EDITOR_CONTENT_MAX_BYTES) return undefined;
	return boundedGitEditorContent(readFileSync(resolved, "utf8"));
}

function gitFile(
	path: string,
	xy: string,
	originalPath?: string,
	untracked = false,
	conflicted = false,
): GitFileStatus {
	const indexStatus = untracked ? "?" : (xy[0] ?? ".");
	const worktreeStatus = untracked ? "?" : (xy[1] ?? ".");
	return {
		path,
		...(originalPath ? { originalPath } : {}),
		indexStatus,
		worktreeStatus,
		staged: !untracked && indexStatus !== ".",
		unstaged: untracked || worktreeStatus !== ".",
		untracked,
		conflicted,
	};
}

function repositoryPathFromRoot(projectRoot: string, repositoryRoot: string): string {
	if (!isInside(projectRoot, repositoryRoot) || projectRoot === repositoryRoot) return "";
	return relative(projectRoot, repositoryRoot).split(sep).join("/");
}

async function resolveGitRepositoryRoot(projectRoot: string, repositoryPath?: string): Promise<string> {
	if (repositoryPath !== undefined) {
		if (repositoryPath.includes("\0") || isAbsolute(repositoryPath)) {
			throw Object.assign(new Error("Git 仓库路径必须是项目内相对路径"), {
				code: "git_repository_path_invalid",
			});
		}
		const candidate = resolve(projectRoot, repositoryPath || ".");
		if (!isInside(projectRoot, candidate)) {
			throw Object.assign(new Error("Git 仓库不在当前项目范围内"), { code: "resource_outside_project" });
		}
		const repositoryRoot = canonicalDirectory(candidate);
		const detectedRoot = canonicalDirectory((await git(repositoryRoot, ["rev-parse", "--show-toplevel"])).trim());
		if (detectedRoot !== repositoryRoot || !isInside(projectRoot, detectedRoot)) {
			throw Object.assign(new Error("目标目录不是当前项目内的 Git 仓库"), {
				code: "git_repository_path_invalid",
			});
		}
		return repositoryRoot;
	}
	try {
		const repositoryRoot = canonicalDirectory((await git(projectRoot, ["rev-parse", "--show-toplevel"])).trim());
		if (!isInside(projectRoot, repositoryRoot)) throw new Error("Git 根目录不在当前项目范围内");
		return repositoryRoot;
	} catch {
		const repositoryRoot = (await discoverGitRepositoryRoots(projectRoot)).sort()[0];
		if (repositoryRoot) return repositoryRoot;
		throw Object.assign(new Error("未找到 Git 仓库"), { code: "git_not_repository" });
	}
}

function assertGitFilePath(repositoryRoot: string, path: string): void {
	if (path.includes("\0") || isAbsolute(path) || !isInside(repositoryRoot, resolve(repositoryRoot, path))) {
		throw Object.assign(new Error("Git 文件路径无效"), { code: "git_file_path_invalid" });
	}
}

function assertGitRevision(revision: string): void {
	if (!/^[0-9a-f]{7,128}$/iu.test(revision)) {
		throw Object.assign(new Error("Git 提交版本无效"), { code: "git_revision_invalid", retryable: false });
	}
}

function parseGitNumStats(output: string, staged: boolean): GitFileStats[] {
	const records = output.split("\0");
	const files: GitFileStats[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;
		const firstTab = record.indexOf("\t");
		const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0) continue;
		const additionsText = record.slice(0, firstTab);
		const deletionsText = record.slice(firstTab + 1, secondTab);
		let path = record.slice(secondTab + 1);
		let originalPath: string | undefined;
		if (!path) {
			originalPath = records[++index];
			path = records[++index] ?? "";
		}
		if (!path) continue;
		const binary = additionsText === "-" || deletionsText === "-";
		files.push({
			path,
			...(originalPath ? { originalPath } : {}),
			staged,
			additions: binary ? 0 : Number(additionsText),
			deletions: binary ? 0 : Number(deletionsText),
			binary,
		});
	}
	return files;
}

function parseGitTracking(value: string): { ahead: number; behind: number } {
	return {
		ahead: Number(/ahead (\d+)/u.exec(value)?.[1] ?? 0),
		behind: Number(/behind (\d+)/u.exec(value)?.[1] ?? 0),
	};
}

function parseGitHistory(output: string): Array<{
	hash: string;
	shortHash: string;
	subject: string;
	authorName: string;
	authorEmail: string;
	authoredAt: string;
	parents: string[];
}> {
	const fields = output.split("\0");
	const commits: Array<{
		hash: string;
		shortHash: string;
		subject: string;
		authorName: string;
		authorEmail: string;
		authoredAt: string;
		parents: string[];
	}> = [];
	for (let index = 0; index + 6 < fields.length; index += 7) {
		const hash = fields[index];
		if (!hash) break;
		commits.push({
			hash,
			shortHash: fields[index + 1] ?? "",
			authorName: fields[index + 2] ?? "",
			authorEmail: fields[index + 3] ?? "",
			authoredAt: fields[index + 4] ?? "",
			subject: fields[index + 5] ?? "",
			parents: (fields[index + 6] ?? "").split(" ").filter(Boolean),
		});
	}
	return commits;
}

async function discoverGitRepositoryRoots(projectRoot: string, rootRepository?: string): Promise<string[]> {
	const repositories = new Set<string>();
	if (rootRepository && isInside(projectRoot, rootRepository)) repositories.add(rootRepository);
	const visited = new Set<string>();
	const pending = [projectRoot];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (!directory) continue;
		let canonicalPath: string;
		try {
			canonicalPath = realpathSync(directory);
		} catch {
			continue;
		}
		if (visited.has(canonicalPath)) continue;
		visited.add(canonicalPath);
		let entries: Dirent[];
		try {
			entries = await readdir(canonicalPath, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
			const child = join(canonicalPath, entry.name);
			if (existsSync(join(child, ".git"))) {
				try {
					const detectedRoot = canonicalDirectory((await git(child, ["rev-parse", "--show-toplevel"])).trim());
					if (isInside(projectRoot, detectedRoot)) repositories.add(detectedRoot);
				} catch {
					// 子目录可能只是普通目录中的无效 .git 文件，继续扫描其他目录。
				}
			}
			pending.push(child);
		}
	}
	return [...repositories];
}

function gitRepositoryStatus(status: GitStatus, projectRoot: string, rootRepository?: string): GitRepositoryStatus {
	return {
		root: status.root,
		path: repositoryPathFromRoot(projectRoot, status.root),
		kind: status.root === rootRepository ? "root" : "nested",
		...(status.branch ? { branch: status.branch } : {}),
		...(status.upstream ? { upstream: status.upstream } : {}),
		...(status.detached ? { detached: true } : {}),
		...(status.merging ? { merging: true } : {}),
		ahead: status.ahead,
		behind: status.behind,
		files: status.files,
	};
}

function parseGitStatus(root: string, output: string): GitStatus {
	const records = output.split("\0");
	const files: GitFileStatus[] = [];
	let branch: string | undefined;
	let upstream: string | undefined;
	let detached = false;
	let ahead = 0;
	let behind = 0;
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;
		if (record.startsWith("# branch.head ")) {
			const value = record.slice(14);
			if (value === "(detached)") detached = true;
			else branch = value;
			continue;
		}
		if (record.startsWith("# branch.upstream ")) {
			upstream = record.slice(18);
			continue;
		}
		if (record.startsWith("# branch.ab ")) {
			const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
			if (match) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
			continue;
		}
		if (record.startsWith("? ")) {
			files.push(gitFile(record.slice(2), "??", undefined, true));
			continue;
		}
		const fields = record.split(" ");
		if (fields[0] === "1") {
			files.push(gitFile(fields.slice(8).join(" "), fields[1] ?? ".."));
		} else if (fields[0] === "2") {
			files.push(gitFile(fields.slice(9).join(" "), fields[1] ?? "..", records[++index]));
		} else if (fields[0] === "u") {
			files.push(gitFile(fields.slice(10).join(" "), fields[1] ?? "UU", undefined, false, true));
		}
	}
	return {
		root,
		...(branch ? { branch } : {}),
		...(upstream ? { upstream } : {}),
		...(detached ? { detached: true } : {}),
		ahead,
		behind,
		files,
	};
}

function jsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function settingSummary(id: string, settings: SettingsManager, themeNames: readonly string[] = []): SettingSummary {
	const definition = getLystarSetting(id);
	if (!definition) throw Object.assign(new Error(`未知设置：${id}`), { code: "setting_not_found" });
	const optionValues = definition.id === "theme" ? themeNames : definition.options;
	return {
		id: definition.id,
		label: definition.label,
		...(definition.description ? { description: definition.description } : {}),
		kind: definition.kind,
		value: definition.get(settings),
		displayValue: definition.format(definition.get(settings)),
		...(optionValues && optionValues.length > 0
			? {
					options: optionValues.map(String),
					optionLabels: optionValues.map((value) => definition.format(value)),
				}
			: {}),
		...(definition.range ? { minimum: definition.range.min, maximum: definition.range.max } : {}),
		scope: definition.scope,
		readOnly: false,
		restartRequired: definition.restartRequired === true,
	};
}

function sessionTree(entries: readonly SessionEntry[], leafId: string | null): SessionTreeNode[] {
	const labels = new Map<string, string | undefined>();
	for (const entry of entries) {
		if (entry.type === "label") labels.set(entry.targetId, entry.label);
	}
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const children = new Map<string, SessionEntry[]>();
	const roots: SessionEntry[] = [];
	for (const entry of entries) {
		if (entry.parentId && entry.parentId !== entry.id && byId.has(entry.parentId)) {
			const siblings = children.get(entry.parentId) ?? [];
			siblings.push(entry);
			children.set(entry.parentId, siblings);
		} else {
			roots.push(entry);
		}
	}
	const output: SessionTreeNode[] = [];
	const visit = (entry: SessionEntry, depth: number): void => {
		const raw = entry.type === "message" ? entry.message : entry;
		output.push({
			id: entry.id,
			parentId: entry.parentId,
			kind: entry.type,
			...(labels.get(entry.id) ? { label: labels.get(entry.id) } : {}),
			timestamp: entry.timestamp,
			preview: JSON.stringify(raw).slice(0, 4096),
			isLeaf: leafId === entry.id,
			depth,
		});
		const descendants = (children.get(entry.id) ?? []).sort(
			(left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp),
		);
		for (const child of descendants) visit(child, depth + 1);
	};
	for (const root of roots.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))) {
		visit(root, 0);
	}
	return output;
}

function transcriptSubagents(entries: readonly SessionEntry[]): SubagentSnapshot[] {
	const snapshots: SubagentSnapshot[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "subagent")
			continue;
		const details = entry.message.details as Partial<SubagentDetails> | undefined;
		if (!Array.isArray(details?.results)) continue;
		for (let index = 0; index < details.results.length; index++) {
			const result = details.results[index];
			if (!result?.agentId || !result.agent || !result.runId) continue;
			snapshots.push({
				runId: result.runId,
				agentId: result.agentId,
				agent: result.agent,
				agentSource: result.agentSource ?? "unknown",
				task: result.task,
				state: result.state ?? "succeeded",
				...(result.currentAction ? { currentAction: result.currentAction } : {}),
				startedAt: result.startedAt ?? Date.parse(entry.timestamp),
				updatedAt: result.updatedAt ?? Date.parse(entry.timestamp),
				elapsedMs: result.elapsedMs ?? 0,
				controllable: false,
				...(result.session ? { session: result.session } : {}),
			});
		}
	}
	return snapshots;
}

function liveSubagent(snapshot: SubagentRunSnapshot): SubagentSnapshot {
	return {
		runId: snapshot.runId,
		agentId: snapshot.agentId,
		agent: snapshot.agent,
		agentSource: snapshot.agentSource,
		task: snapshot.task,
		state: snapshot.state,
		...(snapshot.currentAction ? { currentAction: snapshot.currentAction } : {}),
		startedAt: snapshot.startedAt,
		updatedAt: snapshot.updatedAt,
		elapsedMs: snapshot.elapsedMs,
		controllable: snapshot.controllable,
		...(snapshot.session ? { session: snapshot.session } : {}),
	};
}

function entryItem(entry: SessionEntry): TranscriptItem {
	return {
		entryId: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		kind: entry.type,
		payload: jsonValue(entry),
	};
}

function isTranscriptEntry(entry: SessionEntry): boolean {
	if (["message", "custom", "compaction", "branch_summary"].includes(entry.type)) return true;
	return entry.type === "custom_message" && entry.display === true;
}

function extensionActivityRecordFromEntry(entry: SessionEntry): ExtensionActivityRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== EXTENSION_ACTIVITY_CUSTOM_TYPE) return undefined;
	return parseExtensionActivityRecord(entry.data);
}

function extensionActivityDetails(entries: readonly SessionEntry[], entryIds: readonly string[]): string | undefined {
	const ids = new Set(entryIds);
	const records = entries.flatMap((entry) => {
		if (
			!ids.has(entry.id) ||
			entry.type !== "custom" ||
			entry.customType === EXTENSION_ACTIVITY_CUSTOM_TYPE ||
			entry.customType === AGENT_STEP_CUSTOM_TYPE
		) {
			return [];
		}
		return [{ customType: entry.customType, ...(entry.data === undefined ? {} : { data: entry.data }) }];
	});
	if (records.length === 0) return undefined;
	const details = JSON.stringify(records, null, 2);
	const limit = 16 * 1024;
	return details.length <= limit ? details : `${details.slice(0, limit - 1)}…`;
}

interface CompletedExtensionActivity {
	startEntryId: string;
	relatedEntryIds: string[];
}

function recoverInterruptedExtensionActivities(
	sessionManager: SessionManager,
): Map<string, CompletedExtensionActivity> {
	const entries = sessionManager.getEntries();
	const openActivities = new Map<
		string,
		{
			activity: Extract<ExtensionActivityRecord, { phase: "start" }>;
			startEntryId: string;
			relatedEntryIds: string[];
		}
	>();
	for (const entry of entries) {
		const activity = extensionActivityRecordFromEntry(entry);
		if (activity?.phase === "start") {
			openActivities.set(activity.activityId, { activity, startEntryId: entry.id, relatedEntryIds: [] });
			continue;
		}
		if (activity?.phase === "end") {
			openActivities.delete(activity.activityId);
			continue;
		}
		if (entry.type === "custom" && entry.customType !== AGENT_STEP_CUSTOM_TYPE) {
			[...openActivities.values()].at(-1)?.relatedEntryIds.push(entry.id);
		}
	}
	const completed = new Map<string, CompletedExtensionActivity>();
	const endedAt = Date.now();
	for (const { activity, startEntryId, relatedEntryIds } of openActivities.values()) {
		const details = extensionActivityDetails(entries, relatedEntryIds);
		sessionManager.appendCustomEntry(EXTENSION_ACTIVITY_CUSTOM_TYPE, {
			version: 1,
			phase: "end",
			activityId: activity.activityId,
			extensionPath: activity.extensionPath,
			hook: activity.hook,
			startedAt: activity.startedAt,
			endedAt,
			durationMs: Math.max(0, endedAt - activity.startedAt),
			status: "interrupted",
			relatedEntryIds,
			...(details ? { details } : {}),
		});
		completed.set(activity.activityId, { startEntryId, relatedEntryIds });
	}
	return completed;
}

function sessionGeneration(
	sessionPath: string,
	sessionId: string,
): { generation: string; revision: number; updatedAt: number } {
	if (!existsSync(sessionPath)) return { generation: sessionId, revision: 0, updatedAt: Date.now() };
	const stat = statSync(sessionPath);
	return {
		generation: `${sessionId}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
		revision: stat.size,
		updatedAt: stat.mtimeMs,
	};
}

function createUiContext(onUiRequest: UiRequestHandler): ExtensionUIContext {
	const request = async (
		kind: UiRequest["kind"],
		title: string,
		payload: JsonValue,
		timeoutMs?: number,
	): Promise<Awaited<ReturnType<UiRequestHandler>>> => {
		return onUiRequest({ id: randomUUID(), kind, title, payload, timeoutMs });
	};
	return {
		select: async (title, options, opts) => {
			if (opts?.signal?.aborted) return undefined;
			const result = await request("select", title, { options }, opts?.timeout);
			return result.cancelled ? undefined : typeof result.value === "string" ? result.value : undefined;
		},
		confirm: async (title, message, opts) => {
			if (opts?.signal?.aborted) return false;
			const result = await request("confirm", title, { message }, opts?.timeout);
			return result.cancelled ? false : result.confirmed === true;
		},
		input: async (title, placeholder, opts) => {
			if (opts?.signal?.aborted) return undefined;
			const result = await request("input", title, { placeholder: placeholder ?? "" }, opts?.timeout);
			return result.cancelled ? undefined : typeof result.value === "string" ? result.value : undefined;
		},
		notify: (message, type = "info") => {
			void request("notify", message, { method: "notify", type });
		},
		onTerminalInput: () => () => {},
		setStatus: (key, text) => {
			void request("notify", key, { method: "setStatus", key, text: text ?? null });
		},
		setWorkingMessage: (message) => {
			void request("notify", "working", { method: "setWorkingMessage", message: message ?? null });
		},
		setWorkingVisible: (visible) => {
			void request("notify", "working", { method: "setWorkingVisible", visible });
		},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: (label) => {
			void request("notify", "thinking", { method: "setHiddenThinkingLabel", label: label ?? null });
		},
		setWidget: (key, content, options) => {
			if (content !== undefined && !Array.isArray(content)) {
				throw new Error("LYStar Web Runtime不支持 TUI 组件式小部件");
			}
			void request("notify", key, {
				method: "setWidget",
				key,
				lines: content ?? null,
				placement: options?.placement ?? "aboveEditor",
			});
		},
		setFooter: (factory) => {
			if (factory) throw new Error("LYStar Web Runtime不支持自定义 TUI 页脚");
		},
		setHeader: (factory) => {
			if (factory) throw new Error("LYStar Web Runtime不支持自定义 TUI 页眉");
		},
		setTitle: (title) => {
			void request("notify", title, { method: "setTitle", title });
		},
		custom: async () => {
			throw new Error("LYStar Web Runtime不支持自定义 TUI 组件");
		},
		pasteToEditor: (text) => {
			void request("notify", "editor", { method: "setEditorText", text });
		},
		setEditorText: (text) => {
			void request("notify", "editor", { method: "setEditorText", text });
		},
		getEditorText: () => "",
		editor: async (title, prefill) => {
			const result = await request("editor", title, { prefill: prefill ?? "" });
			return result.cancelled ? undefined : typeof result.value === "string" ? result.value : undefined;
		},
		addAutocompleteProvider: () => {},
		setEditorComponent: (factory) => {
			if (factory) throw new Error("LYStar Web Runtime不支持自定义 TUI 编辑器");
		},
		getEditorComponent: () => undefined,
		get theme() {
			return undefined as never;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "主题切换由 Web 工作台管理" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

function authMethods(runtime: ModelRuntime, providerId: string): AuthType[] {
	const auth = runtime.getProvider(providerId)?.auth;
	return [auth?.apiKey?.login ? "api_key" : undefined, auth?.oauth ? "oauth" : undefined].filter(
		(method): method is AuthType => method !== undefined,
	);
}

type DiscoveredProviderModel = {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
};

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function providerModelsUrls(baseUrl: string): URL[] {
	const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	const candidates = [new URL("models", root), new URL("v1/models", root)];
	const seen = new Set<string>();
	const urls: URL[] = [];
	for (const url of candidates) {
		if (seen.has(url.href)) continue;
		seen.add(url.href);
		urls.push(url);
	}
	return urls;
}

function discoveryHeaders(auth: AuthResult | undefined, api: string | undefined): Record<string, string> {
	const apiKey = auth?.auth.apiKey;
	const configured: Record<string, string> = {};
	for (const [name, value] of Object.entries(auth?.auth.headers ?? {})) {
		if (typeof value === "string") configured[name] = value;
	}
	return {
		accept: "application/json",
		...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
		...(apiKey && api === "anthropic-messages" ? { "x-api-key": apiKey } : {}),
		...(api === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}),
		...configured,
	};
}

function parseDiscoveredModels(payload: unknown): DiscoveredProviderModel[] | undefined {
	const root = recordValue(payload);
	const values = Array.isArray(payload) ? payload : Array.isArray(root?.data) ? root.data : root?.models;
	if (!Array.isArray(values)) return undefined;
	return values.flatMap((value): DiscoveredProviderModel[] => {
		const item = recordValue(value);
		if (!item) return [];
		const id = typeof item.id === "string" ? item.id.trim() : "";
		if (!id) return [];
		const contextWindow =
			positiveInteger(item.contextWindow) ??
			positiveInteger(item.context_length) ??
			positiveInteger(item.context_window);
		const maxTokens =
			positiveInteger(item.maxTokens) ?? positiveInteger(item.max_output_tokens) ?? positiveInteger(item.max_tokens);
		return [
			{
				id,
				...(typeof item.name === "string" && item.name.trim() ? { name: item.name.trim() } : {}),
				...(contextWindow ? { contextWindow } : {}),
				...(maxTokens ? { maxTokens } : {}),
			},
		];
	});
}

async function discoverProviderModels(
	baseUrl: string,
	auth: AuthResult | undefined,
	api: string | undefined,
): Promise<DiscoveredProviderModel[]> {
	const headers = discoveryHeaders(auth, api);
	const failures: string[] = [];
	for (const url of providerModelsUrls(baseUrl)) {
		let response: Response;
		try {
			response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
		} catch (error) {
			failures.push(`${url.href}：${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!response.ok) {
			failures.push(`${url.href}：HTTP ${response.status}`);
			continue;
		}
		const discovered = parseDiscoveredModels(await response.json().catch(() => undefined));
		if (discovered === undefined) {
			failures.push(`${url.href}：响应缺少 models 或 data 列表`);
			continue;
		}
		if (discovered.length === 0) {
			failures.push(`${url.href}：未返回任何模型`);
			continue;
		}
		return discovered;
	}
	throw new Error(`模型目录请求失败：${failures.join("；")}`);
}

function catalogApiFamily(api: string): string {
	switch (api) {
		case "openai-completions":
		case "openai-responses":
			return "openai";
		case "openai-codex-responses":
			return "openai-codex";
		case "anthropic-messages":
			return "anthropic";
		case "google-generative-ai":
			return "google";
		case "google-vertex":
			return "google-vertex";
		case "mistral-conversations":
			return "mistral";
		case "azure-openai-responses":
			return "azure-openai-responses";
		case "bedrock-converse-stream":
			return "amazon-bedrock";
		default:
			return api.split("-", 1)[0] ?? api;
	}
}

function findMatchingCatalogModel(
	runtime: ModelRuntime,
	providerId: string,
	modelId: string,
	providerApi: string,
): Model<Api> | undefined {
	const normalizedId = modelId.toLowerCase();
	const candidates = runtime
		.getModels()
		.filter(
			(model) =>
				model.provider !== providerId &&
				runtime.isBuiltinProvider(model.provider) &&
				model.id.toLowerCase() === normalizedId,
		);
	if (candidates.length <= 1) return candidates[0];

	const apiFamily = catalogApiFamily(providerApi);
	const ranked = candidates
		.map((model) => ({
			model,
			score:
				Number(model.provider === apiFamily) * 4 +
				Number(model.api === providerApi) * 2 +
				Number(providerApi.includes("codex") && model.provider.includes("codex")),
		}))
		.sort((left, right) => right.score - left.score || left.model.provider.localeCompare(right.model.provider));
	const best = ranked[0];
	if (!best || best.score === 0 || ranked[1]?.score === best.score) return undefined;
	return best.model;
}

function modelDefinitionFromCatalog(
	model: Model<Api>,
	baseUrl: string,
	override: DiscoveredProviderModel = { id: model.id },
	api: string = model.api,
): ModelsJsonModel {
	return {
		id: override.id,
		name: override.name ?? model.name,
		api,
		baseUrl,
		reasoning: model.reasoning,
		...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
		input: model.input,
		cost: model.cost,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
		...(api === model.api && model.compat ? { compat: model.compat as ModelsJsonModel["compat"] } : {}),
	};
}

async function requestAuthPrompt(onUiRequest: UiRequestHandler, prompt: AuthPrompt): Promise<string> {
	const response = await onUiRequest({
		id: randomUUID(),
		kind: prompt.type === "secret" ? "secret" : prompt.type === "select" ? "select" : "input",
		title: "模型认证",
		payload: jsonValue(
			prompt.type === "select"
				? { message: prompt.message, options: prompt.options }
				: {
						message: prompt.message === "Enter API key" ? "输入 API 密钥" : prompt.message,
						placeholder: prompt.placeholder ?? "",
					},
		),
		signal: prompt.signal,
	});
	if (response.cancelled || typeof response.value !== "string") {
		throw Object.assign(new Error("模型认证已取消"), { code: "auth_cancelled", retryable: false });
	}
	return response.value;
}

function authEventMessage(event: AuthEvent): string {
	switch (event.type) {
		case "info":
		case "progress":
			return event.message;
		case "auth_url":
			return event.instructions?.trim() || "请在浏览器中完成模型认证";
		case "device_code":
			return `请使用验证码 ${event.userCode} 完成模型认证`;
	}
}

function notifyAuthEvent(onUiRequest: UiRequestHandler, event: AuthEvent): void {
	void onUiRequest({
		id: randomUUID(),
		kind: "notify",
		title: "模型认证",
		payload: jsonValue({ method: `auth_${event.type}`, ...event, message: authEventMessage(event) }),
	});
}

function truncateWithoutSplittingSurrogate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	let end = maxChars;
	if (
		end > 0 &&
		value.charCodeAt(end - 1) >= 0xd800 &&
		value.charCodeAt(end - 1) <= 0xdbff &&
		value.charCodeAt(end) >= 0xdc00 &&
		value.charCodeAt(end) <= 0xdfff
	) {
		end--;
	}
	return value.slice(0, end);
}

function boundedStatus(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length <= 1024 ? text : `${truncateWithoutSplittingSurrogate(text, 1021)}...`;
}

const MAX_BASH_PROGRESS_CHARS = 16 * 1024;
const BASH_TRUNCATION_MARKER = "输出已截断";

function tailWithoutSplittingSurrogate(value: string, maxChars: number): string {
	let start = Math.max(0, value.length - maxChars);
	if (
		start > 0 &&
		value.charCodeAt(start) >= 0xdc00 &&
		value.charCodeAt(start) <= 0xdfff &&
		value.charCodeAt(start - 1) >= 0xd800 &&
		value.charCodeAt(start - 1) <= 0xdbff
	) {
		start++;
	}
	return value.slice(start);
}

function bashCommand(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const command = (value as { command?: unknown }).command;
	return typeof command === "string" ? command : undefined;
}

function toolOutputText(value: unknown): string | undefined {
	const result = toolRecord(value);
	if (!Array.isArray(result?.content)) return undefined;
	return result.content
		.filter(
			(part): part is { type: unknown; text: string } =>
				!!part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function bashOutput(value: unknown): string | undefined {
	const result = toolRecord(value);
	const text = toolOutputText(value);
	if (text === undefined) return undefined;
	const coreTruncated =
		!!result?.details &&
		typeof result.details === "object" &&
		!!(result.details as { truncation?: { truncated?: unknown } }).truncation?.truncated;
	if (!coreTruncated && text.length <= MAX_BASH_PROGRESS_CHARS) return text;
	const output = tailWithoutSplittingSurrogate(text, MAX_BASH_PROGRESS_CHARS - BASH_TRUNCATION_MARKER.length - 1);
	return `${output}\n${BASH_TRUNCATION_MARKER}`;
}

export function projectRuntimeProgress(event: AgentSessionEvent): SessionProgress[] {
	if ("toolName" in event && AGENT_STEP_TOOL_NAMES.has(event.toolName)) return [];
	switch (event.type) {
		case "message_start":
			if (event.message.role === "assistant") return [{ type: "phase", phase: "turn" }];
			if (event.message.role === "user") {
				return [
					{
						type: "user_message",
						text: contentText(event.message.content, ""),
						...(event.queueId ? { queueId: event.queueId } : {}),
					},
				];
			}
			return [];
		case "message_update": {
			const updates: SessionProgress[] = [];
			const stream = event.assistantMessageEvent;
			if (stream.type === "text_delta") updates.push({ type: "assistant_delta", text: stream.delta });
			else if (stream.type === "thinking_delta") updates.push({ type: "thinking_delta", text: stream.delta });
			else if (
				(stream.type === "websearch_start" ||
					stream.type === "websearch_update" ||
					stream.type === "websearch_end") &&
				event.message.role === "assistant"
			) {
				const webSearch = webSearchProgressFromCall(stream.call);
				const summary = webSearchProgressSummary(webSearch);
				if (stream.type === "websearch_end") {
					updates.push({
						type: "tool_end",
						toolCallId: stream.call.id,
						name: "web_search",
						status: stream.call.status === "failed" ? "error" : "success",
						summary,
						...(webSearch ? { webSearch } : {}),
					});
				} else if (stream.type === "websearch_start") {
					updates.push({
						type: "tool_start",
						toolCallId: stream.call.id,
						name: "web_search",
						summary,
						...(webSearch ? { webSearch } : {}),
					});
				} else {
					updates.push({
						type: "tool_update",
						toolCallId: stream.call.id,
						name: "web_search",
						summary,
						...(webSearch ? { webSearch } : {}),
					});
				}
			} else if (
				(stream.type === "toolcall_start" || stream.type === "toolcall_delta" || stream.type === "toolcall_end") &&
				event.message.role === "assistant"
			) {
				const content = event.message.content[stream.contentIndex];
				if (content?.type === "toolCall" && !AGENT_STEP_TOOL_NAMES.has(content.name)) {
					const summary = isDiffTool(content.name)
						? (toolPath(content.arguments) ?? content.name)
						: boundedStatus(content.arguments);
					updates.push(
						toolCallUpdate(
							content.id,
							content.name,
							summary,
							content.arguments,
							stream.type !== "toolcall_delta",
						),
					);
				}
			}
			const usage = event.message.role === "assistant" ? event.message.usage : undefined;
			if (usage) {
				updates.push({
					type: "usage",
					usage: {
						inputTokens: usage.input,
						outputTokens: usage.output,
						cacheReadTokens: usage.cacheRead,
						cacheWriteTokens: usage.cacheWrite,
					},
				});
			}
			return updates;
		}
		case "tool_execution_start": {
			const diffTool = isDiffTool(event.toolName);
			const diff = toolProgressDiff(event.toolName, event.args);
			if (event.toolName === "bash") {
				const command = bashCommand(event.args);
				return [
					{
						type: "tool_start",
						toolCallId: event.toolCallId,
						name: event.toolName,
						...(command === undefined ? {} : { summary: command }),
					},
				];
			}
			return [
				{
					type: "tool_start",
					toolCallId: event.toolCallId,
					name: event.toolName,
					summary: diffTool ? (toolPath(event.args) ?? event.toolName) : boundedStatus(event.args),
					...(diff ? { diff } : {}),
				},
			];
		}
		case "tool_execution_update": {
			const diffTool = isDiffTool(event.toolName);
			const diff = toolProgressDiff(event.toolName, event.args, event.partialResult);
			if (event.toolName === "bash") {
				return [
					{
						type: "tool_update",
						toolCallId: event.toolCallId,
						name: event.toolName,
						summary: bashOutput(event.partialResult) ?? "",
					},
				];
			}
			if (event.toolName === "image_gen") {
				return [
					{
						type: "tool_update",
						toolCallId: event.toolCallId,
						name: event.toolName,
						summary: boundedStatus(toolOutputText(event.partialResult) ?? "正在生成图片"),
					},
				];
			}
			return [
				{
					type: "tool_update",
					toolCallId: event.toolCallId,
					name: event.toolName,
					summary: diffTool
						? (toolPath(event.args) ?? boundedStatus(toolOutputText(event.partialResult) ?? event.toolName))
						: boundedStatus(event.partialResult),
					...(diff ? { diff } : {}),
				},
			];
		}
		case "tool_execution_end": {
			const diffTool = isDiffTool(event.toolName);
			const diff = toolProgressDiff(event.toolName, undefined, event.result);
			if (event.toolName === "bash") {
				return [
					{
						type: "tool_end",
						toolCallId: event.toolCallId,
						name: event.toolName,
						status: event.isError ? "error" : "success",
						summary: bashOutput(event.result) ?? "",
						...(diff ? { diff } : {}),
					},
				];
			}
			if (event.toolName === "image_gen") {
				return [
					{
						type: "tool_end",
						toolCallId: event.toolCallId,
						name: event.toolName,
						status: event.isError ? "error" : "success",
						summary: boundedStatus(
							toolOutputText(event.result) ?? (event.isError ? "图片生成失败" : "图片生成完成"),
						),
					},
				];
			}
			return [
				{
					type: "tool_end",
					toolCallId: event.toolCallId,
					name: event.toolName,
					status: event.isError ? "error" : "success",
					summary: diffTool
						? boundedStatus(toolOutputText(event.result) ?? event.toolName)
						: boundedStatus(event.result),
					...(diff ? { diff } : {}),
				},
			];
		}
		case "entry_appended":
			return [];
		case "tool_activity":
			return AGENT_STEP_TOOL_NAMES.has(event.activity.name)
				? []
				: [{ type: "tool_state", activity: event.activity }];
		case "queue_update":
			return [{ type: "queue_update", steeringCount: event.steering.length, followUpCount: event.followUp.length }];
		case "compaction_start":
			return [
				{ type: "phase", phase: "compaction" },
				{ type: "compaction", status: "running", reason: event.reason },
			];
		case "compaction_end": {
			const status = event.aborted
				? "cancelled"
				: event.result
					? "completed"
					: event.willRetry
						? "waiting_retry"
						: "failed";
			return [
				{
					type: "compaction",
					status,
					reason: event.reason,
					...(event.errorMessage ? { error: boundedStatus(event.errorMessage) } : {}),
				},
			];
		}
		case "auto_retry_start":
			return [
				{ type: "phase", phase: "retry" },
				{
					type: "retry",
					status: "waiting",
					kind: "model",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					error: boundedStatus(event.errorMessage),
				},
			];
		case "auto_retry_end":
			return [
				{
					type: "retry",
					status: event.success ? "completed" : "failed",
					kind: "model",
					attempt: event.attempt,
					...(event.finalError ? { error: boundedStatus(event.finalError) } : {}),
				},
			];
		case "summarization_retry_scheduled":
			return [
				{ type: "phase", phase: "retry" },
				{
					type: "retry",
					status: "waiting",
					kind: "summarization",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					error: boundedStatus(event.errorMessage),
				},
			];
		case "summarization_retry_attempt_start":
			if (event.source === "branchSummary") {
				return [{ type: "retry", status: "running", kind: "branch_summary" }];
			}
			return [
				{ type: "phase", phase: "compaction" },
				{ type: "compaction", status: "running", reason: event.reason },
				{ type: "retry", status: "running", kind: "compaction" },
			];
		case "summarization_retry_finished":
			return [{ type: "retry", status: "completed", kind: "summarization" }];
		case "agent_settled":
			return [{ type: "phase", phase: "idle" }];
		default:
			return [{ type: "status", status: "正在处理" }];
	}
}

function progressWithAgentStep(progress: SessionProgress, controller: AgentStepController): SessionProgress {
	if (progress.type === "assistant_delta" || progress.type === "thinking_delta") {
		const stepId = controller.activeStep?.id;
		return stepId ? { ...progress, stepId } : progress;
	}
	if (progress.type === "tool_state") {
		const stepId = controller.stepIdForTool(progress.activity.toolCallId);
		return stepId ? { ...progress, activity: { ...progress.activity, stepId } } : progress;
	}
	if (progress.type === "tool_start" || progress.type === "tool_update" || progress.type === "tool_end") {
		const stepId = controller.stepIdForTool(progress.toolCallId);
		return stepId ? { ...progress, stepId } : progress;
	}
	return progress;
}

function contentImages(images?: Array<{ data: string; mimeType: string; displayOnly?: boolean }>) {
	return images?.map((image) =>
		image.displayOnly
			? { type: "image" as const, data: image.data, mimeType: image.mimeType, sendToModel: false as const }
			: { type: "image" as const, data: image.data, mimeType: image.mimeType },
	);
}

function promptFailure(entries: readonly SessionEntry[]): string | undefined {
	for (const entry of [...entries].reverse()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.stopReason === "error") return entry.message.errorMessage ?? "模型响应失败";
	}
	return undefined;
}

class CoreRuntimeSession implements RuntimeSession {
	private readonly listeners = new Set<(event: RuntimeEvent) => void>();
	private readonly runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
	private readonly onUiRequest: UiRequestHandler;
	private readonly stepController: AgentStepController;
	private unsubscribe?: () => void;
	private unsubscribeSteps?: () => void;
	private unsubscribeSubagents?: () => void;
	private unsubscribeExtensionActivities?: () => void;
	private activeExtensionActivities: Array<{
		activityId: string;
		startEntryId: string;
		relatedEntryIds: string[];
	}> = [];
	private completedExtensionActivities = new Map<string, CompletedExtensionActivity>();
	private stateRevision = 0;
	private committedEntryCount = 0;
	private lastTranscriptGeneration?: string;
	private lastTranscriptRevision = 0;
	private disposed = false;
	private readonly agentDir: string;
	private companion?: WebCompanionServer;
	private externalClientCount = 0;
	private pendingTurnInputs = 0;
	private turnInputQueue: Promise<void> = Promise.resolve();
	private readonly activePromptOperations = new Set<Promise<AgentTurnContext | undefined>>();

	constructor(
		runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>,
		onUiRequest: UiRequestHandler,
		agentDir: string,
		stepController: AgentStepController,
	) {
		this.runtime = runtime;
		this.onUiRequest = onUiRequest;
		this.agentDir = agentDir;
		this.stepController = stepController;
	}

	get sessionPath(): string {
		const path = this.runtime.session.sessionFile;
		if (!path) throw new Error("Web Runtime要求会话已经持久化");
		return path;
	}

	getLiveMessage(): { text: string; thinking: string; stepId?: string } {
		const result: { text: string; thinking: string; stepId?: string } = { text: "", thinking: "" };
		const message = this.runtime.session.agent.state.streamingMessage;
		if (message?.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") result.text += part.text;
				if (part.type === "thinking") result.thinking += part.thinking;
			}
		}
		const stepId = this.stepController.activeStep?.id;
		return stepId ? { ...result, stepId } : result;
	}

	isConnected(): boolean {
		return !this.disposed;
	}

	ownsSessionWriter(): boolean {
		return true;
	}

	hasExternalClients(): boolean {
		const companion = this.companion as unknown as
			| {
					getClientCount?: () => number;
					readySockets?: Set<unknown>;
			  }
			| undefined;
		const companionClientCount = companion?.getClientCount?.() ?? companion?.readySockets?.size ?? 0;
		return this.externalClientCount > 0 || companionClientCount > 0;
	}

	async bind(): Promise<void> {
		const storage = sessionGeneration(this.sessionPath, this.runtime.session.sessionId);
		const entries = this.runtime.session.sessionManager.getEntries();
		this.committedEntryCount = entries.length;
		this.lastTranscriptGeneration = storage.generation;
		this.lastTranscriptRevision = entries.some(isTranscriptEntry) ? storage.revision : 0;
		this.runtime.setRebindSession(async () => this.bindCurrentSession());
		await this.bindCurrentSession();
	}

	getSnapshot(writeAccess: SessionStateSnapshot["writeAccess"]): SessionStateSnapshot {
		const session = this.runtime.session;
		const header = session.sessionManager.getHeader();
		const storage = sessionGeneration(this.sessionPath, session.sessionId);
		const contextUsage = session.getContextUsage();
		const toolActivityEpoch =
			typeof session.getToolActivityEpoch === "function" ? session.getToolActivityEpoch() : undefined;
		const toolActivityRevision =
			typeof session.getToolActivityRevision === "function" ? session.getToolActivityRevision() : undefined;
		const toolActivities =
			typeof session.getToolActivitySnapshot === "function"
				? session.getToolActivitySnapshot({ activeOnly: true }).map((activity) => {
						const stepId = this.stepController.stepIdForTool(activity.toolCallId);
						return stepId ? { ...activity, stepId } : activity;
					})
				: undefined;
		const hasActiveToolActivity = Boolean(toolActivities?.length);
		const queuedSteerMessages = session.getSteeringQueueItems();
		const queuedFollowUpMessages = session.getFollowUpQueueItems();
		return {
			id: session.sessionId,
			path: this.sessionPath,
			name: session.sessionName,
			cwd: this.runtime.cwd,
			createdAt: header ? new Date(header.timestamp).getTime() : storage.updatedAt,
			updatedAt: storage.updatedAt,
			phase: session.isCompacting
				? "compaction"
				: session.retryAttempt > 0
					? "retry"
					: session.isStreaming || hasActiveToolActivity
						? "turn"
						: "idle",
			activity: session.isStreaming || hasActiveToolActivity ? "running" : "idle",
			model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
			thinkingLevel: session.thinkingLevel,
			attached: true,
			writeAccess,
			revision: this.stateRevision,
			leafId: session.sessionManager.getLeafId(),
			queuedSteerCount: queuedSteerMessages.length,
			queuedFollowUpCount: queuedFollowUpMessages.length,
			...(queuedSteerMessages.length > 0 ? { queuedSteerMessages } : {}),
			...(queuedFollowUpMessages.length > 0 ? { queuedFollowUpMessages } : {}),
			contextTokens: contextUsage?.tokens,
			contextWindow: contextUsage?.contextWindow,
			transcriptGeneration: storage.generation,
			transcriptRevision: storage.revision,
			...(toolActivityEpoch ? { toolActivityEpoch } : {}),
			...(toolActivityRevision === undefined ? {} : { toolActivityRevision }),
			...(toolActivities === undefined ? {} : { toolActivities }),
			...(this.stepController.activeStep ? { activeStep: this.stepController.activeStep } : {}),
		};
	}

	listSettings(): SettingSummary[] {
		const themeNames = [
			...getBuiltinThemeNames(),
			...this.runtime.services.resourceLoader
				.getThemes()
				.themes.flatMap((theme) => (theme.name ? [theme.name] : [])),
		].filter((name, index, values) => values.indexOf(name) === index);
		return getLystarSettingsForUi().map((setting) =>
			settingSummary(setting.id, this.runtime.services.settingsManager, themeNames),
		);
	}

	async setSetting(
		id: string,
		value: boolean | number | string,
	): Promise<{ setting: SettingSummary; requiresRestart: boolean }> {
		const definition = getLystarSetting(id);
		if (!definition) throw Object.assign(new Error(`未知设置：${id}`), { code: "setting_not_found" });
		definition.set(this.runtime.services.settingsManager, value);
		switch (id) {
			case "autocompact":
				this.runtime.session.setAutoCompactionEnabled(value as boolean);
				break;
			case "steering-mode":
				this.runtime.session.setSteeringMode(value as "all" | "one-at-a-time");
				break;
			case "follow-up-mode":
				this.runtime.session.setFollowUpMode(value as "all" | "one-at-a-time");
				break;
			case "transport":
				this.runtime.session.agent.transport = value as "auto" | "sse" | "websocket" | "websocket-cached";
				break;
		}
		await this.runtime.services.settingsManager.flush();
		this.emitStateChanged();
		const setting = this.listSettings().find((candidate) => candidate.id === id);
		if (!setting) throw Object.assign(new Error(`未知设置：${id}`), { code: "setting_not_found" });
		return { setting, requiresRestart: setting.restartRequired };
	}

	getSessionTree(): SessionTreeNode[] {
		return sessionTree(
			this.runtime.session.sessionManager.getEntries(),
			this.runtime.session.sessionManager.getLeafId(),
		);
	}

	getSessionInfo(): SessionInfoResult {
		return this.runtime.session.getSessionInfo();
	}

	listForkMessages(): Array<{ entryId: string; text: string }> {
		return this.runtime.session.getUserMessagesForForking();
	}

	async setEntryLabel(entryId: string, label?: string): Promise<void> {
		this.runtime.session.sessionManager.appendLabelChange(entryId, label?.trim() || undefined);
		this.emitCommittedEntries();
	}

	async navigateSessionTree(
		entryId: string,
		summarize: boolean,
	): Promise<{ editorText?: string; cancelled: boolean; newLeafId?: string }> {
		const result = await this.runtime.session.navigateTree(entryId, { summarize });
		this.emitCommittedEntries();
		return {
			...(result.editorText ? { editorText: result.editorText } : {}),
			cancelled: result.cancelled,
			...(this.runtime.session.sessionManager.getLeafId()
				? { newLeafId: this.runtime.session.sessionManager.getLeafId()! }
				: {}),
		};
	}

	listSubagents(): SubagentSnapshot[] {
		const committed = transcriptSubagents(this.runtime.session.sessionManager.getEntries());
		const parentSessionPath = this.runtime.session.sessionFile;
		const live = getCurrentSubagentRuns()
			.filter((snapshot) => snapshot.session?.parentSessionFile === parentSessionPath)
			.map(liveSubagent);
		const merged = new Map<string, SubagentSnapshot>();
		for (const snapshot of committed) merged.set(`${snapshot.runId}:${snapshot.agentId}`, snapshot);
		for (const snapshot of live) merged.set(`${snapshot.runId}:${snapshot.agentId}`, snapshot);
		return [...merged.values()].sort(
			(left, right) =>
				right.updatedAt - left.updatedAt ||
				left.runId.localeCompare(right.runId) ||
				left.agentId.localeCompare(right.agentId),
		);
	}

	readSubagent(agentId: string): { transcript?: SubagentSnapshot; live?: SubagentSnapshot } {
		const transcript = transcriptSubagents(this.runtime.session.sessionManager.getEntries()).find(
			(snapshot) => snapshot.agentId === agentId,
		);
		const live = getCurrentSubagentRuns().find(
			(snapshot) =>
				snapshot.agentId === agentId && snapshot.session?.parentSessionFile === this.runtime.session.sessionFile,
		);
		return {
			...(transcript ? { transcript } : {}),
			...(live && (!transcript || transcript.runId === live.runId) ? { live: liveSubagent(live) } : {}),
		};
	}

	async abortSubagent(agentId: string): Promise<void> {
		const details = this.readSubagent(agentId);
		if (!details.transcript && !details.live)
			throw Object.assign(new Error("Subagent 不属于当前会话"), { code: "subagent_not_found" });
		await abortSubagent(agentId);
	}

	async continueSubagent(agentId: string, text: string): Promise<void> {
		const transcript = this.readSubagent(agentId).transcript;
		if (!transcript?.session)
			throw Object.assign(new Error("Subagent 会话不可继续"), { code: "subagent_not_continuable" });
		await continueSubagentSession(
			{
				agentId,
				agent: transcript.agent,
				agentSource: transcript.agentSource,
				task: transcript.task,
				agentScope: "both",
				session: transcript.session,
			},
			text,
		);
	}

	async prompt(text: string, images?: Array<{ data: string; mimeType: string }>, _queueId?: string): Promise<void> {
		await this.promptWithOrigin(text, images, { inputId: randomUUID(), origin: { type: "user", channel: "rpc" } });
	}

	async promptWithOrigin(
		text: string,
		images: Array<{ data: string; mimeType: string }> | undefined,
		options: {
			inputId: string;
			origin: AgentInputOrigin;
			activeToolNames?: readonly string[];
			capabilities?: AgentCapabilityLease;
		},
	): Promise<AgentTurnContext | undefined> {
		const currentTurn = this.runtime.session.extensionRunner.createContext().currentTurn;
		if (
			this.pendingTurnInputs > 0 ||
			(currentTurn !== undefined && currentTurn.rootOrigin !== rootOriginOf(options.origin))
		) {
			return this.enqueuePromptWithOrigin(text, images, options);
		}
		return this.trackPromptOperation(this.executePromptWithOrigin(text, images, options));
	}

	private enqueuePromptWithOrigin(
		text: string,
		images: Array<{ data: string; mimeType: string }> | undefined,
		options: {
			inputId: string;
			origin: AgentInputOrigin;
			activeToolNames?: readonly string[];
			capabilities?: AgentCapabilityLease;
		},
	): Promise<AgentTurnContext | undefined> {
		return this.reservePromptWithOrigin(options).submit(text, images);
	}

	reservePromptWithOrigin(options: {
		inputId: string;
		origin: AgentInputOrigin;
		activeToolNames?: readonly string[];
		capabilities?: AgentCapabilityLease;
	}): RuntimePromptReservation {
		this.pendingTurnInputs++;
		let resolveInput!: (
			input: { text: string; images?: Array<{ data: string; mimeType: string }> } | undefined,
		) => void;
		const inputReady = new Promise<{ text: string; images?: Array<{ data: string; mimeType: string }> } | undefined>(
			(resolve) => {
				resolveInput = resolve;
			},
		);
		const execution = this.turnInputQueue
			.catch(() => {})
			.then(async () => {
				const input = await inputReady;
				if (!input) return undefined;
				await Promise.allSettled([...this.activePromptOperations]);
				await this.runtime.session.waitForIdle();
				return this.trackPromptOperation(this.executePromptWithOrigin(input.text, input.images, options));
			});
		this.turnInputQueue = execution.then(
			() => undefined,
			() => undefined,
		);
		void execution
			.finally(() => {
				this.pendingTurnInputs--;
			})
			.catch(() => {});
		let settled = false;
		return {
			submit: (text, images) => {
				if (settled) return Promise.reject(new Error("Turn 输入预约已结束"));
				settled = true;
				resolveInput({ text, ...(images ? { images } : {}) });
				return execution;
			},
			cancel: () => {
				if (settled) return;
				settled = true;
				resolveInput(undefined);
			},
		};
	}

	private trackPromptOperation(promise: Promise<AgentTurnContext | undefined>): Promise<AgentTurnContext | undefined> {
		this.activePromptOperations.add(promise);
		void promise.then(
			() => this.activePromptOperations.delete(promise),
			() => this.activePromptOperations.delete(promise),
		);
		return promise;
	}

	private async executePromptWithOrigin(
		text: string,
		images: Array<{ data: string; mimeType: string }> | undefined,
		options: {
			inputId: string;
			origin: AgentInputOrigin;
			activeToolNames?: readonly string[];
			capabilities?: AgentCapabilityLease;
		},
	): Promise<AgentTurnContext | undefined> {
		const entryCount = this.runtime.session.sessionManager.getEntries().length;
		const previousToolNames = this.runtime.session.getActiveToolNames();
		if (options.activeToolNames) this.runtime.session.setActiveToolsByName([...options.activeToolNames]);
		let turn: AgentTurnContext | undefined;
		try {
			turn = await this.runtime.session.promptWithOrigin(text, {
				images: contentImages(images),
				source: "rpc",
				streamingBehavior: "followUp",
				inputId: options.inputId,
				origin: options.origin,
				...(options.capabilities ? { capabilities: options.capabilities } : {}),
			});
			await this.runtime.session.waitForIdle();
			const error = promptFailure(this.runtime.session.sessionManager.getEntries().slice(entryCount));
			if (error) throw new Error(error);
			this.emitCommittedEntries();
			return turn;
		} finally {
			if (options.activeToolNames) this.runtime.session.setActiveToolsByName(previousToolNames);
		}
	}

	async activateExtensionLifecycle(): Promise<void> {
		await this.turnInputQueue;
		await Promise.allSettled([...this.activePromptOperations]);
		await this.runtime.activateExtensionLifecycle();
	}

	private hasPendingRoomBoundary(): boolean {
		return (
			this.pendingTurnInputs > 0 ||
			this.runtime.session.extensionRunner.createContext().currentTurn?.rootOrigin === "room"
		);
	}

	private async promptUserAfterRoomBoundary(
		text: string,
		images: Array<{ data: string; mimeType: string }> | undefined,
		inputId: string,
	): Promise<void> {
		await this.promptWithOrigin(text, images, {
			inputId,
			origin: { type: "user", channel: "rpc" },
		});
	}

	async steer(text: string, images?: Array<{ data: string; mimeType: string }>, queueId?: string): Promise<void> {
		if (this.hasPendingRoomBoundary()) {
			await this.promptUserAfterRoomBoundary(text, images, queueId ?? randomUUID());
			return;
		}
		if (this.isRegisteredExtensionCommand(text)) {
			await this.runtime.session.prompt(text, { images: contentImages(images), source: "rpc" });
			this.emitStateChanged();
			return;
		}
		await this.runtime.session.steer(text, contentImages(images), queueId);
		this.emitStateChanged();
	}

	async followUp(text: string, images?: Array<{ data: string; mimeType: string }>, queueId?: string): Promise<void> {
		if (this.hasPendingRoomBoundary()) {
			await this.promptUserAfterRoomBoundary(text, images, queueId ?? randomUUID());
			return;
		}
		if (this.isRegisteredExtensionCommand(text)) {
			await this.runtime.session.prompt(text, { images: contentImages(images), source: "rpc" });
			this.emitStateChanged();
			return;
		}
		await this.runtime.session.followUp(text, contentImages(images), queueId);
		this.emitStateChanged();
	}

	async queueAction(queueId: string, action: "remove" | "steer"): Promise<void> {
		this.runtime.session.queueAction(queueId, action);
		this.emitStateChanged();
	}

	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		const queue = this.runtime.session.clearQueue();
		this.emitStateChanged();
		return queue;
	}

	async compact(customInstructions?: string): Promise<void> {
		await this.runtime.session.compact(customInstructions);
		this.emitCommittedEntries();
	}

	async exportSession(outputPath?: string): Promise<{ path: string }> {
		const targetPath = outputPath && !isAbsolute(outputPath) ? resolve(this.runtime.cwd, outputPath) : outputPath;
		if (targetPath?.endsWith(".jsonl")) {
			return { path: this.runtime.session.exportToJsonl(targetPath) };
		}
		return { path: await this.runtime.session.exportToHtml(targetPath) };
	}

	async importSession(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const sourcePath = isAbsolute(inputPath) ? inputPath : resolve(this.runtime.cwd, inputPath);
		const result = await this.runtime.importFromJsonl(inputPath, cwdOverride, this.runtime.cwd);
		if (!result.cancelled) {
			await rebindSessionAttachments(this.runtime.session.sessionManager, sourcePath).catch(() => false);
		}
		return result;
	}

	async shareSession(signal?: AbortSignal): Promise<{ previewUrl: string; gistUrl: string }> {
		return this.runtime.shareViaPrivateGist({ signal });
	}

	getLastAssistantText(): string | undefined {
		return this.runtime.session.getLastAssistantText();
	}

	async getTurnResultAsync(turnId: string): Promise<AgentTurnResult | undefined> {
		return this.runtime.session.getTurnResult(turnId);
	}

	async recordCollaborationResult(result: SessionCollaborationResult): Promise<void> {
		const latestAssistantMessageId = [...this.runtime.session.sessionManager.getEntries()]
			.reverse()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant")?.id;
		const persistedResult: SessionCollaborationResult = {
			taskId: result.taskId,
			outcome: result.outcome,
			...(typeof result.resultText === "string" ? { resultText: result.resultText } : {}),
			...(typeof result.resultMessageId === "string" || latestAssistantMessageId
				? { resultMessageId: result.resultMessageId ?? latestAssistantMessageId }
				: {}),
			...(typeof result.error === "string" ? { error: result.error } : {}),
			completedAt: result.completedAt,
			...(result.workspace ? { workspace: result.workspace } : {}),
			...(result.changedFiles ? { changedFiles: result.changedFiles } : {}),
			...(result.deliveryCommit ? { deliveryCommit: result.deliveryCommit } : {}),
			...(result.patchPath ? { patchPath: result.patchPath } : {}),
		};
		const previousResult = this.runtime.session.sessionManager.getCollaborationResult();
		if (previousResult && JSON.stringify(previousResult) === JSON.stringify(persistedResult)) return;
		this.runtime.session.sessionManager.appendCollaborationResult(persistedResult);
		this.emitStateChanged();
	}

	async runBash(command: string, excludeFromContext: boolean, onChunk: (chunk: string) => void): Promise<JsonValue> {
		const extensionResult = await this.runtime.session.extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.runtime.cwd,
		});
		const result = extensionResult?.result
			? extensionResult.result
			: await this.runtime.session.executeBash(command, onChunk, {
					excludeFromContext,
					operations: extensionResult?.operations,
				});
		if (extensionResult?.result) {
			if (result.output) onChunk(result.output);
			this.runtime.session.recordBashResult(command, result, { excludeFromContext });
		}
		this.emitCommittedEntries();
		return jsonValue(result);
	}

	async rename(name: string): Promise<void> {
		this.runtime.session.setSessionName(name);
		this.emitStateChanged();
	}

	private async refreshModelProvider(provider: string): Promise<void> {
		const modelRuntime = this.runtime.services.modelRuntime;
		const result = await modelRuntime.refresh({ allowNetwork: false, providers: [provider] });
		const error = result.errors.get(provider);
		if (error) throw error;
		const currentModel = this.runtime.session.model;
		if (!currentModel || currentModel.provider !== provider) return;
		const refreshedModel = modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (refreshedModel && refreshedModel !== currentModel) this.runtime.session.agent.state.model = refreshedModel;
	}

	async setModel(modelRef: ModelRef): Promise<void> {
		const modelRuntime = this.runtime.services.modelRuntime;
		await this.refreshModelProvider(modelRef.provider);
		const model = modelRuntime.getModel(modelRef.provider, modelRef.id);
		if (!model) {
			throw Object.assign(new Error(`未找到模型：${modelRef.provider}/${modelRef.id}`), {
				code: "model_not_found",
			});
		}
		await this.runtime.session.setModel(model, { persist: true });
		await this.runtime.services.settingsManager.flush();
		this.emitStateChanged();
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		const provider = this.runtime.session.model?.provider;
		if (provider) await this.refreshModelProvider(provider);
		this.runtime.session.setThinkingLevel(level, { persist: true });
		await this.runtime.services.settingsManager.flush();
		this.emitStateChanged();
	}

	async cycleModel(direction: "forward" | "backward"): Promise<{ changed: boolean; isScoped: boolean }> {
		const result = await this.runtime.session.cycleModel(direction, { persist: true });
		await this.runtime.services.settingsManager.flush();
		this.emitStateChanged();
		return {
			changed: result !== undefined,
			isScoped: result?.isScoped ?? this.runtime.session.scopedModels.length > 0,
		};
	}

	async cycleThinkingLevel(): Promise<{ changed: boolean; supported: boolean }> {
		const previous = this.runtime.session.thinkingLevel;
		const level = this.runtime.session.cycleThinkingLevel({ persist: true });
		await this.runtime.services.settingsManager.flush();
		this.emitStateChanged();
		return { changed: level !== undefined && level !== previous, supported: level !== undefined };
	}

	async fork(entryId: string, position?: "before" | "at"): Promise<{ sessionPath: string; selectedText?: string }> {
		const sourceSessionPath = this.sessionPath;
		const result = await this.runtime.fork(entryId, { position });
		if (result.cancelled) {
			throw Object.assign(new Error("已取消会话分叉"), { code: "session_fork_cancelled" });
		}
		await rebindSessionAttachments(this.runtime.session.sessionManager, sourceSessionPath).catch(() => false);
		this.emitStateChanged();
		return { sessionPath: this.sessionPath, selectedText: result.selectedText };
	}

	async abort(): Promise<void> {
		this.stepController.finishActive("interrupted", "任务已取消");
		this.runtime.session.abortBash();
		await this.runtime.session.abort();
	}

	async reloadResources(): Promise<void> {
		await this.runtime.session.reload();
		this.emitStateChanged();
	}

	private isRegisteredExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return this.runtime.session.extensionRunner.getCommand(commandName) !== undefined;
	}

	async getCompletions(text: string, cursor: number): Promise<CompletionResult | undefined> {
		return this.runtime.session.getCompletions(text, cursor);
	}

	getToolRecoveryDiagnostics(): ToolRecoveryRuntimeDiagnostics {
		return this.runtime.session.getToolRecoveryDiagnostics();
	}

	renderRichText(request: RichTextRenderRequest) {
		return renderTerminalRichText({
			...request,
			themeName: this.runtime.services.settingsManager.getTheme(),
			mermaidMode: this.runtime.services.settingsManager.getMermaidRenderingMode(),
			showCodeBlockFences: this.runtime.services.settingsManager.getShowMarkdownCodeBlockFences(),
			markdownTransformers: this.runtime.session.extensionRunner.getMarkdownTransformers(),
		});
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.stepController.finishActive("interrupted", "会话已停止");
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.unsubscribeSteps?.();
		this.unsubscribeSteps = undefined;
		this.unsubscribeSubagents?.();
		this.unsubscribeSubagents = undefined;
		this.unsubscribeExtensionActivities?.();
		this.unsubscribeExtensionActivities = undefined;
		const companion = this.companion;
		this.companion = undefined;
		this.externalClientCount = 0;
		await companion?.dispose();
		await this.runtime.dispose();
	}

	onEvent(listener: (event: RuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async bindCurrentSession(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.unsubscribeSteps?.();
		this.unsubscribeSteps = undefined;
		this.unsubscribeSubagents?.();
		this.unsubscribeSubagents = undefined;
		this.unsubscribeExtensionActivities?.();
		this.unsubscribeExtensionActivities = undefined;
		this.activeExtensionActivities = [];
		this.completedExtensionActivities.clear();
		const previousCompanion = this.companion;
		this.companion = undefined;
		this.externalClientCount = 0;
		await previousCompanion?.dispose();
		const session = this.runtime.session;
		for (const [activityId, activity] of recoverInterruptedExtensionActivities(session.sessionManager)) {
			this.completedExtensionActivities.set(activityId, activity);
		}
		const unsupportedSessionChange = async () => {
			throw new Error("LYStar Web Runtime不支持由扩展替换会话");
		};
		const commandContextActions: ExtensionCommandContextActions = {
			waitForIdle: () => session.waitForIdle(),
			newSession: unsupportedSessionChange,
			fork: unsupportedSessionChange,
			navigateTree: unsupportedSessionChange,
			switchSession: unsupportedSessionChange,
			reload: () => session.reload(),
		};
		await session.bindExtensions({
			uiContext: createUiContext(this.onUiRequest),
			mode: "rpc",
			commandContextActions,
			abortHandler: () => void this.abort(),
			onError: (error) => this.emit({ type: "progress", payload: jsonValue({ type: "extension_error", ...error }) }),
		});
		this.unsubscribeExtensionActivities = session.extensionRunner.onActivity((activity) => {
			if (this.disposed || this.runtime.session !== session) return;
			if (activity.phase === "start") {
				const startEntryId = session.sessionManager.appendCustomEntry(EXTENSION_ACTIVITY_CUSTOM_TYPE, {
					version: 1,
					phase: "start",
					activityId: activity.activityId,
					extensionPath: activity.extensionPath,
					hook: activity.hook,
					startedAt: activity.startedAt,
				});
				this.activeExtensionActivities.push({
					activityId: activity.activityId,
					startEntryId,
					relatedEntryIds: [],
				});
			} else {
				const activeIndex = this.activeExtensionActivities.findIndex(
					(active) => active.activityId === activity.activityId,
				);
				const active = activeIndex >= 0 ? this.activeExtensionActivities.splice(activeIndex, 1)[0] : undefined;
				const entries = session.sessionManager.getEntries();
				const relatedEntryIds = active?.relatedEntryIds ?? [];
				const details = extensionActivityDetails(entries, relatedEntryIds);
				session.sessionManager.appendCustomEntry(EXTENSION_ACTIVITY_CUSTOM_TYPE, {
					version: 1,
					phase: "end",
					activityId: activity.activityId,
					extensionPath: activity.extensionPath,
					hook: activity.hook,
					startedAt: activity.startedAt,
					endedAt: activity.endedAt,
					durationMs: activity.durationMs,
					status: activity.status,
					relatedEntryIds,
					...(activity.error ? { error: boundedStatus(activity.error) } : {}),
					...(details ? { details } : {}),
				});
				if (active) {
					this.completedExtensionActivities.set(activity.activityId, {
						startEntryId: active.startEntryId,
						relatedEntryIds,
					});
				}
			}
			queueMicrotask(() => {
				if (!this.disposed && this.runtime.session === session) this.emitCommittedEntries();
			});
		});
		this.unsubscribeSteps = this.stepController.onChange((step) => {
			this.stateRevision++;
			this.emit({ type: "progress", payload: { type: "agent_step", step } });
			queueMicrotask(() => this.emitCommittedEntries());
			this.emit({ type: "state_changed", payload: jsonValue(this.getSnapshot("owned")) });
		});
		this.unsubscribe = session.subscribe((event) => {
			this.stateRevision++;
			if (
				event.type === "entry_appended" &&
				event.entry.type === "custom" &&
				event.entry.customType !== EXTENSION_ACTIVITY_CUSTOM_TYPE &&
				event.entry.customType !== AGENT_STEP_CUSTOM_TYPE
			) {
				this.activeExtensionActivities.at(-1)?.relatedEntryIds.push(event.entry.id);
			}
			if (event.type === "tool_execution_start" && !AGENT_STEP_TOOL_NAMES.has(event.toolName)) {
				this.stepController.associateTool(event.toolCallId);
			}
			if (event.type === "message_end" && (event.message.role === "assistant" || event.message.role === "user")) {
				const messageRole = event.message.role;
				const stepId = this.stepController.activeStep?.id;
				if (stepId) {
					const entryOffset = session.sessionManager.getEntries().length;
					queueMicrotask(() => {
						if (this.disposed || this.runtime.session !== session) return;
						const entry = session.sessionManager
							.getEntries()
							.slice(entryOffset)
							.find((candidate) => candidate.type === "message" && candidate.message.role === messageRole);
						if (entry) this.stepController.associateMessage(entry.id, stepId);
					});
				}
				if (event.message.role === "assistant" && event.message.stopReason === "error") {
					this.stepController.finishActive("failed", event.message.errorMessage ?? "模型响应失败");
				} else if (event.message.role === "assistant" && event.message.stopReason === "aborted") {
					this.stepController.finishActive("interrupted", event.message.errorMessage ?? "请求已取消");
				}
			}
			if (event.type === "agent_settled") this.stepController.finishActive("completed");
			if (event.type === "message_end" || event.type === "entry_appended") {
				queueMicrotask(() => this.emitCommittedEntries());
			}
			for (const progress of projectRuntimeProgress(event)) {
				this.emit({ type: "progress", payload: progressWithAgentStep(progress, this.stepController) });
			}
			this.emit({ type: "state_changed", payload: jsonValue(this.getSnapshot("owned")) });
		});
		const parentSessionPath = session.sessionFile;
		if (parentSessionPath) {
			this.unsubscribeSubagents = subscribeSubagentRuns((snapshot, event) => {
				if (
					this.disposed ||
					this.runtime.session !== session ||
					snapshot.session?.parentSessionFile !== parentSessionPath
				)
					return;
				const progress = event ? projectAgentEvent(event) : [];
				this.emit({
					type: "subagent_updated",
					payload: jsonValue({ snapshot, ...(progress.length ? { progress } : {}) }),
				});
			});
		}
		const companion = new WebCompanionServer(
			session,
			this.agentDir,
			() => {
				if (this.disposed || this.runtime.session !== session) return;
				this.emitCommittedEntries();
				this.emitStateChanged();
			},
			(count) => {
				if (this.disposed || this.runtime.session !== session) return;
				this.externalClientCount = count;
				this.emitStateChanged();
			},
		);
		await companion.start();
		if (this.disposed || this.runtime.session !== session) {
			await companion.dispose();
			return;
		}
		this.companion = companion;
		if (this.completedExtensionActivities.size > 0) this.emitCommittedEntries();
	}

	private emitCommittedEntries(): void {
		if (!existsSync(this.sessionPath)) return;
		const session = this.runtime.session;
		const entries = session.sessionManager.getEntries();
		const committed = entries.slice(this.committedEntryCount);
		if (committed.length === 0) return;
		const transcriptEntries = committed.filter(isTranscriptEntry);
		const activityMarkers = transcriptEntries.flatMap((entry) => {
			const activity = extensionActivityRecordFromEntry(entry);
			return activity ? [{ entry, activity }] : [];
		});
		const hasCompletedEntry = committed.some(
			(entry) =>
				entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "bashExecution"),
		);
		const hasTranscriptBeforeCommit = entries.slice(0, this.committedEntryCount).some(isTranscriptEntry);
		if (!hasTranscriptBeforeCommit && !hasCompletedEntry && activityMarkers.length === 0) return;

		const activityMarkersById = new Map<
			string,
			{ start?: SessionEntry; end?: SessionEntry; endRecord?: Extract<ExtensionActivityRecord, { phase: "end" }> }
		>();
		for (const { entry, activity } of activityMarkers) {
			const group = activityMarkersById.get(activity.activityId) ?? {};
			if (activity.phase === "start") group.start = entry;
			else {
				group.end = entry;
				group.endRecord = activity;
			}
			activityMarkersById.set(activity.activityId, group);
		}

		const activityEntryIds = new Set<string>();
		const completedRelatedEntryIds = new Set<string>();
		const processedActivities = new Set<string>();
		for (const { activity } of activityMarkers) {
			if (processedActivities.has(activity.activityId)) continue;
			processedActivities.add(activity.activityId);
			const group = activityMarkersById.get(activity.activityId);
			if (!group) continue;
			const completed = group.endRecord;
			const remembered = this.completedExtensionActivities.get(activity.activityId);
			const startEntryId = remembered?.startEntryId ?? group.start?.id;
			const startEntry = startEntryId ? session.sessionManager.getEntry(startEntryId) : group.start;
			const relatedEntryIds = completed?.relatedEntryIds ?? remembered?.relatedEntryIds ?? [];
			const relatedEntries = relatedEntryIds.flatMap((entryId) => {
				const entry = session.sessionManager.getEntry(entryId);
				return entry?.type === "custom" ? [entry] : [];
			});
			if (group.start) activityEntryIds.add(group.start.id);
			if (group.end) activityEntryIds.add(group.end.id);
			if (startEntry) activityEntryIds.add(startEntry.id);
			for (const entry of relatedEntries) {
				activityEntryIds.add(entry.id);
				completedRelatedEntryIds.add(entry.id);
			}
			if (completed) this.completedExtensionActivities.delete(activity.activityId);
		}

		const activeRelatedEntryIds = new Set(
			this.activeExtensionActivities.flatMap((activity) => activity.relatedEntryIds),
		);
		const includedEntryIds = new Set(activityEntryIds);
		for (const entry of transcriptEntries) {
			if (extensionActivityRecordFromEntry(entry)) continue;
			if (activeRelatedEntryIds.has(entry.id) || completedRelatedEntryIds.has(entry.id)) continue;
			includedEntryIds.add(entry.id);
		}
		const emittedEntries = entries.filter((entry) => includedEntryIds.has(entry.id));
		const agentSteps = this.stepController.stepsForEntries(transcriptEntries);
		this.committedEntryCount = entries.length;
		const storage = sessionGeneration(this.sessionPath, session.sessionId);
		const fromRevision = this.lastTranscriptGeneration === storage.generation ? this.lastTranscriptRevision : 0;
		this.lastTranscriptGeneration = storage.generation;
		this.lastTranscriptRevision = storage.revision;
		this.emit({
			type: "entry_committed",
			payload: jsonValue({
				items: emittedEntries.map(entryItem),
				...(agentSteps.length > 0 ? { agentSteps } : {}),
				transcriptGeneration: storage.generation,
				fromRevision,
				transcriptRevision: storage.revision,
			}),
		});
	}

	private emitStateChanged(): void {
		this.stateRevision++;
		this.emit({ type: "state_changed", payload: jsonValue(this.getSnapshot("owned")) });
	}

	private emit(event: RuntimeEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

export type { ExtensionAPI } from "@earendil-works/pi-coding-agent/core";

export function getRuntimeAgentDir(): string {
	return getAgentDir();
}

export interface CodingAgentRuntimeAdapterOptions {
	agentDir?: string;
	initialRuntime?: AgentSessionRuntime;
	createRuntime?: CreateAgentSessionRuntimeFactory;
	preferSessionOwnership?: boolean;
	sessionCoordinator?: SessionCoordinator;
}

export class CodingAgentRuntimeAdapter implements RuntimeAdapter {
	private readonly agentDir: string;
	private readonly createRuntimeFactory?: CreateAgentSessionRuntimeFactory;
	private readonly externalResourceGrants = new Map<string, { path: string; expiresAt: number }>();
	private readonly sessionInfoCache: SessionInfoCache = { entries: new Map() };
	private readonly sessionListPromises = new Map<string, Promise<SessionSummaryBase[]>>();
	private readonly gitRepositoryRootsCache = new Map<string, { rootRepository?: string; repositoryRoots: string[] }>();
	private readonly nodeToolchain = probeUserNodeToolchain();
	private readonly stepControllers = new WeakMap<AgentSessionRuntime, AgentStepController>();
	private modelRuntimePromise?: Promise<ModelRuntime>;
	private initialRuntime?: AgentSessionRuntime;
	private initialRuntimeClaimed = false;
	private readonly preferSessionOwnership: boolean;
	private sessionCoordinator?: SessionCoordinator;

	constructor(options: string | CodingAgentRuntimeAdapterOptions = getAgentDir()) {
		if (typeof options === "string") {
			this.agentDir = options;
			this.preferSessionOwnership = false;
			return;
		}
		this.agentDir = options.agentDir ?? getAgentDir();
		this.initialRuntime = options.initialRuntime;
		this.createRuntimeFactory = options.createRuntime;
		this.preferSessionOwnership = options.preferSessionOwnership === true;
		this.sessionCoordinator = options.sessionCoordinator;
	}

	setSessionCoordinator(coordinator: SessionCoordinator): void {
		this.sessionCoordinator = coordinator;
	}

	get hasClaimedInitialRuntime(): boolean {
		return this.initialRuntimeClaimed;
	}

	async createSession(
		cwd: string,
		onUiRequest: UiRequestHandler,
		options?: {
			parentSession?: string;
			profileId?: string;
			roomAgent?: boolean;
			collaborationTask?: SessionCollaborationTask;
			collaborationWorkspace?: SessionWorkspaceSnapshot;
			sessionDir?: string;
			readOnly?: boolean;
		},
	): Promise<RuntimeSession> {
		const profile = options?.profileId ? findSessionProfile(cwd, options.profileId, this.agentDir) : undefined;
		if (options?.profileId && !profile) {
			throw Object.assign(new Error(`未找到智能体：${options.profileId}`), { code: "session_profile_not_found" });
		}
		const sessionManager = SessionManager.create(
			cwd,
			options?.sessionDir ?? getDefaultSessionDir(cwd, this.agentDir),
			{
				persistHeader: true,
				...(options?.parentSession
					? { parentSession: options.parentSession, relation: "collaboration" as const }
					: {}),
				...(profile ? { profile: sessionProfileSnapshot(profile) } : {}),
				...(options?.roomAgent ? { roomAgent: true } : {}),
				...(options?.collaborationTask ? { collaborationTask: options.collaborationTask } : {}),
				...(options?.collaborationWorkspace ? { collaborationWorkspace: options.collaborationWorkspace } : {}),
			},
		);
		return this.createRuntime(cwd, sessionManager, onUiRequest, profile, options?.readOnly === true);
	}

	async openSession(
		sessionPath: string,
		onUiRequest: UiRequestHandler,
		options: { deferExtensionLifecycle?: boolean } = {},
	): Promise<RuntimeSession> {
		const initialRuntime = this.takeInitialRuntime(sessionPath);
		if (initialRuntime) {
			await migrateLegacyWebAttachments(initialRuntime.session.sessionManager).catch(() => false);
			return this.wrapRuntime(initialRuntime, onUiRequest);
		}
		try {
			const manager = await SessionManager.openAsync(sessionPath);
			await migrateLegacyWebAttachments(manager).catch(() => false);
			return this.createRuntime(
				manager.getCwd(),
				manager,
				onUiRequest,
				sessionProfileFromHeader(manager, manager.getCwd(), this.agentDir),
				manager.getCollaborationWorkspace()?.mode === "shared",
				options.deferExtensionLifecycle === true,
			);
		} catch (error) {
			if (!(error instanceof SessionLockedError)) throw error;
			let handoffError: Error | undefined;
			if (this.preferSessionOwnership) {
				try {
					if (await requestWebSessionHandoff(this.agentDir, sessionPath)) {
						try {
							const manager = await SessionManager.openAsync(sessionPath);
							await migrateLegacyWebAttachments(manager).catch(() => false);
							return this.createRuntime(
								manager.getCwd(),
								manager,
								onUiRequest,
								sessionProfileFromHeader(manager, manager.getCwd(), this.agentDir),
								manager.getCollaborationWorkspace()?.mode === "shared",
								options.deferExtensionLifecycle === true,
							);
						} catch (takeoverError) {
							if (!(takeoverError instanceof SessionLockedError)) throw takeoverError;
							handoffError = takeoverError;
						}
					}
				} catch (takeoverError) {
					handoffError = takeoverError instanceof Error ? takeoverError : new Error(String(takeoverError));
				}
			}
			try {
				return await WebCompanionRuntime.open(this.agentDir, sessionPath);
			} catch (companionError) {
				if (companionError instanceof WebCompanionProtocolError) throw companionError;
				const cause = handoffError ?? (companionError instanceof Error ? companionError : error);
				throw Object.assign(new Error("会话协作通道暂不可用，请稍后重试", { cause }), {
					code: "session_coordination_unavailable",
					retryable: true,
				});
			}
		}
	}

	inspectSession(sessionPath: string): SessionStateSnapshot {
		const snapshot = readSessionSnapshot(sessionPath);
		const storage = sessionGeneration(sessionPath, snapshot.header.id);
		let name: string | undefined;
		let model: ModelRef | undefined;
		let thinkingLevel: ThinkingLevel = "off";
		for (const entry of snapshot.entries) {
			if (entry.type === "session_info") name = entry.name;
			else if (entry.type === "model_change") model = { provider: entry.provider, id: entry.modelId };
			else if (
				entry.type === "thinking_level_change" &&
				["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(entry.thinkingLevel)
			) {
				thinkingLevel = entry.thinkingLevel as ThinkingLevel;
			}
		}
		return {
			id: snapshot.header.id,
			path: sessionPath,
			...(name ? { name } : {}),
			cwd: snapshot.header.cwd,
			createdAt: new Date(snapshot.header.timestamp).getTime(),
			updatedAt: storage.updatedAt,
			phase: "idle",
			activity: "idle",
			...(model ? { model } : {}),
			thinkingLevel,
			attached: false,
			writeAccess: this.isSessionWriterLocked(sessionPath) ? "locked_externally" : "available",
			revision: 0,
			leafId: snapshot.leafId,
			queuedSteerCount: 0,
			queuedFollowUpCount: 0,
			transcriptGeneration: storage.generation,
			transcriptRevision: storage.revision,
		};
	}

	async inspectSessionActivity(sessionPath: string): Promise<SessionActivity | undefined> {
		if (!this.isSessionWriterLocked(sessionPath)) return undefined;
		try {
			const companion = await WebCompanionRuntime.open(this.agentDir, sessionPath);
			try {
				return companion.getSnapshot("locked_externally").activity;
			} finally {
				await companion.dispose();
			}
		} catch {
			return undefined;
		}
	}

	isSessionWriterLocked(sessionPath: string): boolean {
		return SessionManager.isWriterLocked(sessionPath);
	}

	async deleteSession(sessionPath: string): Promise<void> {
		await SessionManager.deleteSessionWithRecoveryLedger(this.agentDir, sessionPath, () =>
			SessionManager.withWriterLock(sessionPath, () => {
				unlinkSync(sessionPath);
				rmSync(sessionAttachmentDirectory(sessionPath), { recursive: true, force: true });
			}),
		);
	}

	getSessionDirectory(cwd: string): string {
		return getDefaultSessionDir(cwd, this.agentDir);
	}

	async listSessions(cwd: string, options: { metadataOnly?: boolean } = {}): Promise<SessionSummaryBase[]> {
		const metadataOnly = options.metadataOnly === true;
		const key = `${resolve(cwd)}:${metadataOnly ? "metadata" : "full"}`;
		const pending = this.sessionListPromises.get(key);
		if (pending) return pending;
		const request: Promise<SessionSummaryBase[]> = SessionManager.list(
			cwd,
			getDefaultSessionDir(cwd, this.agentDir),
			undefined,
			{
				cache: this.sessionInfoCache,
				includeAllMessagesText: false,
				metadataOnly,
			},
		)
			.then((sessions) => {
				const idsByPath = new Map(sessions.map((session) => [resolve(session.path), session.id]));
				return sessions.map<SessionSummaryBase>((session) => ({
					path: session.path,
					id: session.id,
					cwd: session.cwd,
					...(session.name ? { name: session.name } : {}),
					...(session.parentSessionPath && idsByPath.get(resolve(session.parentSessionPath))
						? { parentId: idsByPath.get(resolve(session.parentSessionPath)) }
						: {}),
					...(session.relation ? { relation: session.relation } : {}),
					...(session.profile
						? {
								profileId: session.profile.id,
								profileName: session.profile.name,
								...(session.profile.icon ? { profileIcon: session.profile.icon } : {}),
							}
						: {}),
					...((session.collaborationResult?.workspace ?? session.collaborationWorkspace)
						? { workspace: session.collaborationResult?.workspace ?? session.collaborationWorkspace }
						: {}),
					createdAt: session.created.getTime(),
					updatedAt: session.modified.getTime(),
					messageCount: session.messageCount,
					firstMessage:
						(session.firstMessage === "(no messages)" ? "" : promptDisplayText(session.firstMessage)) ||
						"未命名会话",
					activity: session.lastOutcome ?? session.collaborationResult?.outcome ?? "idle",
					...(session.collaborationTask
						? {
								taskId: session.collaborationTask.id,
								taskDescription: session.collaborationTask.description,
							}
						: {}),
					...(session.collaborationResult ? { collaborationResult: session.collaborationResult } : {}),
				}));
			})
			.then((sessions) => {
				return sessions;
			});
		this.sessionListPromises.set(key, request);
		try {
			return await request;
		} finally {
			if (this.sessionListPromises.get(key) === request) this.sessionListPromises.delete(key);
		}
	}

	listProjectInstructions(cwd: string): ProjectInstruction[] {
		const root = canonicalDirectory(cwd);
		const active = loadProjectContextFiles({ cwd: root, agentDir: this.agentDir });
		const activePaths = new Set(active.map((file) => realpathSync(file.path)));
		const byPath = new Map<string, ProjectInstruction>();
		for (const file of active) {
			const path = realpathSync(file.path);
			byPath.set(path, {
				path,
				fileName: basename(path),
				exists: true,
				active: true,
				editable: dirname(path) === root && PROJECT_INSTRUCTION_NAMES.includes(basename(path) as never),
				content: file.content,
				contentHash: contentHash(file.content),
			});
		}
		for (const fileName of PROJECT_INSTRUCTION_NAMES) {
			const path = join(root, fileName);
			if (existsSync(path)) {
				const canonicalPath = realpathSync(path);
				if (!isInside(root, canonicalPath) || !statSync(canonicalPath).isFile()) continue;
				const content = readFileSync(canonicalPath, "utf8");
				byPath.set(canonicalPath, {
					path: canonicalPath,
					fileName,
					exists: true,
					active: activePaths.has(canonicalPath),
					editable: dirname(canonicalPath) === root,
					content,
					contentHash: contentHash(content),
				});
			} else {
				byPath.set(path, { path, fileName, exists: false, active: false, editable: true });
			}
		}
		return [...byPath.values()];
	}

	saveProjectInstruction(
		cwd: string,
		fileName: "AGENTS.md" | "AGENTS.override.md",
		content: string,
		expectedHash?: string,
	): ProjectInstruction[] {
		const root = canonicalDirectory(cwd);
		const path = join(root, fileName);
		if (dirname(path) !== root)
			throw Object.assign(new Error("项目指令文件路径无效"), { code: "instruction_path_invalid" });
		if (existsSync(path)) {
			const canonicalPath = realpathSync(path);
			if (!isInside(root, canonicalPath) || dirname(canonicalPath) !== root || !statSync(canonicalPath).isFile()) {
				throw Object.assign(new Error("项目指令文件越过项目边界"), { code: "instruction_path_invalid" });
			}
			const currentHash = contentHash(readFileSync(canonicalPath, "utf8"));
			if (!expectedHash || currentHash !== expectedHash) {
				throw Object.assign(new Error("项目指令文件已被外部修改，请重新加载后再保存"), {
					code: "instruction_conflict",
					retryable: true,
				});
			}
		} else if (expectedHash) {
			throw Object.assign(new Error("项目指令文件已被外部删除，请重新加载后再保存"), {
				code: "instruction_conflict",
				retryable: true,
			});
		}
		atomicWriteUtf8(path, content);
		return this.listProjectInstructions(root);
	}

	listHostInstructions(): ProjectInstruction[] {
		const root = canonicalDirectory(this.agentDir);
		const activeFile = PROJECT_INSTRUCTION_NAMES.map((fileName) => join(root, fileName)).find(existsSync);
		return PROJECT_INSTRUCTION_NAMES.map((fileName) => {
			const path = join(root, fileName);
			if (!existsSync(path)) return { path, fileName, exists: false, active: false, editable: true };
			const canonicalPath = realpathSync(path);
			if (!isInside(root, canonicalPath) || dirname(canonicalPath) !== root || !statSync(canonicalPath).isFile()) {
				throw Object.assign(new Error("Host 指令文件越过配置目录边界"), { code: "instruction_path_invalid" });
			}
			const content = readFileSync(canonicalPath, "utf8");
			return {
				path: canonicalPath,
				fileName,
				exists: true,
				active: activeFile === path,
				editable: true,
				content,
				contentHash: contentHash(content),
			};
		});
	}

	saveHostInstruction(
		fileName: "AGENTS.md" | "AGENTS.override.md",
		content: string,
		expectedHash?: string,
	): ProjectInstruction[] {
		const root = canonicalDirectory(this.agentDir);
		const path = join(root, fileName);
		if (existsSync(path)) {
			const canonicalPath = realpathSync(path);
			if (!isInside(root, canonicalPath) || dirname(canonicalPath) !== root || !statSync(canonicalPath).isFile()) {
				throw Object.assign(new Error("Host 指令文件越过配置目录边界"), { code: "instruction_path_invalid" });
			}
			const currentHash = contentHash(readFileSync(canonicalPath, "utf8"));
			if (!expectedHash || currentHash !== expectedHash) {
				throw Object.assign(new Error("Host 指令文件已被外部修改，请重新加载后再保存"), {
					code: "instruction_conflict",
					retryable: true,
				});
			}
		} else if (expectedHash) {
			throw Object.assign(new Error("Host 指令文件已被外部删除，请重新加载后再保存"), {
				code: "instruction_conflict",
				retryable: true,
			});
		}
		atomicWriteUtf8(path, content);
		return this.listHostInstructions();
	}

	listDirectories(path?: string): HostDirectoryListing {
		const home = canonicalDirectory(homedir());
		const current = canonicalDirectory(path ?? home);
		const entries = readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
			const candidate = join(current, entry.name);
			try {
				const canonicalPath = realpathSync(candidate);
				if (!statSync(canonicalPath).isDirectory()) return [];
				return [{ name: entry.name, path: canonicalPath, hidden: entry.name.startsWith(".") }];
			} catch {
				return [];
			}
		});
		entries.sort((left, right) => left.name.localeCompare(right.name));
		const parent = dirname(current);
		return { path: current, home, ...(parent !== current ? { parent } : {}), entries };
	}

	completeProjectFiles(cwd: string, query: string, limit: number): CompletionItem[] {
		const root = canonicalDirectory(cwd);
		const normalizedQuery = query.replaceAll("\\", "/").replace(/^\.\//, "");
		const lowerQuery = normalizedQuery.toLowerCase();
		const slashIndex = normalizedQuery.lastIndexOf("/");
		let scanRoot = root;
		if (slashIndex >= 0) {
			const candidateRoot = resolve(root, normalizedQuery.slice(0, slashIndex) || ".");
			if (!existsSync(candidateRoot)) return [];
			scanRoot = canonicalDirectory(candidateRoot);
			if (!isInside(root, scanRoot)) return [];
		}
		const stack = [scanRoot];
		const matches: CompletionItem[] = [];
		let visited = 0;
		while (stack.length > 0 && matches.length < limit && visited < 5000) {
			const directory = stack.pop();
			if (!directory) break;
			let entries: Dirent[];
			try {
				entries = readdirSync(directory, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
				visited++;
				if (entry.name === ".git" || (entry.name === "node_modules" && !lowerQuery.startsWith("node_modules")))
					continue;
				const path = join(directory, entry.name);
				const displayPath = relative(root, path).split(sep).join("/");
				if (entry.isDirectory()) stack.push(path);
				if (!displayPath.toLowerCase().includes(lowerQuery)) continue;
				const quoted = displayPath.includes(" ")
					? `@"${displayPath}${entry.isDirectory() ? "/" : ""}"`
					: `@${displayPath}${entry.isDirectory() ? "/" : ""}`;
				matches.push({
					value: `${quoted}${entry.isDirectory() ? "" : " "}`,
					label: entry.name,
					description: dirname(displayPath) === "." ? "项目根目录" : dirname(displayPath),
					kind: entry.isDirectory() ? "directory" : "file",
				});
				if (matches.length >= limit) break;
			}
		}
		return matches;
	}

	resolveProjectResource(cwd: string, target: string, line?: number, column?: number): ProjectResource {
		const parsed = splitResourceTarget(target.trim().replace(/^file:\/\//, ""));
		const resolved = canonicalProjectFile(cwd, parsed.path);
		const stat = statSync(resolved.path);
		if (stat.size > PROJECT_RESOURCE_MAX_BYTES) {
			throw Object.assign(new Error("文件超过 32 MiB 的桌面查看上限"), { code: "resource_too_large" });
		}
		const type = fileMimeType(resolved.path);
		return {
			path: resolved.path,
			displayPath: relative(resolved.root, resolved.path).split(sep).join("/") || basename(resolved.path),
			...type,
			byteLength: stat.size,
			contentVersion: fileContentVersion(resolved.path),
			...((line ?? parsed.line) ? { line: line ?? parsed.line } : {}),
			...((column ?? parsed.column) ? { column: column ?? parsed.column } : {}),
		};
	}

	readProjectResource(cwd: string, path: string, offset: number, limit: number): ContentChunk {
		return readResourceFile(canonicalProjectFile(cwd, path).path, offset, limit);
	}

	saveProjectFile(cwd: string, path: string, content: string, expectedHash: string): ProjectFileSaveResult {
		const resolved = canonicalProjectFile(cwd, path);
		const stat = statSync(resolved.path);
		if (fileMimeType(resolved.path).kind !== "text") {
			throw Object.assign(new Error("只有文本文件支持在线编辑"), {
				code: "project_file_not_editable",
				retryable: false,
			});
		}
		if (stat.size > PROJECT_TEXT_EDITOR_MAX_BYTES) {
			throw Object.assign(new Error("文件超过 2 MiB 的在线编辑上限"), {
				code: "project_file_too_large",
				retryable: false,
			});
		}
		const current = readFileSync(resolved.path);
		if (contentHash(current) !== expectedHash) {
			throw Object.assign(new Error("文件已被外部修改，请重新加载后再保存"), {
				code: "project_file_conflict",
				retryable: true,
			});
		}
		const next = Buffer.from(content, "utf8");
		if (next.byteLength > PROJECT_TEXT_EDITOR_MAX_BYTES) {
			throw Object.assign(new Error("文件超过 2 MiB 的在线编辑上限"), {
				code: "project_file_too_large",
				retryable: false,
			});
		}
		atomicWriteUtf8(resolved.path, content, stat.mode);
		const saved = statSync(resolved.path);
		return {
			path: relative(resolved.root, resolved.path).split(sep).join("/") || basename(resolved.path),
			mimeType: "text/plain; charset=utf-8",
			byteLength: saved.size,
			contentHash: contentHash(next),
			contentVersion: fileContentVersion(resolved.path),
		};
	}

	resolveExternalResource(target: string, line?: number, column?: number): ProjectResource {
		const parsed = splitResourceTarget(target.trim().replace(/^file:\/\//, ""));
		const path = canonicalExternalFile(parsed.path);
		const stat = statSync(path);
		if (stat.size > PROJECT_RESOURCE_MAX_BYTES) {
			throw Object.assign(new Error("文件超过 32 MiB 的桌面查看上限"), { code: "resource_too_large" });
		}
		const accessToken = randomUUID();
		this.externalResourceGrants.set(accessToken, { path, expiresAt: Date.now() + 10 * 60_000 });
		return {
			path,
			displayPath: path,
			...fileMimeType(path),
			byteLength: stat.size,
			contentVersion: fileContentVersion(path),
			...((line ?? parsed.line) ? { line: line ?? parsed.line } : {}),
			...((column ?? parsed.column) ? { column: column ?? parsed.column } : {}),
			accessToken,
		};
	}

	readExternalResource(path: string, accessToken: string, offset: number, limit: number): ContentChunk {
		const grant = this.externalResourceGrants.get(accessToken);
		const canonicalPath = canonicalExternalFile(path);
		if (!grant || grant.expiresAt < Date.now() || grant.path !== canonicalPath) {
			this.externalResourceGrants.delete(accessToken);
			throw Object.assign(new Error("项目外文件授权已失效，请重新确认"), {
				code: "external_resource_grant_invalid",
				retryable: true,
			});
		}
		return readResourceFile(canonicalPath, offset, limit);
	}

	async listModels(): Promise<ModelSummary[]> {
		const runtime = await this.getModelRuntime();
		const config = await ModelConfig.load(join(this.agentDir, "models.json"));
		const providers = new Map(
			runtime.getProviders().map((provider) => {
				const status = runtime.getProviderAuthStatus(provider.id);
				return [
					provider.id,
					{
						authenticated: status.configured,
						authMethods: authMethods(runtime, provider.id),
						authSource: status.configured ? (status.label ?? status.source) : undefined,
					},
				] as const;
			}),
		);
		return runtime.getModels().map((model) => {
			const provider = providers.get(model.provider) ?? {
				authenticated: false,
				authMethods: [] as AuthType[],
			};
			const modelConfig = config.getProvider(model.provider);
			const configuredModel = modelConfig?.models?.find((candidate) => candidate.id === model.id);
			const override = modelConfig?.modelOverrides?.[model.id];
			const capabilitiesPending = Boolean(
				configuredModel &&
					((configuredModel.contextWindow === undefined && override?.contextWindow === undefined) ||
						(configuredModel.maxTokens === undefined && override?.maxTokens === undefined) ||
						(configuredModel.reasoning === undefined && override?.reasoning === undefined)),
			);
			return {
				provider: model.provider,
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				thinkingLevelMap: model.thinkingLevelMap,
				cost: {
					input: Math.max(0, model.cost.input),
					output: Math.max(0, model.cost.output),
					cacheRead: Math.max(0, model.cost.cacheRead),
					cacheWrite: Math.max(0, model.cost.cacheWrite),
				},
				supportedThinkingLevels: getSupportedThinkingLevels(model),
				...(capabilitiesPending ? { capabilitiesPending: true } : {}),
				...(override ? { hasOverrides: true } : {}),
				...provider,
			};
		});
	}

	async listModelProviders(): Promise<ModelProviderSummary[]> {
		const runtime = await this.getModelRuntime();
		const config = await ModelConfig.load(join(this.agentDir, "models.json"));
		return runtime.getProviders().map((provider) => {
			const providerConfig = config.getProvider(provider.id);
			const providerModel = runtime.getModels(provider.id)[0];
			const status = runtime.getProviderAuthStatus(provider.id);
			const builtIn = runtime.isBuiltinProvider(provider.id);
			return {
				id: provider.id,
				name: provider.name,
				...((providerConfig?.api ?? providerModel?.api) ? { api: providerConfig?.api ?? providerModel?.api } : {}),
				...((providerConfig?.baseUrl ?? provider.baseUrl)
					? { baseUrl: providerConfig?.baseUrl ?? provider.baseUrl }
					: {}),
				authenticated: status.configured,
				authMethods: authMethods(runtime, provider.id),
				authSource: status.configured ? (status.label ?? status.source) : undefined,
				modelCount: runtime.getModels(provider.id).length,
				builtIn,
				custom: !builtIn && config.getProvider(provider.id) !== undefined,
				hasCustomConfig: providerConfig !== undefined,
				disabledModels: [...(providerConfig?.disabledModels ?? [])],
				...(providerConfig?.catalogProvider ? { catalogProvider: providerConfig.catalogProvider } : {}),
			};
		});
	}

	async listModelOptions(options: { includeProviders?: readonly string[] } = {}): Promise<ModelOptions> {
		const runtime = await this.getModelRuntime();
		const includedProviders = new Set(options.includeProviders ?? []);
		const authenticatedProviders = new Set(
			runtime
				.getProviders()
				.filter(
					(provider) =>
						runtime.getProviderAuthStatus(provider.id).configured || includedProviders.has(provider.id),
				)
				.map((provider) => provider.id),
		);
		const models = runtime
			.getModels()
			.filter((model) => authenticatedProviders.has(model.provider))
			.map((model) => ({
				provider: model.provider,
				id: model.id,
				name: model.name,
				reasoning: model.reasoning,
				contextWindow: model.contextWindow,
				supportedThinkingLevels: getSupportedThinkingLevels(model),
			}));
		const visibleProviders = new Set(models.map((model) => model.provider));
		const providers = runtime
			.getProviders()
			.filter((provider) => visibleProviders.has(provider.id))
			.map((provider) => ({
				id: provider.id,
				name: provider.name,
				builtIn: runtime.isBuiltinProvider(provider.id),
			}));
		return { models, providers };
	}

	async addModelProvider(input: ModelProviderInput): Promise<ModelProviderSummary[]> {
		if (input.clearCatalogProvider)
			await clearModelsJsonProviderCatalogProvider(join(this.agentDir, "models.json"), input.provider);
		await saveModelsJsonProvider(join(this.agentDir, "models.json"), input.provider, {
			...(input.name ? { name: input.name } : {}),
			baseUrl: input.baseUrl,
			api: input.api,
			...(input.apiKey ? { apiKey: input.apiKey } : {}),
			...(input.catalogProvider ? { catalogProvider: input.catalogProvider } : {}),
		});
		await (await this.getModelRuntime()).refresh({ allowNetwork: false, providers: [input.provider] });
		return this.listModelProviders();
	}

	async addProviderModel(input: ProviderModelInput): Promise<ModelSummary[]> {
		const runtime = await this.getModelRuntime();
		const existing = runtime.getModel(input.provider, input.id);
		const modelsPath = join(this.agentDir, "models.json");
		const override: ModelsJsonModelOverride = {
			...(input.name ? { name: input.name } : {}),
			reasoning: input.reasoning,
			...(input.thinkingLevelMap ? { thinkingLevelMap: input.thinkingLevelMap } : {}),
			input: input.input,
			...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
			...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
		};
		const resetOnly =
			input.resetOverride === true &&
			Boolean(existing) &&
			input.api === undefined &&
			input.baseUrl === undefined &&
			input.name === undefined &&
			input.thinkingLevelMap === undefined &&
			input.contextWindow === undefined &&
			input.maxTokens === undefined;
		if (input.resetOverride) await clearModelsJsonModelOverride(modelsPath, input.provider, input.id);
		if (resetOnly) {
			await runtime.refresh({ allowNetwork: false, providers: [input.provider] });
			return this.listModels();
		}
		if (existing && input.api === undefined && input.baseUrl === undefined) {
			await saveModelsJsonModelOverride(modelsPath, input.provider, input.id, override);
		} else {
			const provider = runtime.getProvider(input.provider);
			const api = input.api ?? existing?.api ?? provider?.getModels()[0]?.api;
			const baseUrl = input.baseUrl ?? existing?.baseUrl ?? provider?.baseUrl;
			if (!api || !baseUrl) throw new Error(`Provider ${input.provider} 的模型缺少 api 或 baseUrl`);
			await saveModelsJsonModel(modelsPath, input.provider, {
				id: input.id,
				name: input.name ?? existing?.name ?? input.id,
				api,
				baseUrl,
				reasoning: input.reasoning,
				...(input.thinkingLevelMap ? { thinkingLevelMap: input.thinkingLevelMap } : {}),
				input: input.input,
				...(existing?.cost ? { cost: existing.cost } : {}),
				...(input.contextWindow
					? { contextWindow: input.contextWindow }
					: existing?.contextWindow
						? { contextWindow: existing.contextWindow }
						: {}),
				...(input.maxTokens
					? { maxTokens: input.maxTokens }
					: existing?.maxTokens
						? { maxTokens: existing.maxTokens }
						: {}),
				...(existing?.compat ? { compat: existing.compat as ModelsJsonModel["compat"] } : {}),
			});
		}
		await runtime.refresh({ allowNetwork: false, providers: [input.provider] });
		return this.listModels();
	}

	async syncModelProvider(providerId: string): Promise<ModelSummary[]> {
		const runtime = await this.getModelRuntime();
		const modelsPath = join(this.agentDir, "models.json");
		const config = await ModelConfig.load(modelsPath);
		const providerConfig = config.getProvider(providerId);
		const builtIn = runtime.isBuiltinProvider(providerId);
		if (!providerConfig && !builtIn) throw new Error(`未找到 Provider：${providerId}`);
		const catalogProvider = providerConfig?.catalogProvider ?? (builtIn ? providerId : undefined);
		if (catalogProvider) {
			if (!runtime.getProvider(catalogProvider)) throw new Error(`未找到模型目录 Provider：${catalogProvider}`);
			const refreshed = await runtime.refresh({ allowNetwork: true, force: true, providers: [catalogProvider] });
			const error = refreshed.errors.get(catalogProvider);
			if (error) throw error;
			if (catalogProvider === providerId) return this.listModels();
		}

		const targetProvider = runtime.getProvider(providerId);
		const baseUrl = providerConfig?.baseUrl ?? targetProvider?.baseUrl;
		if (!baseUrl) throw new Error(`Provider ${providerId} 缺少 baseUrl`);
		const sourceModels = catalogProvider ? [...runtime.getModels(catalogProvider)] : [];
		const discovered = catalogProvider
			? sourceModels.map((model) => ({
					id: model.id,
					name: model.name,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				}))
			: await discoverProviderModels(
					baseUrl,
					await runtime.getAuth(providerId),
					providerConfig?.api ?? targetProvider?.getModels()[0]?.api,
				);
		if (discovered.length === 0) throw new Error("没有发现可同步的模型");
		const existingModels = new Map(runtime.getModels(providerId).map((model) => [model.id, model] as const));
		const configuredModels = providerConfig?.models ?? [];
		const providerApi = providerConfig?.api ?? targetProvider?.getModels()[0]?.api;
		if (!providerApi) throw new Error(`Provider ${providerId} 缺少 api`);
		const definitions = discovered.map((model) => {
			const source =
				sourceModels.find((candidate) => candidate.id === model.id) ??
				findMatchingCatalogModel(runtime, providerId, model.id, providerApi);
			if (source) return modelDefinitionFromCatalog(source, baseUrl, model, providerApi);
			const existingDefinition = configuredModels.find((candidate) => candidate.id === model.id);
			const existingModel = existingModels.get(model.id);
			return {
				...existingDefinition,
				id: model.id,
				name: model.name ?? existingDefinition?.name ?? existingModel?.name ?? model.id,
				api: providerConfig?.api ?? existingDefinition?.api ?? providerApi,
				baseUrl: providerConfig?.baseUrl ?? existingDefinition?.baseUrl ?? baseUrl,
				input: existingDefinition?.input ?? existingModel?.input ?? ["text"],
				...((model.contextWindow ?? existingDefinition?.contextWindow)
					? { contextWindow: model.contextWindow ?? existingDefinition?.contextWindow }
					: {}),
				...((model.maxTokens ?? existingDefinition?.maxTokens)
					? { maxTokens: model.maxTokens ?? existingDefinition?.maxTokens }
					: {}),
			};
		});
		await saveModelsJsonModels(modelsPath, providerId, definitions);
		const discoveredIds = new Set(discovered.map((model) => model.id));
		const configuredModelIds = new Set(configuredModels.map((model) => model.id));
		const previouslySyncedIds = new Set(providerConfig?.syncedModels ?? []);
		const staleModelIds = [...previouslySyncedIds].filter(
			(modelId) =>
				!discoveredIds.has(modelId) &&
				configuredModelIds.has(modelId) &&
				providerConfig?.modelOverrides?.[modelId] === undefined,
		);
		const nextSyncedIds = [...discoveredIds].filter(
			(modelId) => previouslySyncedIds.has(modelId) || !configuredModelIds.has(modelId),
		);
		await removeModelsJsonModels(modelsPath, providerId, staleModelIds);
		await saveModelsJsonSyncedModels(modelsPath, providerId, nextSyncedIds);
		await runtime.refresh({ allowNetwork: false, providers: [providerId] });
		return this.listModels();
	}

	async removeModelProvider(providerId: string): Promise<ModelProviderSummary[]> {
		const runtime = await this.getModelRuntime();
		const modelsPath = join(this.agentDir, "models.json");
		const config = await ModelConfig.load(modelsPath);
		const providerConfig = config.getProvider(providerId);
		const builtIn = runtime.isBuiltinProvider(providerId);
		if (!providerConfig && !builtIn) throw new Error(`未找到 Provider：${providerId}`);
		if (!providerConfig) throw new Error(`Provider ${providerId} 没有可清除的自定义配置`);
		if (!builtIn) await runtime.logout(providerId);
		await removeModelsJsonProvider(modelsPath, providerId);
		await runtime.refresh({ allowNetwork: false, providers: [providerId] });
		return this.listModelProviders();
	}

	async setProviderModelEnabled(providerId: string, modelId: string, enabled: boolean): Promise<ModelSummary[]> {
		const runtime = await this.getModelRuntime();
		const modelsPath = join(this.agentDir, "models.json");
		const config = await ModelConfig.load(modelsPath);
		const providerConfig = config.getProvider(providerId);
		const builtIn = runtime.isBuiltinProvider(providerId);
		if (!providerConfig && !builtIn) throw new Error(`未找到 Provider：${providerId}`);
		const known =
			runtime.getModel(providerId, modelId) !== undefined ||
			(providerConfig?.models ?? []).some((model) => model.id === modelId) ||
			(providerConfig?.disabledModels ?? []).includes(modelId);
		if (!known) throw new Error(`未找到模型：${providerId}/${modelId}`);
		await setModelsJsonModelDisabled(modelsPath, providerId, modelId, !enabled);
		await runtime.refresh({ allowNetwork: false, providers: [providerId] });
		return this.listModels();
	}

	async loginModelProvider(
		provider: string,
		authType: AuthType,
		onUiRequest: UiRequestHandler,
		signal?: AbortSignal,
	): Promise<ModelSummary[]> {
		const runtime = await this.getModelRuntime();
		if (!authMethods(runtime, provider).includes(authType)) {
			throw Object.assign(new Error(`供应商 ${provider} 不支持 ${authType} 登录`), {
				code: "auth_type_unsupported",
				retryable: false,
			});
		}
		await runtime.login(provider, authType, {
			prompt: (prompt) => requestAuthPrompt(onUiRequest, prompt),
			notify: (event) => notifyAuthEvent(onUiRequest, event),
			signal,
		});
		return this.listModels();
	}

	async logoutModelProvider(provider: string): Promise<ModelSummary[]> {
		const runtime = await this.getModelRuntime();
		await runtime.logout(provider);
		return this.listModels();
	}

	listHarnessImports(cwd: string): HarnessImportPreview {
		const preview = discoverHarnessImports({ cwd, agentDir: this.agentDir });
		return {
			sources: preview.sources,
			items: preview.items.map(
				({
					sourcePath: _sourcePath,
					targetPath: _targetPath,
					contentHash: _contentHash,
					generatedContent: _generatedContent,
					...item
				}) => item,
			),
		};
	}

	listSubagentConfigs(cwd: string): SubagentConfig[] {
		return discoverAgentDefinitions(canonicalDirectory(cwd), this.agentDir).definitions.map((definition) => ({
			name: definition.name,
			description: definition.description,
			scope: definition.scope,
			...(definition.tags ? { tags: definition.tags } : {}),
			...(definition.icon ? { icon: definition.icon } : {}),
			...(definition.provider ? { provider: definition.provider } : {}),
			...(definition.model ? { model: definition.model } : {}),
			...(definition.thinkingLevel ? { thinkingLevel: definition.thinkingLevel } : {}),
			...(definition.tools ? { tools: definition.tools } : {}),
			...(definition.skillNames ? { skills: definition.skillNames } : {}),
			content: definition.content,
			editable: definition.editable,
			...(definition.rawContent ? { contentHash: contentHash(definition.rawContent) } : {}),
		}));
	}

	async saveSubagentConfig(
		cwd: string,
		input: {
			scope: "user" | "project";
			originalName?: string;
			name: string;
			description: string;
			icon?: string;
			provider?: string;
			model?: string;
			thinkingLevel?: ThinkingLevel;
			tools?: string[];
			skills?: string[];
			tags?: string[];
			content: string;
			expectedHash?: string;
		},
		onUiRequest: UiRequestHandler,
	): Promise<SubagentConfig[]> {
		const projectRoot = canonicalDirectory(cwd);
		if (input.scope === "project") await this.createTrustedSettings(projectRoot, onUiRequest);
		const root = input.scope === "user" ? canonicalDirectory(this.agentDir) : projectRoot;
		const directory = input.scope === "user" ? join(root, "agents") : join(root, CONFIG_DIR_NAME, "agents");
		mkdirSync(directory, { recursive: true });
		const name = validSubagentName(input.name);
		const originalName = validSubagentName(input.originalName ?? name);
		const originalPath = join(directory, `${originalName}.md`);
		const targetPath = join(directory, `${name}.md`);
		if (existsSync(originalPath)) {
			const currentHash = contentHash(readFileSync(originalPath, "utf8"));
			if (!input.expectedHash || currentHash !== input.expectedHash)
				throw Object.assign(new Error("智能体已被外部修改，请重新加载后再保存"), {
					code: "subagent_conflict",
					retryable: true,
				});
		} else if (input.expectedHash) {
			throw Object.assign(new Error("智能体已被外部删除，请重新加载后再保存"), {
				code: "subagent_conflict",
				retryable: true,
			});
		}
		if (targetPath !== originalPath && existsSync(targetPath))
			throw Object.assign(new Error("同一范围内已存在同名智能体"), { code: "subagent_name_conflict" });
		const description = input.description.trim();
		if (!description) throw Object.assign(new Error("智能体描述不能为空"), { code: "subagent_description_invalid" });
		if (input.provider && !input.model)
			throw Object.assign(new Error("选择供应商后必须选择模型"), { code: "subagent_model_invalid" });
		const rendered = renderSubagentMarkdown({
			name,
			description,
			...(input.icon ? { icon: input.icon } : {}),
			...(input.provider ? { provider: input.provider } : {}),
			...(input.model ? { model: input.model } : {}),
			...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
			...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
			...(input.skills && input.skills.length > 0 ? { skills: input.skills } : {}),
			...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
			content: input.content,
		});
		atomicWriteUtf8(targetPath, rendered);
		if (targetPath !== originalPath && existsSync(originalPath)) unlinkSync(originalPath);
		return this.listSubagentConfigs(projectRoot);
	}

	async deleteSubagentConfig(
		cwd: string,
		input: { scope: "user" | "project"; name: string; expectedHash: string },
		onUiRequest: UiRequestHandler,
	): Promise<SubagentConfig[]> {
		const projectRoot = canonicalDirectory(cwd);
		if (input.scope === "project") await this.createTrustedSettings(projectRoot, onUiRequest);
		const root = input.scope === "user" ? canonicalDirectory(this.agentDir) : projectRoot;
		const directory = input.scope === "user" ? join(root, "agents") : join(root, CONFIG_DIR_NAME, "agents");
		const path = join(directory, `${validSubagentName(input.name)}.md`);
		if (!existsSync(path)) throw Object.assign(new Error("智能体不存在"), { code: "subagent_not_found" });
		const currentHash = contentHash(readFileSync(path, "utf8"));
		if (currentHash !== input.expectedHash)
			throw Object.assign(new Error("智能体已被外部修改，请重新加载后再删除"), {
				code: "subagent_conflict",
				retryable: true,
			});
		unlinkSync(path);
		return this.listSubagentConfigs(projectRoot);
	}

	async importHarnessResources(
		cwd: string,
		itemIds: string[],
		onUiRequest: UiRequestHandler,
	): Promise<HarnessImportResult> {
		const selectedIds = new Set(itemIds);
		const preview = discoverHarnessImports({ cwd, agentDir: this.agentDir });
		if (preview.items.some((item) => selectedIds.has(item.id) && item.sourceScope === "project")) {
			await this.createTrustedSettings(cwd, onUiRequest);
		}
		return importHarnessResources({ cwd, agentDir: this.agentDir, itemIds });
	}

	async listSkills(
		cwd: string,
		onUiRequest: UiRequestHandler,
	): Promise<{ skills: SkillSummary[]; diagnostics: JsonValue }> {
		const { settingsManager } = await this.createTrustedSettings(cwd, onUiRequest);
		const packageManager = new DefaultPackageManager({ cwd, agentDir: this.agentDir, settingsManager });
		const resolved = await packageManager.resolve();
		const skills: SkillSummary[] = [];
		const diagnostics: unknown[] = [];
		for (const resource of resolved.skills) {
			const loaded = loadSkills({
				cwd,
				agentDir: this.agentDir,
				skillPaths: [resource.path],
				includeDefaults: false,
			});
			diagnostics.push(...loaded.diagnostics);
			for (const skill of loaded.skills) {
				skills.push({
					name: skill.name,
					description: skill.description,
					path: resource.path,
					baseDir: skill.baseDir,
					source: resource.metadata.source,
					scope: resource.metadata.scope,
					origin: resource.metadata.origin,
					enabled: resource.enabled,
					disableModelInvocation: skill.disableModelInvocation,
					eligible: resource.metadata.scope === "user" || resource.metadata.scope === "project",
				});
			}
		}
		return { skills, diagnostics: jsonValue(diagnostics) };
	}

	async setSkillEnabled(
		cwd: string,
		path: string,
		scope: "user" | "project",
		enabled: boolean,
		onUiRequest: UiRequestHandler,
	): Promise<{ skills: SkillSummary[]; diagnostics: JsonValue }> {
		const { settingsManager } = await this.createTrustedSettings(cwd, onUiRequest);
		const current =
			scope === "user"
				? (settingsManager.getGlobalSettings().skills ?? [])
				: (settingsManager.getProjectSettings().skills ?? []);
		const next = current.filter((entry) => entry !== `+${path}` && entry !== `-${path}`);
		next.push(`${enabled ? "+" : "-"}${path}`);
		if (scope === "user") settingsManager.setSkillPaths(next);
		else settingsManager.setProjectSkillPaths(next);
		await settingsManager.flush();
		return this.listSkills(cwd, onUiRequest);
	}

	getAbout(): JsonValue {
		return {
			productName: APP_TITLE,
			productVersion: VERSION,
			piVersion: PACKAGE_VERSION,
			hostVersion: HOST_VERSION,
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			releaseRepository: RELEASE_REPOSITORY ?? null,
			agentDir: this.agentDir,
			sessionsDir: join(this.agentDir, "sessions"),
			configDirName: CONFIG_DIR_NAME,
		};
	}

	getChangelog(sessionPath: string, width: number, cwd?: string) {
		const settings = this.settingsForCwd(cwd ?? readSessionSnapshot(sessionPath).header.cwd);
		return renderTerminalRichText({
			text: getFullChangelogMarkdown(),
			width,
			messageType: "custom",
			isStreaming: false,
			themeName: settings.getTheme(),
			mermaidMode: settings.getMermaidRenderingMode(),
			showCodeBlockFences: settings.getShowMarkdownCodeBlockFences(),
			maxLines: 15_000,
			maxBytes: 2 * 1024 * 1024,
		});
	}

	async getDiagnostics(cwd?: string, runtimeDiagnostics?: ToolRecoveryRuntimeDiagnostics): Promise<JsonValue> {
		const report = await getToolRecoveryDoctorReport({
			productName: APP_TITLE,
			productVersion: VERSION,
			runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
			cwd: cwd ?? process.cwd(),
			agentDir: this.agentDir,
			runtimeDiagnostics,
			recoveryMode: getToolRecoveryMode(),
		});
		const { nodeVersion: _runtimeCompatibilityVersion, ...runtimeReport } = report;
		const checks = [
			runtimeEngineCheck(),
			this.nodeToolchain.node
				? {
						id: "node",
						status: "ok",
						message: `用户 Node.js ${this.nodeToolchain.node.version} · ${this.nodeToolchain.node.executable}`,
					}
				: {
						id: "node",
						status: "warning",
						message: "用户环境未检测到 Node.js；Node、npm 和 npx 相关功能不可用",
					},
			...(this.nodeToolchain.npmVersion
				? [{ id: "npm", status: "ok", message: `npm ${this.nodeToolchain.npmVersion}` }]
				: []),
			{ id: "agent-dir", status: existsSync(this.agentDir) ? "ok" : "warning", message: this.agentDir },
			...(cwd ? [{ id: "cwd", status: existsSync(cwd) ? "ok" : "error", message: cwd }] : []),
		];
		return jsonValue({
			...runtimeReport,
			nodeVersion: this.nodeToolchain.node?.version ?? "unavailable",
			checks,
		});
	}

	async getGitStatus(cwd: string, options: { refreshRepositories?: boolean } = {}): Promise<GitStatus> {
		const projectRoot = canonicalDirectory(cwd);
		let topology = options.refreshRepositories ? undefined : this.gitRepositoryRootsCache.get(projectRoot);
		if (!topology) {
			let rootRepository: string | undefined;
			try {
				const detectedRoot = canonicalDirectory((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
				if (isInside(projectRoot, detectedRoot)) rootRepository = detectedRoot;
			} catch {
				// 当前目录可以是包含多个独立仓库的工作目录。
			}
			topology = {
				rootRepository,
				repositoryRoots: await discoverGitRepositoryRoots(projectRoot, rootRepository),
			};
			this.gitRepositoryRootsCache.set(projectRoot, topology);
		}
		let statuses: GitStatus[];
		try {
			statuses = await Promise.all(
				topology.repositoryRoots.map(async (repositoryRootPath) => {
					const status = parseGitStatus(
						repositoryRootPath,
						await git(repositoryRootPath, [
							"status",
							"--porcelain=v2",
							"--branch",
							"-z",
							"--untracked-files=all",
						]),
					);
					return (await gitMergeInProgress(repositoryRootPath)) ? { ...status, merging: true } : status;
				}),
			);
		} catch (error) {
			if (!options.refreshRepositories) {
				this.gitRepositoryRootsCache.delete(projectRoot);
				return this.getGitStatus(projectRoot, { refreshRepositories: true });
			}
			throw error;
		}
		const primary =
			statuses.find((status) => status.root === topology.rootRepository) ??
			statuses.slice().sort((left, right) => left.root.localeCompare(right.root))[0];
		if (!primary) throw Object.assign(new Error("未找到 Git 仓库"), { code: "git_not_repository" });
		const repositories = statuses
			.map((status) => gitRepositoryStatus(status, projectRoot, topology.rootRepository))
			.sort(
				(left, right) =>
					Number(right.kind === "root") - Number(left.kind === "root") || left.path.localeCompare(right.path),
			);
		return { ...primary, repositories };
	}

	async getGitDiff(cwd: string, path: string | undefined, staged: boolean, repositoryPath?: string): Promise<GitDiff> {
		const projectRoot = canonicalDirectory(cwd);
		const repositoryRoot = await resolveGitRepositoryRoot(projectRoot, repositoryPath);
		if (path) assertGitFilePath(repositoryRoot, path);
		const args = ["diff", "--no-ext-diff", "--unified=3"];
		if (staged) args.push("--cached");
		if (path) args.push("--", path);
		const diff = await git(repositoryRoot, args);
		let additions = 0;
		let deletions = 0;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) additions++;
			else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
		}
		const result: GitDiff = {
			...(path ? { path } : {}),
			...(repositoryPath ? { repositoryPath: repositoryPathFromRoot(projectRoot, repositoryRoot) } : {}),
			staged,
			diff,
			additions,
			deletions,
		};
		if (!path) return result;
		const original = await readGitRevisionContent(repositoryRoot, staged ? "HEAD" : "", path);
		const modified = staged
			? await readGitRevisionContent(repositoryRoot, "", path)
			: readWorkingTreeGitContent(repositoryRoot, path);
		if (original === undefined || modified === undefined) return { ...result, contentTruncated: true };
		return { ...result, original, modified };
	}

	async getGitStats(cwd: string, repositoryPath?: string): Promise<GitStats> {
		const projectRoot = canonicalDirectory(cwd);
		const repositoryRoot = await resolveGitRepositoryRoot(projectRoot, repositoryPath);
		const [worktree, staged] = await Promise.all([
			git(repositoryRoot, ["diff", "--numstat", "-z", "--find-renames"]),
			git(repositoryRoot, ["diff", "--cached", "--numstat", "-z", "--find-renames"]),
		]);
		return {
			repositoryPath: repositoryPathFromRoot(projectRoot, repositoryRoot),
			files: [...parseGitNumStats(worktree, false), ...parseGitNumStats(staged, true)],
		};
	}

	async getGitBranches(cwd: string, repositoryPath?: string): Promise<GitBranches> {
		const projectRoot = canonicalDirectory(cwd);
		const repositoryRoot = await resolveGitRepositoryRoot(projectRoot, repositoryPath);
		const [current, hasHead, merging, remotesOutput, branchesOutput] = await Promise.all([
			currentGitBranch(repositoryRoot),
			gitHasHead(repositoryRoot),
			gitMergeInProgress(repositoryRoot),
			git(repositoryRoot, ["remote"]),
			git(repositoryRoot, [
				"for-each-ref",
				"--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(objectname)%00",
				"refs/heads",
				"refs/remotes",
			]),
		]);
		const branches = branchesOutput
			.split("\n")
			.flatMap((row) => {
				if (!row) return [];
				const [refname, name, head, upstream, tracking, commit] = row.split("\0");
				if (!refname || !name || !commit || refname.endsWith("/HEAD")) return [];
				const remote = refname.startsWith("refs/remotes/");
				return [
					{
						name,
						current: head.trim() === "*",
						remote,
						...(upstream ? { upstream } : {}),
						...parseGitTracking(tracking ?? ""),
						commit,
					},
				];
			})
			.sort(
				(left, right) =>
					Number(right.current) - Number(left.current) ||
					Number(left.remote) - Number(right.remote) ||
					left.name.localeCompare(right.name),
			);
		return {
			repositoryPath: repositoryPathFromRoot(projectRoot, repositoryRoot),
			...(current ? { current } : {}),
			detached: !current && hasHead,
			merging,
			remotes: remotesOutput
				.split("\n")
				.map((remote) => remote.trim())
				.filter(Boolean),
			branches,
		};
	}

	async getGitHistory(cwd: string, offset: number, limit: number, repositoryPath?: string): Promise<GitHistory> {
		const projectRoot = canonicalDirectory(cwd);
		const repositoryRoot = await resolveGitRepositoryRoot(projectRoot, repositoryPath);
		const resolvedRepositoryPath = repositoryPathFromRoot(projectRoot, repositoryRoot);
		if (!(await gitHasHead(repositoryRoot))) {
			return { repositoryPath: resolvedRepositoryPath, offset, commits: [], hasMore: false };
		}
		const commits = parseGitHistory(
			await git(repositoryRoot, [
				"log",
				"-z",
				`--skip=${offset}`,
				`--max-count=${limit + 1}`,
				"--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%P",
			]),
		);
		const hasMore = commits.length > limit;
		const page = commits.slice(0, limit);
		return {
			repositoryPath: resolvedRepositoryPath,
			offset,
			commits: page,
			...(hasMore ? { nextOffset: offset + page.length } : {}),
			hasMore,
		};
	}

	async getGitCommit(cwd: string, revision: string, repositoryPath?: string, path?: string): Promise<GitCommit> {
		assertGitRevision(revision);
		const projectRoot = canonicalDirectory(cwd);
		const repositoryRoot = await resolveGitRepositoryRoot(projectRoot, repositoryPath);
		if (path) assertGitFilePath(repositoryRoot, path);
		const fields = (
			await git(repositoryRoot, [
				"show",
				"-s",
				"-z",
				"--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%B%x00%P",
				revision,
			])
		).split("\0");
		const hash = fields[0];
		if (!hash || fields.length < 11) {
			throw Object.assign(new Error("未找到 Git 提交"), { code: "git_commit_not_found", retryable: false });
		}
		const parents = (fields[10] ?? "").split(" ").filter(Boolean);
		const firstParent = parents[0];
		const fileStats = parseGitNumStats(
			firstParent
				? await git(repositoryRoot, ["diff", "--numstat", "-z", "--find-renames", firstParent, hash])
				: await git(repositoryRoot, [
						"diff-tree",
						"--root",
						"--no-commit-id",
						"-r",
						"--numstat",
						"-z",
						"--find-renames",
						hash,
					]),
			false,
		);
		const files = fileStats.map(({ staged: _staged, ...file }) => file);
		let diff: GitDiff | undefined;
		if (path) {
			const file = files.find((candidate) => candidate.path === path);
			const patch = firstParent
				? await git(repositoryRoot, [
						"diff",
						"--no-ext-diff",
						"--unified=3",
						"--find-renames",
						firstParent,
						hash,
						"--",
						path,
					])
				: await git(repositoryRoot, [
						"show",
						"--format=",
						"--no-ext-diff",
						"--unified=3",
						"--find-renames",
						hash,
						"--",
						path,
					]);
			const original = firstParent
				? await readGitRevisionContent(repositoryRoot, firstParent, file?.originalPath ?? path)
				: "";
			const modified = await readGitRevisionContent(repositoryRoot, hash, path);
			diff = {
				path,
				repositoryPath: repositoryPathFromRoot(projectRoot, repositoryRoot),
				staged: false,
				revision: hash,
				diff: patch,
				additions: file?.additions ?? 0,
				deletions: file?.deletions ?? 0,
				...(original === undefined || modified === undefined ? { contentTruncated: true } : { original, modified }),
			};
		}
		return {
			repositoryPath: repositoryPathFromRoot(projectRoot, repositoryRoot),
			hash,
			shortHash: fields[1] ?? hash.slice(0, 7),
			authorName: fields[2] ?? "",
			authorEmail: fields[3] ?? "",
			authoredAt: fields[4] ?? "",
			committerName: fields[5] ?? "",
			committerEmail: fields[6] ?? "",
			committedAt: fields[7] ?? "",
			subject: fields[8] ?? "",
			body: fields[9] ?? "",
			parents,
			files,
			...(diff ? { diff } : {}),
		};
	}

	async mutateGit(
		cwd: string,
		repositoryPath: string | undefined,
		mutation: GitMutation,
		signal?: AbortSignal,
	): Promise<GitMutationResult> {
		const projectRoot = canonicalDirectory(cwd);
		const repositoryRoot = await resolveGitRepositoryRoot(projectRoot, repositoryPath);
		const resolvedRepositoryPath = repositoryPathFromRoot(projectRoot, repositoryRoot);
		let message: string;
		switch (mutation.type) {
			case "stage":
				for (const path of mutation.paths) assertGitFilePath(repositoryRoot, path);
				await gitWrite(repositoryRoot, ["add", "--", ...mutation.paths], signal);
				message = `已暂存 ${mutation.paths.length} 个文件`;
				break;
			case "unstage":
				for (const path of mutation.paths) assertGitFilePath(repositoryRoot, path);
				await gitWrite(repositoryRoot, ["reset", "--quiet", "--", ...mutation.paths], signal);
				message = `已取消暂存 ${mutation.paths.length} 个文件`;
				break;
			case "discard": {
				for (const path of mutation.paths) assertGitFilePath(repositoryRoot, path);
				const status = parseGitStatus(
					repositoryRoot,
					await git(repositoryRoot, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
				);
				const untrackedPaths = new Set(status.files.filter((file) => file.untracked).map((file) => file.path));
				const tracked = mutation.paths.filter((path) => !untrackedPaths.has(path));
				const untracked = mutation.paths.filter((path) => untrackedPaths.has(path));
				if (tracked.length > 0) await gitWrite(repositoryRoot, ["restore", "--worktree", "--", ...tracked], signal);
				if (untracked.length > 0) await gitWrite(repositoryRoot, ["clean", "-f", "--", ...untracked], signal);
				message = `已恢复 ${mutation.paths.length} 个文件`;
				break;
			}
			case "commit": {
				const commitMessage = mutation.message.trim();
				if (!commitMessage)
					throw Object.assign(new Error("提交说明不能为空"), { code: "git_commit_message_required" });
				await gitWrite(repositoryRoot, ["commit", "-m", commitMessage], signal);
				const shortHash = (await git(repositoryRoot, ["rev-parse", "--short", "HEAD"])).trim();
				message = `已提交 ${shortHash}`;
				break;
			}
			case "fetch":
				await gitWrite(repositoryRoot, ["fetch"], signal);
				message = "已获取远端更新";
				break;
			case "pull":
				await gitWrite(repositoryRoot, ["pull", "--ff-only"], signal);
				message = "已快进拉取远端更新";
				break;
			case "push": {
				let upstream: string | undefined;
				try {
					upstream = (
						await git(repositoryRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
					).trim();
				} catch {
					upstream = undefined;
				}
				if (upstream) {
					await gitWrite(repositoryRoot, ["push"], signal);
				} else {
					const branch = await currentGitBranch(repositoryRoot);
					if (!branch)
						throw Object.assign(new Error("Detached HEAD 不能直接推送"), {
							code: "git_detached_head",
							retryable: false,
						});
					const remotes = (await git(repositoryRoot, ["remote"]))
						.split("\n")
						.map((remote) => remote.trim())
						.filter(Boolean);
					const remote = remotes[0];
					if (!remote || remotes.length !== 1) {
						throw Object.assign(new Error("当前分支没有上游，且无法确定唯一远端"), {
							code: "git_upstream_required",
							retryable: false,
						});
					}
					await gitWrite(repositoryRoot, ["push", "--set-upstream", remote, branch], signal);
				}
				message = "已推送当前分支";
				break;
			}
			case "create_branch": {
				const name = await validateGitBranchName(repositoryRoot, mutation.name);
				await gitWrite(repositoryRoot, ["switch", "-c", name], signal);
				message = `已创建并切换到 ${name}`;
				break;
			}
			case "switch_branch": {
				const name = await validateGitBranchName(repositoryRoot, mutation.name);
				await gitWrite(repositoryRoot, ["switch", name], signal);
				message = `已切换到 ${name}`;
				break;
			}
			case "delete_branch": {
				const name = await validateGitBranchName(repositoryRoot, mutation.name);
				await gitWrite(repositoryRoot, ["branch", "-d", name], signal);
				message = `已删除分支 ${name}`;
				break;
			}
			case "merge": {
				const source = await validateGitBranchName(repositoryRoot, mutation.source);
				await gitWrite(repositoryRoot, ["merge", "--no-edit", "--", source], signal);
				message = `已合并 ${source}`;
				break;
			}
			case "abort_merge":
				await gitWrite(repositoryRoot, ["merge", "--abort"], signal);
				message = "已中止合并";
				break;
		}
		return {
			repositoryPath: resolvedRepositoryPath,
			action: mutation.type,
			message,
			status: await this.getGitStatus(projectRoot),
		};
	}

	async checkForUpdates(): Promise<JsonValue> {
		const base = {
			currentVersion: VERSION,
			checkedAt: Date.now(),
			repository: RELEASE_REPOSITORY ?? null,
			installEnabled: false,
			installBlockedReason: "正式 Tauri updater 公钥尚未配置，当前只支持检查版本。",
		};
		if (process.env.PI_OFFLINE) return { ...base, status: "offline", latestVersion: null, url: null };
		try {
			const release = await getLatestPiRelease(VERSION, { repository: RELEASE_REPOSITORY, retry: true });
			return {
				...base,
				status: release
					? isNewerPackageVersion(release.version, VERSION)
						? "available"
						: "current"
					: "unavailable",
				latestVersion: release?.version ?? null,
				packageName: release?.packageName ?? null,
				note: release?.note ?? null,
				url:
					release && RELEASE_REPOSITORY
						? `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${release.version}`
						: null,
			};
		} catch (error) {
			throw Object.assign(new Error(formatVersionCheckError(error)), {
				code: "update_check_failed",
				retryable: true,
			});
		}
	}

	listSettings(sessionPath: string): SettingSummary[] {
		const snapshot = readSessionSnapshot(sessionPath);
		const settings = this.settingsForCwd(snapshot.header.cwd);
		return getLystarSettingsForUi().map((setting) => settingSummary(setting.id, settings, getBuiltinThemeNames()));
	}

	getSessionTree(sessionPath: string): SessionTreeNode[] {
		const snapshot = readSessionSnapshot(sessionPath);
		return sessionTree(snapshot.entries, snapshot.leafId);
	}

	listSubagents(sessionPath: string): SubagentSnapshot[] {
		return transcriptSubagents(readSessionSnapshot(sessionPath).entries).sort(
			(left, right) =>
				right.updatedAt - left.updatedAt ||
				left.runId.localeCompare(right.runId) ||
				left.agentId.localeCompare(right.agentId),
		);
	}

	readSubagent(sessionPath: string, agentId: string): { transcript?: SubagentSnapshot } {
		const transcript = this.listSubagents(sessionPath).find((snapshot) => snapshot.agentId === agentId);
		return transcript ? { transcript } : {};
	}

	getProjectTrust(cwd: string): ProjectTrust {
		const root = canonicalDirectory(cwd);
		const trusted = new ProjectTrustStore(this.agentDir).get(root);
		const resourceRisk = hasTrustRequiringProjectResources(root);
		return {
			cwd: root,
			trusted,
			resourceRisk,
			reason: resourceRisk
				? trusted === true
					? "项目资源已信任"
					: trusted === false
						? "项目资源被明确设为不信任"
						: "项目包含需信任资源，尚未选择"
				: "项目没有需信任资源",
		};
	}

	getProjectTrustDecision(cwd: string): boolean | null {
		const root = canonicalDirectory(cwd);
		const entry = new ProjectTrustStore(this.agentDir).getEntry(root);
		return entry?.path === root ? entry.decision : null;
	}

	async setProjectTrust(cwd: string, trusted: boolean | null): Promise<ProjectTrust> {
		const root = canonicalDirectory(cwd);
		new ProjectTrustStore(this.agentDir).set(root, trusted);
		return this.getProjectTrust(root);
	}

	listPackages(cwd: string): PackageSummary[] {
		const root = canonicalDirectory(cwd);
		return new DefaultPackageManager({
			cwd: root,
			agentDir: this.agentDir,
			settingsManager: this.settingsForCwd(root),
		}).listConfiguredPackages();
	}

	async installPackage(
		cwd: string,
		source: string,
		scope: "user" | "project",
	): Promise<{ changed: boolean; message: string }> {
		const root = canonicalDirectory(cwd);
		await new DefaultPackageManager({
			cwd: root,
			agentDir: this.agentDir,
			settingsManager: this.settingsForCwd(root),
		}).installAndPersist(source, { local: scope === "project" });
		return { changed: true, message: `已安装 ${source}` };
	}

	async removePackage(
		cwd: string,
		source: string,
		scope: "user" | "project",
	): Promise<{ changed: boolean; message: string }> {
		const root = canonicalDirectory(cwd);
		const changed = await new DefaultPackageManager({
			cwd: root,
			agentDir: this.agentDir,
			settingsManager: this.settingsForCwd(root),
		}).removeAndPersist(source, { local: scope === "project" });
		return { changed, message: changed ? `已移除 ${source}` : `未找到 ${source}` };
	}

	async updatePackages(cwd: string, source?: string): Promise<{ changed: boolean; message: string }> {
		const root = canonicalDirectory(cwd);
		if (process.env.PI_OFFLINE)
			throw Object.assign(new Error("离线模式下不能更新包"), { code: "offline", retryable: false });
		await new DefaultPackageManager({
			cwd: root,
			agentDir: this.agentDir,
			settingsManager: this.settingsForCwd(root),
		}).update(source);
		return { changed: true, message: source ? `已更新 ${source}` : "已更新配置包" };
	}

	readProjectImage(cwd: string, path: string): ReadProjectImageResult {
		const resolved = canonicalProjectFile(cwd, path);
		const stat = statSync(resolved.path);
		if (stat.size > 4 * 1024 * 1024)
			throw Object.assign(new Error("图片超过 4 MiB 限制"), { code: "image_too_large", retryable: false });
		const bytes = new Uint8Array(readFileSync(resolved.path));
		const mimeType = imageMimeType(bytes);
		if (!mimeType)
			throw Object.assign(new Error("目标不是支持的图片"), { code: "image_type_unsupported", retryable: false });
		return {
			mimeType,
			base64: Buffer.from(bytes).toString("base64"),
			byteLength: bytes.length,
			contentHash: contentHash(bytes),
		};
	}

	async readClipboardImage(): Promise<ClipboardImageReadResult> {
		const image = await readClipboardImage();
		if (!image) return { capability: true, available: false };
		if (image.bytes.length > 4 * 1024 * 1024)
			throw Object.assign(new Error("剪贴板图片超过 4 MiB 限制"), { code: "image_too_large", retryable: false });
		const mimeType = imageMimeType(image.bytes);
		if (!mimeType)
			throw Object.assign(new Error("剪贴板图片类型不受支持"), { code: "image_type_unsupported", retryable: false });
		return {
			capability: true,
			available: true,
			mimeType,
			data: Buffer.from(image.bytes).toString("base64"),
			byteLength: image.bytes.length,
			contentHash: contentHash(image.bytes),
		};
	}

	async readClipboardText(): Promise<{ capability: boolean; text?: string }> {
		const text = await readClipboardText();
		return { capability: true, ...(text ? { text } : {}) };
	}

	async writeClipboardText(text: string): Promise<{ capability: boolean; changed: boolean }> {
		await copyToClipboard(text);
		return { capability: true, changed: true };
	}

	renderRichText(sessionPath: string, request: RichTextRenderRequest) {
		const snapshot = readSessionSnapshot(sessionPath);
		const settings = this.settingsForCwd(snapshot.header.cwd);
		return renderTerminalRichText({
			...request,
			themeName: settings.getTheme(),
			mermaidMode: settings.getMermaidRenderingMode(),
			showCodeBlockFences: settings.getShowMarkdownCodeBlockFences(),
		});
	}

	private settingsForCwd(cwd: string): SettingsManager {
		const trustStore = new ProjectTrustStore(this.agentDir);
		return SettingsManager.create(cwd, this.agentDir, {
			projectTrusted: !hasTrustRequiringProjectResources(cwd) || trustStore.get(cwd) === true,
		});
	}

	private async createRuntime(
		cwd: string,
		sessionManager: SessionManager,
		onUiRequest: UiRequestHandler,
		sessionProfile?: SessionProfile,
		readOnly = false,
		deferExtensionLifecycle = false,
	): Promise<RuntimeSession> {
		const trustStore = new ProjectTrustStore(this.agentDir);
		const stepController = new AgentStepController(sessionManager);
		const defaultCreateRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd: runtimeCwd,
			agentDir,
			sessionManager: runtimeSessionManager,
			sessionStartEvent,
			projectTrustContext,
			sessionProfile: runtimeSessionProfile,
			deferExtensionLifecycle: deferRuntimeExtensionLifecycle,
		}) => {
			const effectiveProfile =
				runtimeSessionProfile ?? sessionProfileFromHeader(runtimeSessionManager, runtimeCwd, agentDir);
			const activeTools = readOnly
				? [...new Set([...(effectiveProfile?.tools ?? ["read"]), ...READ_ONLY_SESSION_TOOLS])].filter((tool) =>
						READ_ONLY_SESSION_TOOLS.includes(tool as (typeof READ_ONLY_SESSION_TOOLS)[number]),
					)
				: effectiveProfile?.tools;
			const hasTrustResources = hasTrustRequiringProjectResources(runtimeCwd);
			const trusted = !hasTrustResources || trustStore.get(runtimeCwd) === true;
			const settingsManager = SettingsManager.create(runtimeCwd, agentDir, { projectTrusted: trusted });
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				settingsManager,
				modelRuntimeSignal: AbortSignal.timeout(15_000),
				resourceLoaderOptions: {
					extensionFactories: builtInExtensions,
					...(runtimeSessionManager.getHeader()?.roomAgent ? { excludeUserAgentsFile: true } : {}),
					...(effectiveProfile
						? {
								agentsFilesOverride: (base) => ({
									agentsFiles: [
										...base.agentsFiles,
										...(effectiveProfile.agentsInstructions
											? [
													{
														path: `${effectiveProfile.sourcePath}/AGENTS.md`,
														content: effectiveProfile.agentsInstructions,
													},
												]
											: []),
									],
								}),
								appendSystemPromptOverride: (base) => [
									...base,
									...(effectiveProfile.systemPrompt ? [effectiveProfile.systemPrompt] : []),
								],
								skillsOverride: (base) =>
									effectiveProfile.skillNames
										? {
												...base,
												skills: base.skills.filter((skill) =>
													effectiveProfile.skillNames?.includes(skill.name),
												),
											}
										: base,
							}
						: {}),
				},
				resourceLoaderReloadOptions:
					hasTrustResources && trustStore.get(runtimeCwd) === null
						? {
								resolveProjectTrust: async ({ extensionsResult }) =>
									resolveProjectTrusted({
										cwd: runtimeCwd,
										trustStore,
										defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
										extensionsResult,
										projectTrustContext: projectTrustContext ?? {
											cwd: runtimeCwd,
											mode: "rpc",
											hasUI: true,
											ui: createUiContext(onUiRequest),
										},
									}),
							}
						: undefined,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: runtimeSessionManager,
					sessionStartEvent,
					deferExtensionLifecycle: deferRuntimeExtensionLifecycle,
					model: resolveProfileModel(effectiveProfile, services.modelRuntime),
					thinkingLevel: effectiveProfile?.thinkingLevel,
					...(activeTools ? { tools: activeTools } : {}),
					customTools: [
						...createAgentStepTools(stepController),
						createSessionsTool(() => this.sessionCoordinator),
					],
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const projectTrustContext: ProjectTrustContext = {
			cwd,
			mode: "rpc",
			hasUI: true,
			ui: createUiContext(onUiRequest),
		};
		const runtime = await createAgentSessionRuntime(this.createRuntimeFactory ?? defaultCreateRuntime, {
			cwd,
			agentDir: this.agentDir,
			sessionManager,
			projectTrustContext,
			sessionProfile,
			deferExtensionLifecycle,
		});
		this.stepControllers.set(runtime, stepController);
		return this.wrapRuntime(runtime, onUiRequest);
	}

	private takeInitialRuntime(sessionPath: string): AgentSessionRuntime | undefined {
		const runtime = this.initialRuntime;
		const runtimePath = runtime?.session.sessionFile;
		if (!runtime || !runtimePath || resolve(runtimePath) !== resolve(sessionPath)) return undefined;
		this.initialRuntime = undefined;
		this.initialRuntimeClaimed = true;
		return runtime;
	}

	private async wrapRuntime(runtime: AgentSessionRuntime, onUiRequest: UiRequestHandler): Promise<RuntimeSession> {
		const stepController =
			this.stepControllers.get(runtime) ?? new AgentStepController(runtime.session.sessionManager);
		const wrapped = new CoreRuntimeSession(runtime, onUiRequest, this.agentDir, stepController);
		try {
			await wrapped.bind();
			return wrapped;
		} catch (error) {
			try {
				await wrapped.dispose();
			} catch (disposeError) {
				throw new AggregateError([error, disposeError], "Runtime 绑定失败且清理未完成");
			}
			throw error;
		}
	}

	private getModelRuntime(): Promise<ModelRuntime> {
		this.modelRuntimePromise ??= ModelRuntime.create({
			authPath: join(this.agentDir, "auth.json"),
			modelsPath: join(this.agentDir, "models.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		return this.modelRuntimePromise;
	}

	private async createTrustedSettings(
		cwd: string,
		onUiRequest: UiRequestHandler,
	): Promise<{ settingsManager: SettingsManager }> {
		const trustStore = new ProjectTrustStore(this.agentDir);
		const hasTrustResources = hasTrustRequiringProjectResources(cwd);
		let trusted = !hasTrustResources || trustStore.get(cwd) === true;
		const settingsManager = SettingsManager.create(cwd, this.agentDir, { projectTrusted: trusted });
		if (hasTrustResources && trustStore.get(cwd) === null) {
			trusted = await resolveProjectTrusted({
				cwd,
				trustStore,
				defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
				projectTrustContext: { cwd, mode: "rpc", hasUI: true, ui: createUiContext(onUiRequest) },
			});
			settingsManager.setProjectTrusted(trusted);
			await settingsManager.reload();
		}
		return { settingsManager };
	}
}
