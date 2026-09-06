import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
	GUI_COMPANION_CAPABILITIES,
	GUI_COMPANION_LEGACY_CAPABILITIES,
	GUI_COMPANION_LEGACY_PROTOCOL_VERSION,
	GUI_COMPANION_PROTOCOL_VERSION,
	type GuiCompanionCapability,
	type GuiCompanionCommand,
	type GuiCompanionImage,
	type GuiCompanionServerMessage,
	type GuiCompanionSnapshot,
	type GuiCompanionSnapshotWire,
	getGuiCompanionEndpoint,
} from "@earendil-works/pi-coding-agent/core";
import type {
	CompletionResult,
	JsonValue,
	ModelRef,
	SessionInfoResult,
	SessionProgress,
	SessionStateSnapshot,
	SessionTreeNode,
	SettingSummary,
	SubagentSnapshot,
	ThinkingLevel,
	ToolActivity,
	TranscriptItem,
	UsageProgress,
} from "@lystar/code-gui-protocol";
import type { RuntimeEvent, RuntimeSession } from "./types.ts";

type PendingResponse = {
	resolve(value: unknown): void;
	reject(error: Error): void;
	onBashChunk?: (chunk: string) => void;
};
type GuiCompanionRequestOptions = Omit<
	Extract<GuiCompanionCommand, { type: "request" }>,
	"type" | "requestId" | "command"
>;

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

function isGuiCompanionSnapshot(value: unknown): value is GuiCompanionSnapshotWire {
	const item = record(value);
	return (
		item !== undefined &&
		typeof item.id === "string" &&
		typeof item.path === "string" &&
		typeof item.cwd === "string" &&
		typeof item.thinkingLevel === "string" &&
		typeof item.transcriptGeneration === "string" &&
		typeof item.transcriptRevision === "number"
	);
}

