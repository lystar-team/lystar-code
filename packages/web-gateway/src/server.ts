import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	CompletionResult,
	ContentChunk,
	GitDiff,
	GitStatus,
	GuiProtocolClient,
	HostDirectoryListing,
	JsonValue,
	ModelProviderSummary,
	ModelSummary,
	OperationSnapshot,
	ProjectInstruction,
	ProjectResource,
	ProjectTrust,
	ReadImageContentResult,
	ServerEvent,
	SessionProgress,
	SessionStateSnapshot,
	SessionSummary,
	SessionTreeNode,
	SettingSummary,
	TranscriptItem,
	TranscriptPage,
} from "@lystar/code-gui-protocol";
import { WebSocket, WebSocketServer } from "ws";
import {
	bearerToken,
	cookieValue,
	hostMatches,
	isValidClientId,
	loadWebGatewayConfig,
	originHostname,
	requestHostname,
	type WebGatewayConfig,
} from "./config.ts";
import { connectHostClient, type HostInitialSnapshot } from "./host-client.ts";
import { ProjectRegistry, type WebProject } from "./project-registry.ts";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const PROGRESS_BATCH_MS = 50;
const PUBLIC_SESSION_FIRST_MESSAGE_LIMIT = 512;
const BROWSER_CONTEXT_IDLE_MS = 60_000;
const ACTIVE_OPERATION_STATUSES = new Set<OperationSnapshot["status"]>(["accepted", "running", "waiting_for_input"]);

export type WebSessionSummary = Omit<SessionSummary, "path" | "cwd"> & { pinned?: boolean };
export type WebSessionSnapshot = Omit<SessionStateSnapshot, "path" | "cwd">;
type WebTranscriptItem = Omit<TranscriptItem, "payload">;
export type WebOperation = Omit<
	OperationSnapshot,
	"sessionPath" | "clientInstanceId" | "clientRequestId" | "payloadHash"
> & {
	sessionId?: string;
};
export interface WebLease {
	leaseId: string;
	leaseGeneration: number;
	createdAt: number;
	updatedAt: number;
}

interface SessionRef {
	id: string;
	path: string;
	projectId: string;
	cwd: string;
}

type ContextLease = {
	leaseId: string;
	leaseGeneration: number;
	sessionPath: string;
	createdAt: number;
	updatedAt: number;
};

interface BrowserContext {
	id: string;
	client?: GuiProtocolClient;
	connectPromise?: Promise<GuiProtocolClient>;
	initial?: HostInitialSnapshot;
	leases: Map<string, ContextLease>;
	sockets: Set<WebSocket>;
	sessionListPromises: Map<string, Promise<SessionSummary[]>>;
	sessionListCache: Map<string, SessionListCache>;
	sessionListGeneration: number;
	bootstrapGeneration: number;
	bootstrapCache?: BootstrapCache;
	bootstrapPromise?: Promise<BootstrapResponse>;
	activeRequests: number;
	idleTimer?: ReturnType<typeof setTimeout>;
	reconnectTimer?: ReturnType<typeof setTimeout>;
	progressTimer?: ReturnType<typeof setTimeout>;
	pendingProgress: PendingProgressEvent[];
	reconnectAttempt: number;
	connectionState: "unknown" | "connected" | "disconnected";
}

interface WebProjectResponse {
	id: string;
	name: string;
	path: string;
	pinned?: boolean;
	color?: WebProject["color"];
	archived?: boolean;
	sessions: WebSessionSummary[];
}

interface DirectoryResponse {
	path: string;
	parent?: string;
	home: string;
	entries: Array<{ name: string; path: string; hidden: boolean; kind: "directory" | "file" }>;
}

interface BootstrapResponse {
	projects: WebProjectResponse[];
	capabilities: readonly string[];
	connection: { connected: boolean; host: string; productVersion?: string };
	pendingUiRequests: Array<Extract<ServerEvent, { type: "ui_request" }>>;
	operations: WebOperation[];
	leases: Array<{ sessionId: string; lease: WebLease }>;
}

interface BootstrapCache {
	generation: number;
	value: BootstrapResponse;
}

type WebSessionProgressEvent = {
	type: "session_progress";
	sessionId: string;
	progress: SessionProgress;
};

interface PendingProgressEvent {
	key?: string;
	event: WebSessionProgressEvent;
}

function progressCoalescingKey(event: WebSessionProgressEvent): string | undefined {
	switch (event.progress.type) {
		case "assistant_delta":
		case "thinking_delta":
		case "phase":
		case "queue_update":
		case "status":
		case "usage":
			return `${event.sessionId}:${event.progress.type}`;
		case "tool_update":
			return `${event.sessionId}:${event.progress.type}:${event.progress.toolCallId}`;
		default:
			return undefined;
	}
}

function mergeProgress(left: SessionProgress, right: SessionProgress): SessionProgress {
	if (left.type === "assistant_delta" && right.type === "assistant_delta")
		return { type: "assistant_delta", text: left.text + right.text };
	if (left.type === "thinking_delta" && right.type === "thinking_delta")
		return { type: "thinking_delta", text: left.text + right.text };
	return right;
}

interface SessionListCache {
	generation: number;
	value: SessionSummary[];
}

class HttpError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: JsonValue;

	constructor(status: number, code: string, message: string, details?: JsonValue) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function statusOf(error: unknown): number {
	return error instanceof HttpError ? error.status : 500;
}

function toError(error: unknown): HttpError {
	if (error instanceof HttpError) return error;
	const candidate = object(error);
	const code = typeof candidate?.code === "string" ? candidate.code : "internal_error";
	const message = error instanceof Error ? error.message : String(error);
	if (code === "session_control_locked" || code === "session_locked")
		return new HttpError(409, code, "当前会话正在其他进程中使用");
	if (code === "invalid_session_lease") return new HttpError(409, code, "会话控制权已失效，请重新取得控制权");
	if (code === "operation_request_conflict") return new HttpError(409, code, "同一请求编号对应了不同内容");
	if (code === "operation_journal_corrupt") return new HttpError(503, code, "任务记录损坏，后台当前不可写");
	if (code === "instruction_conflict")
		return new HttpError(409, code, "全局 AGENTS.md 已被外部修改，请重新加载后再保存");
	if (code === "instruction_path_invalid") return new HttpError(400, code, "全局 AGENTS.md 路径无效");
	return new HttpError(statusOf(error), code, message);
}

function parseJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolvePromise, reject) => {
		const contentLength = Number(request.headers["content-length"] ?? 0);
		if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
			reject(new HttpError(413, "request_too_large", "请求内容超过大小限制"));
			request.resume();
			return;
		}
		const chunks: Buffer[] = [];
		let total = 0;
		request.on("data", (chunk: Buffer) => {
			total += chunk.byteLength;
			if (total > MAX_BODY_BYTES) {
				reject(new HttpError(413, "request_too_large", "请求内容超过大小限制"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			if (chunks.length === 0) {
				resolvePromise({});
				return;
			}
			try {
				const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				const record = object(value);
				if (!record) throw new Error("请求体必须是 JSON 对象");
				resolvePromise(record);
			} catch (error) {
				reject(new HttpError(400, "invalid_json", error instanceof Error ? error.message : "请求体不是有效 JSON"));
			}
		});
		request.on("error", reject);
	});
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers?: Record<string, string>): void {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
		...headers,
	});
	response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
	const value = toError(error);
	sendJson(response, value.status, {
		error: {
			code: value.code,
			message: value.message,
			...(value.details === undefined ? {} : { details: value.details }),
		},
	});
}

function setSecurityHeaders(response: ServerResponse): void {
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
	response.setHeader("Referrer-Policy", "same-origin");
	response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	response.setHeader(
		"Content-Security-Policy",
		"default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
	);
}

function orderSessionSummaries(
	sessions: readonly SessionSummary[],
	sessionOrder?: readonly string[],
): SessionSummary[] {
	if (!sessionOrder?.length) return [...sessions];
	const sessionsById = new Map(sessions.map((session) => [session.id, session]));
	const orderedIds = new Set<string>();
	const ordered = sessionOrder.flatMap((sessionId) => {
		const session = sessionsById.get(sessionId);
		if (!session) return [];
		orderedIds.add(sessionId);
		return [session];
	});
	return [...ordered, ...sessions.filter((session) => !orderedIds.has(session.id))];
}

