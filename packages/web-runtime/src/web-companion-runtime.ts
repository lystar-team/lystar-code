import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
	getWebCompanionEndpoint,
	WEB_COMPANION_CAPABILITIES,
	WEB_COMPANION_LEGACY_CAPABILITIES,
	WEB_COMPANION_LEGACY_PROTOCOL_VERSION,
	WEB_COMPANION_PROTOCOL_VERSION,
	type WebCompanionCapability,
	type WebCompanionCommand,
	type WebCompanionImage,
	type WebCompanionServerMessage,
	type WebCompanionSnapshot,
	type WebCompanionSnapshotWire,
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
} from "@lystar/code-web-protocol";
import type { RuntimeEvent, RuntimeSession } from "./types.ts";

type PendingResponse = {
	command: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
	onBashChunk?: (chunk: string) => void;
	timer?: ReturnType<typeof setTimeout>;
};
const MAX_COMPANION_BYTES = 8 * 1024 * 1024;
const COMPANION_HANDSHAKE_MS = 10_000;
const COMPANION_REQUEST_MS = 30_000;
const LONG_COMPANION_COMMANDS = new Set([
	"prompt",
	"compact",
	"run_bash",
	"navigate_session_tree",
	"reload_resources",
	"continue_subagent",
	"export_session",
	"import_session",
]);

type WebCompanionRequestOptions = Omit<
	Extract<WebCompanionCommand, { type: "request" }>,
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

