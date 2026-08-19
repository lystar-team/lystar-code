import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	type Dirent,
	existsSync,
	fsyncSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
	type AgentSessionEvent,
	APP_TITLE,
	type AuthEvent,
	type AuthPrompt,
	abortSubagent,
	CONFIG_DIR_NAME,
	type CreateAgentSessionRuntimeFactory,
	continueSubagentSession,
	copyToClipboard,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	DefaultPackageManager,
	type ExtensionCommandContextActions,
	type ExtensionUIContext,
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
	isNewerPackageVersion,
	loadProjectContextFiles,
	loadSkills,
	ModelConfig,
	ModelRuntime,
	PACKAGE_VERSION,
	ProjectTrustStore,
	RELEASE_REPOSITORY,
	readClipboardImage,
	readClipboardText,
	readSessionSnapshot,
	renderTerminalRichText,
	resolveProjectTrusted,
	type SessionEntry,
	SessionManager,
	SettingsManager,
	type SubagentDetails,
	type SubagentRunSnapshot,
	saveModelsJsonModel,
	saveModelsJsonProvider,
	VERSION,
} from "@earendil-works/pi-coding-agent/core";
import type {
	AuthType,
	ClipboardImageReadResult,
	CompletionItem,
	CompletionResult,
	ContentChunk,
	GitDiff,
	GitFileStatus,
	GitStatus,
	HostDirectoryListing,
	JsonValue,
	ModelRef,
	PackageSummary,
	ProjectInstruction,
	ProjectResource,
	ProjectTrust,
	ReadProjectImageResult,
	SessionInfoResult,
	SessionProgress,
	SessionStateSnapshot,
	SessionTreeNode,
	SettingSummary,
	SubagentSnapshot,
	ThinkingLevel,
	ToolDiff,
	TranscriptItem,
} from "@lystar/code-gui-protocol";
import { GUI_PROTOCOL_VERSION } from "@lystar/code-gui-protocol";
import { ExtensionUiBridge } from "./extension-ui-bridge.ts";
import type {
	ModelProviderInput,
	ModelProviderSummary,
	ModelSummary,
	ProviderModelInput,
	RichTextRenderRequest,
	RuntimeAdapter,
	RuntimeEvent,
	RuntimeSession,
	SessionSummaryBase,
	SkillSummary,
	ToolRecoveryRuntimeDiagnostics,
	UiRequest,
	UiRequestHandler,
} from "./types.ts";

function readHostVersion(): string | undefined {
	for (const path of [
		join(dirname(process.execPath), "gui-host-package.json"),
		new URL("../package.json", import.meta.url),
	]) {
		try {
			const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
			if (typeof value.version === "string") return value.version;
		} catch {}
	}
	return undefined;
}

const HOST_VERSION = process.env.PI_GUI_HOST_VERSION ?? readHostVersion() ?? "0.0.0";
const execFileAsync = promisify(execFile);
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PROJECT_RESOURCE_MAX_BYTES = 32 * 1024 * 1024;
const PROJECT_INSTRUCTION_NAMES = ["AGENTS.override.md", "AGENTS.md"] as const;
const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
	".bmp": "image/bmp",
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