function publicSessionSummary(session: SessionSummary, pinnedSessionIds?: readonly string[]): WebSessionSummary {
	const { path: _path, cwd: _cwd, ...result } = session;
	return {
		...result,
		...(pinnedSessionIds?.includes(result.id) ? { pinned: true } : {}),
		firstMessage:
			result.firstMessage.length > PUBLIC_SESSION_FIRST_MESSAGE_LIMIT
				? `${result.firstMessage.slice(0, PUBLIC_SESSION_FIRST_MESSAGE_LIMIT - 1)}…`
				: result.firstMessage,
	};
}

function publicSessionSnapshot(snapshot: SessionStateSnapshot): WebSessionSnapshot {
	const { path: _path, cwd: _cwd, ...result } = snapshot;
	return result;
}

function publicTranscriptItem(item: TranscriptItem): WebTranscriptItem {
	// Web 页面只使用投影后的 view；原始 payload 可能包含大型工具输出，不能重复传输。
	const { payload: _payload, ...result } = item;
	return result;
}

function publicLease(lease: {
	leaseId: string;
	leaseGeneration: number;
	createdAt: number;
	updatedAt: number;
}): WebLease {
	return {
		leaseId: lease.leaseId,
		leaseGeneration: lease.leaseGeneration,
		createdAt: lease.createdAt,
		updatedAt: lease.updatedAt,
	};
}

function publicOperation(operation: OperationSnapshot, sessionId?: string): WebOperation {
	const {
		sessionPath: _sessionPath,
		clientInstanceId: _clientInstanceId,
		clientRequestId: _clientRequestId,
		payloadHash: _payloadHash,
		...result
	} = operation;
	return { ...result, ...(sessionId ? { sessionId } : {}) };
}

function parsePathParts(pathname: string): string[] {
	return pathname
		.split("/")
		.filter(Boolean)
		.map((part) => {
			try {
				return decodeURIComponent(part);
			} catch {
				throw new HttpError(400, "invalid_path", "请求路径不是有效编码");
			}
		});
}

