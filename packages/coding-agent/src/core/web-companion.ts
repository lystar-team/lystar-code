import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	abortSubagent,
	continueSubagentSession,
	getCurrentSubagentRuns,
	type SubagentDetails,
	type SubagentRunSnapshot,
} from "../extensions/subagent/index.ts";
import { getBuiltinThemeNames } from "../modes/interactive/theme/theme.ts";
import type { AgentSession } from "./agent-session.ts";
import { getLystarSetting, getLystarSettingsForUi } from "./lystar-settings-catalog.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { type SessionEntry, SessionManager } from "./session-manager.ts";
import {
	getWebCompanionEndpoint,
	WEB_COMPANION_CAPABILITIES,
	WEB_COMPANION_PROTOCOL_VERSION,
	type WebCompanionCommand,
	type WebCompanionImage,
	type WebCompanionServerMessage,
	type WebCompanionSnapshot,
} from "./web-companion-contract.ts";

export {
	getWebCompanionEndpoint,
	WEB_COMPANION_CAPABILITIES,
	WEB_COMPANION_LEGACY_CAPABILITIES,
	WEB_COMPANION_LEGACY_PROTOCOL_VERSION,
	WEB_COMPANION_PROTOCOL_VERSION,
	type WebCompanionCapability,
	type WebCompanionCommand,
	type WebCompanionImage,
	type WebCompanionProtocolVersion,
	type WebCompanionServerMessage,
	type WebCompanionSnapshot,
	type WebCompanionSnapshotWire,
} from "./web-companion-contract.ts";

const MAX_WEB_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;

function send(socket: Socket, message: WebCompanionServerMessage): void {
	if (socket.destroyed || !socket.writable) return;
	if (socket.writableLength >= MAX_WEB_SOCKET_BUFFER_BYTES) {
		socket.destroy();
		return;
	}
	const payload = `${JSON.stringify(message)}\n`;
	if (socket.writableLength + Buffer.byteLength(payload) > MAX_WEB_SOCKET_BUFFER_BYTES) {
		socket.destroy();
		return;
	}
	const writable = socket.write(payload);
	if (!writable && socket.writableLength > MAX_WEB_SOCKET_BUFFER_BYTES) socket.destroy();
}

function isAddressInUse(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE";
}

async function probeEndpoint(endpoint: string): Promise<boolean> {
	return await new Promise<boolean>((resolve, reject) => {
		const socket = createConnection(endpoint);
		const cleanup = () => {
			socket.removeAllListeners();
			socket.destroy();
		};
		socket.once("connect", () => {
			cleanup();
			resolve(true);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			cleanup();
			if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
				resolve(false);
				return;
			}
			reject(error);
		});
	});
}

function listenServer(server: Server, endpoint: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.listen(endpoint, onListening);
	});
}

async function createListeningServer(endpoint: string, onConnection: (socket: Socket) => void): Promise<Server> {
	const create = () => createServer(onConnection);
	let server = create();
	try {
		await listenServer(server, endpoint);
		return server;
	} catch (error) {
		if (!isAddressInUse(error)) throw error;
		if (process.platform === "win32") {
			throw new Error(`Web companion is already running at ${endpoint}`);
		}

		if (await probeEndpoint(endpoint)) {
			throw new Error(`Web companion is already running at ${endpoint}`);
		}

		try {
			unlinkSync(endpoint);
		} catch (unlinkError) {
			if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
		}

		server = create();
		await listenServer(server, endpoint);
		return server;
	}
}

function sessionImages(images: WebCompanionImage[] | undefined): ImageContent[] | undefined {
	return images?.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
}

type CompanionSettingSummary = {
	id: string;
	label: string;
	description?: string;
	kind: string;
	value: boolean | number | string;
	displayValue: string;
	options?: string[];
	optionLabels?: string[];
	minimum?: number;
	maximum?: number;
	scope: "global" | "project";
	readOnly: boolean;
	restartRequired: boolean;
};

type CompanionSessionTreeNode = {
	id: string;
	parentId: string | null;
	kind: string;
	label?: string;
	timestamp: string;
	preview: string;
	isLeaf: boolean;
	depth: number;
};

