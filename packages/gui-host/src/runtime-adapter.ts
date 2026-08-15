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
	APP_TITLE,
	type AuthEvent,
	type AuthPrompt,
	CONFIG_DIR_NAME,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	DefaultPackageManager,
	type ExtensionCommandContextActions,
	type ExtensionUIContext,
	formatVersionCheckError,
	getAgentDir,
	getDefaultSessionDir,
	getLatestPiRelease,
	getSupportedThinkingLevels,
	hasTrustRequiringProjectResources,
	isNewerPackageVersion,
	loadProjectContextFiles,
	loadSkills,
	ModelConfig,
	ModelRuntime,
	PACKAGE_VERSION,
	ProjectTrustStore,
	RELEASE_REPOSITORY,
	readSessionSnapshot,
	resolveProjectTrusted,
	type SessionEntry,
	SessionManager,
	SettingsManager,
	saveModelsJsonModel,
	saveModelsJsonProvider,
	VERSION,
} from "@earendil-works/pi-coding-agent/core";
import type {
	AuthType,
	CompletionItem,
	CompletionResult,
	ContentChunk,
	GitDiff,
	GitFileStatus,
	GitStatus,
	HostDirectoryListing,
	JsonValue,
	ModelRef,
	ProjectInstruction,
	ProjectResource,
	SessionStateSnapshot,
	ThinkingLevel,
	TranscriptItem,
} from "@lystar/code-gui-protocol";
import type {
	ModelProviderInput,
	ModelProviderSummary,
	ModelSummary,
	ProviderModelInput,
	RuntimeAdapter,
	RuntimeEvent,
	RuntimeSession,
	SessionSummaryBase,
	SkillSummary,
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

function contentHash(content: string): string {
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

class CoreRuntimeSession implements RuntimeSession {
	private readonly listeners = new Set<(event: RuntimeEvent) => void>();
	private readonly runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
	private readonly onUiRequest: UiRequestHandler;
	private unsubscribe?: () => void;
	private stateRevision = 0;
	private committedEntryCount = 0;
	private lastTranscriptGeneration?: string;
	private lastTranscriptRevision = 0;
	private disposed = false;

	constructor(runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>, onUiRequest: UiRequestHandler) {
		this.runtime = runtime;
		this.onUiRequest = onUiRequest;
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
			model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
			thinkingLevel: session.thinkingLevel,
			attached: true,
			writeAccess,
			revision: this.stateRevision,
			leafId: session.sessionManager.getLeafId(),
			queuedSteerCount: session.pendingMessageCount,
			transcriptGeneration: storage.generation,
			transcriptRevision: storage.revision,
		};
	}

	async prompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
		await this.runtime.session.prompt(text, {
			images: images?.map((image) => ({ type: "image", ...image })),
			source: "rpc",
		});
		await this.runtime.session.waitForIdle();
		this.emitCommittedEntries();
	}

	async runBash(command: string, onChunk: (chunk: string) => void): Promise<JsonValue> {
		const result = await this.runtime.session.executeBash(command, onChunk);
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

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe?.();
		await this.runtime.dispose();
	}

	onEvent(listener: (event: RuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async bindCurrentSession(): Promise<void> {
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
			uiContext: createUiContext(this.onUiRequest),
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
			this.emit({ type: "progress", payload: jsonValue(event) });
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
			...(model ? { model } : {}),
			thinkingLevel,
			attached: false,
			writeAccess: this.isSessionWriterLocked(sessionPath) ? "locked_externally" : "available",
			revision: 0,
			leafId: snapshot.leafId,
			queuedSteerCount: 0,
			transcriptGeneration: storage.generation,
			transcriptRevision: storage.revision,
		};
	}

	isSessionWriterLocked(sessionPath: string): boolean {
		return SessionManager.isWriterLocked(sessionPath);
	}

	async deleteSession(sessionPath: string): Promise<void> {
		SessionManager.withWriterLock(sessionPath, () => unlinkSync(sessionPath));
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
		return runtime.getModels().flatMap((model) => {
			const provider = providers.get(model.provider);
			if (!provider?.authenticated) return [];
			return [
				{
					provider: model.provider,
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					cost: model.cost,
					supportedThinkingLevels: getSupportedThinkingLevels(model),
					...provider,
				},
			];
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
			protocolVersion: 1,
			releaseRepository: RELEASE_REPOSITORY ?? null,
			agentDir: this.agentDir,
			sessionsDir: join(this.agentDir, "sessions"),
			configDirName: CONFIG_DIR_NAME,
		};
	}

	async getDiagnostics(cwd?: string): Promise<JsonValue> {
		const checks = [
			{ id: "node", status: "ok", message: `Node.js ${process.version}` },
			{ id: "agent-dir", status: existsSync(this.agentDir) ? "ok" : "warning", message: this.agentDir },
			...(cwd ? [{ id: "cwd", status: existsSync(cwd) ? "ok" : "error", message: cwd }] : []),
		];
		return { checks, platform: process.platform, arch: process.arch };
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
		if (process.env.PI_OFFLINE) return { ...base, status: "offline", latestVersion: null };
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
			};
		} catch (error) {
			throw Object.assign(new Error(formatVersionCheckError(error)), {
				code: "update_check_failed",
				retryable: true,
			});
		}
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
		const wrapped = new CoreRuntimeSession(runtime, onUiRequest);
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
