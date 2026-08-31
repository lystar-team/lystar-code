import { createHash, randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import type {
	JsonValue,
	SessionProgress,
	SessionStateSnapshot,
	SessionTreeNode,
	TranscriptItem,
	UsageProgress,
} from "@lystar/code-gui-protocol";
import type { RuntimeEvent, RuntimeSession } from "./types.ts";

type PendingResponse = { resolve(value: unknown): void; reject(error: Error): void };

interface GuiCompanionImage {
	data: string;
	mimeType: string;
}

interface GuiCompanionSnapshot {
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
}

type GuiCompanionCommand =
	| { type: "hello"; sessionPath: string }
	| {
			type: "request";
			requestId: string;
			command: "prompt" | "steer" | "follow_up" | "clear_queue" | "abort" | "snapshot";
			text?: string;
			images?: GuiCompanionImage[];
	  };

type GuiCompanionServerMessage =
	| { type: "ready"; snapshot: GuiCompanionSnapshot }
	| { type: "response"; requestId: string; ok: true; result?: unknown }
	| { type: "response"; requestId: string; ok: false; error: string }
	| { type: "snapshot"; snapshot: GuiCompanionSnapshot }
	| { type: "agent_event"; event: unknown }
	| {
			type: "entry_committed";
			items: unknown[];
			transcriptGeneration: string;
			fromRevision: number;
			transcriptRevision: number;
	  };

function getGuiCompanionEndpoint(agentDir: string, sessionPath: string): string {
	const suffix = createHash("sha256").update(`${agentDir}\0${sessionPath}`).digest("hex").slice(0, 32);
	return process.platform === "win32"
		? `\\\\.\\pipe\\lystar-session-companion-${suffix}`
		: join(agentDir, "host", "companions", `${suffix}.sock`);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textFromContent(value: unknown): string {
	if (!Array.isArray(value)) return typeof value === "string" ? value : "";
	return value
		.map((part) => {
			const item = record(part);
			return item?.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.join("");
}

function usage(value: unknown): UsageProgress | undefined {
	const item = record(value);
	if (!item) return undefined;
	const result: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	} = {};
	if (typeof item.input === "number") result.inputTokens = item.input;
	if (typeof item.output === "number") result.outputTokens = item.output;
	if (typeof item.cacheRead === "number") result.cacheReadTokens = item.cacheRead;
	if (typeof item.cacheWrite === "number") result.cacheWriteTokens = item.cacheWrite;
	return Object.keys(result).length > 0 ? result : undefined;
}

function projectAgentEvent(value: unknown): SessionProgress[] {
	const event = record(value);
	if (!event || typeof event.type !== "string") return [];
	if (event.type === "message_start") {
		const message = record(event.message);
		if (message?.role === "user") return [{ type: "user_message", text: textFromContent(message.content) }];
		return [];
	}
	if (event.type === "message_update") {
		const stream = record(event.assistantMessageEvent);
		const updates: SessionProgress[] = [];
		if (stream?.type === "text_delta" && typeof stream.delta === "string") {
			updates.push({ type: "assistant_delta", text: stream.delta });
		} else if (stream?.type === "thinking_delta" && typeof stream.delta === "string") {
			updates.push({ type: "thinking_delta", text: stream.delta });
		}
		const message = record(event.message);
		const currentUsage = usage(message?.usage);
		if (currentUsage) updates.push({ type: "usage", usage: currentUsage });
		return updates;
	}
	if (event.type === "tool_execution_start") {
		return [
			{
				type: "tool_start",
				toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : randomUUID(),
				name: typeof event.toolName === "string" ? event.toolName : "tool",
				summary: "",
			},
		];
	}
	if (event.type === "tool_execution_end") {
		return [
			{
				type: "tool_end",
				toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : randomUUID(),
				name: typeof event.toolName === "string" ? event.toolName : "tool",
				status: event.isError === true ? "error" : "success",
				summary: "",
			},
		];
	}
	if (event.type === "queue_update") {
		return [
			{
				type: "queue_update",
				steeringCount: Array.isArray(event.steering) ? event.steering.length : 0,
				followUpCount: Array.isArray(event.followUp) ? event.followUp.length : 0,
			},
		];
	}
	if (event.type === "compaction_start") return [{ type: "phase", phase: "compaction" }];
	if (event.type === "agent_settled") return [{ type: "phase", phase: "idle" }];
	return [];
}

function transcriptItem(value: unknown): TranscriptItem | undefined {
	const entry = record(value);
	if (
		!entry ||
		typeof entry.id !== "string" ||
		typeof entry.type !== "string" ||
		typeof entry.timestamp !== "string"
	) {
		return undefined;
	}
	return {
		entryId: entry.id,
		parentId: typeof entry.parentId === "string" ? entry.parentId : null,
		timestamp: entry.timestamp,
		kind: entry.type,
		payload: entry as unknown as JsonValue,
	};
}

function snapshot(
	value: GuiCompanionSnapshot,
	writeAccess: SessionStateSnapshot["writeAccess"],
	revision: number,
): SessionStateSnapshot {
	return {
		id: value.id,
		path: value.path,
		cwd: value.cwd,
		...(value.name ? { name: value.name } : {}),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		phase: value.phase,
		activity: value.activity,
		...(value.model ? { model: value.model } : {}),
		thinkingLevel: value.thinkingLevel as SessionStateSnapshot["thinkingLevel"],
		attached: true,
		writeAccess,
		revision,
		leafId: value.leafId,
		queuedSteerCount: value.queuedSteerCount,
		queuedFollowUpCount: value.queuedFollowUpCount,
		...(value.contextTokens === undefined ? {} : { contextTokens: value.contextTokens }),
		...(value.contextWindow === undefined ? {} : { contextWindow: value.contextWindow }),
		transcriptGeneration: value.transcriptGeneration,
		transcriptRevision: value.transcriptRevision,
	};
}

export class GuiCompanionRuntime implements RuntimeSession {
	private readonly listeners = new Set<(event: RuntimeEvent) => void>();
	private readonly pending = new Map<string, PendingResponse>();
	private socket?: Socket;
	private buffer = "";
	private snapshotValue: GuiCompanionSnapshot;
	private revision = 0;
	private disposed = false;

	private readonly sessionPathValue: string;

	private constructor(sessionPathValue: string, initialSnapshot: GuiCompanionSnapshot) {
		this.sessionPathValue = sessionPathValue;
		this.snapshotValue = initialSnapshot;
	}

	static async open(agentDir: string, sessionPath: string): Promise<GuiCompanionRuntime> {
		const endpoint = getGuiCompanionEndpoint(agentDir, sessionPath);
		const socket = await new Promise<Socket>((resolve, reject) => {
			const candidate = createConnection(endpoint);
			candidate.once("connect", () => resolve(candidate));
			candidate.once("error", reject);
		});
		const ready = await new Promise<GuiCompanionSnapshot>((resolve, reject) => {
			let buffer = "";
			const onData = (chunk: Buffer | string) => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				try {
					const message = JSON.parse(line) as GuiCompanionServerMessage;
					if (message.type === "ready") {
						cleanup();
						resolve(message.snapshot);
					} else {
						cleanup();
						reject(new Error("GUI 共享通道返回了无效握手"));
					}
				} catch (error) {
					cleanup();
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			};
			const cleanup = () => {
				socket.off("data", onData);
				socket.off("error", onError);
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			socket.on("data", onData);
			socket.once("error", onError);
			socket.write(`${JSON.stringify({ type: "hello", sessionPath } satisfies GuiCompanionCommand)}\n`);
		});
		const runtime = new GuiCompanionRuntime(sessionPath, ready);
		runtime.attach(socket);
		return runtime;
	}

	get sessionPath(): string {
		return this.sessionPathValue;
	}

	getSnapshot(writeAccess: SessionStateSnapshot["writeAccess"]): SessionStateSnapshot {
		return snapshot(this.snapshotValue, writeAccess, this.revision);
	}

	listSettings() {
		return [];
	}

	async setSetting(): Promise<{ setting: never; requiresRestart: boolean }> {
		throw new Error("TUI 共享会话请在 TUI 中修改设置");
	}

	getSessionTree(): SessionTreeNode[] {
		return [];
	}

	getSessionInfo() {
		return {
			name: this.snapshotValue.name ?? null,
			sessionFile: this.sessionPathValue,
			sessionId: this.snapshotValue.id,
			messages: { total: 0, user: 0, agent: 0, toolCalls: 0, toolResults: 0 },
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			usageBreakdown: [],
			cacheWaste: { missedTokens: 0, missedCost: 0, missCount: 0 },
		};
	}

	listForkMessages() {
		return [];
	}

	async setEntryLabel(): Promise<void> {
		throw new Error("TUI 共享会话暂不支持标签编辑");
	}

	async navigateSessionTree(): Promise<{ cancelled: boolean }> {
		throw new Error("TUI 共享会话暂不支持会话树导航");
	}

	listSubagents() {
		return [];
	}

	readSubagent() {
		return {};
	}

	async abortSubagent(): Promise<void> {
		throw new Error("TUI 共享会话暂不支持 Subagent 控制");
	}

	async continueSubagent(): Promise<void> {
		throw new Error("TUI 共享会话暂不支持 Subagent 控制");
	}

	async prompt(text: string, images?: GuiCompanionImage[]): Promise<void> {
		await this.request("prompt", text, images);
	}

	async steer(text: string, images?: GuiCompanionImage[]): Promise<void> {
		await this.request("steer", text, images);
	}

	async followUp(text: string, images?: GuiCompanionImage[]): Promise<void> {
		await this.request("follow_up", text, images);
	}

	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		return (await this.request("clear_queue")) as { steering: string[]; followUp: string[] };
	}

	async compact(): Promise<void> {
		throw new Error("TUI 共享会话暂不支持压缩控制");
	}

	async exportSession(): Promise<{ path: string }> {
		throw new Error("TUI 共享会话暂不支持导出控制");
	}

	async importSession(): Promise<{ cancelled: boolean }> {
		throw new Error("TUI 共享会话暂不支持导入控制");
	}

	async shareSession(): Promise<{ previewUrl: string; gistUrl: string }> {
		throw new Error("TUI 共享会话暂不支持分享控制");
	}

	getLastAssistantText(): string | undefined {
		return undefined;
	}

	async runBash(): Promise<JsonValue> {
		throw new Error("TUI 共享会话暂不支持 Bash 控制");
	}

	async rename(): Promise<void> {
		throw new Error("TUI 共享会话暂不支持重命名控制");
	}

	async setModel(): Promise<void> {
		throw new Error("TUI 共享会话请在 TUI 中切换模型");
	}

	async setThinkingLevel(): Promise<void> {
		throw new Error("TUI 共享会话请在 TUI 中切换思考强度");
	}

	async cycleModel(): Promise<{ changed: boolean; isScoped: boolean }> {
		throw new Error("TUI 共享会话请在 TUI 中切换模型");
	}

	cycleThinkingLevel(): { changed: boolean; supported: boolean } {
		throw new Error("TUI 共享会话请在 TUI 中切换思考强度");
	}

	async fork(): Promise<{ sessionPath: string; selectedText?: string }> {
		throw new Error("TUI 共享会话暂不支持分叉控制");
	}

	async abort(): Promise<void> {
		await this.request("abort");
	}

	async reloadResources(): Promise<void> {
		throw new Error("TUI 共享会话暂不支持资源重载");
	}

	getCompletions() {
		return undefined;
	}

	getToolRecoveryDiagnostics() {
		return {
			mode: "off" as const,
			toolFailureTotal: [],
			toolRecoveryAttemptTotal: [],
			toolRecoverySuccessTotal: [],
			toolRepeatBlockedTotal: [],
			toolUnsafeRetryBlockedTotal: [],
			lessonMatchTotal: [],
			lessonRecoverySuccessTotal: [],
			lessonSuspendedTotal: [],
			duration: { count: 0, totalMs: 0, maxMs: 0 },
			activeCircuits: 0,
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const pending of this.pending.values()) pending.reject(new Error("GUI 共享会话已断开"));
		this.pending.clear();
		this.socket?.end();
		this.socket = undefined;
	}

	onEvent(listener: (event: RuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private attach(socket: Socket): void {
		this.socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			this.buffer += chunk;
			let newline = this.buffer.indexOf("\n");
			while (newline >= 0) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				newline = this.buffer.indexOf("\n");
				if (line.trim()) this.handleMessage(line);
			}
		});
		socket.on("close", () => {
			this.rejectPending();
		});
		socket.on("error", () => this.rejectPending());
	}

	private rejectPending(): void {
		for (const pending of this.pending.values()) pending.reject(new Error("TUI 共享会话已断开"));
		this.pending.clear();
	}

	private handleMessage(line: string): void {
		let message: GuiCompanionServerMessage;
		try {
			message = JSON.parse(line) as GuiCompanionServerMessage;
		} catch {
			return;
		}
		if (message.type === "response") {
			const pending = this.pending.get(message.requestId);
			if (!pending) return;
			this.pending.delete(message.requestId);
			if (message.ok) pending.resolve(message.result);
			else pending.reject(new Error(message.error));
			return;
		}
		if (message.type === "snapshot" || message.type === "ready") {
			this.snapshotValue = message.snapshot;
			this.revision++;
			this.emit({ type: "state_changed", payload: this.getSnapshot("owned") as unknown as JsonValue });
			return;
		}
		if (message.type === "agent_event") {
			for (const progress of projectAgentEvent(message.event)) this.emit({ type: "progress", payload: progress });
			this.emit({ type: "state_changed", payload: this.getSnapshot("owned") as unknown as JsonValue });
			return;
		}
		if (message.type === "entry_committed") {
			const items = message.items.flatMap((item) => {
				const parsed = transcriptItem(item);
				return parsed ? [parsed] : [];
			});
			this.emit({
				type: "entry_committed",
				payload: {
					items,
					transcriptGeneration: message.transcriptGeneration,
					fromRevision: message.fromRevision,
					transcriptRevision: message.transcriptRevision,
				} as unknown as JsonValue,
			});
		}
	}

	private request(
		command: Extract<GuiCompanionCommand, { type: "request" }>["command"],
		text?: string,
		images?: GuiCompanionImage[],
	): Promise<unknown> {
		if (!this.socket || this.disposed) return Promise.reject(new Error("TUI 共享会话已断开"));
		const requestId = randomUUID();
		let rejectRequest: (error: Error) => void = () => {};
		const pending = new Promise<unknown>((resolve, reject) => {
			rejectRequest = reject;
			this.pending.set(requestId, { resolve, reject });
		});
		const message: Extract<GuiCompanionCommand, { type: "request" }> = {
			type: "request",
			requestId,
			command,
			...(text === undefined ? {} : { text }),
			...(images === undefined ? {} : { images }),
		};
		this.socket.write(`${JSON.stringify(message)}\n`, (error) => {
			if (!error) return;
			this.pending.delete(requestId);
			rejectRequest(error);
		});
		return pending;
	}

	private emit(event: RuntimeEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

export function isGuiCompanionError(error: unknown): boolean {
	return error instanceof Error && /GUI companion|TUI 共享会话/.test(error.message);
}
