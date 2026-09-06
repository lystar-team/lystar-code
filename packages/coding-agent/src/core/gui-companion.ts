import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import type { ToolActivitySnapshot } from "./tool-activity.ts";

export interface GuiCompanionImage {
	data: string;
	mimeType: string;
}

export interface GuiCompanionSnapshot {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	createdAt: number;
	updatedAt: number;
	phase: "idle" | "turn" | "compaction" | "retry";
	activity: "idle" | "running";
	model?: { provider: string; id: string };
	thinkingLevel: string;
	leafId: string | null;
	queuedSteerCount: number;
	queuedFollowUpCount: number;
	contextTokens?: number | null;
	contextWindow?: number;
	transcriptGeneration: string;
	transcriptRevision: number;
	toolActivityEpoch: string;
	toolActivityRevision: number;
	toolActivities: ToolActivitySnapshot[];
}

export type GuiCompanionCommand =
	| { type: "hello"; sessionPath: string }
	| {
			type: "request";
			requestId: string;
			command:
				| "prompt"
				| "steer"
				| "follow_up"
				| "clear_queue"
				| "abort"
				| "snapshot"
				| "set_model"
				| "set_thinking_level"
				| "cycle_model"
				| "cycle_thinking_level"
				| "get_completions";
			text?: string;
			cursor?: number;
			images?: GuiCompanionImage[];
			model?: { provider: string; id: string };
			level?: ThinkingLevel;
			direction?: "forward" | "backward";
	  };

export type GuiCompanionServerMessage =
	| { type: "ready"; snapshot: GuiCompanionSnapshot }
	| { type: "response"; requestId: string; ok: true; result?: unknown }
	| { type: "response"; requestId: string; ok: false; error: string }
	| { type: "snapshot"; snapshot: GuiCompanionSnapshot }
	| { type: "agent_event"; event: AgentSessionEvent }
	| {
			type: "entry_committed";
			items: unknown[];
			transcriptGeneration: string;
			fromRevision: number;
			transcriptRevision: number;
	  };

function endpointHash(agentDir: string, sessionPath: string): string {
	return createHash("sha256").update(`${agentDir}\0${sessionPath}`).digest("hex").slice(0, 32);
}

export function getGuiCompanionEndpoint(agentDir: string, sessionPath: string): string {
	const suffix = endpointHash(agentDir, sessionPath);
	return process.platform === "win32"
		? `\\\\.\\pipe\\lystar-session-companion-${suffix}`
		: join(agentDir, "host", "companions", `${suffix}.sock`);
}

function send(socket: Socket, message: GuiCompanionServerMessage): void {
	if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
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
			throw new Error(`GUI companion is already running at ${endpoint}`);
		}

		if (await probeEndpoint(endpoint)) {
			throw new Error(`GUI companion is already running at ${endpoint}`);
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

function sessionImages(images: GuiCompanionImage[] | undefined): ImageContent[] | undefined {
	return images?.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export class GuiCompanionServer {
	private readonly sockets = new Set<Socket>();
	private server?: Server;
	private unsubscribe?: () => void;
	private endpoint?: string;
	private committedEntryCount: number;
	private readonly session: AgentSession;
	private readonly agentDir: string;
	private readonly onSessionChanged?: () => void;
	private committedTranscriptRevision: number;

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
		const endpoint = getGuiCompanionEndpoint(this.agentDir, sessionPath);
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
					queueMicrotask(() => this.broadcastCommittedEntries());
				}
				queueMicrotask(() => this.broadcast({ type: "snapshot", snapshot: this.snapshot() }));
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
		let command: GuiCompanionCommand;
		try {
			command = JSON.parse(line) as GuiCompanionCommand;
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
			const result = await this.execute(command);
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

	private async execute(command: Extract<GuiCompanionCommand, { type: "request" }>): Promise<unknown> {
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
				await this.session.abort();
				return {};
			case "snapshot":
				return this.snapshot();
			case "get_completions":
				if (typeof command.cursor !== "number" || command.cursor < 0) throw new Error("补全光标位置无效");
				return this.session.getCompletions(command.text ?? "", command.cursor);
		}
	}

	private snapshot(): GuiCompanionSnapshot {
		const sessionPath = this.session.sessionFile;
		if (!sessionPath) throw new Error("当前会话尚未持久化");
		const header = this.session.sessionManager.getHeader();
		const stat = existsSync(sessionPath) ? statSync(sessionPath) : undefined;
		const usage = this.session.getContextUsage();
		return {
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
			toolActivityEpoch: this.session.getToolActivityEpoch(),
			toolActivityRevision: this.session.getToolActivityRevision(),
			toolActivities: this.session.getToolActivitySnapshot(),
		};
	}

	private broadcast(message: GuiCompanionServerMessage): void {
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
