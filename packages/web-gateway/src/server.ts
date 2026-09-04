import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	ContentChunk,
	GitDiff,
	GitStatus,
	GuiProtocolClient,
	HostDirectoryListing,
	JsonValue,
	ModelProviderSummary,
	ModelSummary,
	OperationSnapshot,
	ProjectResource,
	ProjectTrust,
	ServerEvent,
	SessionStateSnapshot,
	SessionSummary,
	SessionTreeNode,
	SettingSummary,
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
const ACTIVE_OPERATION_STATUSES = new Set<OperationSnapshot["status"]>(["accepted", "running", "waiting_for_input"]);

export type WebSessionSummary = Omit<SessionSummary, "path" | "cwd">;
export type WebSessionSnapshot = Omit<SessionStateSnapshot, "path" | "cwd">;
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

interface BrowserContext {
	id: string;
	client?: GuiProtocolClient;
	connectPromise?: Promise<GuiProtocolClient>;
	initial?: HostInitialSnapshot;
	leases: Map<
		string,
		{ leaseId: string; leaseGeneration: number; sessionPath: string; createdAt: number; updatedAt: number }
	>;
	sockets: Set<WebSocket>;
}

interface WebProjectResponse {
	id: string;
	name: string;
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

function publicSessionSummary(session: SessionSummary): WebSessionSummary {
	const { path: _path, cwd: _cwd, ...result } = session;
	return result;
}

function publicSessionSnapshot(snapshot: SessionStateSnapshot): WebSessionSnapshot {
	const { path: _path, cwd: _cwd, ...result } = snapshot;
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
	private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
	private readonly server: Server;
	private listening = false;

	constructor(config: WebGatewayConfig) {
		this.config = config;
		this.registry = new ProjectRegistry(config.agentDir);
		this.server = createServer((request, response) => void this.handleRequest(request, response));
		this.server.on("upgrade", (request, socket, head) => void this.handleUpgrade(request, socket, head));
		this.webSockets.on("connection", (socket, request) => void this.handleWebSocket(socket, request));
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
		for (const context of this.contexts.values()) {
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
			context = { id, leases: new Map(), sockets: new Set() };
			this.contexts.set(id, context);
		}
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
		const promise = connectHostClient(
			this.config,
			context.id,
			(event) => this.handleHostEvent(context, event),
			(error) => {
				if (context.client?.getSnapshot().connected === false) {
					context.client = undefined;
					context.connectPromise = undefined;
					context.initial = undefined;
					context.leases.clear();
					this.broadcast(context, {
						type: "connection_state",
						connected: false,
						message: error?.message ?? "Web Host 已断开",
					});
				}
			},
		)
			.then((result) => {
				context.client = result.client;
				context.initial = result.initial;
				return result.client;
			})
			.finally(() => {
				if (context.connectPromise === promise) context.connectPromise = undefined;
			});
		context.connectPromise = promise;
		return promise;
	}

	private async buildBootstrap(context: BrowserContext): Promise<BootstrapResponse> {
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
		return {
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
		};
	}

	private async listProjectSessions(context: BrowserContext, project: WebProject): Promise<SessionSummary[]> {
		const client = await this.getClient(context);
		const sessions = await client.request<SessionSummary[]>({ command: "list_sessions", cwd: project.cwd });
		const sessionsById = new Map<string, SessionSummary>();
		for (const session of sessions) {
			const existing = sessionsById.get(session.id);
			if (!existing || session.updatedAt > existing.updatedAt) sessionsById.set(session.id, session);
		}
		const uniqueSessions = [...sessionsById.values()].sort((left, right) => right.updatedAt - left.updatedAt);
		for (const session of uniqueSessions)
			this.sessions.set(session.id, { id: session.id, path: session.path, projectId: project.id, cwd: session.cwd });
		await this.registry.setRecentSessions(project.id, uniqueSessions);
		return uniqueSessions;
	}

	private publicProject(project: WebProject, sessions: SessionSummary[]): WebProjectResponse {
		return {
			id: project.id,
			name: project.name,
			...(project.pinned ? { pinned: true } : {}),
			...(project.color ? { color: project.color } : {}),
			...(project.archived ? { archived: true } : {}),
			sessions: sessions.map(publicSessionSummary),
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
				await this.handleApi(request, response, url, context);
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
		try {
			const context: BrowserContext = { id: `health-${randomUUID()}`, leases: new Map(), sockets: new Set() };
			const client = await this.getClient(context);
			host = client.getSnapshot().connected ? "connected" : "unavailable";
			await client.close().catch(() => {});
		} catch {}
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
			await this.handleSettings(request, response, url, context);
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
			const sessions = await this.listProjectSessions(context, project);
			sendJson(response, 201, { project: this.publicProject(project, sessions) });
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
			sendJson(response, 200, {
				project: this.publicProject(update, await this.listProjectSessions(context, update)),
			});
			return;
		}
		if (parts.length === 3 && request.method === "DELETE") {
			await this.registry.remove(projectId);
			sendJson(response, 200, { removed: true });
			return;
		}
		if (parts.length === 4 && parts[3] === "sessions" && request.method === "GET") {
			const sessions = await this.listProjectSessions(context, project);
			sendJson(response, 200, { sessions: sessions.map(publicSessionSummary) });
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
				sendJson(
					response,
					200,
					await client.request<JsonValue>({
						command: "set_skill_enabled",
						cwd: project.cwd,
						path: stringValue(body.path) ?? "",
						scope: body.scope === "user" ? "user" : "project",
						enabled: body.enabled === true,
						clientInstanceId: context.id,
						clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
					}),
				);
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
			context.leases.set(sessionId, result.lease);
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
				sendJson(
					response,
					200,
					await client.request<TranscriptPage>({
						command: "read_transcript",
						sessionPath: session.path,
						...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
						limit,
					}),
				);
			}
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
			context.leases.set(newSessionId, result.lease);
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
			const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
			const level = stringValue(body.level);
			if (!level || !levels.has(level))
				throw new HttpError(400, "invalid_thinking_level", "不支持的 Thinking Level");
			sendJson(response, 200, {
				session: publicSessionSnapshot(
					await client.request<SessionStateSnapshot>({
						command: "set_session_thinking",
						sessionPath: session.path,
						leaseId: lease.leaseId,
						level: level as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
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
	): Promise<void> {
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

	private handleHostEvent(context: BrowserContext, event: ServerEvent): void {
		const projected = this.projectEvent(event);
		if (projected) this.broadcast(context, projected);
	}

	private projectEvent(event: ServerEvent): Record<string, unknown> | undefined {
		if (event.type === "session_snapshot") {
			const ref = this.sessions.get(event.snapshot.id);
			if (ref) {
				this.sessions.set(event.snapshot.id, { ...ref, path: event.snapshot.path, cwd: event.snapshot.cwd });
				return {
					type: "session_snapshot",
					sessionId: event.snapshot.id,
					snapshot: publicSessionSnapshot(event.snapshot),
				};
			}
			return {
				type: "session_snapshot",
				sessionId: event.snapshot.id,
				snapshot: publicSessionSnapshot(event.snapshot),
			};
		}
		if (event.type === "session_removed") {
			const sessionId = [...this.sessions.values()].find((candidate) => candidate.path === event.sessionPath)?.id;
			if (!sessionId) return { type: "sessions_changed" };
			this.sessions.delete(sessionId);
			return { type: "session_removed", sessionId };
		}
		if (event.type === "sessions_changed") {
			const projectId = this.registry.list().find((project) => project.cwd === event.cwd)?.id;
			return { type: "sessions_changed", ...(projectId ? { projectId } : {}) };
		}
		if (event.type === "transcript_changed") {
			const sessionId = [...this.sessions.values()].find((candidate) => candidate.path === event.sessionPath)?.id;
			return sessionId ? { type: "transcript_changed", sessionId } : undefined;
		}
		if (event.type === "transcript_committed") {
			const sessionId = [...this.sessions.values()].find((candidate) => candidate.path === event.sessionPath)?.id;
			return sessionId
				? {
						type: "transcript_committed",
						sessionId,
						transcriptGeneration: event.transcriptGeneration,
						fromRevision: event.fromRevision,
						toRevision: event.toRevision,
						items: event.items,
					}
				: undefined;
		}
		if (event.type === "session_progress") {
			const sessionId = [...this.sessions.values()].find((candidate) => candidate.path === event.sessionPath)?.id;
			return sessionId ? { type: "session_progress", sessionId, progress: event.progress } : undefined;
		}
		if (event.type === "operation_updated") {
			const sessionId = [...this.sessions.values()].find(
				(candidate) => candidate.path === event.operation.sessionPath,
			)?.id;
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
			if (socket.readyState === WebSocket.OPEN) socket.send(payload);
		}
	}

	private handleUpgrade(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
		try {
			this.assertRequestBoundary(request, true);
			const url = new URL(request.url ?? "/ws", `http://${request.headers.host ?? "localhost"}`);
			if (url.pathname !== "/ws") throw new HttpError(404, "not_found", "未找到 WebSocket 接口");
			this.assertToken(request, true, url);
			const context = this.contextFor(request, undefined, url);
			this.webSockets.handleUpgrade(request, socket, head, (webSocket) =>
				this.webSockets.emit("connection", webSocket, request),
			);
			void context;
		} catch {
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
		socket.on("close", () => context.sockets.delete(socket));
		socket.on("error", () => context.sockets.delete(socket));
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