function contentHash(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
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

function atomicWriteUtf8(path: string, content: string): void {
	const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let file: number | undefined;
	try {
		file = openSync(temporaryPath, "wx");
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

function fileMimeType(path: string): { kind: "text" | "image"; mimeType: string } {
	const imageMimeType = IMAGE_MIME_TYPES[extname(path).toLowerCase()];
	if (imageMimeType) return { kind: "image", mimeType: imageMimeType };
	const file = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(Math.min(8192, statSync(path).size));
		const bytesRead = readSync(file, buffer, 0, buffer.length, 0);
		if (buffer.subarray(0, bytesRead).includes(0)) {
			throw Object.assign(new Error("只支持打开文本文件和常见图片"), { code: "resource_type_unsupported" });
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
		const result = await execFileAsync("git", ["-C", cwd, ...args], {
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

function parseGitStatus(root: string, output: string): GitStatus {
	const records = output.split("\0");
	const files: GitFileStatus[] = [];
	let branch: string | undefined;
	let upstream: string | undefined;
	let ahead = 0;
	let behind = 0;
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;
		if (record.startsWith("# branch.head ")) {
			const value = record.slice(14);
			if (value !== "(detached)") branch = value;
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
	return { root, ...(branch ? { branch } : {}), ...(upstream ? { upstream } : {}), ahead, behind, files };
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
	const stack = roots
		.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
		.map((entry) => ({ entry, depth: 0 }));
	while (stack.length > 0) {
		const { entry, depth } = stack.pop()!;
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
		const descendants = children.get(entry.id) ?? [];
		for (const child of descendants.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))) {
			stack.push({ entry: child, depth: depth + 1 });
		}
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
				throw new Error("LYStar GUI 后台不支持 TUI 组件式小部件");
			}
			void request("notify", key, {
				method: "setWidget",
				key,
				lines: content ?? null,
				placement: options?.placement ?? "aboveEditor",
			});
		},
		setFooter: (factory) => {
			if (factory) throw new Error("LYStar GUI 后台不支持自定义 TUI 页脚");
		},
		setHeader: (factory) => {
			if (factory) throw new Error("LYStar GUI 后台不支持自定义 TUI 页眉");
		},
		setTitle: (title) => {
			void request("notify", title, { method: "setTitle", title });
		},
		custom: async () => {
			throw new Error("LYStar GUI 后台不支持自定义 TUI 组件");
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
			if (factory) throw new Error("LYStar GUI 后台不支持自定义 TUI 编辑器");
		},
		getEditorComponent: () => undefined,
		get theme() {
			return undefined as never;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "主题切换由 GUI 管理" }),
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

function notifyAuthEvent(onUiRequest: UiRequestHandler, event: AuthEvent): void {
	void onUiRequest({
		id: randomUUID(),
		kind: "notify",
		title: "模型认证",
		payload: jsonValue({ method: `auth_${event.type}`, ...event }),
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

function toolRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function toolPath(value: unknown): string | undefined {
	const record = toolRecord(value);
	const path = record?.path ?? record?.file_path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

function toolNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function diffText(value: unknown): { text?: string; truncated?: boolean } {
	if (typeof value === "string") {
		const text = truncateWithoutSplittingSurrogate(value, 16 * 1024);
		return { text, ...(text.length < value.length ? { truncated: true } : {}) };
	}
	return {};
}

function isDiffTool(name: string): boolean {
	return name === "edit" || name === "write" || name === "apply_patch";
}

function toolProgressDiff(name: string, args: unknown, result?: unknown): ToolDiff | undefined {
	if (!isDiffTool(name)) return undefined;
	const details = toolRecord(toolRecord(result)?.details);
	if (!details) {
		const path = name === "edit" || name === "write" ? toolPath(args) : undefined;
		return path ? { files: [{ path }] } : undefined;
	}
	if (name === "apply_patch") {
		if (!Array.isArray(details.files)) return undefined;
		const files = details.files.flatMap((value) => {
			const file = toolRecord(value);
			if (!file) return [];
			const diff = diffText(file.diff);
			const path = toolPath(file);
			const additions = toolNumber(file.additions);
			const deletions = toolNumber(file.deletions);
			const operation = typeof file.operation === "string" ? file.operation : undefined;
			if (!path && additions === undefined && deletions === undefined && !diff.text) return [];
			return [
				{
					...(path ? { path } : {}),
					...(operation ? { operation } : {}),
					...(additions === undefined ? {} : { additions }),
					...(deletions === undefined ? {} : { deletions }),
					...(diff.text === undefined ? {} : { diff: diff.text }),
					...(diff.truncated ? { truncated: true } : {}),
				},
			];
		});
		return files.length > 0 ? { files } : undefined;
	}
	const path = toolPath(args);
	const additions = toolNumber(details.additions);
	const deletions = toolNumber(details.deletions);
	const operation = typeof details.operation === "string" ? details.operation : undefined;
	const diff = diffText(details.diff);
	if (!path && additions === undefined && deletions === undefined && !operation && !diff.text) {
		return undefined;
	}
	return {
		files: [
			{
				...(path ? { path } : {}),
				...(operation ? { operation } : {}),
				...(additions === undefined ? {} : { additions }),
				...(deletions === undefined ? {} : { deletions }),
				...(diff.text === undefined ? {} : { diff: diff.text }),
				...(diff.truncated ? { truncated: true } : {}),
			},
		],
	};
}

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
	switch (event.type) {
		case "message_update": {
			const updates: SessionProgress[] = [];
			const stream = event.assistantMessageEvent;
			if (stream.type === "text_delta") updates.push({ type: "assistant_delta", text: stream.delta });
			else if (stream.type === "thinking_delta") updates.push({ type: "thinking_delta", text: stream.delta });
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
			return [{ type: "status", status: boundedStatus(event.type) }];
	}
}

function contentImages(images?: Array<{ data: string; mimeType: string }>) {
	return images?.map((image) => ({ type: "image" as const, ...image }));
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
	private readonly extensionUi: ExtensionUiBridge;
	private unsubscribe?: () => void;
	private stateRevision = 0;
	private committedEntryCount = 0;
	private lastTranscriptGeneration?: string;
	private lastTranscriptRevision = 0;
	private disposed = false;

	constructor(
		runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>,
		onUiRequest: UiRequestHandler,
		agentDir: string,
	) {
		this.runtime = runtime;
		this.extensionUi = new ExtensionUiBridge(
			onUiRequest,
			(event) => this.emit({ type: "extension_ui", payload: jsonValue(event) }),
			(error) =>
				this.runtime.session.extensionRunner.emitError({
					extensionPath: "rust-extension-ui",
					event: error.event,
					error: error.error,
					...(error.stack ? { stack: error.stack } : {}),
				}),
			(text, cursor) => this.getCompletions(text, cursor),
			agentDir,
		);
	}

	get sessionPath(): string {
		const path = this.runtime.session.sessionFile;
		if (!path) throw new Error("GUI 后台要求会话已经持久化");
		return path;
	}

	async bind(): Promise<void> {
		const storage = sessionGeneration(this.sessionPath, this.runtime.session.sessionId);
		this.committedEntryCount = this.runtime.session.sessionManager.getEntries().length;
		this.lastTranscriptGeneration = storage.generation;
		this.lastTranscriptRevision = storage.revision;
		this.runtime.setRebindSession(async () => this.bindCurrentSession());
		await this.bindCurrentSession();
	}

	getSnapshot(writeAccess: SessionStateSnapshot["writeAccess"]): SessionStateSnapshot {
		const session = this.runtime.session;
		const header = session.sessionManager.getHeader();
		const storage = sessionGeneration(this.sessionPath, session.sessionId);
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
					: session.isStreaming
						? "turn"
						: "idle",
			activity: session.isStreaming ? "running" : "idle",
			model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
			thinkingLevel: session.thinkingLevel,
			attached: true,
			writeAccess,
			revision: this.stateRevision,
			leafId: session.sessionManager.getLeafId(),
			queuedSteerCount: session.getSteeringMessages().length,
			queuedFollowUpCount: session.getFollowUpMessages().length,
			transcriptGeneration: storage.generation,
			transcriptRevision: storage.revision,
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
		const live = getCurrentSubagentRuns().map(liveSubagent);
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
		const live = getCurrentSubagentRuns().find((snapshot) => snapshot.agentId === agentId);
		return {
			...(transcript ? { transcript } : {}),
			...(live && transcript?.runId === live.runId ? { live: liveSubagent(live) } : {}),
		};
	}

	async abortSubagent(agentId: string): Promise<void> {
		if (!this.readSubagent(agentId).transcript)
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

	async prompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
		const entryCount = this.runtime.session.sessionManager.getEntries().length;
		await this.runtime.session.prompt(text, {
			images: contentImages(images),
			source: "rpc",
		});
		await this.runtime.session.waitForIdle();
		const error = promptFailure(this.runtime.session.sessionManager.getEntries().slice(entryCount));
		if (error) throw new Error(error);
		this.emitCommittedEntries();
	}

	async steer(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
		await this.runtime.session.steer(text, contentImages(images));
		this.emitStateChanged();
	}

	async followUp(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
		await this.runtime.session.followUp(text, contentImages(images));
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
		return this.runtime.importFromJsonl(inputPath, cwdOverride, this.runtime.cwd);
	}

	async shareSession(signal?: AbortSignal): Promise<{ previewUrl: string; gistUrl: string }> {
		return this.runtime.shareViaPrivateGist({ signal });
	}

	getLastAssistantText(): string | undefined {
		return this.runtime.session.getLastAssistantText();
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

	async setModel(modelRef: ModelRef): Promise<void> {
		const model = this.runtime.services.modelRuntime.getModel(modelRef.provider, modelRef.id);
		if (!model) {
			throw Object.assign(new Error(`未找到模型：${modelRef.provider}/${modelRef.id}`), {
				code: "model_not_found",
			});
		}
		await this.runtime.session.setModel(model);
		this.emitStateChanged();
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.runtime.session.setThinkingLevel(level);
		this.emitStateChanged();
	}

	async cycleModel(direction: "forward" | "backward"): Promise<{ changed: boolean; isScoped: boolean }> {
		const result = await this.runtime.session.cycleModel(direction);
		this.emitStateChanged();
		return {
			changed: result !== undefined,
			isScoped: result?.isScoped ?? this.runtime.session.scopedModels.length > 0,
		};
	}

	cycleThinkingLevel(): { changed: boolean; supported: boolean } {
		const previous = this.runtime.session.thinkingLevel;
		const level = this.runtime.session.cycleThinkingLevel();
		this.emitStateChanged();
		return { changed: level !== undefined && level !== previous, supported: level !== undefined };
	}

	async fork(entryId: string, position?: "before" | "at"): Promise<{ sessionPath: string; selectedText?: string }> {
		const result = await this.runtime.fork(entryId, { position });
		if (result.cancelled) {
			throw Object.assign(new Error("已取消会话分叉"), { code: "session_fork_cancelled" });
		}
		this.emitStateChanged();
		return { sessionPath: this.sessionPath, selectedText: result.selectedText };
	}

	async abort(): Promise<void> {
		this.runtime.session.abortBash();
		await this.runtime.session.abort();
	}

	async reloadResources(): Promise<void> {
		await this.runtime.session.reload();
		this.extensionUi.reset();
		this.emitStateChanged();
	}

	getCompletions(text: string, cursor: number): CompletionResult | undefined {
		const before = text.slice(0, cursor);
		const slash = /^\/([^\s]*)$/.exec(before);
		if (slash) {
			const query = slash[1].toLowerCase();
			const commands: CompletionItem[] = [
				...this.runtime.session.extensionRunner.getRegisteredCommands().map((command) => ({
					value: `/${command.invocationName} `,
					label: command.invocationName,
					description: command.description,
					kind: "extension" as const,
				})),
				...this.runtime.session.promptTemplates.map((prompt) => ({
					value: `/${prompt.name} `,
					label: prompt.name,
					description: prompt.description,
					kind: "prompt" as const,
				})),
				...this.runtime.session.resourceLoader.getSkills().skills.map((skill) => ({
					value: `/skill:${skill.name} `,
					label: `skill:${skill.name}`,
					description: skill.description,
					kind: "skill" as const,
				})),
			];
			return {
				prefixStart: 0,
				prefixEnd: cursor,
				items: commands
					.filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(query))
					.slice(0, 50),
			};
		}

		const skill = /(?:^|\s)([$@])(\[?)([a-z0-9-]*)$/i.exec(before);
		if (!skill) return undefined;
		const symbol = skill[1];
		const query = skill[3].toLowerCase();
		const prefix = `${symbol}${skill[2]}${skill[3]}`;
		const items = this.runtime.session.resourceLoader
			.getSkills()
			.skills.filter((candidate) => `${candidate.name} ${candidate.description}`.toLowerCase().includes(query))
			.slice(0, 30)
			.map((candidate) => ({
				value: `${symbol}[${candidate.name}] `,
				label: candidate.name,
				description: candidate.description,
				kind: "skill" as const,
			}));
		return { prefixStart: cursor - prefix.length, prefixEnd: cursor, items };
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
		this.extensionUi.dispose();
		this.unsubscribe?.();
		await this.runtime.dispose();
	}

	getExtensionUiSnapshot() {
		return this.extensionUi.snapshot();
	}

	getExtensionComponentDiagnostics(): JsonValue {
		return jsonValue(this.extensionUi.getComponentDiagnostics());
	}

	updateExtensionEditorState(text: string, generation: number): number {
		return this.extensionUi.updateEditorState(text, generation);
	}

	async dispatchExtensionTerminalInput(data: string) {
		return this.extensionUi.dispatchTerminalInput(data);
	}

	dispatchExtensionComponentInput(
		componentId: string,
		generation: number,
		data: string,
	): { accepted: boolean; appAction?: string } {
		const result = this.extensionUi.dispatchComponentInput(componentId, generation, data);
		return result ? { accepted: true, ...result } : { accepted: false };
	}

	resizeExtensionComponents(width: number, height: number): boolean {
		this.extensionUi.resizeComponents(width, height);
		return true;
	}

	disposeExtensionComponent(componentId: string, generation: number): boolean {
		return this.extensionUi.disposeComponent(componentId, generation);
	}

	completeExtensionCustom(
		componentId: string,
		generation: number,
		value: JsonValue | undefined,
		cancelled: boolean,
	): boolean {
		return this.extensionUi.completeCustom(componentId, generation, value, cancelled);
	}

	publishExtensionComponents(): void {
		this.extensionUi.publishComponentSnapshot();
	}

	onEvent(listener: (event: RuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async bindCurrentSession(): Promise<void> {
		this.extensionUi.reset();
		this.unsubscribe?.();
		const session = this.runtime.session;
		const unsupportedSessionChange = async () => {
			throw new Error("LYStar GUI 后台不支持由扩展替换会话");
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
			uiContext: this.extensionUi.context() as unknown as ExtensionUIContext,
			mode: "rpc",
			commandContextActions,
			abortHandler: () => void this.abort(),
			onError: (error) => this.emit({ type: "progress", payload: jsonValue({ type: "extension_error", ...error }) }),
		});
		this.unsubscribe = session.subscribe((event) => {
			this.stateRevision++;
			if (event.type === "message_end" || event.type === "entry_appended") {
				queueMicrotask(() => this.emitCommittedEntries());
			}
			for (const progress of projectRuntimeProgress(event)) this.emit({ type: "progress", payload: progress });
			this.emit({ type: "state_changed", payload: jsonValue(this.getSnapshot("owned")) });
		});
	}

	private emitCommittedEntries(): void {
		if (!existsSync(this.sessionPath)) return;
		const entries = this.runtime.session.sessionManager.getEntries();
		const committed = entries.slice(this.committedEntryCount);
		if (committed.length === 0) return;
		const storage = sessionGeneration(this.sessionPath, this.runtime.session.sessionId);
		const fromRevision = this.lastTranscriptGeneration === storage.generation ? this.lastTranscriptRevision : 0;
		this.committedEntryCount = entries.length;
		this.lastTranscriptGeneration = storage.generation;
		this.lastTranscriptRevision = storage.revision;
		this.emit({
			type: "entry_committed",
			payload: jsonValue({
				items: committed.filter(isTranscriptEntry).map(entryItem),
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

export function getGuiAgentDir(): string {
	return getAgentDir();
}

export class CodingAgentRuntimeAdapter implements RuntimeAdapter {
	private readonly agentDir: string;
	private readonly externalResourceGrants = new Map<string, { path: string; expiresAt: number }>();
	private modelRuntimePromise?: Promise<ModelRuntime>;

	constructor(agentDir = getAgentDir()) {
		this.agentDir = agentDir;
	}

	async createSession(cwd: string, onUiRequest: UiRequestHandler): Promise<RuntimeSession> {
		return this.createRuntime(cwd, SessionManager.create(cwd, getDefaultSessionDir(cwd, this.agentDir)), onUiRequest);
	}

	async openSession(sessionPath: string, onUiRequest: UiRequestHandler): Promise<RuntimeSession> {
		const manager = SessionManager.open(sessionPath);
		return this.createRuntime(manager.getCwd(), manager, onUiRequest);
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
				["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(entry.thinkingLevel)
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

	isSessionWriterLocked(sessionPath: string): boolean {
		return SessionManager.isWriterLocked(sessionPath);
	}

	async deleteSession(sessionPath: string): Promise<void> {
		await SessionManager.deleteSessionWithRecoveryLedger(this.agentDir, sessionPath, () =>
			SessionManager.withWriterLock(sessionPath, () => unlinkSync(sessionPath)),
		);
	}

	async listSessions(cwd: string): Promise<SessionSummaryBase[]> {
		return (await SessionManager.list(cwd, getDefaultSessionDir(cwd, this.agentDir))).map((session) => ({
			path: session.path,
			id: session.id,
			cwd: session.cwd,
			...(session.name ? { name: session.name } : {}),
			createdAt: session.created.getTime(),
			updatedAt: session.modified.getTime(),
			messageCount: session.messageCount,
			firstMessage: session.firstMessage === "(no messages)" ? "未命名会话" : session.firstMessage,
			activity: session.lastOutcome ?? "idle",
		}));
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
			...((line ?? parsed.line) ? { line: line ?? parsed.line } : {}),
			...((column ?? parsed.column) ? { column: column ?? parsed.column } : {}),
		};
	}

	readProjectResource(cwd: string, path: string, offset: number, limit: number): ContentChunk {
		return readResourceFile(canonicalProjectFile(cwd, path).path, offset, limit);
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
		const providers = new Map(
			await Promise.all(
				runtime.getProviders().map(async (provider) => {
					const status = runtime.getProviderAuthStatus(provider.id);
					return [
						provider.id,
						{
							authenticated: (await runtime.checkAuth(provider.id)) !== undefined,
							authMethods: authMethods(runtime, provider.id),
							authSource: status.configured ? (status.label ?? status.source) : undefined,
						},
					] as const;
				}),
			),
		);
		return runtime.getModels().map((model) => {
			const provider = providers.get(model.provider) ?? {
				authenticated: false,
				authMethods: [] as AuthType[],
			};
			return {
				provider: model.provider,
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				cost: {
					input: Math.max(0, model.cost.input),
					output: Math.max(0, model.cost.output),
					cacheRead: Math.max(0, model.cost.cacheRead),
					cacheWrite: Math.max(0, model.cost.cacheWrite),
				},
				supportedThinkingLevels: getSupportedThinkingLevels(model),
				...provider,
			};
		});
	}

	async listModelProviders(): Promise<ModelProviderSummary[]> {
		const runtime = await this.getModelRuntime();
		const config = await ModelConfig.load(join(this.agentDir, "models.json"));
		return Promise.all(
			runtime.getProviders().map(async (provider) => {
				const status = runtime.getProviderAuthStatus(provider.id);
				const builtIn = runtime.isBuiltinProvider(provider.id);
				return {
					id: provider.id,
					name: provider.name,
					authenticated: (await runtime.checkAuth(provider.id)) !== undefined,
					authMethods: authMethods(runtime, provider.id),
					authSource: status.configured ? (status.label ?? status.source) : undefined,
					modelCount: runtime.getModels(provider.id).length,
					builtIn,
					custom: !builtIn && config.getProvider(provider.id) !== undefined,
				};
			}),
		);
	}

	async addModelProvider(input: ModelProviderInput): Promise<ModelProviderSummary[]> {
		await saveModelsJsonProvider(join(this.agentDir, "models.json"), input.provider, {
			...(input.name ? { name: input.name } : {}),
			baseUrl: input.baseUrl,
			api: input.api,
		});
		await (await this.getModelRuntime()).refresh({ allowNetwork: false, providers: [input.provider] });
		return this.listModelProviders();
	}

	async addProviderModel(input: ProviderModelInput): Promise<ModelSummary[]> {
		await saveModelsJsonModel(join(this.agentDir, "models.json"), input.provider, {
			id: input.id,
			...(input.name ? { name: input.name } : {}),
			...(input.api ? { api: input.api } : {}),
			...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
			reasoning: input.reasoning,
			input: input.input,
			...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
			...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
		});
		await (await this.getModelRuntime()).refresh({ allowNetwork: false, providers: [input.provider] });
		return this.listModels();
	}

	async loginModelProvider(
		provider: string,
		authType: AuthType,
		onUiRequest: UiRequestHandler,
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
		});
		return this.listModels();
	}

	async logoutModelProvider(provider: string): Promise<ModelSummary[]> {
		const runtime = await this.getModelRuntime();
		await runtime.logout(provider);
		return this.listModels();
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
			protocolVersion: GUI_PROTOCOL_VERSION,
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
			guiProtocolVersion: GUI_PROTOCOL_VERSION,
			cwd: cwd ?? process.cwd(),
			agentDir: this.agentDir,
			runtimeDiagnostics,
			recoveryMode: getToolRecoveryMode(),
		});
		const checks = [
			{ id: "node", status: "ok", message: `Node.js ${process.version}` },
			{ id: "agent-dir", status: existsSync(this.agentDir) ? "ok" : "warning", message: this.agentDir },
			...(cwd ? [{ id: "cwd", status: existsSync(cwd) ? "ok" : "error", message: cwd }] : []),
		];
		return jsonValue({ ...report, checks });
	}

	async getGitStatus(cwd: string): Promise<GitStatus> {
		const [root, status] = await Promise.all([
			git(cwd, ["rev-parse", "--show-toplevel"]),
			git(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
		]);
		return parseGitStatus(root.trim(), status);
	}

	async getGitDiff(cwd: string, path: string | undefined, staged: boolean): Promise<GitDiff> {
		const args = ["diff", "--no-ext-diff", "--unified=3"];
		if (staged) args.push("--cached");
		if (path) args.push("--", path);
		const diff = await git(cwd, args);
		let additions = 0;
		let deletions = 0;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) additions++;
			else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
		}
		return { ...(path ? { path } : {}), staged, diff, additions, deletions };
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
	): Promise<RuntimeSession> {
		const trustStore = new ProjectTrustStore(this.agentDir);
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd: runtimeCwd,
			agentDir,
			sessionManager: runtimeSessionManager,
			sessionStartEvent,
			projectTrustContext,
		}) => {
			const hasTrustResources = hasTrustRequiringProjectResources(runtimeCwd);
			const trusted = !hasTrustResources || trustStore.get(runtimeCwd) === true;
			const settingsManager = SettingsManager.create(runtimeCwd, agentDir, { projectTrusted: trusted });
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				settingsManager,
				modelRuntimeSignal: AbortSignal.timeout(15_000),
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
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir: this.agentDir,
			sessionManager,
		});
		const wrapped = new CoreRuntimeSession(runtime, onUiRequest, this.agentDir);
		await wrapped.bind();
		return wrapped;
	}

	private getModelRuntime(): Promise<ModelRuntime> {
		this.modelRuntimePromise ??= ModelRuntime.create({
			authPath: join(this.agentDir, "auth.json"),
			modelsPath: join(this.agentDir, "models.json"),
			allowModelNetwork: false,
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