function projectAgentEvent(value: unknown): SessionProgress[] {
	const event = record(value);
	if (!event || typeof event.type !== "string") return [];
	if (event.type === "message_start") {
		const message = record(event.message);
		if (message?.role === "user") return [{ type: "user_message", text: textFromContent(message.content) }];
		if (message?.role === "assistant") return [{ type: "phase", phase: "turn" }];
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
	if (event.type === "tool_activity") {
		const activity = record(event.activity);
		if (!activity || typeof activity.activityEpoch !== "string" || typeof activity.toolCallId !== "string") return [];
		return [{ type: "tool_state", activity: activity as ToolActivity }];
	}
	if (event.type === "tool_execution_update" && event.toolName === "bash") {
		return [
			{
				type: "bash",
				command: typeof record(event.args)?.command === "string" ? (record(event.args)?.command as string) : "",
				output: "",
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

export class GuiCompanionProtocolError extends Error {
	readonly code = "gui_companion_protocol_incompatible";
	readonly retryable = false;
	readonly details: JsonValue;

	constructor(message: string, details: JsonValue) {
		super(message);
		this.name = "GuiCompanionProtocolError";
		this.details = details;
	}
}

function normalizeSnapshot(value: GuiCompanionSnapshotWire): GuiCompanionSnapshot {
	const protocolVersion = value.protocolVersion ?? GUI_COMPANION_LEGACY_PROTOCOL_VERSION;
	if (
		protocolVersion !== GUI_COMPANION_LEGACY_PROTOCOL_VERSION &&
		protocolVersion !== GUI_COMPANION_PROTOCOL_VERSION
	) {
		throw new GuiCompanionProtocolError("TUI 共享通道协议版本不受当前 GUI Host 支持", {
			protocolVersion,
			supportedVersions: [GUI_COMPANION_LEGACY_PROTOCOL_VERSION, GUI_COMPANION_PROTOCOL_VERSION],
		});
	}
	if (protocolVersion === GUI_COMPANION_PROTOCOL_VERSION && !value.capabilities) {
		throw new GuiCompanionProtocolError("TUI 共享通道缺少 v2 能力清单", { protocolVersion });
	}
	if (value.capabilities !== undefined && !Array.isArray(value.capabilities)) {
		throw new GuiCompanionProtocolError("TUI 共享通道能力清单格式无效", { protocolVersion });
	}
	const capabilities = value.capabilities ?? [...GUI_COMPANION_LEGACY_CAPABILITIES];
	if (!capabilities.every((capability) => GUI_COMPANION_CAPABILITIES.includes(capability))) {
		throw new GuiCompanionProtocolError("TUI 共享通道返回了未知能力", { protocolVersion });
	}
	return { ...value, protocolVersion, capabilities };
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
		...(value.toolActivityEpoch ? { toolActivityEpoch: value.toolActivityEpoch } : {}),
		...(value.toolActivityRevision === undefined ? {} : { toolActivityRevision: value.toolActivityRevision }),
		...(value.toolActivities ? { toolActivities: value.toolActivities } : {}),
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
	private capabilities: GuiCompanionCapability[];

	private readonly sessionPathValue: string;

	private constructor(sessionPathValue: string, initialSnapshot: GuiCompanionSnapshotWire) {
		this.sessionPathValue = sessionPathValue;
		this.snapshotValue = normalizeSnapshot(initialSnapshot);
		this.capabilities = [...this.snapshotValue.capabilities];
	}

	static async open(agentDir: string, sessionPath: string): Promise<GuiCompanionRuntime> {
		const endpoint = getGuiCompanionEndpoint(agentDir, sessionPath);
		const socket = await new Promise<Socket>((resolve, reject) => {
			const candidate = createConnection(endpoint);
			candidate.once("connect", () => resolve(candidate));
			candidate.once("error", reject);
		});
		const ready = await new Promise<GuiCompanionSnapshotWire>((resolve, reject) => {
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
			socket.write(
				`${JSON.stringify({ type: "hello", sessionPath, protocolVersion: GUI_COMPANION_PROTOCOL_VERSION } satisfies GuiCompanionCommand)}\n`,
			);
		});
		try {
			const runtime = new GuiCompanionRuntime(sessionPath, ready);
			runtime.attach(socket);
			return runtime;
		} catch (error) {
			socket.destroy();
			throw error;
		}
	}

	get sessionPath(): string {
		return this.sessionPathValue;
	}

	getCapabilities(): readonly GuiCompanionCapability[] {
		return this.capabilities;
	}

	getSnapshot(writeAccess: SessionStateSnapshot["writeAccess"]): SessionStateSnapshot {
		return snapshot(this.snapshotValue, writeAccess, this.revision);
	}

	listSettings(): SettingSummary[] {
		return [];
	}

	async listSettingsAsync(): Promise<SettingSummary[]> {
		return this.request("list_settings") as Promise<SettingSummary[]>;
	}

	async setSetting(
		id: string,
		value: boolean | number | string,
	): Promise<{ setting: SettingSummary; requiresRestart: boolean }> {
		return (await this.request("set_setting", { id, value })) as {
			setting: SettingSummary;
			requiresRestart: boolean;
		};
	}

	getSessionTree(): SessionTreeNode[] {
		return [];
	}

	async getSessionTreeAsync(): Promise<SessionTreeNode[]> {
		return (await this.request("get_session_tree")) as SessionTreeNode[];
	}

	getSessionInfo(): SessionInfoResult {
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

	async getSessionInfoAsync(): Promise<SessionInfoResult> {
		return (await this.request("get_session_info")) as SessionInfoResult;
	}

	listForkMessages(): Array<{ entryId: string; text: string }> {
		return [];
	}

	async listForkMessagesAsync(): Promise<Array<{ entryId: string; text: string }>> {
		return (await this.request("list_fork_messages")) as Array<{ entryId: string; text: string }>;
	}

	async setEntryLabel(entryId: string, label?: string): Promise<void> {
		await this.request("set_entry_label", { entryId, label });
	}

	async navigateSessionTree(
		entryId: string,
		summarize: boolean,
	): Promise<{ editorText?: string; cancelled: boolean; newLeafId?: string }> {
		return (await this.request("navigate_session_tree", { entryId, summarize })) as {
			editorText?: string;
			cancelled: boolean;
			newLeafId?: string;
		};
	}

	listSubagents(): SubagentSnapshot[] {
		return [];
	}

	async listSubagentsAsync(): Promise<SubagentSnapshot[]> {
		return (await this.request("list_subagents")) as SubagentSnapshot[];
	}

	readSubagent(): { transcript?: SubagentSnapshot; live?: SubagentSnapshot } {
		return {};
	}

	async readSubagentAsync(agentId: string): Promise<{ transcript?: SubagentSnapshot; live?: SubagentSnapshot }> {
		return (await this.request("read_subagent", { agentId })) as {
			transcript?: SubagentSnapshot;
			live?: SubagentSnapshot;
		};
	}

	async abortSubagent(agentId: string): Promise<void> {
		await this.request("abort_subagent", { agentId });
	}

	async continueSubagent(agentId: string, text: string): Promise<void> {
		await this.request("continue_subagent", { agentId, text });
	}

	async prompt(text: string, images?: GuiCompanionImage[]): Promise<void> {
		await this.request("prompt", { text, images });
	}

	async steer(text: string, images?: GuiCompanionImage[]): Promise<void> {
		await this.request("steer", { text, images });
	}

	async followUp(text: string, images?: GuiCompanionImage[]): Promise<void> {
		await this.request("follow_up", { text, images });
	}

	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		return (await this.request("clear_queue")) as { steering: string[]; followUp: string[] };
	}

	async compact(customInstructions?: string): Promise<void> {
		const result = await this.request("compact", { customInstructions });
		if (isGuiCompanionSnapshot(result)) this.applySnapshot(result);
	}

	async exportSession(outputPath?: string): Promise<{ path: string }> {
		return (await this.request("export_session", { outputPath })) as { path: string };
	}

	async importSession(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean; sessionPath?: string }> {
		return (await this.request("import_session", { inputPath, cwdOverride })) as {
			cancelled: boolean;
			sessionPath?: string;
		};
	}

	async shareSession(signal?: AbortSignal): Promise<{ previewUrl: string; gistUrl: string }> {
		if (signal?.aborted) throw new Error("分享已取消");
		const result = await this.exportSession();
		if (signal?.aborted) throw new Error("分享已取消");
		return { previewUrl: result.path, gistUrl: result.path };
	}

	getLastAssistantText(): string | undefined {
		return undefined;
	}

	async getLastAssistantTextAsync(): Promise<string | undefined> {
		const result = record(await this.request("get_last_assistant_text"));
		return typeof result?.text === "string" ? result.text : undefined;
	}

	async runBash(command: string, excludeFromContext: boolean, onChunk: (chunk: string) => void): Promise<JsonValue> {
		return (await this.request(
			"run_bash",
			{ bashCommand: command, excludeFromContext },
			{ onBashChunk: onChunk },
		)) as JsonValue;
	}

	async rename(name: string): Promise<void> {
		const result = await this.request("rename", { name });
		if (isGuiCompanionSnapshot(result)) this.applySnapshot(result);
	}

	async setModel(model: ModelRef): Promise<void> {
		const result = await this.request("set_model", { model });
		if (isGuiCompanionSnapshot(result)) this.applySnapshot(result);
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		const result = await this.request("set_thinking_level", { level });
		if (isGuiCompanionSnapshot(result)) this.applySnapshot(result);
	}

	async cycleModel(direction: "forward" | "backward"): Promise<{ changed: boolean; isScoped: boolean }> {
		const result = record(await this.request("cycle_model", { direction }));
		if (!result) throw new Error("TUI 共享会话返回了无效的模型切换结果");
		if (isGuiCompanionSnapshot(result.snapshot)) this.applySnapshot(result.snapshot);
		return { changed: result.changed === true, isScoped: result.isScoped === true };
	}

	async cycleThinkingLevel(): Promise<{ changed: boolean; supported: boolean }> {
		const result = record(await this.request("cycle_thinking_level"));
		if (!result) throw new Error("TUI 共享会话返回了无效的思考强度切换结果");
		if (isGuiCompanionSnapshot(result.snapshot)) this.applySnapshot(result.snapshot);
		return { changed: result.changed === true, supported: result.supported === true };
	}

	async fork(entryId: string, position?: "before" | "at"): Promise<{ sessionPath: string; selectedText?: string }> {
		const result = record(await this.request("fork_session", { entryId, position }));
		if (!result || typeof result.sessionPath !== "string") throw new Error("TUI 共享会话没有返回分叉路径");
		return {
			sessionPath: result.sessionPath,
			...(typeof result.selectedText === "string" ? { selectedText: result.selectedText } : {}),
		};
	}

	async abort(): Promise<void> {
		await this.request("abort");
	}

	async reloadResources(): Promise<void> {
		const result = await this.request("reload_resources");
		if (isGuiCompanionSnapshot(result)) this.applySnapshot(result);
	}

	async getCompletions(text: string, cursor: number): Promise<CompletionResult | undefined> {
		const result = await this.request("get_completions", { text, cursor });
		return result as CompletionResult | undefined;
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

	private applySnapshot(next: GuiCompanionSnapshotWire): void {
		this.snapshotValue = normalizeSnapshot(next);
		this.capabilities = [...this.snapshotValue.capabilities];
		this.revision++;
		this.emit({ type: "state_changed", payload: this.getSnapshot("owned") as unknown as JsonValue });
	}

	private handleMessage(line: string): void {
		let message: GuiCompanionServerMessage;
		try {
			message = JSON.parse(line) as GuiCompanionServerMessage;
		} catch {
			return;
		}
		if (message.type === "bash_chunk") {
			this.pending.get(message.requestId)?.onBashChunk?.(message.chunk);
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
			this.applySnapshot(message.snapshot);
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
		options: GuiCompanionRequestOptions = {},
		callbacks: { onBashChunk?: (chunk: string) => void } = {},
	): Promise<unknown> {
		if (!this.socket || this.disposed) return Promise.reject(new Error("TUI 共享会话已断开"));
		const requestId = randomUUID();
		let rejectRequest: (error: Error) => void = () => {};
		const pending = new Promise<unknown>((resolve, reject) => {
			rejectRequest = reject;
			this.pending.set(requestId, { resolve, reject, ...callbacks });
		});
		const message: Extract<GuiCompanionCommand, { type: "request" }> = {
			type: "request",
			requestId,
			command,
			...options,
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