type CompanionSubagentSnapshot = {
	runId: string;
	agentId: string;
	agent: string;
	agentSource: "builtin" | "user" | "project" | "unknown";
	task: string;
	state: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
	currentAction?: string;
	startedAt: number;
	updatedAt: number;
	elapsedMs: number;
	controllable: boolean;
	session?: {
		version: 1;
		sessionId: string;
		sessionFile: string;
		parentSessionFile?: string;
		cwd: string;
		createdAt: number;
	};
};

function settingSummary(session: AgentSession, id: string): CompanionSettingSummary {
	const definition = getLystarSetting(id);
	if (!definition) throw Object.assign(new Error(`未知设置：${id}`), { code: "setting_not_found" });
	const themeNames = [
		...getBuiltinThemeNames(),
		...session.resourceLoader.getThemes().themes.flatMap((theme) => (theme.name ? [theme.name] : [])),
	].filter((name, index, values) => values.indexOf(name) === index);
	const value = definition.get(session.settingsManager);
	const optionValues = definition.id === "theme" ? themeNames : definition.options;
	return {
		id: definition.id,
		label: definition.label,
		...(definition.description ? { description: definition.description } : {}),
		kind: definition.kind,
		value,
		displayValue: definition.format(value),
		...(optionValues && optionValues.length > 0
			? { options: optionValues.map(String), optionLabels: optionValues.map((option) => definition.format(option)) }
			: {}),
		...(definition.range ? { minimum: definition.range.min, maximum: definition.range.max } : {}),
		scope: definition.scope,
		readOnly: false,
		restartRequired: definition.restartRequired === true,
	};
}

function listSettings(session: AgentSession): CompanionSettingSummary[] {
	return getLystarSettingsForUi().map((setting) => settingSummary(session, setting.id));
}