function webSearchProgressSummary(call: Record<string, unknown>): string {
	const action = record(call.action);
	if (action?.type === "search") {
		if (typeof action.query === "string" && action.query.trim().length > 0) return action.query.trim();
		if (Array.isArray(action.queries)) {
			const query = action.queries.find(
				(value): value is string => typeof value === "string" && value.trim().length > 0,
			);
			if (query) return query.trim();
		}
		return "网页搜索";
	}
	if (action?.type === "open_page") return typeof action.url === "string" ? `打开 ${action.url}` : "打开网页";
	if (action?.type === "find_in_page") return typeof action.url === "string" ? `查找 ${action.url}` : "查找网页内容";
	return "网页搜索";
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

function isWebCompanionSnapshot(value: unknown): value is WebCompanionSnapshotWire {
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
		if (
			(stream?.type === "websearch_start" ||
				stream?.type === "websearch_update" ||
				stream?.type === "websearch_end") &&
			message?.role === "assistant"
		) {
			const call = record(stream.call);
			if (call && typeof call.id === "string") {
				const summary = webSearchProgressSummary(call);
				if (stream.type === "websearch_end") {
					updates.push({
						type: "tool_end",
						toolCallId: call.id,
						name: "web_search",
						status: call.status === "failed" ? "error" : "success",
						summary,
					});
				} else if (stream.type === "websearch_start") {
					updates.push({ type: "tool_start", toolCallId: call.id, name: "web_search", summary });
				} else {
					updates.push({ type: "tool_update", toolCallId: call.id, name: "web_search", summary });
				}
			}
		}
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
	if (event.type === "compaction_start") {
		const reason = event.reason;
		if (reason !== "manual" && reason !== "threshold" && reason !== "overflow") return [];
		return [
			{ type: "phase", phase: "compaction" },
			{ type: "compaction", status: "running", reason },
		];
	}
	if (event.type === "compaction_end") {
		const reason = event.reason;
		if (reason !== "manual" && reason !== "threshold" && reason !== "overflow") return [];
		const status = event.aborted
			? "cancelled"
			: event.result !== undefined && event.result !== null
				? "completed"
				: event.willRetry
					? "waiting_retry"
					: "failed";
		return [
			{
				type: "compaction",
				status,
				reason,
				...(typeof event.errorMessage === "string" ? { error: event.errorMessage.slice(0, 1024) } : {}),
			},
		];
	}
	if (event.type === "summarization_retry_scheduled") {
		const attempt =
			typeof event.attempt === "number" && Number.isInteger(event.attempt) && event.attempt > 0
				? event.attempt
				: undefined;
		const maxAttempts =
			typeof event.maxAttempts === "number" && Number.isInteger(event.maxAttempts) && event.maxAttempts > 0
				? event.maxAttempts
				: undefined;
		const delayMs =
			typeof event.delayMs === "number" && Number.isInteger(event.delayMs) && event.delayMs >= 0
				? event.delayMs
				: undefined;
		return [
			{ type: "phase", phase: "retry" },
			{
				type: "retry",
				status: "waiting",
				kind: "summarization",
				...(attempt === undefined ? {} : { attempt }),
				...(maxAttempts === undefined ? {} : { maxAttempts }),
				...(delayMs === undefined ? {} : { delayMs }),
				...(typeof event.errorMessage === "string" ? { error: event.errorMessage.slice(0, 1024) } : {}),
			},
		];
	}
	if (event.type === "summarization_retry_attempt_start") {
		if (event.source === "branchSummary") return [{ type: "retry", status: "running", kind: "branch_summary" }];
		if (event.source !== "compaction") return [];
		const reason = event.reason;
		if (reason !== "manual" && reason !== "threshold" && reason !== "overflow") return [];
		return [
			{ type: "phase", phase: "compaction" },
			{ type: "compaction", status: "running", reason },
			{ type: "retry", status: "running", kind: "compaction" },
		];
	}
	if (event.type === "summarization_retry_finished") {
		return [{ type: "retry", status: "completed", kind: "summarization" }];
	}
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

export class WebCompanionProtocolError extends Error {
	readonly code = "web_companion_protocol_incompatible";
	readonly retryable = false;
	readonly details: JsonValue;

	constructor(message: string, details: JsonValue) {
		super(message);
		this.name = "WebCompanionProtocolError";
		this.details = details;
	}
}

function normalizeSnapshot(value: WebCompanionSnapshotWire): WebCompanionSnapshot {
	const protocolVersion = value.protocolVersion ?? WEB_COMPANION_LEGACY_PROTOCOL_VERSION;
	if (
		protocolVersion !== WEB_COMPANION_LEGACY_PROTOCOL_VERSION &&
		protocolVersion !== WEB_COMPANION_PROTOCOL_VERSION
	) {
		throw new WebCompanionProtocolError("TUI 共享通道协议版本不受当前 Web Runtime 支持", {
			protocolVersion,
			supportedVersions: [WEB_COMPANION_LEGACY_PROTOCOL_VERSION, WEB_COMPANION_PROTOCOL_VERSION],
		});
	}
	if (protocolVersion === WEB_COMPANION_PROTOCOL_VERSION && !value.capabilities) {
		throw new WebCompanionProtocolError("TUI 共享通道缺少 v2 能力清单", { protocolVersion });
	}
	if (value.capabilities !== undefined && !Array.isArray(value.capabilities)) {
		throw new WebCompanionProtocolError("TUI 共享通道能力清单格式无效", { protocolVersion });
	}
	const capabilities = value.capabilities ?? [...WEB_COMPANION_LEGACY_CAPABILITIES];
	if (!capabilities.every((capability) => WEB_COMPANION_CAPABILITIES.includes(capability))) {
		throw new WebCompanionProtocolError("TUI 共享通道返回了未知能力", { protocolVersion });
	}
	return { ...value, protocolVersion, capabilities };
}

function snapshot(
	value: WebCompanionSnapshot,
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

export class WebCompanionRuntime implements RuntimeSession {
	private readonly listeners = new Set<(event: RuntimeEvent) => void>();
	private readonly pending = new Map<string, PendingResponse>();
	private socket?: Socket;
	private buffer = "";
	private readonly initialEvents: RuntimeEvent[] = [];
	private initialEventBytes = 0;
	private observed = false;
	private heartbeat?: ReturnType<typeof setInterval>;
	private snapshotValue: WebCompanionSnapshot;
	private liveMessage?: { text: string; thinking: string };
	private revision = 0;
	private disposed = false;
	private capabilities: WebCompanionCapability[];

	private readonly sessionPathValue: string;

	private constructor(sessionPathValue: string, initialSnapshot: WebCompanionSnapshotWire) {
		this.sessionPathValue = sessionPathValue;
		this.snapshotValue = normalizeSnapshot(initialSnapshot);
		this.liveMessage = initialSnapshot.liveMessage ? { ...initialSnapshot.liveMessage } : undefined;
		this.capabilities = [...this.snapshotValue.capabilities];
	}

	static async open(agentDir: string, sessionPath: string): Promise<WebCompanionRuntime> {
		return new Promise((resolve, reject) => {
			const socket = createConnection(getWebCompanionEndpoint(agentDir, sessionPath));
			socket.setEncoding("utf8");
			let runtime: WebCompanionRuntime | undefined;
			let buffer = "";
			const fail = (error: Error) => {
				clearTimeout(timer);
				runtime?.rejectPending(error);
				socket.destroy();
				reject(error);
			};
			const timer = setTimeout(() => fail(new Error("TUI 共享通道握手超时")), COMPANION_HANDSHAKE_MS);
			timer.unref?.();
			socket.once("error", fail);
			socket.once("close", () => fail(new Error("TUI 共享通道已关闭")));
			socket.once("connect", () => {
				socket.write(
					`${JSON.stringify({ type: "hello", sessionPath, protocolVersion: WEB_COMPANION_PROTOCOL_VERSION } satisfies WebCompanionCommand)}\n`,
				);
			});
			socket.on("data", (chunk: string) => {
				try {
					if (runtime) {
						runtime.consume(chunk);
						return;
					}
					buffer += chunk;
					const newline = buffer.indexOf("\n");
					if (newline < 0) {
						if (Buffer.byteLength(buffer) > MAX_COMPANION_BYTES) throw new Error("TUI 共享握手超过大小限制");
						return;
					}
					if (Buffer.byteLength(buffer.slice(0, newline)) > MAX_COMPANION_BYTES)
						throw new Error("TUI 共享握手超过大小限制");
					const message = JSON.parse(buffer.slice(0, newline)) as WebCompanionServerMessage;
					if (
						message.type !== "ready" ||
						!isWebCompanionSnapshot(message.snapshot) ||
						message.snapshot.path !== sessionPath
					) {
						throw new Error("TUI 共享通道返回了无效握手或会话路径");
					}
					runtime = new WebCompanionRuntime(sessionPath, message.snapshot);
					runtime.socket = socket;
					runtime.consume(buffer.slice(newline + 1));
					buffer = "";
					clearTimeout(timer);
					runtime.heartbeat = setInterval(() => {
						if (runtime?.isConnected()) void runtime.request("snapshot").catch(fail);
					}, COMPANION_HANDSHAKE_MS);
					runtime.heartbeat.unref?.();
					resolve(runtime);
				} catch (error) {
					fail(error instanceof Error ? error : new Error(String(error)));
				}
			});
		});
	}

	getLiveMessage(): { text: string; thinking: string } | undefined {
		return this.liveMessage ? { ...this.liveMessage } : undefined;
	}

	async readLiveMessage(): Promise<{ text: string; thinking: string } | undefined> {
		await this.request("snapshot");
		return this.liveMessage ? { ...this.liveMessage } : undefined;
	}

	get sessionPath(): string {
		return this.sessionPathValue;
	}

	isConnected(): boolean {
		return !this.disposed && this.socket !== undefined && !this.socket.destroyed;
	}

	ownsSessionWriter(): boolean {
		return false;
	}

	getCapabilities(): readonly WebCompanionCapability[] {
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

	async prompt(text: string, images?: WebCompanionImage[]): Promise<void> {
		await this.request("prompt", { text, images });
	}

	async steer(text: string, images?: WebCompanionImage[]): Promise<void> {
		await this.request("steer", { text, images });
	}

	async followUp(text: string, images?: WebCompanionImage[]): Promise<void> {
		await this.request("follow_up", { text, images });
	}

	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		return (await this.request("clear_queue")) as { steering: string[]; followUp: string[] };
	}

	async compact(customInstructions?: string): Promise<void> {
		const result = await this.request("compact", { customInstructions });
		if (isWebCompanionSnapshot(result)) this.applySnapshot(result);
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
		if (isWebCompanionSnapshot(result)) this.applySnapshot(result);
	}

	async setModel(model: ModelRef): Promise<void> {
		const result = await this.request("set_model", { model });
		if (isWebCompanionSnapshot(result)) this.applySnapshot(result);
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		const result = await this.request("set_thinking_level", { level });
		if (isWebCompanionSnapshot(result)) this.applySnapshot(result);
	}

	async cycleModel(direction: "forward" | "backward"): Promise<{ changed: boolean; isScoped: boolean }> {
		const result = record(await this.request("cycle_model", { direction }));
		if (!result) throw new Error("TUI 共享会话返回了无效的模型切换结果");
		if (isWebCompanionSnapshot(result.snapshot)) this.applySnapshot(result.snapshot);
		return { changed: result.changed === true, isScoped: result.isScoped === true };
	}

	async cycleThinkingLevel(): Promise<{ changed: boolean; supported: boolean }> {
		const result = record(await this.request("cycle_thinking_level"));
		if (!result) throw new Error("TUI 共享会话返回了无效的思考强度切换结果");
		if (isWebCompanionSnapshot(result.snapshot)) this.applySnapshot(result.snapshot);
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
		if (isWebCompanionSnapshot(result)) this.applySnapshot(result);
	}

	async getCompletions(text: string, cursor: number): Promise<CompletionResult | undefined> {
		const result = await this.request("get_completions", { text, cursor });
		return result as CompletionResult | undefined;
	}

	getToolRecoveryDiagnostics(): undefined {
		// Companion 未提供远端恢复统计，不能用本地假数据替代。
		return undefined;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.rejectPending();
		this.initialEvents.length = 0;
		this.listeners.clear();
		this.socket?.destroy();
		this.socket = undefined;
	}

	onEvent(listener: (event: RuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		this.observed = true;
		const pending = this.initialEvents.splice(0);
		this.initialEventBytes = 0;
		for (const event of pending) listener(event);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline);
			if (Buffer.byteLength(line) > MAX_COMPANION_BYTES) throw new Error("TUI 共享消息超过大小限制");
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim()) this.handleMessage(line);
			newline = this.buffer.indexOf("\n");
		}
		if (Buffer.byteLength(this.buffer) > MAX_COMPANION_BYTES) throw new Error("TUI 共享残帧超过大小限制");
	}

	private rejectPending(error = new Error("TUI 共享会话已断开")): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = undefined;
		for (const pending of this.pending.values()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private applySnapshot(next: WebCompanionSnapshotWire): void {
		if (!isWebCompanionSnapshot(next) || next.path !== this.sessionPathValue) throw new Error("TUI 共享快照无效");
		this.snapshotValue = normalizeSnapshot(next);
		if (next.liveMessage) {
			if (typeof next.liveMessage.text !== "string" || typeof next.liveMessage.thinking !== "string")
				throw new Error("TUI 生成内容快照无效");
			this.liveMessage = { ...next.liveMessage };
		}
		if (next.phase === "idle" && this.liveMessage) this.liveMessage = { text: "", thinking: "" };
		this.capabilities = [...this.snapshotValue.capabilities];
		this.revision++;
		this.emit({ type: "state_changed", payload: this.getSnapshot("owned") as unknown as JsonValue });
	}

	private handleMessage(line: string): void {
		const message = JSON.parse(line) as WebCompanionServerMessage;
		if (!record(message) || typeof message.type !== "string") throw new Error("TUI 共享消息无效");
		if (message.type === "bash_chunk") {
			this.pending.get(message.requestId)?.onBashChunk?.(message.chunk);
			return;
		}
		if (message.type === "response") {
			const pending = this.pending.get(message.requestId);
			if (!pending) return;
			if (message.ok && pending.command === "snapshot") {
				if (!isWebCompanionSnapshot(message.result)) throw new Error("TUI 共享快照响应无效");
				this.applySnapshot(message.result);
			}
			this.pending.delete(message.requestId);
			if (pending.timer) clearTimeout(pending.timer);
			if (message.ok) {
				pending.resolve(message.result);
			} else pending.reject(new Error(message.error));
			return;
		}
		if (message.type === "snapshot" || message.type === "ready") {
			this.applySnapshot(message.snapshot);
			return;
		}
		if (message.type === "agent_event") {
			for (const progress of projectAgentEvent(message.event)) {
				if (this.liveMessage) {
					if (progress.type === "assistant_delta") this.liveMessage.text += progress.text;
					if (progress.type === "thinking_delta") this.liveMessage.thinking += progress.text;
					if (progress.type === "phase" && (progress.phase === "turn" || progress.phase === "idle"))
						this.liveMessage = { text: "", thinking: "" };
				}
				this.emit({ type: "progress", payload: progress });
			}
			return;
		}
		if (message.type === "entry_committed") {
			this.snapshotValue = {
				...this.snapshotValue,
				transcriptGeneration: message.transcriptGeneration,
				transcriptRevision: message.transcriptRevision,
			};
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
		command: Extract<WebCompanionCommand, { type: "request" }>["command"],
		options: WebCompanionRequestOptions = {},
		callbacks: { onBashChunk?: (chunk: string) => void } = {},
	): Promise<unknown> {
		if (!this.isConnected()) return Promise.reject(new Error("TUI 共享会话已断开"));
		const requestId = randomUUID();
		const message = { type: "request", requestId, command, ...options } satisfies Extract<
			WebCompanionCommand,
			{ type: "request" }
		>;
		const bytes = `${JSON.stringify(message)}\n`;
		if (this.pending.size >= 128 || this.socket!.writableLength + Buffer.byteLength(bytes) > MAX_COMPANION_BYTES) {
			this.socket!.destroy();
			return Promise.reject(new Error("TUI 共享请求队列超过限制"));
		}
		return new Promise((resolve, reject) => {
			const pending: PendingResponse = { command, resolve, reject, ...callbacks };
			if (!LONG_COMPANION_COMMANDS.has(command)) {
				pending.timer = setTimeout(() => {
					this.rejectPending(new Error(`TUI 共享请求超时：${command}`));
					this.socket?.destroy();
				}, COMPANION_REQUEST_MS);
				pending.timer.unref?.();
			}
			this.pending.set(requestId, pending);
			this.socket!.write(bytes, (error) => {
				if (error) {
					this.rejectPending(error);
					this.socket?.destroy();
				}
			});
		});
	}

	private emit(event: RuntimeEvent): void {
		if (this.disposed) return;
		if (!this.observed) {
			this.initialEventBytes += Buffer.byteLength(JSON.stringify(event));
			if (this.initialEventBytes > MAX_COMPANION_BYTES) throw new Error("TUI 共享事件接管队列超过限制");
			this.initialEvents.push(event);
			return;
		}
		for (const listener of this.listeners) listener(event);
	}
}

export function isWebCompanionError(error: unknown): boolean {
	return error instanceof Error && /Web companion|TUI 共享会话/.test(error.message);
}