function isInside(root: string, candidate: string): boolean {
	const value = relative(root, candidate);
	return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function relativePath(root: string, candidate: string): string {
	const value = relative(root, candidate);
	return value === "." ? "" : value.split(sep).join("/");
}

function latestOperation(operations: OperationSnapshot[], sessionPath: string): OperationSnapshot | undefined {
	return operations
		.filter((operation) => operation.sessionPath === sessionPath)
		.sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

async function readChunks(read: (offset: number) => Promise<ContentChunk>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let offset = 0;
	let total = 0;
	while (true) {
		const chunk = await read(offset);
		if (chunk.offset !== offset || (!chunk.done && chunk.nextOffset <= offset)) {
			throw new HttpError(502, "invalid_content_chunk", "后台返回了无效的文件分块");
		}
		const bytes = Buffer.from(chunk.data, "base64");
		total += bytes.byteLength;
		if (total > MAX_FILE_BYTES) throw new HttpError(413, "file_too_large", "文件超过浏览器查看大小限制");
		chunks.push(new Uint8Array(bytes));
		offset = chunk.nextOffset;
		if (chunk.done) {
			const result = new Uint8Array(total);
			let position = 0;
			for (const part of chunks) {
				result.set(part, position);
				position += part.byteLength;
			}
			return result;
		}
	}
}

export class WebGatewayServer {
	readonly config: WebGatewayConfig;
	readonly registry: ProjectRegistry;
	private readonly contexts = new Map<string, BrowserContext>();
	private readonly sessions = new Map<string, SessionRef>();
	private readonly sessionIdsByPath = new Map<string, string>();
	private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
	private readonly server: Server;
	private readonly heartbeatTimer: ReturnType<typeof setInterval>;
	private readonly socketLiveness = new WeakMap<WebSocket, boolean>();
	private listening = false;
	private closed = false;

	constructor(config: WebGatewayConfig) {
		this.config = config;
		this.registry = new ProjectRegistry(config.agentDir);
		this.server = createServer((request, response) => void this.handleRequest(request, response));
		this.server.on("upgrade", (request, socket, head) => void this.handleUpgrade(request, socket, head));
		this.webSockets.on("connection", (socket, request) => void this.handleWebSocket(socket, request));
		this.heartbeatTimer = setInterval(() => this.checkWebSocketLiveness(), 15_000);
		this.heartbeatTimer.unref?.();
	}

	async listen(): Promise<void> {
		await this.registry.load();
		await new Promise<void>((resolvePromise, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.config.port, this.config.host, () => {
				this.server.off("error", reject);
				this.listening = true;
				resolvePromise();
			});
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.heartbeatTimer);
		for (const context of this.contexts.values()) {
			if (context.idleTimer) clearTimeout(context.idleTimer);
			if (context.reconnectTimer) clearTimeout(context.reconnectTimer);
			this.clearPendingProgress(context);
			for (const socket of context.sockets) socket.close(1001, "Web Gateway stopped");
			await context.client?.close().catch(() => {});
		}
		this.contexts.clear();
		await new Promise<void>((resolvePromise) => {
			if (!this.listening) {
				resolvePromise();
				return;
			}
			this.server.close(() => resolvePromise());
		});
		this.listening = false;
	}

	getToken(): string {
		return this.config.token;
	}

	private createContext(id: string): BrowserContext {
		return {
			id,
			leases: new Map(),
			sockets: new Set(),
			sessionListPromises: new Map(),
			sessionListCache: new Map(),
			sessionListGeneration: 0,
			bootstrapGeneration: 0,
			activeRequests: 0,
			pendingProgress: [],
			reconnectAttempt: 0,
			connectionState: "unknown",
		};
	}

	private touchContext(context: BrowserContext): void {
		if (context.idleTimer) {
			clearTimeout(context.idleTimer);
			context.idleTimer = undefined;
		}
	}

	private clearPendingProgress(context: BrowserContext): void {
		if (context.progressTimer) {
			clearTimeout(context.progressTimer);
			context.progressTimer = undefined;
		}
		context.pendingProgress.length = 0;
	}

	private flushPendingProgress(context: BrowserContext): void {
		if (context.progressTimer) {
			clearTimeout(context.progressTimer);
			context.progressTimer = undefined;
		}
		if (context.pendingProgress.length === 0) return;
		const pending = context.pendingProgress.splice(0);
		for (const entry of pending) this.broadcast(context, entry.event);
	}

	private enqueueProgress(context: BrowserContext, event: WebSessionProgressEvent): void {
		const key = progressCoalescingKey(event);
		const previous = context.pendingProgress.at(-1);
		if (key && previous?.key === key) {
			previous.event = { ...event, progress: mergeProgress(previous.event.progress, event.progress) };
		} else {
			context.pendingProgress.push({ key, event });
		}
		if (context.pendingProgress.length >= 64) {
			this.flushPendingProgress(context);
			return;
		}
		if (context.progressTimer) return;
		const timer = setTimeout(() => {
			context.progressTimer = undefined;
			this.flushPendingProgress(context);
		}, PROGRESS_BATCH_MS);
		timer.unref?.();
		context.progressTimer = timer;
	}

	private scheduleContextCleanup(context: BrowserContext): void {
		if (
			this.closed ||
			this.contexts.get(context.id) !== context ||
			context.sockets.size > 0 ||
			context.activeRequests > 0 ||
			context.connectPromise ||
			context.reconnectTimer ||
			context.idleTimer
		)
			return;
		const timer = setTimeout(() => {
			context.idleTimer = undefined;
			if (
				context.sockets.size > 0 ||
				context.activeRequests > 0 ||
				context.connectPromise ||
				context.reconnectTimer ||
				this.contexts.get(context.id) !== context
			)
				return;
			this.contexts.delete(context.id);
			context.leases.clear();
			context.sessionListPromises.clear();
			this.clearPendingProgress(context);
			context.sessionListCache.clear();
			context.bootstrapCache = undefined;
			const client = context.client;
			context.client = undefined;
			context.initial = undefined;
			void client?.close().catch(() => {});
		}, BROWSER_CONTEXT_IDLE_MS);
		timer.unref?.();
		context.idleTimer = timer;
	}

	private invalidateBootstrap(context: BrowserContext): void {
		context.bootstrapGeneration += 1;
		context.sessionListGeneration += 1;
		if (context.sockets.size === 0 && context.activeRequests === 0) return;
		context.sessionListCache.clear();
		context.sessionListPromises.clear();
	}

	private contextFor(request: IncomingMessage, response?: ServerResponse, url?: URL): BrowserContext {
		const header = request.headers["x-lystar-client-id"];
		const headerValue = Array.isArray(header) ? header[0] : header;
		const queryValue = url?.searchParams.get("clientId") ?? undefined;
		const cookieClientId = cookieValue(request.headers.cookie, "lystar_web_client");
		const id = isValidClientId(headerValue)
			? headerValue
			: isValidClientId(queryValue)
				? queryValue
				: isValidClientId(cookieClientId)
					? cookieClientId
					: randomUUID();
		if (
			response &&
			!isValidClientId(headerValue) &&
			!isValidClientId(queryValue) &&
			!isValidClientId(cookieClientId)
		) {
			response.setHeader("Set-Cookie", `lystar_web_client=${id}; Path=/; SameSite=Lax; HttpOnly`);
		}
		let context = this.contexts.get(id);
		if (!context) {
			context = this.createContext(id);
			this.contexts.set(id, context);
		}
		this.touchContext(context);
		return context;
	}

	private assertRequestBoundary(request: IncomingMessage, requireOrigin = false): void {
		const hostname = requestHostname(
			Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host,
		);
		if (!hostname || !hostMatches(hostname, this.config.allowedHosts)) {
			throw new HttpError(400, "host_not_allowed", "当前访问地址不在 Web Host 白名单中");
		}
		const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
		if (origin) {
			const originHost = originHostname(origin);
			if (!originHost || !hostMatches(originHost, this.config.allowedHosts)) {
				throw new HttpError(403, "origin_not_allowed", "当前页面来源不在 Web Host 白名单中");
			}
		} else if (requireOrigin) {
			throw new HttpError(403, "origin_required", "WebSocket 连接缺少来源信息");
		}
	}

	private assertToken(request: IncomingMessage, websocket = false, url?: URL): void {
		const header = Array.isArray(request.headers.authorization)
			? request.headers.authorization[0]
			: request.headers.authorization;
		const candidate = bearerToken(header) ?? (websocket ? url?.searchParams.get("token")?.trim() : undefined);
		if (!candidate || candidate !== this.config.token)
			throw new HttpError(401, "unauthorized", "需要有效的 Web Token");
	}

	private async getClient(context: BrowserContext): Promise<GuiProtocolClient> {
		if (context.client?.getSnapshot().connected) return context.client;
		if (context.connectPromise) return context.connectPromise;
		const wasDisconnected = context.connectionState === "disconnected";
		let connectedClient: GuiProtocolClient | undefined;
		const promise = connectHostClient(
			this.config,
			context.id,
			(event) => this.handleHostEvent(context, event),
			(error) => this.handleHostDisconnect(context, connectedClient, error),
		)
			.then(async (result) => {
				connectedClient = result.client;
				context.client = result.client;
				context.initial = result.initial;
				await this.restoreContextLeases(context, result.client);
				if (context.client !== result.client) throw new Error("Web Host 在恢复会话控制权时断开");
				context.connectionState = "connected";
				context.reconnectAttempt = 0;
				if (wasDisconnected && context.sockets.size > 0) {
					this.broadcast(context, { type: "connection_state", connected: true, message: "Web Host 已恢复" });
					void this.pushBootstrap(context);
				}
				return result.client;
			})
			.finally(() => {
				if (context.connectPromise === promise) context.connectPromise = undefined;
				if (!context.client && context.sockets.size > 0) this.scheduleReconnect(context);
				this.scheduleContextCleanup(context);
			});
		context.connectPromise = promise;
		return promise;
	}

	private handleHostDisconnect(context: BrowserContext, client?: GuiProtocolClient, error?: Error): void {
		if (this.closed || (client && context.client && context.client !== client)) return;
		context.client = undefined;
		context.initial = undefined;
		this.clearPendingProgress(context);
		this.invalidateBootstrap(context);
		const shouldNotify = context.connectionState !== "disconnected" && context.sockets.size > 0;
		context.connectionState = "disconnected";
		if (shouldNotify) {
			this.broadcast(context, {
				type: "connection_state",
				connected: false,
				message: error?.message ?? "Web Host 已断开",
			});
		}
		this.scheduleReconnect(context);
		this.scheduleContextCleanup(context);
	}

	private scheduleReconnect(context: BrowserContext): void {
		if (this.closed || context.reconnectTimer || context.connectPromise || context.sockets.size === 0) return;
		const delay = Math.min(5_000, 250 * 2 ** Math.min(context.reconnectAttempt, 5));
		context.reconnectAttempt += 1;
		const timer = setTimeout(() => {
			context.reconnectTimer = undefined;
			void this.getClient(context).catch(() => {});
		}, delay);
		timer.unref?.();
		context.reconnectTimer = timer;
	}

	private async restoreContextLeases(context: BrowserContext, client: GuiProtocolClient): Promise<void> {
		const previousLeases = [...context.leases.entries()];
		for (const [sessionId, previous] of previousLeases) {
			try {
				const result = await client.request<{
					lease: ContextLease;
				}>({
					command: "acquire_session",
					sessionPath: previous.sessionPath,
					clientInstanceId: context.id,
				});
				context.leases.set(sessionId, result.lease);
			} catch {
				context.leases.delete(sessionId);
			}
		}
	}

	private async buildBootstrap(context: BrowserContext): Promise<BootstrapResponse> {
		const cached = context.bootstrapCache;
		if (cached && cached.generation === context.bootstrapGeneration) return cached.value;
		if (context.bootstrapPromise) return context.bootstrapPromise;
		const generation = context.bootstrapGeneration;
		const promise = (async () => {
			const client = await this.getClient(context);
			const projects = await Promise.all(
				this.registry.list().map(async (project) => {
					try {
						const sessions = await this.listProjectSessions(context, project);
						return this.publicProject(project, sessions);
					} catch {
						// 会话目录读取短暂超时时，先返回索引中最近一次成功读取的真实会话，避免整个工作台退化为空壳。
						return this.publicProject(project, project.recentSessions ?? []);
					}
				}),
			);
			const hello = client.getSnapshot().hello;
			const initial = context.initial;
			const value: BootstrapResponse = {
				projects,
				capabilities: hello?.capabilities ?? [],
				connection: {
					connected: true,
					host: "Web Host",
					...(hello?.productVersion ? { productVersion: hello.productVersion } : {}),
				},
				pendingUiRequests: initial?.pendingUiRequests ?? [],
				operations: (initial?.operations ?? []).map((operation) =>
					publicOperation(operation, this.sessions.get(operation.sessionPath)?.id),
				),
				leases: [...context.leases.entries()].map(([sessionId, lease]) => ({
					sessionId,
					lease: publicLease(lease),
				})),
			};
			context.bootstrapCache = { generation, value };
			return value;
		})();
		context.bootstrapPromise = promise;
		try {
			return await promise;
		} finally {
			if (context.bootstrapPromise === promise) context.bootstrapPromise = undefined;
		}
	}

	private async listProjectSessions(context: BrowserContext, project: WebProject): Promise<SessionSummary[]> {
		const cached = context.sessionListCache.get(project.id);
		if (cached?.generation === context.sessionListGeneration) return cached.value;
		const pending = context.sessionListPromises.get(project.id);
		if (pending) return pending;
		const generation = context.sessionListGeneration;
		const request = (async () => {
			const client = await this.getClient(context);
			const sessions = await client.request<SessionSummary[]>({
				command: "list_sessions",
				cwd: project.cwd,
				metadataOnly: true,
			});
			const sessionsById = new Map<string, SessionSummary>();
			for (const session of sessions) {
				const existing = sessionsById.get(session.id);
				if (!existing || session.updatedAt > existing.updatedAt) sessionsById.set(session.id, session);
			}
			const uniqueSessions = [...sessionsById.values()].sort(
				(left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
			);
			for (const session of uniqueSessions) {
				this.sessions.set(session.id, {
					id: session.id,
					path: session.path,
					projectId: project.id,
					cwd: session.cwd,
				});
				this.sessionIdsByPath.set(session.path, session.id);
			}
			const orderedSessions = orderSessionSummaries(uniqueSessions, project.sessionOrder);
			await this.registry.setRecentSessions(project.id, orderedSessions);
			context.sessionListCache.set(project.id, { generation, value: orderedSessions });
			return orderedSessions;
		})();
		context.sessionListPromises.set(project.id, request);
		try {
			return await request;
		} finally {
			if (context.sessionListPromises.get(project.id) === request) context.sessionListPromises.delete(project.id);
		}
	}

	private publicProject(project: WebProject, sessions: SessionSummary[]): WebProjectResponse {
		return {
			id: project.id,
			name: project.name,
			path: project.cwd,
			...(project.pinned ? { pinned: true } : {}),
			...(project.color ? { color: project.color } : {}),
			...(project.archived ? { archived: true } : {}),
			sessions: sessions.map((session) => publicSessionSummary(session, project.pinnedSessionIds)),
		};
	}

	private async resolveSession(context: BrowserContext, sessionId: string): Promise<SessionRef> {
		const cached = this.sessions.get(sessionId);
		if (cached) return cached;
		for (const project of this.registry.list()) {
			const sessions = await this.listProjectSessions(context, project);
			const session = sessions.find((candidate) => candidate.id === sessionId);
			if (session) return this.sessions.get(session.id)!;
		}
		throw new HttpError(404, "session_not_found", "未找到会话");
	}

	private project(id: string): WebProject {
		const project = this.registry.get(id);
		if (!project) throw new HttpError(404, "project_not_found", "未找到项目");
		return project;
	}

	private projectPath(project: WebProject, input: string | undefined): string {
		const value = input?.trim() ?? "";
		if (!value) return project.cwd;
		if (value.includes("\0") || isAbsolute(value))
			throw new HttpError(400, "invalid_project_path", "项目路径必须是相对路径");
		const candidate = resolve(project.cwd, value);
		if (!isInside(project.cwd, candidate))
			throw new HttpError(403, "project_path_escape", "目标路径不在当前项目范围内");
		return candidate;
	}

	private async projectTree(project: WebProject, input: string | undefined): Promise<DirectoryResponse> {
		const root = resolve(project.cwd);
		const directory = this.projectPath(project, input);
		const entries = await readdir(directory, { withFileTypes: true });
		const mapped = await Promise.all(
			entries.map(async (entry) => {
				const candidate = resolve(directory, entry.name);
				try {
					const canonicalPath = await realpath(candidate);
					if (!isInside(root, canonicalPath)) return undefined;
					const info = await stat(canonicalPath);
					if (!info.isDirectory() && !info.isFile()) return undefined;
					return {
						name: entry.name,
						path: relativePath(root, canonicalPath),
						hidden: entry.name.startsWith("."),
						kind: info.isDirectory() ? ("directory" as const) : ("file" as const),
					};
				} catch {
					return undefined;
				}
			}),
		);
		const visibleEntries = mapped.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
		visibleEntries.sort(
			(left, right) =>
				Number(right.kind === "directory") - Number(left.kind === "directory") ||
				left.name.localeCompare(right.name),
		);
		const parentCandidate = resolve(directory, "..");
		const parent =
			directory !== root && isInside(root, parentCandidate) ? relativePath(root, parentCandidate) : undefined;
		return {
			path: relativePath(root, directory),
			...(parent === undefined ? {} : { parent }),
			home: "",
			entries: visibleEntries,
		};
	}

	private async requireLease(
		context: BrowserContext,
		sessionId: string,
	): Promise<{
		leaseId: string;
		sessionPath: string;
		clientInstanceId: string;
		leaseGeneration: number;
		createdAt: number;
		updatedAt: number;
	}> {
		const lease = context.leases.get(sessionId);
		if (!lease) throw new HttpError(409, "session_control_required", "请先取得当前会话的控制权");
		return { ...lease, clientInstanceId: context.id };
	}

	private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		setSecurityHeaders(response);
		response.setHeader("Vary", "Origin");
		try {
			this.assertRequestBoundary(request, false);
			const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
			if (request.method === "OPTIONS") {
				response.writeHead(204, {
					"Access-Control-Allow-Headers": "Authorization, Content-Type, X-LYStar-Client-Id",
					"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
				});
				response.end();
				return;
			}
			if (url.pathname === "/healthz") {
				await this.handleHealth(response);
				return;
			}
			if (url.pathname.startsWith("/api/")) {
				this.assertToken(request);
				const context = this.contextFor(request, response);
				context.activeRequests += 1;
				try {
					await this.handleApi(request, response, url, context);
				} finally {
					context.activeRequests -= 1;
					this.scheduleContextCleanup(context);
				}
				return;
			}
			await this.handleStatic(response, url.pathname);
		} catch (error) {
			if (!response.headersSent) sendError(response, error);
			else response.destroy();
		}
	}

	private async handleHealth(response: ServerResponse): Promise<void> {
		let host: "connected" | "unavailable" = "unavailable";
		const activeContext = [...this.contexts.values()].find((context) =>
			Boolean(context.client?.getSnapshot().connected || context.connectPromise),
		);
		if (activeContext) {
			try {
				const client = activeContext.client ?? (await activeContext.connectPromise!);
				host = client.getSnapshot().connected ? "connected" : "unavailable";
			} catch {}
		} else {
			try {
				const context = this.createContext(`health-${randomUUID()}`);
				const client = await this.getClient(context);
				host = client.getSnapshot().connected ? "connected" : "unavailable";
				await client.close().catch(() => {});
			} catch {}
		}
		sendJson(response, host === "connected" ? 200 : 503, { ok: host === "connected", gateway: "ok", host });
	}

	private async handleStatic(response: ServerResponse, pathname: string): Promise<void> {
		const relativeName = pathname === "/" || pathname === "" ? "index.html" : pathname.replace(/^\/+/, "");
		const candidate = resolve(this.config.staticDir, relativeName);
		if (!isInside(resolve(this.config.staticDir), candidate))
			throw new HttpError(403, "static_path_escape", "无效的静态资源路径");
		let file = candidate;
		try {
			const info = await stat(file);
			if (!info.isFile()) throw new Error("not a file");
		} catch {
			file = join(this.config.staticDir, "index.html");
		}
		const body = await readFile(file);
		const extension = file.split(".").at(-1)?.toLowerCase();
		const types: Record<string, string> = {
			html: "text/html; charset=utf-8",
			js: "text/javascript; charset=utf-8",
			css: "text/css; charset=utf-8",
			json: "application/json; charset=utf-8",
			svg: "image/svg+xml",
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			ico: "image/x-icon",
			webp: "image/webp",
		};
		response.writeHead(200, {
			"Content-Type": types[extension ?? ""] ?? "application/octet-stream",
			"Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
			"Content-Length": body.byteLength,
		});
		response.end(body);
	}

	private async handleApi(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		context: BrowserContext,
	): Promise<void> {
		const parts = parsePathParts(url.pathname);
		if (parts[1] === "bootstrap" && request.method === "GET") {
			sendJson(response, 200, await this.buildBootstrap(context));
			return;
		}
		if (parts.length === 3 && parts[1] === "resources" && parts[2] === "external" && request.method === "GET") {
			const path = url.searchParams.get("path")?.trim();
			if (!path) throw new HttpError(400, "resource_path_required", "资源路径不能为空");
			const client = await this.getClient(context);
			const resource = await client.request<ProjectResource>({
				command: "resolve_external_resource",
				target: path,
			});
			const bytes = await readChunks((offset) =>
				client.request<ContentChunk>({
					command: "read_external_resource",
					path: resource.path,
					accessToken: resource.accessToken ?? "",
					offset,
					limit: 1024 * 1024,
				}),
			);
			sendJson(response, 200, {
				kind: resource.kind,
				path: resource.displayPath,
				mimeType: resource.mimeType,
				byteLength: bytes.byteLength,
				...(resource.kind === "image"
					? { data: Buffer.from(bytes).toString("base64") }
					: { content: Buffer.from(bytes).toString("utf8") }),
			});
			return;
		}
		if (parts[1] === "projects") {
			await this.handleProjects(request, response, url, context, parts);
			return;
		}
		if (parts[1] === "directories" && request.method === "GET") {
			const client = await this.getClient(context);
			const listing = await client.request<HostDirectoryListing>({
				command: "list_directories",
				...(url.searchParams.get("path") ? { path: url.searchParams.get("path")! } : {}),
			});
			sendJson(response, 200, {
				path: listing.path,
				...(listing.parent ? { parent: listing.parent } : {}),
				home: listing.home,
				entries: listing.entries,
			});
			return;
		}
		if (parts[1] === "sessions") {
			await this.handleSessions(request, response, url, context, parts);
			return;
		}
		if (parts[1] === "operations") {
			await this.handleOperations(request, response, url, context, parts);
			return;
		}
		if (parts[1] === "model-providers") {
			const client = await this.getClient(context);
			if (parts.length === 2 && request.method === "POST") {
				const body = await parseJsonBody(request);
				const provider = stringValue(body.provider);
				const baseUrl = stringValue(body.baseUrl);
				const api = stringValue(body.api);
				if (!provider || !baseUrl || !api)
					throw new HttpError(400, "model_provider_fields_required", "Provider、Base URL 和 API 类型不能为空");
				const result = await client.request<ModelProviderSummary[]>({
					command: "add_model_provider",
					provider,
					name: stringValue(body.name),
					baseUrl,
					api,
					...(stringValue(body.apiKey) ? { apiKey: stringValue(body.apiKey) } : {}),
					...(stringValue(body.catalogProvider) ? { catalogProvider: stringValue(body.catalogProvider) } : {}),
					...(body.clearCatalogProvider === true ? { clearCatalogProvider: true } : {}),
					clientInstanceId: context.id,
					clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
				});
				sendJson(response, 200, { providers: result });
				return;
			}
			if (parts.length === 4 && parts[3] === "models" && request.method === "POST") {
				const body = await parseJsonBody(request);
				const provider = stringValue(parts[2]);
				const id = stringValue(body.id);
				const input = Array.isArray(body.input)
					? body.input.filter((value): value is "text" | "image" => value === "text" || value === "image")
					: [];
				if (!provider || !id || input.length === 0)
					throw new HttpError(400, "model_fields_required", "模型 ID 和输入类型不能为空");
				const thinkingLevelMap = object(body.thinkingLevelMap);
				const result = await client.request<ModelSummary[]>({
					command: "add_provider_model",
					provider,
					id,
					name: stringValue(body.name),
					api: stringValue(body.api),
					baseUrl: stringValue(body.baseUrl),
					reasoning: body.reasoning === true,
					input,
					...(thinkingLevelMap
						? { thinkingLevelMap: jsonValue(thinkingLevelMap) as Record<string, string | null> }
						: {}),
					...(body.resetOverride === true ? { resetOverride: true } : {}),
					...(Number.isInteger(body.contextWindow) && Number(body.contextWindow) > 0
						? { contextWindow: Number(body.contextWindow) }
						: {}),
					...(Number.isInteger(body.maxTokens) && Number(body.maxTokens) > 0
						? { maxTokens: Number(body.maxTokens) }
						: {}),
					clientInstanceId: context.id,
					clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
				});
				sendJson(response, 200, { models: result });
				return;
			}
			if (parts.length === 4 && parts[3] === "sync" && request.method === "POST") {
				const provider = stringValue(parts[2]);
				if (!provider) throw new HttpError(400, "model_provider_required", "Provider 不能为空");
				const result = await client.request<ModelSummary[]>({
					command: "sync_model_provider",
					provider,
					clientInstanceId: context.id,
					clientRequestId: stringValue((await parseJsonBody(request)).clientRequestId) ?? randomUUID(),
				});
				sendJson(response, 200, { models: result });
				return;
			}
			throw new HttpError(404, "model_provider_not_found", "未找到模型 Provider 接口");
		}
		if (parts[1] === "models" && request.method === "GET") {
			const client = await this.getClient(context);
			const [models, providers] = await Promise.all([
				client.request<ModelSummary[]>({ command: "list_models" }),
				client.request<ModelProviderSummary[]>({ command: "list_model_providers" }),
			]);
			sendJson(response, 200, { models, providers });
			return;
		}
		if (parts[1] === "about" && request.method === "GET") {
			sendJson(response, 200, await (await this.getClient(context)).request<JsonValue>({ command: "get_about" }));
			return;
		}
		if (parts[1] === "diagnostics" && request.method === "GET") {
			const projectId = url.searchParams.get("projectId") ?? undefined;
			const project = projectId ? this.project(projectId) : undefined;
			sendJson(
				response,
				200,
				await (await this.getClient(context)).request<JsonValue>({
					command: "get_diagnostics",
					...(project ? { cwd: project.cwd } : {}),
				}),
			);
			return;
		}
		if (parts[1] === "settings") {
			await this.handleSettings(request, response, url, context, parts);
			return;
		}
		if (parts[1] === "ui-requests" && parts.length === 3 && request.method === "POST") {
			const body = await parseJsonBody(request);
			const client = await this.getClient(context);
			await client.respondToUi(parts[2], {
				...(body.value === undefined ? {} : { value: jsonValue(body.value) }),
				...(typeof body.confirmed === "boolean" ? { confirmed: body.confirmed } : {}),
				...(typeof body.cancelled === "boolean" ? { cancelled: body.cancelled } : {}),
			});
			sendJson(response, 200, { accepted: true });
			return;
		}
		throw new HttpError(404, "not_found", "未找到请求接口");
	}

	private async handleProjects(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		context: BrowserContext,
		parts: string[],
	): Promise<void> {
		if (parts.length === 2 && request.method === "GET") {
			const projects = await Promise.all(
				this.registry
					.list()
					.map(async (project) => this.publicProject(project, await this.listProjectSessions(context, project))),
			);
			sendJson(response, 200, { projects });
			return;
		}
		if (parts.length === 2 && request.method === "POST") {
			const body = await parseJsonBody(request);
			const cwd = stringValue(body.cwd);
			if (!cwd) throw new HttpError(400, "project_directory_required", "项目目录不能为空");
			const client = await this.getClient(context);
			const listing = await client.request<HostDirectoryListing>({ command: "list_directories", path: cwd });
			const project = await this.registry.add({ id: randomUUID(), cwd: listing.path, name: stringValue(body.name) });
			this.invalidateBootstrap(context);
			const sessions = await this.listProjectSessions(context, project);
			sendJson(response, 201, { project: this.publicProject(project, sessions) });
			return;
		}
		if (parts.length === 3 && parts[2] === "order" && request.method === "PATCH") {
			const body = await parseJsonBody(request);
			if (!Array.isArray(body.projectIds) || body.projectIds.some((id) => typeof id !== "string"))
				throw new HttpError(400, "project_order_invalid", "项目顺序数据无效");
			await this.registry.reorderProjects(body.projectIds);
			this.invalidateBootstrap(context);
			sendJson(response, 200, { orderedProjectIds: this.registry.list().map((candidate) => candidate.id) });
			return;
		}
		if (parts.length < 3) throw new HttpError(404, "project_not_found", "未找到项目");
		const projectId = parts[2];
		const project = this.project(projectId);
		if (parts.length === 3 && request.method === "PATCH") {
			const body = await parseJsonBody(request);
			const name = stringValue(body.name) ?? project.name;
			const update = await this.registry.update(projectId, {
				name,
				pinned: body.pinned === true,
				color: ["red", "orange", "green", "blue", "purple", "gray"].includes(String(body.color))
					? (body.color as WebProject["color"])
					: undefined,
				archived: body.archived === true,
			});
			this.invalidateBootstrap(context);
			sendJson(response, 200, {
				project: this.publicProject(update, await this.listProjectSessions(context, update)),
			});
			return;
		}
		if (parts.length === 3 && request.method === "DELETE") {
			await this.registry.remove(projectId);
			this.invalidateBootstrap(context);
			sendJson(response, 200, { removed: true });
			return;
		}
		if (parts.length === 5 && parts[3] === "sessions" && parts[4] === "order" && request.method === "PATCH") {
			const body = await parseJsonBody(request);
			if (!Array.isArray(body.sessionIds) || body.sessionIds.some((id) => typeof id !== "string"))
				throw new HttpError(400, "session_order_invalid", "会话顺序数据无效");
			const sessions = await this.listProjectSessions(context, project);
			const sessionIds = body.sessionIds;
			const knownSessionIds = new Set(sessions.map((session) => session.id));
			if (
				new Set(sessionIds).size !== sessionIds.length ||
				sessionIds.length !== sessions.length ||
				sessionIds.some((sessionId) => !knownSessionIds.has(sessionId))
			)
				throw new HttpError(400, "session_order_invalid", "会话顺序必须包含当前项目的全部会话");
			await this.registry.setSessionOrder(projectId, sessionIds);
			this.invalidateBootstrap(context);
			const orderedSessions = orderSessionSummaries(sessions, sessionIds);
			sendJson(response, 200, {
				sessions: orderedSessions.map((session) => publicSessionSummary(session, project.pinnedSessionIds)),
			});
			return;
		}
		if (parts.length === 6 && parts[3] === "sessions" && parts[5] === "pin" && request.method === "PATCH") {
			const sessionId = parts[4];
			const sessions = await this.listProjectSessions(context, project);
			if (!sessions.some((session) => session.id === sessionId))
				throw new HttpError(404, "session_not_found", "未找到项目中的会话");
			const body = await parseJsonBody(request);
			const updated = await this.registry.setSessionPinned(projectId, sessionId, body.pinned === true);
			this.invalidateBootstrap(context);
			sendJson(response, 200, {
				project: this.publicProject(updated, sessions),
			});
			return;
		}
		if (parts.length === 4 && parts[3] === "sessions" && request.method === "GET") {
			const sessions = await this.listProjectSessions(context, project);
			sendJson(response, 200, {
				sessions: sessions.map((session) => publicSessionSummary(session, project.pinnedSessionIds)),
			});
			return;
		}
		if (parts.length === 4 && parts[3] === "completions" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const text = typeof body.text === "string" ? body.text : "";
			const cursor = Number(body.cursor);
			if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length)
				throw new HttpError(400, "completion_cursor_invalid", "输入建议光标位置无效");
			const sessionId = stringValue(body.sessionId);
			const session = sessionId ? await this.resolveSession(context, sessionId) : undefined;
			if (session && session.projectId !== project.id)
				throw new HttpError(400, "completion_project_mismatch", "会话不属于当前项目");
			const result = await (await this.getClient(context)).request<CompletionResult>({
				command: "get_completions",
				cwd: project.cwd,
				...(session ? { sessionPath: session.path } : {}),
				text,
				cursor,
			});
			sendJson(response, 200, result);
			return;
		}
		if (parts.length >= 4 && parts[3] === "tree" && request.method === "GET") {
			sendJson(response, 200, await this.projectTree(project, url.searchParams.get("path") ?? undefined));
			return;
		}
		if (parts.length === 4 && parts[3] === "file" && request.method === "GET") {
			const path = url.searchParams.get("path")?.trim();
			if (!path) throw new HttpError(400, "file_path_required", "文件路径不能为空");
			const client = await this.getClient(context);
			const resource = await client.request<ProjectResource>({
				command: "resolve_project_resource",
				cwd: project.cwd,
				target: path,
			});
			const bytes = await readChunks((offset) =>
				client.request<ContentChunk>({
					command: "read_project_resource",
					cwd: project.cwd,
					path: resource.path,
					offset,
					limit: 1024 * 1024,
				}),
			);
			if (resource.kind === "image") {
				sendJson(response, 200, {
					kind: resource.kind,
					path: resource.displayPath,
					mimeType: resource.mimeType,
					byteLength: bytes.byteLength,
					data: Buffer.from(bytes).toString("base64"),
				});
			} else {
				sendJson(response, 200, {
					kind: resource.kind,
					path: resource.displayPath,
					mimeType: resource.mimeType,
					byteLength: bytes.byteLength,
					content: Buffer.from(bytes).toString("utf8"),
				});
			}
			return;
		}
		if (parts.length === 5 && parts[3] === "git" && parts[4] === "status" && request.method === "GET") {
			sendJson(
				response,
				200,
				await (await this.getClient(context)).request<GitStatus>({ command: "get_git_status", cwd: project.cwd }),
			);
			return;
		}
		if (parts.length === 5 && parts[3] === "git" && parts[4] === "diff" && request.method === "GET") {
			sendJson(
				response,
				200,
				await (await this.getClient(context)).request<GitDiff>({
					command: "get_git_diff",
					cwd: project.cwd,
					...(url.searchParams.get("path") ? { path: url.searchParams.get("path")! } : {}),
					staged: url.searchParams.get("staged") === "true",
				}),
			);
			return;
		}
		if (parts.length === 4 && parts[3] === "trust") {
			const client = await this.getClient(context);
			if (request.method === "GET") {
				sendJson(
					response,
					200,
					await client.request<ProjectTrust>({ command: "get_project_trust", cwd: project.cwd }),
				);
				return;
			}
			if (request.method === "POST") {
				const body = await parseJsonBody(request);
				if (typeof body.sessionId !== "string")
					throw new HttpError(400, "session_required", "写入项目信任状态需要当前会话");
				const session = await this.resolveSession(context, body.sessionId);
				const lease = await this.requireLease(context, body.sessionId);
				sendJson(
					response,
					200,
					await client.request<ProjectTrust>({
						command: "set_project_trust",
						cwd: project.cwd,
						trusted: body.trusted === true,
						sessionPath: session.path,
						leaseId: lease.leaseId,
						clientInstanceId: context.id,
						clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
					}),
				);
				return;
			}
		}
		if (parts.length === 4 && parts[3] === "skills") {
			const client = await this.getClient(context);
			if (request.method === "GET") {
				sendJson(response, 200, await client.request<JsonValue>({ command: "list_skills", cwd: project.cwd }));
				return;
			}
			if (request.method === "POST") {
				const body = await parseJsonBody(request);
				await client.request<JsonValue>({
					command: "set_skill_enabled",
					cwd: project.cwd,
					path: stringValue(body.path) ?? "",
					scope: body.scope === "user" ? "user" : "project",
					enabled: body.enabled === true,
					clientInstanceId: context.id,
					clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
				});
				sendJson(response, 200, await client.request<JsonValue>({ command: "list_skills", cwd: project.cwd }));
				return;
			}
		}
		throw new HttpError(404, "not_found", "未找到项目接口");
	}

	private async handleSessions(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		context: BrowserContext,
		parts: string[],
	): Promise<void> {
		if (parts.length === 2 && request.method === "POST") {
			const body = await parseJsonBody(request);
			const project = this.project(stringValue(body.projectId) ?? "");
			const client = await this.getClient(context);
			const result = await client.request<{
				lease: {
					leaseId: string;
					leaseGeneration: number;
					sessionPath: string;
					clientInstanceId: string;
					createdAt: number;
					updatedAt: number;
				};
				snapshot: SessionStateSnapshot;
			}>({
				command: "create_session",
				cwd: project.cwd,
				clientInstanceId: context.id,
				clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
			});
			const sessionId = result.snapshot.id;
			this.sessions.set(sessionId, {
				id: sessionId,
				path: result.snapshot.path,
				projectId: project.id,
				cwd: result.snapshot.cwd,
			});
			this.sessionIdsByPath.set(result.snapshot.path, sessionId);
			context.leases.set(sessionId, result.lease);
			this.invalidateBootstrap(context);
			sendJson(response, 201, { session: publicSessionSnapshot(result.snapshot), lease: publicLease(result.lease) });
			return;
		}
		if (parts.length < 3) throw new HttpError(404, "session_not_found", "未找到会话");
		const sessionId = parts[2];
		const session = await this.resolveSession(context, sessionId);
		const client = await this.getClient(context);
		if (parts.length === 3 && request.method === "GET") {
			sendJson(response, 200, {
				session: publicSessionSnapshot(
					await client.request<SessionStateSnapshot>({ command: "inspect_session", sessionPath: session.path }),
				),
			});
			return;
		}
		if (parts.length === 3 && request.method === "DELETE") {
			context.leases.delete(sessionId);
			await client.request({
				command: "delete_session",
				cwd: session.cwd,
				sessionPath: session.path,
				clientInstanceId: context.id,
				clientRequestId: randomUUID(),
			});
			this.sessions.delete(sessionId);
			if (this.sessionIdsByPath.get(session.path) === sessionId) this.sessionIdsByPath.delete(session.path);
			this.invalidateBootstrap(context);
			sendJson(response, 200, { removed: true });
			return;
		}
		if (parts.length === 4 && parts[3] === "control") {
			if (request.method === "POST") {
				const result = await client.request<{
					lease: {
						leaseId: string;
						leaseGeneration: number;
						sessionPath: string;
						clientInstanceId: string;
						createdAt: number;
						updatedAt: number;
					};
					snapshot: SessionStateSnapshot;
				}>({ command: "acquire_session", sessionPath: session.path, clientInstanceId: context.id });
				context.leases.set(sessionId, result.lease);
				this.invalidateBootstrap(context);
				sendJson(response, 200, {
					owned: true,
					lease: publicLease(result.lease),
					snapshot: publicSessionSnapshot(result.snapshot),
				});
				return;
			}
			if (request.method === "DELETE") {
				const lease = context.leases.get(sessionId);
				if (lease) {
					await client.request({ command: "release_session", sessionPath: session.path, leaseId: lease.leaseId });
					context.leases.delete(sessionId);
					this.invalidateBootstrap(context);
				}
				sendJson(response, 200, { released: true });
				return;
			}
		}
		if (parts.length === 4 && parts[3] === "transcript" && request.method === "GET") {
			const limitValue = Number(url.searchParams.get("limit") ?? "120");
			const limit = Number.isInteger(limitValue) ? Math.min(200, Math.max(1, limitValue)) : 120;
			const query = url.searchParams.get("search")?.trim();
			if (query) {
				sendJson(
					response,
					200,
					await client.request<JsonValue>({
						command: "search_transcript",
						sessionPath: session.path,
						query,
						...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
						limit: Math.min(100, limit),
					}),
				);
			} else {
				const page = await client.request<TranscriptPage>({
					command: "read_transcript",
					sessionPath: session.path,
					...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
					limit,
				});
				sendJson(response, 200, { ...page, items: page.items.map(publicTranscriptItem) });
			}
			return;
		}
		if (parts.length === 6 && parts[3] === "content" && parts[5] === "image" && request.method === "GET") {
			const image = await client.request<ReadImageContentResult>({
				command: "read_image_content",
				sessionPath: session.path,
				contentRef: parts[4],
			});
			sendJson(response, 200, image);
			return;
		}
		if (parts.length === 4 && parts[3] === "operations" && request.method === "GET") {
			const operations = await client.request<OperationSnapshot[]>({
				command: "list_operations",
				sessionPath: session.path,
			});
			sendJson(response, 200, { operations: operations.map((operation) => publicOperation(operation, sessionId)) });
			return;
		}
		if (parts.length === 4 && parts[3] === "tree" && request.method === "GET") {
			sendJson(response, 200, {
				tree: await client.request<SessionTreeNode[]>({ command: "get_session_tree", sessionPath: session.path }),
			});
			return;
		}
		if (parts.length === 5 && parts[3] === "tree" && parts[4] === "navigate" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const lease = await this.requireLease(context, sessionId);
			sendJson(
				response,
				200,
				await client.request<JsonValue>({
					command: "navigate_session_tree",
					sessionPath: session.path,
					leaseId: lease.leaseId,
					entryId: stringValue(body.entryId) ?? "",
					summarize: body.summarize === true,
					clientInstanceId: context.id,
					clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
				}),
			);
			return;
		}
		if (parts.length === 4 && parts[3] === "prompt") {
			await this.handlePromptLike(request, response, context, sessionId, session, "prompt");
			return;
		}
		if (parts.length === 4 && parts[3] === "steer") {
			await this.handlePromptLike(request, response, context, sessionId, session, "steer");
			return;
		}
		if (parts.length === 4 && parts[3] === "follow-up") {
			await this.handlePromptLike(request, response, context, sessionId, session, "follow_up");
			return;
		}
		if (parts.length === 4 && parts[3] === "abort" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const lease = await this.requireLease(context, sessionId);
			const operations = await client.request<OperationSnapshot[]>({
				command: "list_operations",
				sessionPath: session.path,
			});
			const operation = stringValue(body.operationId)
				? operations.find((candidate) => candidate.operationId === body.operationId)
				: latestOperation(operations, session.path);
			if (!operation || !ACTIVE_OPERATION_STATUSES.has(operation.status))
				throw new HttpError(409, "no_active_operation", "当前会话没有正在运行的任务");
			sendJson(
				response,
				200,
				await client.request<JsonValue>({
					command: "abort_operation",
					operationId: operation.operationId,
					leaseId: lease.leaseId,
				}),
			);
			return;
		}
		if (parts.length === 4 && parts[3] === "compact" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const lease = await this.requireLease(context, sessionId);
			const result = await client.request<{ operation: OperationSnapshot }>({
				command: "compact",
				sessionPath: session.path,
				leaseId: lease.leaseId,
				clientInstanceId: context.id,
				clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
				...(stringValue(body.customInstructions) ? { customInstructions: body.customInstructions as string } : {}),
			});
			sendJson(response, 202, { operation: publicOperation(result.operation, sessionId) });
			return;
		}
		if (parts.length === 4 && parts[3] === "fork" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const lease = await this.requireLease(context, sessionId);
			const result = await client.request<{
				lease: {
					leaseId: string;
					leaseGeneration: number;
					sessionPath: string;
					clientInstanceId: string;
					createdAt: number;
					updatedAt: number;
				};
				snapshot: SessionStateSnapshot;
				selectedText?: string;
			}>({
				command: "fork_session",
				sessionPath: session.path,
				leaseId: lease.leaseId,
				entryId: stringValue(body.entryId) ?? "",
				...(body.position === "before" || body.position === "at" ? { position: body.position } : {}),
				clientInstanceId: context.id,
				clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
			});
			context.leases.delete(sessionId);
			const newSessionId = result.snapshot.id;
			this.sessions.set(newSessionId, {
				id: newSessionId,
				path: result.snapshot.path,
				projectId: session.projectId,
				cwd: result.snapshot.cwd,
			});
			this.sessionIdsByPath.set(result.snapshot.path, newSessionId);
			context.leases.set(newSessionId, result.lease);
			this.invalidateBootstrap(context);
			sendJson(response, 201, {
				session: publicSessionSnapshot(result.snapshot),
				lease: publicLease(result.lease),
				...(result.selectedText ? { selectedText: result.selectedText } : {}),
			});
			return;
		}
		if (parts.length === 4 && parts[3] === "rename" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const lease = await this.requireLease(context, sessionId);
			const snapshot = await client.request<SessionStateSnapshot>({
				command: "rename_session",
				sessionPath: session.path,
				leaseId: lease.leaseId,
				name: String(body.name ?? "").trim(),
				clientInstanceId: context.id,
				clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
			});
			sendJson(response, 200, { session: publicSessionSnapshot(snapshot) });
			return;
		}
		if (parts.length === 4 && parts[3] === "export" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const lease = await this.requireLease(context, sessionId);
			sendJson(
				response,
				200,
				await client.request<JsonValue>({
					command: "export_session",
					sessionPath: session.path,
					leaseId: lease.leaseId,
					clientInstanceId: context.id,
					clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
					...(stringValue(body.outputPath) ? { outputPath: body.outputPath as string } : {}),
				}),
			);
			return;
		}
		if (parts.length === 4 && parts[3] === "model" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const lease = await this.requireLease(context, sessionId);
			sendJson(response, 200, {
				session: publicSessionSnapshot(
					await client.request<SessionStateSnapshot>({
						command: "set_session_model",
						sessionPath: session.path,
						leaseId: lease.leaseId,
						model: {
							provider: stringValue(object(body.model)?.provider) ?? "",
							id: stringValue(object(body.model)?.id) ?? "",
						},
						clientInstanceId: context.id,
						clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
					}),
				),
			});
			return;
		}
		if (parts.length === 4 && parts[3] === "thinking" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const lease = await this.requireLease(context, sessionId);
			const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
			const level = stringValue(body.level);
			if (!level || !levels.has(level))
				throw new HttpError(400, "invalid_thinking_level", "不支持的 Thinking Level");
			sendJson(response, 200, {
				session: publicSessionSnapshot(
					await client.request<SessionStateSnapshot>({
						command: "set_session_thinking",
						sessionPath: session.path,
						leaseId: lease.leaseId,
						level: level as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra",
						clientInstanceId: context.id,
						clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
					}),
				),
			});
			return;
		}
		throw new HttpError(404, "not_found", "未找到会话接口");
	}

	private async handlePromptLike(
		request: IncomingMessage,
		response: ServerResponse,
		context: BrowserContext,
		sessionId: string,
		session: SessionRef,
		kind: "prompt" | "steer" | "follow_up",
	): Promise<void> {
		if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "该接口只支持 POST");
		const body = await parseJsonBody(request);
		const text = typeof body.text === "string" ? body.text : "";
		if (!text.trim()) throw new HttpError(400, "prompt_required", "消息内容不能为空");
		const lease = await this.requireLease(context, sessionId);
		const images = Array.isArray(body.images) ? body.images : undefined;
		const command = kind === "prompt" ? "prompt" : kind === "steer" ? "steer" : "follow_up";
		const result = await (await this.getClient(context)).request<{ operation?: OperationSnapshot }>({
			command,
			sessionPath: session.path,
			leaseId: lease.leaseId,
			clientInstanceId: context.id,
			clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
			text,
			...(images ? { images: jsonValue(images) as Array<{ data: string; mimeType: string }> } : {}),
		});
		sendJson(
			response,
			result.operation ? 202 : 200,
			result.operation ? { operation: publicOperation(result.operation, sessionId) } : { accepted: true },
		);
	}

	private async handleOperations(
		request: IncomingMessage,
		response: ServerResponse,
		_url: URL,
		context: BrowserContext,
		parts: string[],
	): Promise<void> {
		const client = await this.getClient(context);
		if (parts.length === 3 && request.method === "GET") {
			const operation = await client.request<OperationSnapshot>({ command: "get_operation", operationId: parts[2] });
			sendJson(response, 200, {
				operation: publicOperation(operation, this.sessions.get(operation.sessionPath)?.id),
			});
			return;
		}
		if (parts.length === 4 && parts[3] === "abort" && request.method === "POST") {
			const operationId = parts[2];
			const operation = await client.request<OperationSnapshot>({ command: "get_operation", operationId });
			const sessionId = this.sessions.get(operation.sessionPath)?.id;
			if (!sessionId) throw new HttpError(404, "session_not_found", "未找到任务所属会话");
			const lease = await this.requireLease(context, sessionId);
			sendJson(
				response,
				200,
				await client.request<JsonValue>({ command: "abort_operation", operationId, leaseId: lease.leaseId }),
			);
			return;
		}
		throw new HttpError(404, "operation_not_found", "未找到任务接口");
	}

	private async handleSettings(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		context: BrowserContext,
		parts: string[],
	): Promise<void> {
		if (parts.length === 3 && parts[2] === "host-instructions") {
			const client = await this.getClient(context);
			if (request.method === "GET") {
				sendJson(response, 200, {
					instructions: await client.request<ProjectInstruction[]>({ command: "list_host_instructions" }),
				});
				return;
			}
			if (request.method === "POST") {
				const body = await parseJsonBody(request);
				if (body.fileName !== "AGENTS.md")
					throw new HttpError(400, "instruction_file_invalid", "Web 端只支持管理全局 AGENTS.md");
				if (typeof body.content !== "string")
					throw new HttpError(400, "instruction_content_invalid", "全局 AGENTS.md 内容必须是文本");
				const instructions = await client.request<ProjectInstruction[]>({
					command: "save_host_instruction",
					fileName: "AGENTS.md",
					content: body.content,
					...(typeof body.expectedHash === "string" ? { expectedHash: body.expectedHash } : {}),
					clientInstanceId: context.id,
					clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
				});
				sendJson(response, 200, { instructions });
				return;
			}
			throw new HttpError(405, "method_not_allowed", "该接口不支持当前方法");
		}

		const sessionId = url.searchParams.get("sessionId")?.trim();
		if (!sessionId) throw new HttpError(400, "session_required", "设置接口需要当前会话");
		const session = await this.resolveSession(context, sessionId);
		const client = await this.getClient(context);
		if (request.method === "GET") {
			sendJson(response, 200, {
				settings: await client.request<SettingSummary[]>({ command: "list_settings", sessionPath: session.path }),
			});
			return;
		}
		if (request.method === "POST") {
			const body = await parseJsonBody(request);
			const lease = await this.requireLease(context, sessionId);
			sendJson(
				response,
				200,
				await client.request<JsonValue>({
					command: "set_setting",
					sessionPath: session.path,
					leaseId: lease.leaseId,
					clientInstanceId: context.id,
					clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
					id: stringValue(body.id) ?? "",
					value: jsonValue(body.value) as boolean | number | string,
				}),
			);
			return;
		}
		throw new HttpError(405, "method_not_allowed", "该接口不支持当前方法");
	}

	private async pushBootstrap(context: BrowserContext): Promise<void> {
		try {
			const bootstrap = await this.buildBootstrap(context);
			this.broadcast(context, { type: "bootstrap", data: bootstrap });
		} catch {
			this.broadcast(context, {
				type: "connection_state",
				connected: false,
				message: "Web Host 恢复后读取工作区失败",
			});
		}
	}

	private handleHostEvent(context: BrowserContext, event: ServerEvent): void {
		if (context.sockets.size === 0) {
			if (event.type !== "session_progress") {
				this.invalidateBootstrap(context);
				this.projectEvent(event);
			}
			return;
		}
		if (event.type !== "session_progress") this.invalidateBootstrap(context);
		const projected = this.projectEvent(event);
		if (!projected) return;
		if (projected.type === "session_progress") {
			this.enqueueProgress(context, projected as WebSessionProgressEvent);
			return;
		}
		this.flushPendingProgress(context);
		this.broadcast(context, projected);
	}

	private projectEvent(event: ServerEvent): Record<string, unknown> | undefined {
		if (event.type === "session_snapshot") {
			const ref = this.sessions.get(event.snapshot.id);
			if (ref) {
				if (ref.path !== event.snapshot.path && this.sessionIdsByPath.get(ref.path) === event.snapshot.id)
					this.sessionIdsByPath.delete(ref.path);
				this.sessionIdsByPath.set(event.snapshot.path, event.snapshot.id);
				this.sessions.set(event.snapshot.id, { ...ref, path: event.snapshot.path, cwd: event.snapshot.cwd });
				return {
					type: "session_snapshot",
					sessionId: event.snapshot.id,
					snapshot: publicSessionSnapshot(event.snapshot),
				};
			}
			this.sessionIdsByPath.set(event.snapshot.path, event.snapshot.id);
			return {
				type: "session_snapshot",
				sessionId: event.snapshot.id,
				snapshot: publicSessionSnapshot(event.snapshot),
			};
		}
		if (event.type === "session_removed") {
			const sessionId = this.sessionIdsByPath.get(event.sessionPath);
			if (!sessionId) return { type: "sessions_changed" };
			this.sessions.delete(sessionId);
			this.sessionIdsByPath.delete(event.sessionPath);
			return { type: "session_removed", sessionId };
		}
		if (event.type === "sessions_changed") {
			const projectId = this.registry.list().find((project) => project.cwd === event.cwd)?.id;
			return { type: "sessions_changed", ...(projectId ? { projectId } : {}) };
		}
		if (event.type === "transcript_changed") {
			const sessionId = this.sessionIdsByPath.get(event.sessionPath);
			return sessionId ? { type: "transcript_changed", sessionId } : undefined;
		}
		if (event.type === "transcript_committed") {
			const sessionId = this.sessionIdsByPath.get(event.sessionPath);
			return sessionId
				? {
						type: "transcript_committed",
						sessionId,
						transcriptGeneration: event.transcriptGeneration,
						fromRevision: event.fromRevision,
						toRevision: event.toRevision,
						items: event.items.map(publicTranscriptItem),
					}
				: undefined;
		}
		if (event.type === "session_progress") {
			const sessionId = this.sessionIdsByPath.get(event.sessionPath);
			return sessionId ? { type: "session_progress", sessionId, progress: event.progress } : undefined;
		}
		if (event.type === "operation_updated") {
			const sessionId = this.sessionIdsByPath.get(event.operation.sessionPath);
			return {
				type: "operation_updated",
				operation: publicOperation(event.operation, sessionId),
			};
		}
		if (event.type === "ui_request")
			return {
				type: "ui_request",
				id: event.id,
				operationId: event.operationId,
				kind: event.kind,
				title: event.title,
				payload: event.payload,
				...(event.timeoutMs ? { timeoutMs: event.timeoutMs } : {}),
			};
		return undefined;
	}

	private broadcast(context: BrowserContext, value: unknown): void {
		const payload = JSON.stringify(value);
		for (const socket of context.sockets) {
			if (socket.readyState !== WebSocket.OPEN) continue;
			if (socket.bufferedAmount > 2 * 1024 * 1024) {
				socket.terminate();
				continue;
			}
			socket.send(payload, (error) => {
				if (error) socket.terminate();
			});
		}
	}

	private checkWebSocketLiveness(): void {
		for (const context of this.contexts.values()) {
			for (const socket of context.sockets) {
				if (socket.readyState !== WebSocket.OPEN) continue;
				if (this.socketLiveness.get(socket) === false) {
					socket.terminate();
					continue;
				}
				this.socketLiveness.set(socket, false);
				socket.ping();
			}
		}
	}

	private handleUpgrade(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
		let context: BrowserContext | undefined;
		try {
			this.assertRequestBoundary(request, true);
			const url = new URL(request.url ?? "/ws", `http://${request.headers.host ?? "localhost"}`);
			if (url.pathname !== "/ws") throw new HttpError(404, "not_found", "未找到 WebSocket 接口");
			this.assertToken(request, true, url);
			context = this.contextFor(request, undefined, url);
			this.webSockets.handleUpgrade(request, socket, head, (webSocket) =>
				this.webSockets.emit("connection", webSocket, request),
			);
		} catch {
			if (context) this.scheduleContextCleanup(context);
			socket.destroy();
		}
	}

	private async handleWebSocket(socket: WebSocket, request: IncomingMessage): Promise<void> {
		const context = this.contextFor(
			request,
			undefined,
			new URL(request.url ?? "/ws", `http://${request.headers.host ?? "localhost"}`),
		);
		context.sockets.add(socket);
		this.touchContext(context);
		this.socketLiveness.set(socket, true);
		socket.on("pong", () => {
			this.socketLiveness.set(socket, true);
		});
		const removeSocket = () => {
			context.sockets.delete(socket);
			if (context.sockets.size === 0) this.clearPendingProgress(context);
			this.scheduleContextCleanup(context);
		};
		socket.on("close", removeSocket);
		socket.on("error", removeSocket);
		try {
			const bootstrap = await this.buildBootstrap(context);
			if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "bootstrap", data: bootstrap }));
		} catch (error) {
			if (socket.readyState === WebSocket.OPEN) socket.close(1011, toError(error).message.slice(0, 120));
		}
	}
}

export async function createWebGatewayServer(): Promise<WebGatewayServer> {
	return new WebGatewayServer(await loadWebGatewayConfig());
}