function sessionTree(entries: readonly SessionEntry[], leafId: string | null): CompanionSessionTreeNode[] {
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
	const output: CompanionSessionTreeNode[] = [];
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

function transcriptSubagents(entries: readonly SessionEntry[]): CompanionSubagentSnapshot[] {
	const snapshots: CompanionSubagentSnapshot[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "subagent")
			continue;
		const details = entry.message.details as Partial<SubagentDetails> | undefined;
		if (!Array.isArray(details?.results)) continue;
		for (const result of details.results) {
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

function liveSubagent(snapshot: SubagentRunSnapshot): CompanionSubagentSnapshot {
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

function listSubagents(session: AgentSession): CompanionSubagentSnapshot[] {
	const merged = new Map<string, CompanionSubagentSnapshot>();
	for (const snapshot of transcriptSubagents(session.sessionManager.getEntries()))
		merged.set(`${snapshot.runId}:${snapshot.agentId}`, snapshot);
	for (const snapshot of getCurrentSubagentRuns()) {
		const current = liveSubagent(snapshot);
		merged.set(`${current.runId}:${current.agentId}`, current);
	}
	return [...merged.values()].sort(
		(left, right) =>
			right.updatedAt - left.updatedAt ||
			left.runId.localeCompare(right.runId) ||
			left.agentId.localeCompare(right.agentId),
	);
}

function readSubagent(
	session: AgentSession,
	agentId: string,
): {
	transcript?: CompanionSubagentSnapshot;
	live?: CompanionSubagentSnapshot;
} {
	const transcript = transcriptSubagents(session.sessionManager.getEntries()).find(
		(snapshot) => snapshot.agentId === agentId,
	);
	const live = getCurrentSubagentRuns().find((snapshot) => snapshot.agentId === agentId);
	return {
		...(transcript ? { transcript } : {}),
		...(live && transcript?.runId === live.runId ? { live: liveSubagent(live) } : {}),
	};
}

function persistDetachedSession(manager: SessionManager): string {
	const sessionPath = manager.getSessionFile();
	if (!sessionPath) {
		manager.dispose();
		throw new Error("共享会话没有生成会话文件");
	}
	try {
		if (!existsSync(sessionPath)) {
			const header = manager.getHeader();
			if (!header) throw new Error("共享会话缺少会话头");
			const entries = [header, ...manager.getEntries()];
			writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
		}
		return sessionPath;
	} finally {
		manager.dispose();
	}
}
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export class WebCompanionServer {
	private readonly sockets = new Set<Socket>();
	private server?: Server;
	private unsubscribe?: () => void;
	private endpoint?: string;
	private committedEntryCount: number;
	private readonly session: AgentSession;
	private readonly agentDir: string;
	private readonly onSessionChanged?: () => void;
	private committedTranscriptRevision: number;
	private snapshotBroadcastPending = false;
	private committedBroadcastPending = false;

	constructor(session: AgentSession, agentDir: string, onSessionChanged?: () => void) {
		this.session = session;
		this.agentDir = agentDir;
		this.onSessionChanged = onSessionChanged;
		this.committedEntryCount = session.sessionManager.getEntries().length;
		const sessionPath = session.sessionFile;
		this.committedTranscriptRevision = sessionPath && existsSync(sessionPath) ? statSync(sessionPath).size : 0;
	}

	async start(): Promise<void> {
		const sessionPath = this.session.sessionFile;
		if (!sessionPath || this.server) return;
		const endpoint = getWebCompanionEndpoint(this.agentDir, sessionPath);
		if (process.platform !== "win32") mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
		const server = await createListeningServer(endpoint, (socket) => this.accept(socket));
		this.endpoint = endpoint;
		this.server = server;
		server.once("close", () => {
			if (process.platform !== "win32" && existsSync(endpoint)) unlinkSync(endpoint);
		});
		try {
			if (process.platform !== "win32") chmodSync(endpoint, 0o600);
			this.unsubscribe = this.session.subscribe((event) => {
				this.broadcast({ type: "agent_event", event });
				if (event.type === "message_end" || event.type === "entry_appended") {
					this.scheduleCommittedEntriesBroadcast();
				}
				this.scheduleSnapshotBroadcast();
			});
		} catch (error) {
			await this.dispose();
			throw error;
		}
	}

	async dispose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		for (const socket of this.sockets) socket.end();
		this.sockets.clear();
		const server = this.server;
		this.server = undefined;
		this.endpoint = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	getEndpoint(): string | undefined {
		return this.endpoint;
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.trim()) continue;
				void this.handle(socket, line);
			}
		});
		socket.once("close", () => this.sockets.delete(socket));
		socket.once("error", () => this.sockets.delete(socket));
	}

	private async handle(socket: Socket, line: string): Promise<void> {
		let command: WebCompanionCommand;
		try {
			command = JSON.parse(line) as WebCompanionCommand;
		} catch {
			socket.destroy();
			return;
		}
		if (command.type === "hello") {
			if (command.sessionPath !== this.session.sessionFile) {
				socket.destroy();
				return;
			}
			send(socket, { type: "ready", snapshot: this.snapshot() });
			return;
		}
		try {
			const result = await this.execute(command, socket);
			send(socket, { type: "response", requestId: command.requestId, ok: true, result });
		} catch (error) {
			send(socket, {
				type: "response",
				requestId: command.requestId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async execute(
		command: Extract<WebCompanionCommand, { type: "request" }>,
		socket?: Socket,
	): Promise<unknown> {
		switch (command.command) {
			case "prompt":
				if (!command.text?.trim()) throw new Error("提示内容不能为空");
				await this.session.prompt(command.text, {
					images: sessionImages(command.images),
					source: "rpc",
					...(this.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
				});
				await this.session.waitForIdle();
				return {};
			case "steer":
				if (!command.text?.trim()) throw new Error("提示内容不能为空");
				await this.session.steer(command.text, sessionImages(command.images));
				return {};
			case "follow_up":
				if (!command.text?.trim()) throw new Error("提示内容不能为空");
				await this.session.followUp(command.text, sessionImages(command.images));
				return {};
			case "clear_queue":
				return this.session.clearQueue();
			case "set_model": {
				const modelRef = command.model;
				if (!modelRef || !modelRef.provider.trim() || !modelRef.id.trim()) throw new Error("模型标识不能为空");
				const model = this.session.modelRuntime.getModel(modelRef.provider, modelRef.id);
				if (!model) throw new Error(`未找到模型：${modelRef.provider}/${modelRef.id}`);
				await this.session.setModel(model);
				this.onSessionChanged?.();
				return this.snapshot();
			}
			case "set_thinking_level": {
				const level = command.level;
				if (!level || !THINKING_LEVELS.has(level)) throw new Error("不支持的 Thinking Level");
				this.session.setThinkingLevel(level);
				this.onSessionChanged?.();
				return this.snapshot();
			}
			case "cycle_model": {
				const direction = command.direction;
				if (direction !== "forward" && direction !== "backward") throw new Error("模型切换方向无效");
				const result = await this.session.cycleModel(direction);
				this.onSessionChanged?.();
				return {
					snapshot: this.snapshot(),
					changed: result !== undefined,
					isScoped: result?.isScoped ?? this.session.scopedModels.length > 0,
				};
			}
			case "cycle_thinking_level": {
				const previous = this.session.thinkingLevel;
				const level = this.session.cycleThinkingLevel();
				this.onSessionChanged?.();
				return {
					snapshot: this.snapshot(),
					changed: level !== undefined && level !== previous,
					supported: level !== undefined,
				};
			}
			case "abort":
				this.session.abortBash();
				await this.session.abort();
				return {};
			case "snapshot":
				return this.snapshot();
			case "get_completions":
				if (typeof command.cursor !== "number" || command.cursor < 0) throw new Error("补全光标位置无效");
				return this.session.getCompletions(command.text ?? "", command.cursor);
			case "get_session_tree":
				return sessionTree(this.session.sessionManager.getEntries(), this.session.sessionManager.getLeafId());
			case "get_session_info":
				return this.session.getSessionInfo();
			case "list_fork_messages":
				return this.session.getUserMessagesForForking();
			case "set_entry_label": {
				if (!command.entryId?.trim()) throw new Error("会话树节点不能为空");
				this.session.sessionManager.appendLabelChange(command.entryId, command.label?.trim() || undefined);
				this.onSessionChanged?.();
				this.scheduleCommittedEntriesBroadcast();
				return { changed: true };
			}
			case "navigate_session_tree": {
				if (!command.entryId?.trim()) throw new Error("会话树节点不能为空");
				const result = await this.session.navigateTree(command.entryId, { summarize: command.summarize === true });
				this.onSessionChanged?.();
				this.scheduleCommittedEntriesBroadcast();
				return {
					...(result.editorText ? { editorText: result.editorText } : {}),
					cancelled: result.cancelled,
					...(this.session.sessionManager.getLeafId()
						? { newLeafId: this.session.sessionManager.getLeafId()! }
						: {}),
				};
			}
			case "list_settings":
				return listSettings(this.session);
			case "set_setting": {
				if (!command.id?.trim() || command.value === undefined) throw new Error("设置参数不完整");
				const definition = getLystarSetting(command.id);
				if (!definition) throw Object.assign(new Error(`未知设置：${command.id}`), { code: "setting_not_found" });
				definition.set(this.session.settingsManager, command.value);
				switch (command.id) {
					case "autocompact":
						this.session.setAutoCompactionEnabled(command.value as boolean);
						break;
					case "steering-mode":
						this.session.setSteeringMode(command.value as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						this.session.setFollowUpMode(command.value as "all" | "one-at-a-time");
						break;
					case "transport":
						this.session.agent.transport = command.value as "auto" | "sse" | "websocket" | "websocket-cached";
						break;
				}
				await this.session.settingsManager.flush();
				this.onSessionChanged?.();
				return {
					setting: settingSummary(this.session, command.id),
					requiresRestart: definition.restartRequired === true,
				};
			}
			case "compact":
				await this.session.compact(command.customInstructions);
				this.scheduleCommittedEntriesBroadcast();
				return this.snapshot();
			case "export_session": {
				const cwd = this.session.sessionManager.getCwd();
				const targetPath =
					command.outputPath && !isAbsolute(command.outputPath)
						? resolve(cwd, command.outputPath)
						: command.outputPath;
				if (targetPath?.endsWith(".jsonl")) return { path: this.session.exportToJsonl(targetPath) };
				return { path: await this.session.exportToHtml(targetPath) };
			}
			case "get_last_assistant_text":
				return { text: this.session.getLastAssistantText() };
			case "run_bash": {
				if (!command.bashCommand?.trim()) throw new Error("Shell 命令不能为空");
				const extensionResult = await this.session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: command.bashCommand,
					excludeFromContext: command.excludeFromContext === true,
					cwd: this.session.sessionManager.getCwd(),
				});
				const result = extensionResult?.result
					? extensionResult.result
					: await this.session.executeBash(
							command.bashCommand,
							(chunk) => {
								if (socket) send(socket, { type: "bash_chunk", requestId: command.requestId, chunk });
							},
							{
								excludeFromContext: command.excludeFromContext === true,
								operations: extensionResult?.operations,
							},
						);
				if (extensionResult?.result) {
					this.session.recordBashResult(command.bashCommand, result, {
						excludeFromContext: command.excludeFromContext === true,
					});
					if (socket && result.output)
						send(socket, { type: "bash_chunk", requestId: command.requestId, chunk: result.output });
				}
				this.scheduleCommittedEntriesBroadcast();
				return result;
			}
			case "fork_session": {
				const position = command.position ?? "before";
				const selectedEntry = command.entryId ? this.session.sessionManager.getEntry(command.entryId) : undefined;
				if (!selectedEntry) throw new Error("无效的分叉节点");
				let targetLeafId: string | null = null;
				let selectedText: string | undefined;
				if (position === "at") {
					targetLeafId = selectedEntry.id;
				} else {
					if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
						throw new Error("分叉前置位置必须是用户消息");
					}
					targetLeafId = selectedEntry.parentId;
					selectedText = this.session
						.getUserMessagesForForking()
						.find((item) => item.entryId === selectedEntry.id)?.text;
				}
				const currentSessionPath = this.session.sessionFile;
				if (!currentSessionPath) throw new Error("当前共享会话没有会话文件");
				const currentManager = this.session.sessionManager;
				const manager = targetLeafId
					? currentManager.createBranchedSessionManager(targetLeafId)
					: SessionManager.create(currentManager.getCwd(), currentManager.getSessionDir());
				if (!targetLeafId) manager.newSession({ parentSession: currentSessionPath });
				const sessionPath = persistDetachedSession(manager);
				return { sessionPath, selectedText };
			}
			case "import_session": {
				if (!command.inputPath?.trim()) throw new Error("导入会话路径不能为空");
				const cwd = this.session.sessionManager.getCwd();
				const resolvedPath = isAbsolute(command.inputPath) ? command.inputPath : resolve(cwd, command.inputPath);
				if (!existsSync(resolvedPath)) throw new Error(`未找到导入文件：${resolvedPath}`);
				const sessionDir = this.session.sessionManager.getSessionDir();
				const destinationPath = join(sessionDir, basename(resolvedPath));
				const manager = SessionManager.importFromJsonl(
					resolvedPath,
					destinationPath,
					sessionDir,
					command.cwdOverride,
				);
				try {
					assertSessionCwdExists(manager, cwd);
					const sessionPath = persistDetachedSession(manager);
					return { cancelled: false, sessionPath };
				} catch (error) {
					manager.dispose();
					throw error;
				}
			}
			case "rename":
				if (command.name === undefined) throw new Error("会话名称不能为空");
				this.session.setSessionName(command.name);
				this.onSessionChanged?.();
				return this.snapshot();
			case "reload_resources":
				await this.session.reload();
				this.onSessionChanged?.();
				return this.snapshot();
			case "list_subagents":
				return listSubagents(this.session);
			case "read_subagent":
				if (!command.agentId?.trim()) throw new Error("Subagent 标识不能为空");
				return readSubagent(this.session, command.agentId);
			case "abort_subagent": {
				if (!command.agentId?.trim()) throw new Error("Subagent 标识不能为空");
				if (!readSubagent(this.session, command.agentId).transcript)
					throw Object.assign(new Error("Subagent 不属于当前会话"), { code: "subagent_not_found" });
				await abortSubagent(command.agentId);
				return { changed: true };
			}
			case "continue_subagent": {
				if (!command.agentId?.trim() || !command.text?.trim()) throw new Error("Subagent 参数不完整");
				const transcript = readSubagent(this.session, command.agentId).transcript;
				if (!transcript?.session)
					throw Object.assign(new Error("Subagent 会话不可继续"), { code: "subagent_not_continuable" });
				await continueSubagentSession(
					{
						agentId: command.agentId,
						agent: transcript.agent,
						agentSource: transcript.agentSource,
						task: transcript.task,
						agentScope: "both",
						session: transcript.session,
					},
					command.text,
				);
				return { changed: true };
			}
		}
	}

	private snapshot(): WebCompanionSnapshot {
		const sessionPath = this.session.sessionFile;
		if (!sessionPath) throw new Error("当前会话尚未持久化");
		const header = this.session.sessionManager.getHeader();
		const stat = existsSync(sessionPath) ? statSync(sessionPath) : undefined;
		const usage = this.session.getContextUsage();
		const toolActivityEpoch =
			typeof this.session.getToolActivityEpoch === "function" ? this.session.getToolActivityEpoch() : "";
		const toolActivityRevision =
			typeof this.session.getToolActivityRevision === "function" ? this.session.getToolActivityRevision() : 0;
		const toolActivities =
			typeof this.session.getToolActivitySnapshot === "function" ? this.session.getToolActivitySnapshot() : [];
		return {
			protocolVersion: WEB_COMPANION_PROTOCOL_VERSION,
			id: this.session.sessionManager.getSessionId(),
			path: sessionPath,
			cwd: this.session.sessionManager.getCwd(),
			...(this.session.sessionName ? { name: this.session.sessionName } : {}),
			createdAt: header ? Date.parse(header.timestamp) : Date.now(),
			updatedAt: stat?.mtimeMs ?? Date.now(),
			phase: this.session.isCompacting
				? "compaction"
				: this.session.retryAttempt > 0
					? "retry"
					: this.session.isStreaming
						? "turn"
						: "idle",
			activity: this.session.isStreaming ? "running" : "idle",
			model: this.session.model ? { provider: this.session.model.provider, id: this.session.model.id } : undefined,
			thinkingLevel: this.session.thinkingLevel,
			leafId: this.session.sessionManager.getLeafId(),
			queuedSteerCount: this.session.getSteeringMessages().length,
			queuedFollowUpCount: this.session.getFollowUpMessages().length,
			contextTokens: usage?.tokens,
			contextWindow: usage?.contextWindow,
			transcriptGeneration: this.session.sessionManager.getSessionId(),
			transcriptRevision: stat?.size ?? 0,
			toolActivityEpoch,
			toolActivityRevision,
			toolActivities,
			capabilities: [...WEB_COMPANION_CAPABILITIES],
		};
	}

	private scheduleSnapshotBroadcast(): void {
		if (this.snapshotBroadcastPending) return;
		this.snapshotBroadcastPending = true;
		queueMicrotask(() => {
			this.snapshotBroadcastPending = false;
			if (this.server) this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
		});
	}

	private scheduleCommittedEntriesBroadcast(): void {
		if (this.committedBroadcastPending) return;
		this.committedBroadcastPending = true;
		queueMicrotask(() => {
			this.committedBroadcastPending = false;
			if (this.server) this.broadcastCommittedEntries();
		});
	}

	private broadcast(message: WebCompanionServerMessage): void {
		for (const socket of this.sockets) send(socket, message);
	}

	private broadcastCommittedEntries(): void {
		const sessionPath = this.session.sessionFile;
		if (!sessionPath || !existsSync(sessionPath)) return;
		const entries = this.session.sessionManager.getEntries();
		const committed = entries.slice(this.committedEntryCount);
		if (committed.length === 0) return;
		const stat = statSync(sessionPath);
		this.committedEntryCount = entries.length;
		const fromRevision = this.committedTranscriptRevision;
		this.committedTranscriptRevision = stat.size;
		this.broadcast({
			type: "entry_committed",
			items: committed,
			transcriptGeneration: this.session.sessionManager.getSessionId(),
			fromRevision,
			transcriptRevision: stat.size,
		});
	}
}
