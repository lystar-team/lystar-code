import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type FSWatcher, watch } from "node:fs";
import {
	type FileHandle,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Duplex, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw } from "node:zlib";
import {
	type CompletionResult,
	type ContentChunk,
	type GitBranches,
	type GitCommit,
	type GitDiff,
	type GitHistory,
	type GitMutationResult,
	type GitStats,
	type GitStatus,
	type HostDirectoryListing,
	isGitMutation,
	type JsonValue,
	type ModelOptions,
	type ModelProviderSummary,
	type ModelSummary,
	type OperationSnapshot,
	type ProjectFileSaveResult,
	type ProjectInstruction,
	type ProjectResource,
	type ProjectTrust,
	type ReadImageContentResult,
	type RuntimeProtocolClient,
	type ServerEvent,
	type SessionActivity,
	type SessionProgress,
	type SessionStateSnapshot,
	type SessionSummary,
	type SessionTreeNode,
	type SettingSummary,
	type SubagentConfig,
	type SubagentSnapshot,
	type ThinkingLevel,
	type TranscriptItem,
	type TranscriptPage,
} from "@lystar/code-web-protocol";
import {
	getRuntimeServiceStatus,
	loadProductBranding,
	restartRuntimeService,
	saveProductBranding,
	stopRuntimeService,
} from "@lystar/code-web-runtime";
import { WebSocket, WebSocketServer } from "ws";
import {
	bearerToken,
	cookieValue,
	DEFAULT_RUNTIME_PORT,
	hostMatches,
	isValidClientId,
	loadWebGatewayConfig,
	originHostname,
	parseGatewayPort,
	requestHostname,
	validateAllowedHosts,
	validateGatewayHost,
	validateWebPassword,
	WebConfigStore,
	type WebGatewayConfig,
} from "./config.ts";
import {
	type CpuSnapshot,
	calculateCpuUsage,
	diskUsage,
	hostCpu,
	hostMemory,
	hostNetworkAddresses,
	hostUptimeSeconds,
	readCpuSnapshot,
} from "./host-diagnostics.ts";
import {
	getMacosGitKeychainRequirement,
	getMacosPermissionsStatus,
	requestMacosPermission,
} from "./macos-permissions.ts";
import { ProductUpdateController } from "./product-update.ts";
import { type ProjectGroup, ProjectGroupRegistry } from "./project-group-registry.ts";
import { ProjectRegistry, type WebProject } from "./project-registry.ts";
import { connectRuntimeClient, ensurePersistentRuntime, type RuntimeInitialSnapshot } from "./runtime-client.ts";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_ATTACHMENTS = 8;
const MAX_PROMPT_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const UPLOAD_CLEANUP_MS = 5 * 60 * 1000;
const PROGRESS_BATCH_MS = 50;
const PUBLIC_SESSION_FIRST_MESSAGE_LIMIT = 512;
const BROWSER_CONTEXT_IDLE_MS = 60_000;
const ACTIVE_OPERATION_STATUSES = new Set<OperationSnapshot["status"]>(["accepted", "running", "waiting_for_input"]);
const MAX_SESSION_DETAIL_EVENTS = 256;
const MAX_SESSION_DETAIL_BYTES = 2 * 1024 * 1024;
const PROJECT_WATCH_DEBOUNCE_MS = 150;
const UPLOAD_EXTENSIONS: Record<string, string> = {
	"application/pdf": ".pdf",
	"application/zip": ".zip",
	"image/apng": ".apng",
	"image/bmp": ".bmp",
	"image/gif": ".gif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"text/css": ".css",
	"text/html": ".html",
	"text/javascript": ".js",
	"text/markdown": ".md",
	"text/plain": ".txt",
	"text/typescript": ".ts",
};

function uploadExtension(filename: string | undefined, mimeType: string): string {
	const extension = filename ? extname(filename).toLowerCase() : "";
	return /^\.[a-z0-9][a-z0-9._-]{0,15}$/u.test(extension) ? extension : (UPLOAD_EXTENSIONS[mimeType] ?? ".bin");
}

function xmlAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function promptFileTag(reference: { path: string; filename: string; mimeType: string }): string {
	return `<file name="${xmlAttribute(reference.path)}" filename="${xmlAttribute(reference.filename)}" mimeType="${xmlAttribute(reference.mimeType)}"></file>`;
}

function replacePromptFilePath(text: string, sourcePath: string, targetPath: string): string {
	return text.replaceAll(`name="${xmlAttribute(sourcePath)}"`, `name="${xmlAttribute(targetPath)}"`);
}

async function persistSessionAttachment(
	sessionPath: string,
	input: { bytes: Uint8Array; filename?: string; mimeType: string },
): Promise<{ path: string }> {
	const bytes = Buffer.from(input.bytes);
	const hash = contentHash(bytes);
	const resolvedSessionPath = resolve(sessionPath);
	const directory = join(
		dirname(resolvedSessionPath),
		".attachments",
		basename(resolvedSessionPath, extname(resolvedSessionPath)),
	);
	const path = join(directory, `${hash}${uploadExtension(input.filename, input.mimeType)}`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = await readFile(path);
		if (contentHash(existing) !== hash) {
			const temporaryPath = join(directory, `.${hash}.${process.pid}.${randomUUID()}.tmp`);
			try {
				await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
				await rename(temporaryPath, path);
			} finally {
				await unlink(temporaryPath).catch(() => {});
			}
		}
	}
	return { path };
}

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

interface SessionDeleteFailure {
	sessionId: string;
	status: number;
	code: string;
	message: string;
}

interface SessionDeleteResult {
	deletedIds: string[];
	failures: SessionDeleteFailure[];
}

interface ProjectWatcher {
	watcher: FSWatcher;
	paths: Set<string>;
	timer?: ReturnType<typeof setTimeout>;
}

type ModelSettingsResult = {
	models: ModelSummary[];
	providers: (ModelProviderSummary & { catalogProvider?: string })[];
};

type ContextLease = {
	leaseId: string;
	leaseGeneration: number;
	sessionPath: string;
	createdAt: number;
	updatedAt: number;
};

interface RuntimeConnectionStatus {
	pid?: number;
	processMemory?: {
		rssBytes: number;
		heapUsedBytes: number;
		externalBytes: number;
	};
}

interface BrowserContext {
	id: string;
	client?: RuntimeProtocolClient;
	connectPromise?: Promise<RuntimeProtocolClient>;
	initial?: RuntimeInitialSnapshot;
	leases: Map<string, ContextLease>;
	sockets: Set<WebSocket>;
	sessionListPromises: Map<string, Promise<SessionSummary[]>>;
	sessionListCache: Map<string, SessionListCache>;
	sessionSummaryState: Map<string, { name?: string; activity: SessionActivity; operationUpdatedAt?: number }>;
	sessionSnapshotState: Map<string, WebSessionSnapshot>;
	sessionDetailState: Map<string, SessionDetailState>;
	sessionListGeneration: number;
	bootstrapGeneration: number;
	bootstrapCache?: BootstrapCache;
	bootstrapPromise?: Promise<BootstrapResponse>;
	resumeGeneration?: number;
	resumeSessionIds: Set<string>;
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
	projectGroups: ProjectGroup[];
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

interface GatewaySecuritySettingsResponse {
	host: string;
	allowedHosts: string[];
	port: number;
	runtimePort: number;
	passwordConfigured: boolean;
	editable: {
		host: boolean;
		allowedHosts: boolean;
		port: boolean;
		runtimePort: boolean;
		password: boolean;
	};
}

type GatewaySecuritySettingsSaveResponse = GatewaySecuritySettingsResponse & {
	accepted: true;
	passwordChanged: boolean;
	restartPending: true;
	runtimePreserved: true;
};

type WebSessionProgressEvent = {
	type: "session_progress";
	sessionId: string;
	progress: SessionProgress;
};

type WebSubagentUpdatedEvent = {
	type: "subagent_updated";
	sessionId: string;
	snapshot: SubagentSnapshot;
	progress?: SessionProgress[];
};

interface PendingProgressEvent {
	key?: string;
	event: WebSessionProgressEvent;
}

interface SessionDetailRecord {
	seq: number;
	payload: string;
	bytes: number;
}

interface SessionDetailState {
	nextSeq: number;
	events: SessionDetailRecord[];
	bytes: number;
}

function sessionActivityFromProgress(progress: SessionProgress): SessionActivity | undefined {
	switch (progress.type) {
		case "phase":
			return progress.phase === "waiting_for_input"
				? "waiting_for_input"
				: progress.phase === "idle"
					? "idle"
					: "running";
		case "compaction":
			return progress.status === "running" || progress.status === "waiting_retry" ? "running" : undefined;
		case "retry":
			return progress.status === "running" || progress.status === "waiting" ? "running" : undefined;
		case "assistant_delta":
		case "thinking_delta":
		case "tool_start":
		case "tool_update":
		case "tool_end":
		case "user_message":
		case "bash":
			return "running";
		case "tool_state":
			return ["success", "error", "cancelled", "interrupted"].includes(progress.activity.state)
				? undefined
				: "running";
		case "queue_update":
		case "status":
		case "usage":
			return undefined;
	}
}

function sessionActivityFromOperation(status: OperationSnapshot["status"]): SessionActivity | undefined {
	if (status === "accepted" || status === "running") return "running";
	if (status === "waiting_for_input") return "waiting_for_input";
	if (status === "completed" || status === "failed" || status === "aborted" || status === "interrupted") return status;
	return undefined;
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
		case "tool_state":
			return `${event.sessionId}:${event.progress.type}:${event.progress.activity.toolCallId}`;
		default:
			return undefined;
	}
}

function shouldSendProgressImmediately(progress: SessionProgress): boolean {
	if (progress.type === "tool_start" || progress.type === "tool_end") return true;
	if (progress.type !== "tool_state") return false;
	return (
		(progress.activity.state === "running" &&
			progress.activity.progress === undefined &&
			progress.activity.output === undefined &&
			progress.activity.error === undefined) ||
		["success", "error", "cancelled", "interrupted"].includes(progress.activity.state)
	);
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

interface UploadedFile {
	byteLength: number;
	expiresAt: number;
	filename?: string;
	mimeType: string;
	persistedPath?: string;
}

interface PersistedUpload {
	byteLength: number;
	filename: string;
	mimeType: string;
	path: string;
	sourcePath: string;
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

function contentHash(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

export function scopedRuntimeClientId(profile: string | undefined, browserClientId: string): string {
	return createHash("sha256")
		.update(`${profile ?? "default"}\0${browserClientId}`)
		.digest("hex");
}

function statusOf(error: unknown): number {
	if (error instanceof HttpError) return error.status;
	const candidate = object(error);
	return typeof candidate?.status === "number" && candidate.status >= 400 && candidate.status < 600
		? candidate.status
		: 500;
}

function toError(error: unknown): HttpError {
	if (error instanceof HttpError) return error;
	const candidate = object(error);
	const code = typeof candidate?.code === "string" ? candidate.code : "internal_error";
	const message = error instanceof Error ? error.message : String(error);
	if (code === "session_control_locked" || code === "session_locked")
		return new HttpError(409, code, "当前会话正在其他进程中使用");
	if (code === "web_companion_protocol_incompatible")
		return new HttpError(503, code, "当前 TUI 与 Web Runtime 的共享协议不兼容，请重启 TUI 后重试");
	if (code === "invalid_session_lease") return new HttpError(409, code, "会话控制权已失效，请重新取得控制权");
	if (code === "operation_request_conflict") return new HttpError(409, code, "同一请求编号对应了不同内容");
	if (code === "operation_journal_corrupt") return new HttpError(503, code, "任务记录损坏，后台当前不可写");
	if (code === "instruction_conflict")
		return new HttpError(409, code, "全局 AGENTS.md 已被外部修改，请重新加载后再保存");
	if (code === "instruction_path_invalid") return new HttpError(400, code, "全局 AGENTS.md 路径无效");
	if (code === "project_file_conflict") return new HttpError(409, code, "文件已被外部修改，请重新加载后再保存");
	if (code === "git_credentials_required") return new HttpError(409, code, message);
	if (code === "project_file_not_editable" || code === "project_file_too_large") {
		return new HttpError(400, code, message);
	}
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

function sameSessionSnapshot(left: WebSessionSnapshot, right: WebSessionSnapshot): boolean {
	const leftModel = left.model;
	const rightModel = right.model;
	return (
		left.id === right.id &&
		left.name === right.name &&
		left.createdAt === right.createdAt &&
		left.updatedAt === right.updatedAt &&
		left.phase === right.phase &&
		left.activity === right.activity &&
		leftModel?.provider === rightModel?.provider &&
		leftModel?.id === rightModel?.id &&
		left.thinkingLevel === right.thinkingLevel &&
		left.attached === right.attached &&
		left.writeAccess === right.writeAccess &&
		left.leafId === right.leafId &&
		left.queuedSteerCount === right.queuedSteerCount &&
		left.queuedFollowUpCount === right.queuedFollowUpCount &&
		JSON.stringify(left.queuedSteerMessages ?? []) === JSON.stringify(right.queuedSteerMessages ?? []) &&
		JSON.stringify(left.queuedFollowUpMessages ?? []) === JSON.stringify(right.queuedFollowUpMessages ?? []) &&
		left.contextTokens === right.contextTokens &&
		left.contextWindow === right.contextWindow &&
		left.transcriptGeneration === right.transcriptGeneration &&
		left.transcriptRevision === right.transcriptRevision &&
		left.toolActivityEpoch === right.toolActivityEpoch &&
		left.toolActivityRevision === right.toolActivityRevision &&
		JSON.stringify(left.toolActivities ?? []) === JSON.stringify(right.toolActivities ?? [])
	);
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

interface ZipSourceEntry {
	path: string;
	archivePath: string;
	directory: boolean;
	mode: number;
	modifiedAt: Date;
}

interface ZipCentralEntry extends ZipSourceEntry {
	crc: number;
	compressedSize: number;
	uncompressedSize: number;
	localOffset: number;
	method: number;
}

const ZIP_MAX_VALUE = 0xffffffff;
const ZIP_MAX_ENTRIES = 0xffff;

function zipDateTime(date: Date): { date: number; time: number } {
	const year = Math.min(2107, Math.max(1980, date.getFullYear()));
	return {
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
	};
}

async function writeZipBuffer(handle: FileHandle, position: number, value: Buffer): Promise<number> {
	let offset = 0;
	while (offset < value.length) {
		const result = await handle.write(value, offset, value.length - offset, position + offset);
		offset += result.bytesWritten;
	}
	return position + value.length;
}

async function collectZipEntries(
	root: string,
	selections: ReadonlyArray<{ path: string; kind: "file" | "directory" }>,
): Promise<ZipSourceEntry[]> {
	const unique = [...new Map(selections.map((entry) => [entry.path, entry])).values()].sort(
		(left, right) => left.path.length - right.path.length || left.path.localeCompare(right.path),
	);
	const roots = unique.filter(
		(entry) =>
			!unique.some(
				(candidate) =>
					candidate.path !== entry.path && candidate.kind === "directory" && isInside(candidate.path, entry.path),
			),
	);
	const result: ZipSourceEntry[] = [];
	const archivePaths = new Set<string>();
	const visitedDirectories = new Set<string>();
	const append = (entry: ZipSourceEntry) => {
		if (archivePaths.has(entry.archivePath)) return;
		if (result.length >= ZIP_MAX_ENTRIES) {
			throw new HttpError(413, "archive_entry_limit", "ZIP 内文件数量超过 65535 个");
		}
		archivePaths.add(entry.archivePath);
		result.push(entry);
	};
	const visit = async (path: string, archivePath: string): Promise<void> => {
		const canonicalPath = await realpath(path);
		if (!isInside(root, canonicalPath)) return;
		const info = await stat(canonicalPath);
		const normalizedPath = archivePath.replaceAll("\\", "/").replace(/^\/+/, "");
		if (info.isDirectory()) {
			const directoryPath = normalizedPath.endsWith("/") ? normalizedPath : `${normalizedPath}/`;
			append({
				path: canonicalPath,
				archivePath: directoryPath,
				directory: true,
				mode: info.mode,
				modifiedAt: info.mtime,
			});
			if (visitedDirectories.has(canonicalPath)) return;
			visitedDirectories.add(canonicalPath);
			const children = await readdir(canonicalPath, { withFileTypes: true });
			children.sort((left, right) => left.name.localeCompare(right.name));
			for (const child of children) {
				const childCandidate = resolve(canonicalPath, child.name);
				let childPath: string;
				try {
					childPath = await realpath(childCandidate);
				} catch {
					continue;
				}
				if (!isInside(root, childPath)) continue;
				await visit(childPath, normalizedPath ? `${normalizedPath}/${child.name}` : child.name);
			}
			return;
		}
		if (!info.isFile()) return;
		append({
			path: canonicalPath,
			archivePath: normalizedPath,
			directory: false,
			mode: info.mode,
			modifiedAt: info.mtime,
		});
	};
	for (const selection of roots) await visit(selection.path, relativePath(root, selection.path));
	return result;
}

async function createZipArchive(outputPath: string, entries: readonly ZipSourceEntry[]): Promise<void> {
	const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		let position = 0;
		const centralEntries: ZipCentralEntry[] = [];
		for (const entry of entries) {
			const name = Buffer.from(entry.archivePath, "utf8");
			if (name.length > ZIP_MAX_ENTRIES) throw new HttpError(413, "archive_path_too_long", "ZIP 内路径过长");
			if (position > ZIP_MAX_VALUE) throw new HttpError(413, "archive_too_large", "ZIP 文件超过 4 GiB 上限");
			const timestamp = zipDateTime(entry.modifiedAt);
			const localOffset = position;
			const method = entry.directory ? 0 : 8;
			const flags = entry.directory ? 0x0800 : 0x0808;
			const localHeader = Buffer.alloc(30);
			localHeader.writeUInt32LE(0x04034b50, 0);
			localHeader.writeUInt16LE(20, 4);
			localHeader.writeUInt16LE(flags, 6);
			localHeader.writeUInt16LE(method, 8);
			localHeader.writeUInt16LE(timestamp.time, 10);
			localHeader.writeUInt16LE(timestamp.date, 12);
			localHeader.writeUInt16LE(name.length, 26);
			position = await writeZipBuffer(handle, position, localHeader);
			position = await writeZipBuffer(handle, position, name);

			let checksum = 0;
			let compressedSize = 0;
			let uncompressedSize = 0;
			if (!entry.directory) {
				const checksumStream = new Transform({
					transform(chunk: Buffer, _encoding, callback) {
						const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						uncompressedSize += data.length;
						checksum = crc32(data, checksum) >>> 0;
						if (uncompressedSize > ZIP_MAX_VALUE) {
							callback(new HttpError(413, "archive_entry_too_large", "ZIP 内单个文件超过 4 GiB 上限"));
							return;
						}
						callback(null, data);
					},
				});
				const output = new Writable({
					write(chunk: Buffer, _encoding, callback) {
						const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						void writeZipBuffer(handle!, position, data)
							.then((nextPosition) => {
								position = nextPosition;
								compressedSize += data.length;
								if (compressedSize > ZIP_MAX_VALUE || position > ZIP_MAX_VALUE) {
									callback(new HttpError(413, "archive_too_large", "ZIP 文件超过 4 GiB 上限"));
									return;
								}
								callback();
							})
							.catch((error) => callback(error as Error));
					},
				});
				await pipeline(createReadStream(entry.path), checksumStream, createDeflateRaw(), output);
				const descriptor = Buffer.alloc(16);
				descriptor.writeUInt32LE(0x08074b50, 0);
				descriptor.writeUInt32LE(checksum, 4);
				descriptor.writeUInt32LE(compressedSize, 8);
				descriptor.writeUInt32LE(uncompressedSize, 12);
				position = await writeZipBuffer(handle, position, descriptor);
			}
			centralEntries.push({ ...entry, crc: checksum, compressedSize, uncompressedSize, localOffset, method });
		}

		const centralOffset = position;
		for (const entry of centralEntries) {
			const name = Buffer.from(entry.archivePath, "utf8");
			const timestamp = zipDateTime(entry.modifiedAt);
			const header = Buffer.alloc(46);
			header.writeUInt32LE(0x02014b50, 0);
			header.writeUInt16LE(0x0314, 4);
			header.writeUInt16LE(20, 6);
			header.writeUInt16LE(entry.directory ? 0x0800 : 0x0808, 8);
			header.writeUInt16LE(entry.method, 10);
			header.writeUInt16LE(timestamp.time, 12);
			header.writeUInt16LE(timestamp.date, 14);
			header.writeUInt32LE(entry.crc, 16);
			header.writeUInt32LE(entry.compressedSize, 20);
			header.writeUInt32LE(entry.uncompressedSize, 24);
			header.writeUInt16LE(name.length, 28);
			header.writeUInt32LE((((entry.mode & 0xffff) << 16) | (entry.directory ? 0x10 : 0)) >>> 0, 38);
			header.writeUInt32LE(entry.localOffset, 42);
			position = await writeZipBuffer(handle, position, header);
			position = await writeZipBuffer(handle, position, name);
		}
		const centralSize = position - centralOffset;
		if (centralOffset > ZIP_MAX_VALUE || centralSize > ZIP_MAX_VALUE) {
			throw new HttpError(413, "archive_too_large", "ZIP 文件超过 4 GiB 上限");
		}
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(centralEntries.length, 8);
		end.writeUInt16LE(centralEntries.length, 10);
		end.writeUInt32LE(centralSize, 12);
		end.writeUInt32LE(centralOffset, 16);
		await writeZipBuffer(handle, position, end);
		await handle.sync();
		await handle.close();
		handle = undefined;
		try {
			await link(temporaryPath, outputPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new HttpError(409, "archive_name_conflict", "项目根目录下已有同名 ZIP 文件");
			}
			throw error;
		}
	} finally {
		await handle?.close().catch(() => {});
		await unlink(temporaryPath).catch(() => {});
	}
}

function latestOperation(operations: OperationSnapshot[], sessionPath: string): OperationSnapshot | undefined {
	return operations
		.filter((operation) => operation.sessionPath === sessionPath)
		.sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

async function readChunks(read: (offset: number) => Promise<ContentChunk>, maxBytes: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let offset = 0;
	let total = 0;
	while (total < maxBytes) {
		const chunk = await read(offset);
		if (chunk.offset !== offset || (!chunk.done && chunk.nextOffset <= offset)) {
			throw new HttpError(502, "invalid_content_chunk", "后台返回了无效的文件分块");
		}
		const bytes = Buffer.from(chunk.data, "base64");
		const accepted = bytes.subarray(0, Math.min(bytes.byteLength, maxBytes - total));
		total += accepted.byteLength;
		chunks.push(new Uint8Array(accepted));
		offset = chunk.nextOffset;
		if (chunk.done || accepted.byteLength < bytes.byteLength) break;
	}
	const result = new Uint8Array(total);
	let position = 0;
	for (const part of chunks) {
		result.set(part, position);
		position += part.byteLength;
	}
	return result;
}

export class WebGatewayServer {
	readonly config: WebGatewayConfig;
	readonly registry: ProjectRegistry;
	readonly projectGroups: ProjectGroupRegistry;
	private readonly contexts = new Map<string, BrowserContext>();
	private readonly sessions = new Map<string, SessionRef>();
	private readonly sessionIdsByPath = new Map<string, string>();
	private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
	private readonly server: Server;
	private readonly connections = new Set<Socket>();
	private closePromise?: Promise<void>;
	private readonly heartbeatTimer: ReturnType<typeof setInterval>;
	private readonly uploadCleanupTimer: ReturnType<typeof setInterval>;
	private readonly uploadedFiles = new Map<string, UploadedFile>();
	private readonly projectWatchers = new Map<string, ProjectWatcher>();
	private readonly productUpdate: ProductUpdateController;
	private modelCatalogRevision = 1;
	private readonly modelOptionsCache = new Map<string, { revision: number; value: ModelOptions }>();
	private readonly modelOptionsPromises = new Map<string, Promise<ModelOptions>>();
	private modelSettingsCache?: { revision: number; value: ModelSettingsResult };
	private modelSettingsPromise?: Promise<ModelSettingsResult>;
	private lastRuntimeModelCatalogEvent?: string;
	private readonly socketLiveness = new WeakMap<WebSocket, boolean>();
	private readonly detailSubscriptions = new WeakMap<WebSocket, Set<string>>();
	private readonly projectSubscriptions = new WeakMap<WebSocket, Set<string>>();
	private previousCpuSnapshot?: CpuSnapshot;
	private restartHandler?: () => void;
	private listening = false;
	private closed = false;

	constructor(config: WebGatewayConfig) {
		this.config = config;
		this.registry = new ProjectRegistry(config.agentDir);
		this.projectGroups = new ProjectGroupRegistry(config.agentDir);
		this.productUpdate = new ProductUpdateController(config.agentDir);
		this.server = createServer((request, response) => void this.handleRequest(request, response));
		this.server.on("connection", (socket) => {
			this.connections.add(socket);
			socket.once("close", () => this.connections.delete(socket));
		});
		this.server.on("upgrade", (request, socket, head) => void this.handleUpgrade(request, socket, head));
		this.webSockets.on("connection", (socket, request) => void this.handleWebSocket(socket, request));
		this.heartbeatTimer = setInterval(() => this.checkWebSocketLiveness(), 15_000);
		this.heartbeatTimer.unref?.();
		this.uploadCleanupTimer = setInterval(() => void this.cleanupUploadedFiles(), UPLOAD_CLEANUP_MS);
		this.uploadCleanupTimer.unref?.();
	}

	async listen(): Promise<void> {
		await this.registry.load();
		await this.projectGroups.load();
		await new Promise<void>((resolvePromise, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.config.port, this.config.host, () => {
				this.server.off("error", reject);
				this.listening = true;
				resolvePromise();
			});
		});
	}

	close(): Promise<void> {
		this.closePromise ??= this.shutdown();
		return this.closePromise;
	}

	private async shutdown(): Promise<void> {
		this.closed = true;
		clearInterval(this.heartbeatTimer);
		clearInterval(this.uploadCleanupTimer);
		// 未完成的 HTTP 请求和未响应关闭帧的 WebSocket 不能阻塞重新监听。
		const forceClose = setTimeout(() => {
			for (const socket of this.webSockets.clients) socket.terminate();
			for (const socket of this.connections) socket.destroy();
		}, 1_000);
		try {
			await this.cleanupUploadedFiles(true);
			for (const state of this.projectWatchers.values()) {
				if (state.timer) clearTimeout(state.timer);
				state.watcher.close();
			}
			this.projectWatchers.clear();
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
			for (const socket of this.webSockets.clients) socket.terminate();
			this.webSockets.close();
			this.listening = false;
		} finally {
			clearTimeout(forceClose);
		}
	}

	getToken(): string {
		return this.config.token;
	}

	private restartAfterResponse(response: ServerResponse): void {
		response.once("finish", () => {
			setImmediate(() => this.restartHandler?.());
		});
	}

	setRestartHandler(handler: () => void): void {
		this.restartHandler = handler;
	}

	private createContext(id: string): BrowserContext {
		return {
			id,
			leases: new Map(),
			sockets: new Set(),
			sessionListPromises: new Map(),
			sessionListCache: new Map(),
			sessionSummaryState: new Map(),
			sessionSnapshotState: new Map(),
			sessionDetailState: new Map(),
			sessionListGeneration: 0,
			bootstrapGeneration: 0,
			resumeSessionIds: new Set(),
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
		for (const entry of pending) this.broadcastSessionProgress(context, entry.event);
	}

	private enqueueProgress(context: BrowserContext, event: WebSessionProgressEvent): void {
		if (shouldSendProgressImmediately(event.progress)) {
			this.flushPendingProgress(context);
			this.broadcastSessionProgress(context, event);
			return;
		}
		const key = progressCoalescingKey(event);
		const previous = context.pendingProgress.at(-1);
		if (key && previous?.key === key) {
			previous.event = { ...event, progress: mergeProgress(previous.event.progress, event.progress) };
		} else {
			context.pendingProgress.push({ key, event });
		}
		if (context.pendingProgress.length >= 64 || JSON.stringify(context.pendingProgress).length >= 16 * 1024) {
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

	private invalidateAllBootstraps(): void {
		for (const context of this.contexts.values()) {
			this.invalidateBootstrap(context);
			if (context.sockets.size > 0) void this.pushBootstrap(context);
		}
	}

	private invalidateModelCatalog(): void {
		this.modelCatalogRevision += 1;
		this.modelOptionsCache.clear();
		this.modelOptionsPromises.clear();
		this.modelSettingsCache = undefined;
		this.modelSettingsPromise = undefined;
		for (const context of this.contexts.values()) {
			if (context.sockets.size > 0) {
				this.broadcast(context, { type: "model_catalog_changed", revision: this.modelCatalogRevision });
			}
		}
	}

	private async modelOptions(context: BrowserContext, includeProviders: readonly string[]): Promise<ModelOptions> {
		const normalizedProviders = [...new Set(includeProviders)].sort();
		const key = normalizedProviders.join("\0");
		const cached = this.modelOptionsCache.get(key);
		if (cached?.revision === this.modelCatalogRevision) return cached.value;
		const pending = this.modelOptionsPromises.get(key);
		if (pending) return pending;
		const revision = this.modelCatalogRevision;
		const promise = this.getClient(context).then((client) =>
			client.request<ModelOptions>({
				command: "list_model_options",
				...(normalizedProviders.length > 0 ? { includeProviders: normalizedProviders } : {}),
			}),
		);
		this.modelOptionsPromises.set(key, promise);
		try {
			const value = await promise;
			if (revision !== this.modelCatalogRevision) {
				if (this.modelOptionsPromises.get(key) === promise) this.modelOptionsPromises.delete(key);
				return this.modelOptions(context, normalizedProviders);
			}
			this.modelOptionsCache.set(key, { revision, value });
			return value;
		} finally {
			if (this.modelOptionsPromises.get(key) === promise) this.modelOptionsPromises.delete(key);
		}
	}

	private async modelSettings(context: BrowserContext): Promise<ModelSettingsResult> {
		if (this.modelSettingsCache?.revision === this.modelCatalogRevision) return this.modelSettingsCache.value;
		if (this.modelSettingsPromise) return this.modelSettingsPromise;
		const revision = this.modelCatalogRevision;
		const promise = this.getClient(context).then(async (client) => {
			const [models, providers] = await Promise.all([
				client.request<ModelSummary[]>({ command: "list_models" }),
				client.request<ModelProviderSummary[]>({ command: "list_model_providers" }),
			]);
			return { models, providers };
		});
		this.modelSettingsPromise = promise;
		try {
			const value = await promise;
			if (revision !== this.modelCatalogRevision) {
				if (this.modelSettingsPromise === promise) this.modelSettingsPromise = undefined;
				return this.modelSettings(context);
			}
			this.modelSettingsCache = { revision, value };
			return value;
		} finally {
			if (this.modelSettingsPromise === promise) this.modelSettingsPromise = undefined;
		}
	}

	private ensureProjectWatcher(project: WebProject): void {
		if (this.projectWatchers.has(project.id)) return;
		const onChange = (_eventType: string, filename: string | Buffer | null) => {
			const state = this.projectWatchers.get(project.id);
			if (!state) return;
			const path = filename ? String(filename).split(sep).join("/") : "";
			if (path === ".git/objects" || path.startsWith(".git/objects/")) return;
			state.paths.add(path);
			if (state.timer) clearTimeout(state.timer);
			state.timer = setTimeout(() => {
				state.timer = undefined;
				const paths = [...state.paths];
				state.paths.clear();
				for (const context of this.contexts.values()) {
					if (context.sockets.size > 0)
						this.broadcastProject(context, project.id, {
							type: "project_files_changed",
							projectId: project.id,
							paths,
						});
				}
			}, PROJECT_WATCH_DEBOUNCE_MS);
			state.timer.unref?.();
		};
		let watcher: FSWatcher;
		try {
			watcher = watch(project.cwd, { persistent: false, recursive: true }, onChange);
		} catch {
			watcher = watch(project.cwd, { persistent: false }, onChange);
		}
		const state: ProjectWatcher = { watcher, paths: new Set() };
		watcher.on("error", () => {
			if (state.timer) clearTimeout(state.timer);
			watcher.close();
			if (this.projectWatchers.get(project.id) === state) this.projectWatchers.delete(project.id);
		});
		this.projectWatchers.set(project.id, state);
	}

	private contextFor(request: IncomingMessage, response?: ServerResponse, url?: URL): BrowserContext {
		const header = request.headers["x-lystar-client-id"];
		const headerValue = Array.isArray(header) ? header[0] : header;
		const queryValue = url?.searchParams.get("clientId") ?? undefined;
		const cookieClientId = cookieValue(request.headers.cookie, "lystar_web_client");
		const browserClientId = isValidClientId(headerValue)
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
			response.setHeader("Set-Cookie", `lystar_web_client=${browserClientId}; Path=/; SameSite=Lax; HttpOnly`);
		}
		const id = scopedRuntimeClientId(this.config.serviceProfile, browserClientId);
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
			throw new HttpError(401, "unauthorized", "需要有效的 Web 密码");
	}

	private async getClient(context: BrowserContext): Promise<RuntimeProtocolClient> {
		if (context.client?.getSnapshot().connected) return context.client;
		if (context.connectPromise) return context.connectPromise;
		const wasDisconnected = context.connectionState === "disconnected";
		let connectedClient: RuntimeProtocolClient | undefined;
		const promise = connectRuntimeClient(
			this.config,
			context.id,
			(event) => this.handleHostEvent(context, event),
			(error) => this.handleRuntimeDisconnect(context, connectedClient, error),
		)
			.then(async (result) => {
				if (this.closed) {
					await result.client.close().catch(() => {});
					throw new Error("Web Gateway 已关闭");
				}
				connectedClient = result.client;
				context.client = result.client;
				context.initial = result.initial;
				await this.restoreContextLeases(context, result.client);
				if (context.client !== result.client) throw new Error("Web Runtime 在恢复会话控制权时断开");
				context.connectionState = "connected";
				context.reconnectAttempt = 0;
				if (wasDisconnected) this.invalidateModelCatalog();
				if (wasDisconnected && context.sockets.size > 0) {
					this.broadcast(context, { type: "connection_state", connected: true, message: "Web Runtime 已恢复" });
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

	private handleRuntimeDisconnect(context: BrowserContext, client?: RuntimeProtocolClient, error?: Error): void {
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
				message: error?.message ?? "Web Runtime 已断开",
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

	private async restoreContextLeases(context: BrowserContext, client: RuntimeProtocolClient): Promise<void> {
		const subscribedSessionIds = new Set<string>();
		for (const socket of context.sockets) {
			for (const sessionId of this.subscriptionsFor(socket)) subscribedSessionIds.add(sessionId);
		}
		const previousLeases = [...context.leases.entries()];
		const restoreLease = async ([sessionId, previous]: [string, ContextLease]): Promise<void> => {
			try {
				const result = await client.request<{
					lease: ContextLease;
				}>({
					command: "acquire_session",
					sessionPath: previous.sessionPath,
					clientInstanceId: context.id,
				});
				if (context.client !== client) {
					context.leases.delete(sessionId);
					return;
				}
				context.leases.set(sessionId, result.lease);
				const payload = JSON.stringify({ type: "session_lease", sessionId, lease: publicLease(result.lease) });
				for (const socket of context.sockets) {
					if (this.subscriptionsFor(socket).has(sessionId)) this.sendWebSocket(socket, payload);
				}
			} catch {
				context.leases.delete(sessionId);
			}
		};
		context.leases.clear();
		await Promise.all(previousLeases.filter(([sessionId]) => subscribedSessionIds.has(sessionId)).map(restoreLease));
		await Promise.all(previousLeases.filter(([sessionId]) => !subscribedSessionIds.has(sessionId)).map(restoreLease));
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
			const initial = await client.request<RuntimeInitialSnapshot>({ command: "get_snapshot" });
			if (context.client !== client || !client.getSnapshot().connected)
				throw new Error("Web Runtime 在读取工作区时断开");
			context.initial = initial;
			const operations = new Map(initial.operations.map((operation) => [operation.operationId, operation]));
			for (const operation of client.getSnapshot().operations.values()) {
				const previous = operations.get(operation.operationId);
				if (!previous || operation.updatedAt > previous.updatedAt) operations.set(operation.operationId, operation);
			}
			for (const snapshot of initial.sessions) this.sessionIdsByPath.set(snapshot.path, snapshot.id);
			const value: BootstrapResponse = {
				projects,
				projectGroups: this.projectGroups.list(),
				capabilities: hello?.capabilities ?? [],
				connection: {
					connected: true,
					host: "Web Host",
					...(hello?.productVersion ? { productVersion: hello.productVersion } : {}),
				},
				pendingUiRequests: initial?.pendingUiRequests ?? [],
				operations: [...operations.values()].map((operation) =>
					publicOperation(operation, this.sessionIdsByPath.get(operation.sessionPath)),
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
				if (!this.sessions.has(session.id)) {
					this.sessions.set(session.id, {
						id: session.id,
						path: session.path,
						projectId: project.id,
						cwd: session.cwd,
					});
				}
				this.sessionIdsByPath.set(session.path, session.id);
			}
			await this.registry.setRecentSessions(project.id, uniqueSessions);
			const refreshedProject = this.registry.get(project.id);
			const orderedSessions = orderSessionSummaries(uniqueSessions, refreshedProject?.sessionOrder);
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
		const projects = this.registry.list();
		for (const project of projects) {
			const recent = project.recentSessions?.find(
				(session) => session.id === sessionId && session.cwd === project.cwd,
			);
			if (!recent) continue;
			try {
				if (!(await stat(recent.path)).isFile()) continue;
			} catch {
				continue;
			}
			const resolved = { id: recent.id, path: recent.path, projectId: project.id, cwd: recent.cwd };
			this.sessions.set(sessionId, resolved);
			this.sessionIdsByPath.set(recent.path, sessionId);
			return resolved;
		}
		for (const project of projects) {
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

	private async projectEntryPath(
		project: WebProject,
		input: string,
	): Promise<{ path: string; root: string; kind: "file" | "directory" }> {
		const root = await realpath(resolve(project.cwd));
		const candidate = this.projectPath(project, input);
		let path: string;
		try {
			path = await realpath(candidate);
		} catch {
			throw new HttpError(404, "file_not_found", "文件或目录不存在");
		}
		if (!isInside(root, path)) throw new HttpError(403, "project_path_escape", "目标路径不在当前项目范围内");
		const info = await stat(path);
		if (!info.isFile() && !info.isDirectory()) {
			throw new HttpError(400, "file_not_regular", "目标不是普通文件或目录");
		}
		return { path, root, kind: info.isDirectory() ? "directory" : "file" };
	}

	private async projectFilePath(project: WebProject, input: string): Promise<{ path: string; root: string }> {
		const entry = await this.projectEntryPath(project, input);
		if (entry.kind !== "file") throw new HttpError(400, "file_not_regular", "目标不是普通文件");
		return entry;
	}

	private async projectMutableEntryPath(
		project: WebProject,
		input: string,
	): Promise<{ path: string; root: string; kind: "file" | "directory" }> {
		if (!input.trim()) throw new HttpError(400, "file_path_required", "文件或目录路径不能为空");
		const root = resolve(project.cwd);
		const canonicalRoot = await realpath(root);
		const path = this.projectPath(project, input);
		let info: Awaited<ReturnType<typeof lstat>>;
		let canonicalParent: string;
		try {
			[info, canonicalParent] = await Promise.all([lstat(path), realpath(dirname(path))]);
		} catch {
			throw new HttpError(404, "file_not_found", "文件或目录不存在");
		}
		if (!isInside(canonicalRoot, canonicalParent)) {
			throw new HttpError(403, "project_path_escape", "目标路径不在当前项目范围内");
		}
		if (info.isSymbolicLink()) return { path, root, kind: "file" };
		let canonicalPath: string;
		try {
			canonicalPath = await realpath(path);
		} catch {
			throw new HttpError(404, "file_not_found", "文件或目录不存在");
		}
		if (!isInside(canonicalRoot, canonicalPath)) {
			throw new HttpError(403, "project_path_escape", "目标路径不在当前项目范围内");
		}
		if (!info.isFile() && !info.isDirectory()) {
			throw new HttpError(400, "file_not_regular", "目标不是普通文件或目录");
		}
		return { path, root, kind: info.isDirectory() ? "directory" : "file" };
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

	private async deleteSessions(context: BrowserContext, sessionIds: string[]): Promise<SessionDeleteResult> {
		const client = await this.getClient(context);
		const resolved = await Promise.all(
			sessionIds.map(async (sessionId) => {
				try {
					return { sessionId, session: await this.resolveSession(context, sessionId) };
				} catch (error) {
					const value = toError(error);
					return {
						sessionId,
						failure: { sessionId, status: value.status, code: value.code, message: value.message },
					};
				}
			}),
		);
		const items = resolved.flatMap((entry) =>
			entry.session ? [{ cwd: entry.session.cwd, sessionPath: entry.session.path }] : [],
		);
		const runtimeResult =
			items.length > 0
				? await client.request<{
						deletedPaths: string[];
						failures: Array<{ sessionPath: string; code: string; message: string; retryable?: boolean }>;
					}>({
						command: "delete_sessions",
						items,
						clientInstanceId: context.id,
						clientRequestId: randomUUID(),
					})
				: { deletedPaths: [], failures: [] };
		const sessionIdByPath = new Map(
			resolved.flatMap((entry) => (entry.session ? [[entry.session.path, entry.sessionId] as const] : [])),
		);
		const deletedIds = runtimeResult.deletedPaths.flatMap((path) => {
			const sessionId = sessionIdByPath.get(path);
			if (!sessionId) return [];
			context.leases.delete(sessionId);
			this.sessions.delete(sessionId);
			if (this.sessionIdsByPath.get(path) === sessionId) this.sessionIdsByPath.delete(path);
			return [sessionId];
		});
		const failures: SessionDeleteFailure[] = [
			...resolved.flatMap((entry) => (entry.failure ? [entry.failure] : [])),
			...runtimeResult.failures.flatMap((failure) => {
				const sessionId = sessionIdByPath.get(failure.sessionPath);
				if (!sessionId) return [];
				return [
					{
						sessionId,
						status: failure.code === "not_found" ? 404 : failure.retryable ? 409 : 500,
						code: failure.code,
						message: failure.message,
					},
				];
			}),
		];
		if (deletedIds.length > 0) this.invalidateBootstrap(context);
		return { deletedIds, failures };
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
			if (url.pathname === "/api/branding" && request.method === "GET") {
				await this.handleBranding(request, response);
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
			await this.handleStatic(request, response, url.pathname);
		} catch (error) {
			if (!response.headersSent) sendError(response, error);
			else response.destroy();
		}
	}

	private async collectDiagnostics(context: BrowserContext, projectId?: string): Promise<Record<string, unknown>> {
		const project = projectId ? this.project(projectId) : undefined;
		const client = await this.getClient(context);
		const [runtimeDiagnostics, runtimeStatus, runtimeConnection] = await Promise.all([
			client.request<JsonValue>({
				command: "get_diagnostics",
				...(project ? { cwd: project.cwd } : {}),
			}),
			getRuntimeServiceStatus(
				this.config.runtimeEndpoint,
				this.config.serviceProfile,
				undefined,
				this.config.agentDir,
			),
			client.request<RuntimeConnectionStatus>({ command: "get_connection_status" }).catch(() => undefined),
		]);
		const currentCpuSnapshot = readCpuSnapshot();
		const cpuUsagePercent = calculateCpuUsage(this.previousCpuSnapshot, currentCpuSnapshot);
		this.previousCpuSnapshot = currentCpuSnapshot;
		const memory = hostMemory();
		const disk = await diskUsage(this.config.agentDir);
		const gatewayMemory = process.memoryUsage();
		const runtimeMemory = runtimeConnection?.processMemory;
		const processes = [
			{
				name: "Web Gateway",
				role: "gateway",
				pid: process.pid,
				rssBytes: gatewayMemory.rss,
			},
			...(runtimeConnection?.pid && runtimeMemory
				? [
						{
							name: "Web Runtime",
							role: "runtime",
							pid: runtimeConnection.pid,
							rssBytes: runtimeMemory.rssBytes,
						},
					]
				: []),
		];
		const runtimeObject = {
			status: runtimeStatus.reachable ? "running" : "unavailable",
			...runtimeStatus,
			...(runtimeConnection?.pid ? { pid: runtimeConnection.pid } : {}),
			...(runtimeMemory ? { processMemory: runtimeMemory } : {}),
		};
		const existing = object(runtimeDiagnostics) ?? {};
		const existingChecks = Array.isArray(existing.checks) ? existing.checks : [];
		return {
			...existing,
			generatedAt: Date.now(),
			web: {
				host: this.config.host,
				port: this.config.port,
				ipAddresses: hostNetworkAddresses(),
			},
			gateway: {
				status: "running",
				pid: process.pid,
				host: this.config.host,
				port: this.config.port,
				uptimeSeconds: Math.floor(process.uptime()),
				rssBytes: gatewayMemory.rss,
			},
			runtime: runtimeObject,
			cpu: hostCpu(cpuUsagePercent),
			memory,
			disk,
			host: {
				platform: process.platform,
				arch: process.arch,
				uptimeSeconds: hostUptimeSeconds(),
			},
			processMemory: {
				totalRssBytes: processes.reduce((sum, processInfo) => sum + processInfo.rssBytes, 0),
				processes,
			},
			checks: [
				...existingChecks,
				{ id: "web-gateway", status: "ok", message: `Web Gateway ${this.config.host}:${this.config.port}` },
				{
					id: "web-runtime",
					status: runtimeStatus.reachable ? "ok" : "error",
					message: runtimeStatus.reachable ? "Web Runtime 已连接" : "Web Runtime 不可用",
				},
				{
					id: "disk",
					status: disk.available ? "ok" : "warning",
					message: disk.available ? `磁盘 ${disk.usedPercent}% 已使用` : "磁盘信息不可用",
				},
			],
		};
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

	private async handleStatic(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
		const relativeName = pathname === "/" || pathname === "" ? "index.html" : pathname.replace(/^\/+/, "");
		const candidate = resolve(this.config.staticDir, relativeName);
		if (!isInside(resolve(this.config.staticDir), candidate))
			throw new HttpError(403, "static_path_escape", "无效的静态资源路径");
		let file = candidate;
		try {
			const info = await stat(file);
			if (!info.isFile()) throw new Error("not a file");
		} catch {
			const acceptsHtml = String(request.headers.accept ?? "").includes("text/html");
			const looksLikeAsset = /(?:^|\/)[^/]+\.[A-Za-z\d]+$/u.test(relativeName);
			if (request.method !== "GET" || !acceptsHtml || looksLikeAsset) {
				throw new HttpError(404, "static_not_found", "静态资源不存在");
			}
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
			"Cache-Control": file.endsWith("index.html")
				? "no-store"
				: file.endsWith("sw.js")
					? "no-cache"
					: "public, max-age=31536000, immutable",
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
		if (parts.length === 2 && parts[1] === "branding") {
			await this.handleBranding(request, response);
			return;
		}
		if (parts.length === 2 && parts[1] === "security-settings") {
			await this.handleGatewaySecuritySettings(request, response);
			return;
		}
		if (parts.length === 2 && parts[1] === "system-permissions") {
			if (request.method === "GET") {
				sendJson(response, 200, getMacosPermissionsStatus(this.config.agentDir));
				return;
			}
			if (request.method === "POST") {
				const body = await parseJsonBody(request);
				const permission = stringValue(body.permission);
				if (
					permission !== "keychain" &&
					permission !== "accessibility" &&
					permission !== "automation" &&
					permission !== "screen-recording"
				) {
					throw new HttpError(400, "system_permission_invalid", "不支持的系统授权项目");
				}
				if (permission === "keychain") {
					throw new HttpError(
						409,
						"system_permission_requires_terminal",
						"Git 钥匙串授权只能在运行 LYStar Code Web 的 Mac 本机终端完成。请执行 lc web permissions setup。",
					);
				}
				sendJson(response, 200, requestMacosPermission(permission, this.config.agentDir));
				return;
			}
			throw new HttpError(405, "method_not_allowed", "系统授权接口只支持 GET 或 POST");
		}
		if (parts[1] === "product-update") {
			await this.handleProductUpdate(request, response, context, parts);
			return;
		}
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
			const bytes = await readChunks(
				(offset) =>
					client.request<ContentChunk>({
						command: "read_external_resource",
						path: resource.path,
						accessToken: resource.accessToken ?? "",
						offset,
						limit: 1024 * 1024,
					}),
				resource.kind === "text" ? MAX_TEXT_PREVIEW_BYTES : MAX_BINARY_PREVIEW_BYTES,
			);
			const truncated = bytes.byteLength < resource.byteLength;
			sendJson(response, 200, {
				kind: resource.kind,
				path: resource.displayPath,
				mimeType: resource.mimeType,
				byteLength: resource.byteLength,
				previewByteLength: bytes.byteLength,
				truncated,
				...(resource.kind === "text"
					? { content: Buffer.from(bytes).toString("utf8") }
					: truncated
						? {}
						: { data: Buffer.from(bytes).toString("base64") }),
			});
			return;
		}
		if (parts.length === 3 && parts[1] === "uploads" && parts[2] === "file" && request.method === "POST") {
			await this.handleFileUpload(request, response);
			return;
		}
		if (parts[1] === "project-groups") {
			await this.handleProjectGroups(request, response, parts);
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
		if (parts[1] === "model-options" && request.method === "GET") {
			const includeProviders = url.searchParams
				.getAll("includeProvider")
				.map((provider) => provider.trim())
				.filter(Boolean);
			const options = await this.modelOptions(context, includeProviders);
			sendJson(response, 200, { revision: this.modelCatalogRevision, ...options });
			return;
		}
		if (parts[1] === "model-providers") {
			const client = await this.getClient(context);
			if (parts.length === 3 && request.method === "DELETE") {
				const provider = stringValue(parts[2]);
				if (!provider) throw new HttpError(400, "model_provider_required", "Provider 不能为空");
				const result = await client.request<ModelProviderSummary[]>({
					command: "remove_model_provider",
					provider,
					clientInstanceId: context.id,
					clientRequestId: randomUUID(),
				});
				sendJson(response, 200, { providers: result });
				return;
			}
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
			if (parts.length === 5 && parts[3] === "models" && parts[4] === "enabled" && request.method === "POST") {
				const body = await parseJsonBody(request);
				const provider = stringValue(parts[2]);
				const id = stringValue(body.id);
				if (!provider || !id) throw new HttpError(400, "model_provider_required", "Provider 和模型 ID 不能为空");
				const result = await client.request<ModelSummary[]>({
					command: "set_provider_model_enabled",
					provider,
					id,
					enabled: body.enabled !== false,
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
			const settings = await this.modelSettings(context);
			sendJson(response, 200, { revision: this.modelCatalogRevision, ...settings });
			return;
		}
		if (parts[1] === "about" && request.method === "GET") {
			sendJson(response, 200, await (await this.getClient(context)).request<JsonValue>({ command: "get_about" }));
			return;
		}
		if (parts.length === 3 && parts[1] === "diagnostics" && parts[2] === "actions" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const action = stringValue(body.action);
			if (action === "restart-runtime") {
				if (!this.config.manageRuntime) {
					throw new HttpError(409, "runtime_not_managed", "当前 Gateway 不管理 Runtime 生命周期");
				}
				const profile = this.config.serviceProfile;
				const currentStatus = await getRuntimeServiceStatus(
					this.config.runtimeEndpoint,
					profile,
					undefined,
					this.config.agentDir,
				);
				if (!currentStatus.installed) {
					await stopRuntimeService(
						this.config.runtimeEndpoint,
						false,
						profile,
						undefined,
						false,
						this.config.agentDir,
					);
				}
				const status = currentStatus.installed
					? await restartRuntimeService(this.config.runtimeEndpoint, profile, undefined, this.config.agentDir)
					: await ensurePersistentRuntime({ ...this.config, manageRuntime: true });
				sendJson(response, 200, { accepted: true, service: "runtime", status });
				return;
			}
			if (action === "restart-gateway") {
				if (!this.restartHandler)
					throw new HttpError(503, "gateway_restart_unavailable", "当前 Gateway 不支持自重启");
				this.restartAfterResponse(response);
				sendJson(response, 202, { accepted: true, service: "gateway" }, { Connection: "close" });
				return;
			}
			throw new HttpError(400, "diagnostics_action_invalid", "不支持的诊断操作");
		}
		if (parts[1] === "diagnostics" && request.method === "GET") {
			const projectId = url.searchParams.get("projectId") ?? undefined;
			sendJson(response, 200, await this.collectDiagnostics(context, projectId));
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
			this.invalidateBootstrap(context);
			sendJson(response, 200, { accepted: true });
			return;
		}
		throw new HttpError(404, "not_found", "未找到请求接口");
	}

	private async handleProjectGroups(
		request: IncomingMessage,
		response: ServerResponse,
		parts: string[],
	): Promise<void> {
		if (parts.length === 2 && request.method === "GET") {
			sendJson(response, 200, { groups: this.projectGroups.list() });
			return;
		}
		if (parts.length === 2 && request.method === "POST") {
			const body = await parseJsonBody(request);
			const group = await this.projectGroups.create(stringValue(body.name) ?? "");
			this.invalidateAllBootstraps();
			sendJson(response, 201, { group, groups: this.projectGroups.list() });
			return;
		}
		if (parts.length === 2 && request.method === "PATCH") {
			const body = await parseJsonBody(request);
			if (!Array.isArray(body.groupIds) || body.groupIds.some((id) => typeof id !== "string"))
				throw new HttpError(400, "project_group_order_invalid", "项目组顺序数据无效");
			await this.projectGroups.reorder(body.groupIds);
			this.invalidateAllBootstraps();
			sendJson(response, 200, { groups: this.projectGroups.list() });
			return;
		}
		if (parts.length !== 3) throw new HttpError(404, "project_group_not_found", "未找到项目组接口");
		const groupId = parts[2];
		if (request.method === "PATCH") {
			const body = await parseJsonBody(request);
			const group = await this.projectGroups.update(groupId, stringValue(body.name) ?? "");
			this.invalidateAllBootstraps();
			sendJson(response, 200, { group, groups: this.projectGroups.list() });
			return;
		}
		if (request.method === "DELETE") {
			await this.projectGroups.remove(groupId);
			this.invalidateAllBootstraps();
			sendJson(response, 200, { groups: this.projectGroups.list() });
			return;
		}
		throw new HttpError(405, "method_not_allowed", "该接口不支持当前方法");
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
		if (parts.length === 4 && parts[3] === "group" && request.method === "PATCH") {
			const body = await parseJsonBody(request);
			await this.projectGroups.assignProject(projectId, stringValue(body.groupId));
			this.invalidateAllBootstraps();
			sendJson(response, 200, { groups: this.projectGroups.list() });
			return;
		}
		if (parts.length === 3 && request.method === "DELETE") {
			const watcher = this.projectWatchers.get(projectId);
			if (watcher?.timer) clearTimeout(watcher.timer);
			watcher?.watcher.close();
			this.projectWatchers.delete(projectId);
			await this.registry.remove(projectId);
			await this.projectGroups.assignProject(projectId);
			this.invalidateAllBootstraps();
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
			this.ensureProjectWatcher(project);
			sendJson(response, 200, await this.projectTree(project, url.searchParams.get("path") ?? undefined));
			return;
		}
		if (parts.length === 4 && parts[3] === "upload" && request.method === "POST") {
			const directoryPath = url.searchParams.get("path")?.trim() ?? "";
			const name = url.searchParams.get("name")?.trim();
			if (!name) throw new HttpError(400, "file_name_required", "文件名不能为空");
			if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
				throw new HttpError(400, "file_name_invalid", "文件名不能包含路径分隔符");
			}
			const directory = await this.projectEntryPath(project, directoryPath);
			if (directory.kind !== "directory") {
				throw new HttpError(400, "upload_target_not_directory", "上传目标不是目录");
			}
			const target = resolve(directory.path, name);
			if (dirname(target) !== directory.path) {
				throw new HttpError(403, "project_path_escape", "上传目标不在当前目录范围内");
			}
			try {
				await lstat(target);
				throw new HttpError(409, "file_name_conflict", "同一目录下已有同名文件或目录");
			} catch (error) {
				if (error instanceof HttpError) throw error;
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const temporaryPath = join(directory.path, `.${name}.${process.pid}.${randomUUID()}.upload`);
			try {
				await pipeline(request, createWriteStream(temporaryPath, { flags: "wx", mode: 0o644 }));
				try {
					await link(temporaryPath, target);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") {
						throw new HttpError(409, "file_name_conflict", "同一目录下已有同名文件或目录");
					}
					throw error;
				}
				const info = await stat(target);
				this.ensureProjectWatcher(project);
				sendJson(response, 200, {
					path: relativePath(directory.root, target),
					byteLength: info.size,
				});
			} finally {
				await unlink(temporaryPath).catch(() => {});
			}
			return;
		}
		if (parts.length === 4 && parts[3] === "archive" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const name = stringValue(body.name);
			if (
				!name ||
				!name.toLowerCase().endsWith(".zip") ||
				name.includes("/") ||
				name.includes("\\") ||
				name.includes("\0")
			) {
				throw new HttpError(400, "archive_name_invalid", "ZIP 文件名必须以 .zip 结尾且不能包含路径分隔符");
			}
			if (
				!Array.isArray(body.paths) ||
				body.paths.length === 0 ||
				body.paths.length > 1000 ||
				body.paths.some((path) => typeof path !== "string" || !path.trim())
			) {
				throw new HttpError(400, "archive_paths_invalid", "请选择 1 至 1000 个文件或目录");
			}
			const sources = await Promise.all(
				body.paths.map((path) => this.projectEntryPath(project, (path as string).trim())),
			);
			const root = sources[0].root;
			const outputPath = resolve(root, name);
			if (dirname(outputPath) !== root) {
				throw new HttpError(403, "project_path_escape", "ZIP 必须生成在项目根目录");
			}
			try {
				await stat(outputPath);
				throw new HttpError(409, "archive_name_conflict", "项目根目录下已有同名 ZIP 文件");
			} catch (error) {
				if (error instanceof HttpError) throw error;
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const archiveEntries = await collectZipEntries(root, sources);
			if (archiveEntries.length === 0) throw new HttpError(400, "archive_empty", "选中内容没有可压缩文件");
			this.ensureProjectWatcher(project);
			await createZipArchive(outputPath, archiveEntries);
			sendJson(response, 200, { path: name, entryCount: archiveEntries.length });
			return;
		}
		if (parts.length === 4 && parts[3] === "file") {
			if (request.method === "GET" && url.searchParams.get("download") === "true") {
				const path = url.searchParams.get("path")?.trim();
				if (!path) throw new HttpError(400, "file_path_required", "文件路径不能为空");
				const file = await this.projectFilePath(project, path);
				const info = await stat(file.path);
				const filename = encodeURIComponent(basename(file.path)).replace(
					/[!'()*]/gu,
					(value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
				);
				response.writeHead(200, {
					"Cache-Control": "no-store",
					"Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
					"Content-Length": String(info.size),
					"Content-Type": "application/octet-stream",
				});
				response.end(await readFile(file.path));
				return;
			}
			if (request.method === "PATCH") {
				const body = await parseJsonBody(request);
				const path = stringValue(body.path);
				const name = stringValue(body.name);
				if (!path) throw new HttpError(400, "file_path_required", "文件路径不能为空");
				if (!name) throw new HttpError(400, "file_name_required", "文件名不能为空");
				if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
					throw new HttpError(400, "file_name_invalid", "文件名不能包含路径分隔符");
				}
				const source = await this.projectMutableEntryPath(project, path);
				if (basename(source.path) === name) {
					sendJson(response, 200, { path: relativePath(source.root, source.path) });
					return;
				}
				const target = resolve(dirname(source.path), name);
				if (!isInside(source.root, target)) {
					throw new HttpError(403, "project_path_escape", "目标路径不在当前项目范围内");
				}
				try {
					await lstat(target);
					throw new HttpError(409, "file_name_conflict", "同一目录下已有同名文件或目录");
				} catch (error) {
					if (error instanceof HttpError) throw error;
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				await rename(source.path, target);
				sendJson(response, 200, { path: relativePath(source.root, target) });
				return;
			}
			if (request.method === "DELETE") {
				const body = await parseJsonBody(request);
				if (
					!Array.isArray(body.paths) ||
					body.paths.length === 0 ||
					body.paths.length > 1000 ||
					body.paths.some((path) => typeof path !== "string" || !path.trim())
				) {
					throw new HttpError(400, "delete_paths_invalid", "请选择 1 至 1000 个文件或目录");
				}
				const entries = await Promise.all(
					body.paths.map((path) => this.projectMutableEntryPath(project, (path as string).trim())),
				);
				const uniqueEntries = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
				const deletionRoots = uniqueEntries.filter(
					(entry) =>
						!uniqueEntries.some(
							(candidate) =>
								candidate.path !== entry.path &&
								candidate.kind === "directory" &&
								isInside(candidate.path, entry.path),
						),
				);
				this.ensureProjectWatcher(project);
				for (const entry of deletionRoots) {
					await rm(entry.path, { recursive: entry.kind === "directory", force: false });
				}
				sendJson(response, 200, {
					paths: deletionRoots.map((entry) => relativePath(entry.root, entry.path)),
				});
				return;
			}
			const client = await this.getClient(context);
			if (request.method === "GET") {
				const path = url.searchParams.get("path")?.trim();
				if (!path) throw new HttpError(400, "file_path_required", "文件路径不能为空");
				const resource = await client.request<ProjectResource>({
					command: "resolve_project_resource",
					cwd: project.cwd,
					target: path,
				});
				if (url.searchParams.get("metadata") === "true") {
					sendJson(response, 200, {
						kind: resource.kind,
						path: resource.displayPath,
						mimeType: resource.mimeType,
						byteLength: resource.byteLength,
						...(resource.contentVersion ? { contentVersion: resource.contentVersion } : {}),
					});
					return;
				}
				const bytes = await readChunks(
					(offset) =>
						client.request<ContentChunk>({
							command: "read_project_resource",
							cwd: project.cwd,
							path: resource.path,
							offset,
							limit: 1024 * 1024,
						}),
					resource.kind === "text" ? MAX_TEXT_PREVIEW_BYTES : MAX_BINARY_PREVIEW_BYTES,
				);
				const truncated = bytes.byteLength < resource.byteLength;
				if (resource.kind === "image") {
					sendJson(response, 200, {
						kind: resource.kind,
						path: resource.displayPath,
						mimeType: resource.mimeType,
						byteLength: resource.byteLength,
						previewByteLength: bytes.byteLength,
						truncated,
						...(resource.contentVersion ? { contentVersion: resource.contentVersion } : {}),
						...(truncated ? {} : { data: Buffer.from(bytes).toString("base64") }),
					});
				} else if (resource.kind === "binary") {
					sendJson(response, 200, {
						kind: resource.kind,
						path: resource.displayPath,
						mimeType: resource.mimeType,
						byteLength: resource.byteLength,
						previewByteLength: bytes.byteLength,
						truncated,
						...(resource.contentVersion ? { contentVersion: resource.contentVersion } : {}),
						...(truncated ? {} : { data: Buffer.from(bytes).toString("base64") }),
					});
				} else {
					sendJson(response, 200, {
						kind: resource.kind,
						path: resource.displayPath,
						mimeType: resource.mimeType,
						byteLength: resource.byteLength,
						previewByteLength: bytes.byteLength,
						truncated,
						...(resource.contentVersion ? { contentVersion: resource.contentVersion } : {}),
						contentHash: contentHash(bytes),
						content: Buffer.from(bytes).toString("utf8"),
					});
				}
				return;
			}
			if (request.method === "POST") {
				const body = await parseJsonBody(request);
				const path = stringValue(body.path);
				const expectedHash = stringValue(body.expectedHash);
				if (!path) throw new HttpError(400, "file_path_required", "文件路径不能为空");
				if (typeof body.content !== "string") {
					throw new HttpError(400, "file_content_invalid", "文件内容必须是文本");
				}
				if (!expectedHash) throw new HttpError(400, "file_version_required", "保存文件需要原始内容版本");
				const sessionId = stringValue(body.sessionId);
				const session = sessionId ? await this.resolveSession(context, sessionId) : undefined;
				if (session && session.projectId !== project.id) {
					throw new HttpError(400, "file_project_mismatch", "会话不属于当前文件所在项目");
				}
				const lease = sessionId ? await this.requireLease(context, sessionId) : undefined;
				const saved = await client.request<ProjectFileSaveResult>({
					command: "save_project_file",
					...(session && lease ? { sessionPath: session.path, leaseId: lease.leaseId } : {}),
					cwd: project.cwd,
					path,
					content: body.content,
					expectedHash,
					clientInstanceId: context.id,
					clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
				});
				sendJson(response, 200, {
					kind: "text",
					path: saved.path,
					mimeType: saved.mimeType,
					byteLength: saved.byteLength,
					previewByteLength: saved.byteLength,
					truncated: false,
					content: body.content,
					contentHash: saved.contentHash,
					contentVersion: saved.contentVersion,
				});
				return;
			}
			throw new HttpError(405, "method_not_allowed", "文件接口不支持当前方法");
		}
		if (parts.length === 5 && parts[3] === "git" && parts[4] === "status" && request.method === "GET") {
			this.ensureProjectWatcher(project);
			sendJson(
				response,
				200,
				await (await this.getClient(context)).request<GitStatus>({
					command: "get_git_status",
					cwd: project.cwd,
					...(url.searchParams.get("discover") === "true" ? { refreshRepositories: true } : {}),
				}),
			);
			return;
		}
		if (parts.length === 5 && parts[3] === "git" && parts[4] === "diff" && request.method === "GET") {
			const repositoryPath = url.searchParams.get("repositoryPath")?.trim();
			if (repositoryPath) this.projectPath(project, repositoryPath);
			sendJson(
				response,
				200,
				await (await this.getClient(context)).request<GitDiff>({
					command: "get_git_diff",
					cwd: project.cwd,
					...(url.searchParams.get("path") ? { path: url.searchParams.get("path")! } : {}),
					...(repositoryPath ? { repositoryPath } : {}),
					staged: url.searchParams.get("staged") === "true",
				}),
			);
			return;
		}
		if (parts.length === 5 && parts[3] === "git" && parts[4] === "stats" && request.method === "GET") {
			const repositoryPath = url.searchParams.get("repositoryPath")?.trim();
			if (repositoryPath) this.projectPath(project, repositoryPath);
			sendJson(
				response,
				200,
				await (await this.getClient(context)).request<GitStats>({
					command: "get_git_stats",
					cwd: project.cwd,
					...(repositoryPath ? { repositoryPath } : {}),
				}),
			);
			return;
		}
		if (parts.length === 5 && parts[3] === "git" && parts[4] === "branches" && request.method === "GET") {
			const repositoryPath = url.searchParams.get("repositoryPath")?.trim();
			if (repositoryPath) this.projectPath(project, repositoryPath);
			sendJson(
				response,
				200,
				await (await this.getClient(context)).request<GitBranches>({
					command: "get_git_branches",
					cwd: project.cwd,
					...(repositoryPath ? { repositoryPath } : {}),
				}),
			);
			return;
		}
		if (parts.length === 5 && parts[3] === "git" && parts[4] === "history" && request.method === "GET") {
			const repositoryPath = url.searchParams.get("repositoryPath")?.trim();
			if (repositoryPath) this.projectPath(project, repositoryPath);
			const offset = Number(url.searchParams.get("offset") ?? "0");
			const limit = Number(url.searchParams.get("limit") ?? "50");
			if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
				throw new HttpError(400, "git_history_page_invalid", "Git 历史分页参数无效");
			}
			sendJson(
				response,
				200,
				await (await this.getClient(context)).request<GitHistory>({
					command: "get_git_history",
					cwd: project.cwd,
					...(repositoryPath ? { repositoryPath } : {}),
					offset,
					limit,
				}),
			);
			return;
		}
		if (parts.length === 5 && parts[3] === "git" && parts[4] === "commit" && request.method === "GET") {
			const repositoryPath = url.searchParams.get("repositoryPath")?.trim();
			if (repositoryPath) this.projectPath(project, repositoryPath);
			const revision = url.searchParams.get("revision")?.trim();
			if (!revision) throw new HttpError(400, "git_revision_required", "Git 提交版本不能为空");
			const path = url.searchParams.get("path")?.trim();
			sendJson(
				response,
				200,
				await (await this.getClient(context)).request<GitCommit>({
					command: "get_git_commit",
					cwd: project.cwd,
					...(repositoryPath ? { repositoryPath } : {}),
					revision,
					...(path ? { path } : {}),
				}),
			);
			return;
		}
		if (parts.length === 5 && parts[3] === "git" && parts[4] === "mutate" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const repositoryPath = stringValue(body.repositoryPath);
			const repositoryDirectory = this.projectPath(project, repositoryPath);
			if (!isGitMutation(body.mutation)) {
				throw new HttpError(400, "git_mutation_invalid", "Git 操作参数无效");
			}
			if (["fetch", "pull", "push"].includes(body.mutation.type)) {
				const requirement = getMacosGitKeychainRequirement(repositoryDirectory, this.config.agentDir);
				if (requirement.required) {
					throw new HttpError(409, "git_credentials_required", requirement.message ?? "Git 钥匙串需要本机授权", {
						hosts: requirement.hosts,
					});
				}
			}
			sendJson(
				response,
				200,
				await (await this.getClient(context)).request<GitMutationResult>({
					command: "mutate_git",
					cwd: project.cwd,
					...(repositoryPath ? { repositoryPath } : {}),
					mutation: body.mutation,
					clientInstanceId: context.id,
					clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
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
		if (parts.length === 2 && request.method === "DELETE") {
			const body = await parseJsonBody(request);
			const sessionIds = Array.isArray(body.sessionIds)
				? [...new Set(body.sessionIds.filter((value): value is string => Boolean(stringValue(value))))]
				: [];
			if (sessionIds.length === 0) {
				throw new HttpError(400, "session_ids_required", "至少选择一个会话");
			}
			const result = await this.deleteSessions(context, sessionIds);
			sendJson(response, 200, {
				deletedIds: result.deletedIds,
				failures: result.failures.map(({ sessionId, code, message }) => ({ sessionId, code, message })),
			});
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
			const result = await this.deleteSessions(context, [sessionId]);
			const failure = result.failures[0];
			if (failure) throw new HttpError(failure.status, failure.code, failure.message);
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
				}>(
					{ command: "acquire_session", sessionPath: session.path, clientInstanceId: context.id },
					{
						onResult: (value) => {
							const live = object(object(value)?.liveMessage);
							if (!live) return;
							if (typeof live.text !== "string" || typeof live.thinking !== "string")
								throw new Error("Web Runtime 生成内容快照无效");
							this.flushPendingProgress(context);
							this.recordSessionDetail(context, sessionId, {
								type: "session_stream",
								sessionId,
								text: live.text,
								thinking: live.thinking,
								...(typeof live.stepId === "string" ? { stepId: live.stepId } : {}),
							});
						},
					},
				);
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
		if (parts.length === 4 && parts[3] === "subagents" && request.method === "GET") {
			const subagents = await client.request<SubagentSnapshot[]>({
				command: "list_subagents",
				sessionPath: session.path,
			});
			sendJson(response, 200, { subagents });
			return;
		}
		if (parts.length === 5 && parts[3] === "subagents" && request.method === "GET") {
			const details = await client.request<{ transcript?: SubagentSnapshot; live?: SubagentSnapshot }>({
				command: "read_subagent",
				sessionPath: session.path,
				agentId: parts[4],
			});
			if (!details.transcript && !details.live)
				throw new HttpError(404, "subagent_not_found", "未找到属于当前会话的 Subagent");
			sendJson(response, 200, details);
			return;
		}
		if (parts.length === 6 && parts[3] === "subagents" && parts[5] === "transcript" && request.method === "GET") {
			const details = await client.request<{ transcript?: SubagentSnapshot; live?: SubagentSnapshot }>({
				command: "read_subagent",
				sessionPath: session.path,
				agentId: parts[4],
			});
			const childSession = details.transcript?.session ?? details.live?.session;
			if (!childSession?.sessionFile)
				throw new HttpError(404, "subagent_transcript_not_found", "Subagent 会话记录不可读取");
			if (childSession.parentSessionFile && childSession.parentSessionFile !== session.path)
				throw new HttpError(404, "subagent_not_found", "Subagent 不属于当前会话");
			const limitValue = Number(url.searchParams.get("limit") ?? "120");
			const limit = Number.isInteger(limitValue) ? Math.min(200, Math.max(1, limitValue)) : 120;
			const query = url.searchParams.get("search")?.trim();
			if (query) {
				sendJson(
					response,
					200,
					await client.request<JsonValue>({
						command: "search_transcript",
						sessionPath: childSession.sessionFile,
						query,
						...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
						limit: Math.min(100, limit),
					}),
				);
			} else {
				const page = await client.request<TranscriptPage>({
					command: "read_transcript",
					sessionPath: childSession.sessionFile,
					...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
					limit,
				});
				sendJson(response, 200, { ...page, items: page.items.map(publicTranscriptItem) });
			}
			return;
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
		if (parts.length === 6 && parts[3] === "subagents" && parts[5] === "abort" && request.method === "POST") {
			const lease = await this.requireLease(context, sessionId);
			const result = await client.request<JsonValue>({
				command: "abort_subagent",
				sessionPath: session.path,
				agentId: parts[4],
				leaseId: lease.leaseId,
				clientInstanceId: context.id,
				clientRequestId: randomUUID(),
			});
			sendJson(response, 200, result);
			return;
		}
		if (parts.length === 6 && parts[3] === "subagents" && parts[5] === "continue" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const text = stringValue(body.text);
			if (!text) throw new HttpError(400, "subagent_text_required", "继续 Subagent 需要输入内容");
			const lease = await this.requireLease(context, sessionId);
			const result = await client.request<JsonValue>({
				command: "continue_subagent",
				sessionPath: session.path,
				agentId: parts[4],
				text,
				leaseId: lease.leaseId,
				clientInstanceId: context.id,
				clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
			});
			sendJson(response, 200, result);
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
		if (parts.length === 4 && parts[3] === "queue-action") {
			await this.handleQueueAction(request, response, context, sessionId, session);
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
		if (parts.length === 4 && parts[3] === "reload" && request.method === "POST") {
			const body = await parseJsonBody(request);
			const lease = await this.requireLease(context, sessionId);
			const snapshot = await client.request<SessionStateSnapshot>(
				{
					command: "reload_resources",
					sessionPath: session.path,
					leaseId: lease.leaseId,
					clientInstanceId: context.id,
					clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
				},
				{ timeoutMs: 0 },
			);
			sendJson(response, 200, { session: publicSessionSnapshot(snapshot) });
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

	private async handleFileUpload(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await parseJsonBody(request);
		const filename = stringValue(body.filename);
		const mimeType = stringValue(body.mimeType)?.trim() || "application/octet-stream";
		const encoded = stringValue(body.data);
		if (!encoded) throw new HttpError(400, "file_data_required", "文件内容不能为空");
		const comma = encoded.startsWith("data:") ? encoded.indexOf(",") : -1;
		const base64 = comma >= 0 ? encoded.slice(comma + 1) : encoded;
		if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(base64) || base64.length % 4 === 1)
			throw new HttpError(400, "file_data_invalid", "文件内容不是有效的 Base64 数据");
		const bytes = Buffer.from(base64, "base64");
		if (bytes.length === 0) throw new HttpError(400, "file_data_invalid", "文件内容不能为空");
		if (bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "file_too_large", "单个文件不能超过 8 MB");
		const path = join(tmpdir(), `lystar-web-upload-${randomUUID()}${uploadExtension(filename, mimeType)}`);
		await writeFile(path, bytes, { mode: 0o600 });
		this.uploadedFiles.set(path, {
			mimeType,
			...(filename ? { filename } : {}),
			byteLength: bytes.byteLength,
			expiresAt: Date.now() + UPLOAD_TTL_MS,
		});
		sendJson(response, 201, { path, mimeType, byteLength: bytes.byteLength });
	}

	private async cleanupUploadedFiles(force = false): Promise<void> {
		const now = Date.now();
		for (const [path, upload] of this.uploadedFiles) {
			if (!force && upload.expiresAt > now) continue;
			this.uploadedFiles.delete(path);
			await unlink(path).catch(() => {});
		}
	}

	private async persistUploadedFiles(sessionPath: string, value: unknown): Promise<PersistedUpload[]> {
		if (value === undefined) return [];
		if (!Array.isArray(value)) throw new HttpError(400, "file_attachments_invalid", "文件附件数据无效");
		if (value.length > MAX_PROMPT_ATTACHMENTS) {
			throw new HttpError(413, "too_many_file_attachments", `单条消息最多上传 ${MAX_PROMPT_ATTACHMENTS} 个附件`);
		}
		const persisted: PersistedUpload[] = [];
		const seen = new Set<string>();
		let totalBytes = 0;
		for (const item of value) {
			const attachment = object(item);
			const sourcePath = stringValue(attachment?.path);
			if (!sourcePath) throw new HttpError(400, "file_attachment_path_required", "文件附件路径不能为空");
			if (seen.has(sourcePath)) continue;
			seen.add(sourcePath);
			const upload = this.uploadedFiles.get(sourcePath);
			if (!upload || upload.expiresAt <= Date.now()) {
				throw new HttpError(400, "file_attachment_expired", "文件附件已过期，请重新上传");
			}
			totalBytes += upload.byteLength;
			if (totalBytes > MAX_PROMPT_ATTACHMENT_BYTES) {
				throw new HttpError(413, "file_attachments_too_large", "单条消息附件总大小不能超过 32 MB");
			}
			upload.expiresAt = Date.now() + UPLOAD_TTL_MS;
			let path = upload.persistedPath;
			if (path) {
				const file = await stat(path).catch(() => undefined);
				if (!file?.isFile()) path = undefined;
			}
			if (!path) {
				const file = await stat(sourcePath).catch(() => undefined);
				if (!file?.isFile()) throw new HttpError(400, "file_attachment_missing", "文件附件不存在，请重新上传");
				const bytes = await readFile(sourcePath).catch(() => undefined);
				if (!bytes) throw new HttpError(400, "file_attachment_missing", "文件附件不存在，请重新上传");
				const artifact = await persistSessionAttachment(sessionPath, {
					bytes,
					filename: upload.filename,
					mimeType: upload.mimeType,
				});
				path = artifact.path;
				upload.persistedPath = path;
				await unlink(sourcePath).catch(() => {});
			}
			if (!path) throw new Error("Persisted attachment path is missing");
			persisted.push({
				sourcePath,
				path,
				filename: upload.filename ?? `attachment${uploadExtension(undefined, upload.mimeType)}`,
				mimeType: upload.mimeType,
				byteLength: upload.byteLength,
			});
		}
		return persisted;
	}

	private async handleQueueAction(
		request: IncomingMessage,
		response: ServerResponse,
		context: BrowserContext,
		sessionId: string,
		session: SessionRef,
	): Promise<void> {
		if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "该接口只支持 POST");
		const body = await parseJsonBody(request);
		const queueId = stringValue(body.queueId);
		const action = body.action === "remove" || body.action === "steer" ? body.action : undefined;
		if (!queueId) throw new HttpError(400, "queue_message_required", "排队消息标识不能为空");
		if (!action) throw new HttpError(400, "queue_action_invalid", "排队消息操作无效");
		const lease = await this.requireLease(context, sessionId);
		const result = await (await this.getClient(context)).request<{ operation?: OperationSnapshot }>({
			command: "queue_action",
			sessionPath: session.path,
			leaseId: lease.leaseId,
			clientInstanceId: context.id,
			clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
			queueId,
			action,
		});
		sendJson(
			response,
			result.operation ? 202 : 200,
			result.operation ? { operation: publicOperation(result.operation, sessionId) } : { accepted: true },
		);
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
		if (Array.isArray(body.images) && body.images.length > 0) {
			throw new HttpError(400, "inline_images_unsupported", "图片必须先通过文件上传接口提交");
		}
		const uploadedFiles = await this.persistUploadedFiles(session.path, body.attachments);
		let persistedText = text;
		for (const upload of uploadedFiles) {
			const rewritten = replacePromptFilePath(persistedText, upload.sourcePath, upload.path);
			persistedText = rewritten === persistedText ? `${persistedText}\n${promptFileTag(upload)}`.trim() : rewritten;
		}
		const command = kind === "prompt" ? "prompt" : kind === "steer" ? "steer" : "follow_up";
		const queueId = kind === "prompt" ? undefined : stringValue(body.queueId);
		const result = await (await this.getClient(context)).request<{ operation?: OperationSnapshot }>({
			command,
			sessionPath: session.path,
			leaseId: lease.leaseId,
			clientInstanceId: context.id,
			clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
			text: persistedText,
			...(queueId ? { queueId } : {}),
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
				operation: publicOperation(operation, this.sessionIdsByPath.get(operation.sessionPath)),
			});
			return;
		}
		if (parts.length === 4 && parts[3] === "abort" && request.method === "POST") {
			const operationId = parts[2];
			const operation = await client.request<OperationSnapshot>({ command: "get_operation", operationId });
			const sessionId = this.sessionIdsByPath.get(operation.sessionPath);
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

	private async currentProductVersion(context: BrowserContext): Promise<string> {
		const about = object(await (await this.getClient(context)).request<JsonValue>({ command: "get_about" }));
		const version = stringValue(about?.productVersion);
		if (!version) throw new HttpError(502, "product_version_invalid", "Runtime 没有返回有效的应用版本");
		return version;
	}

	private async handleProductUpdate(
		request: IncomingMessage,
		response: ServerResponse,
		context: BrowserContext,
		parts: string[],
	): Promise<void> {
		const currentVersion = await this.currentProductVersion(context);
		const job = await this.productUpdate.status(currentVersion);
		if (parts.length === 2 && request.method === "GET") {
			sendJson(response, 200, { currentVersion, ...(job ? { job } : {}) });
			return;
		}

		const client = await this.getClient(context);
		if (parts.length === 3 && parts[2] === "check" && request.method === "GET") {
			try {
				const check = object(await client.request<JsonValue>({ command: "check_for_updates" }));
				if (!check) throw new Error("Runtime 返回的版本检查结果无效");
				const repository = stringValue(check.repository);
				const availability = await this.productUpdate.availability(repository);
				sendJson(response, 200, {
					...check,
					currentVersion,
					repository: repository ?? null,
					installEnabled: availability.enabled,
					installBlockedReason: availability.reason,
					...(job ? { job } : {}),
				});
			} catch (error) {
				sendJson(response, 200, {
					currentVersion,
					checkedAt: Date.now(),
					repository: null,
					installEnabled: false,
					installBlockedReason: "版本检查失败",
					status: "unavailable",
					latestVersion: null,
					note: error instanceof Error ? error.message : String(error),
					...(job ? { job } : {}),
				});
			}
			return;
		}

		if (parts.length === 2 && request.method === "POST") {
			const body = await parseJsonBody(request);
			const targetVersion = stringValue(body.targetVersion);
			if (!targetVersion) throw new HttpError(400, "product_update_version_required", "目标版本不能为空");
			const check = object(await client.request<JsonValue>({ command: "check_for_updates" }));
			const latestVersion = stringValue(check?.latestVersion);
			if (check?.status !== "available" || !latestVersion) {
				throw new HttpError(409, "product_update_not_available", "当前没有可安装的新版本");
			}
			if (targetVersion !== latestVersion) {
				throw new HttpError(409, "product_update_version_changed", `最新版本已变为 v${latestVersion}，请重新确认`);
			}
			const availability = await this.productUpdate.availability(stringValue(check?.repository));
			if (!availability.enabled) {
				throw new HttpError(409, "product_update_unavailable", availability.reason);
			}
			const started = await this.productUpdate.start(currentVersion, targetVersion);
			sendJson(response, 202, { currentVersion, job: started });
			return;
		}

		throw new HttpError(405, "method_not_allowed", "更新接口不支持当前方法");
	}

	private async handleBranding(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method === "GET") {
			sendJson(response, 200, await loadProductBranding(this.config.agentDir));
			return;
		}
		if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "该接口只支持 GET 或 POST");
		const body = await parseJsonBody(request);
		try {
			sendJson(
				response,
				200,
				await saveProductBranding(this.config.agentDir, {
					name: body.name,
					...(Object.hasOwn(body, "logo") ? { logo: body.logo } : {}),
				}),
			);
		} catch (error) {
			throw new HttpError(400, "branding_invalid", error instanceof Error ? error.message : String(error));
		}
	}

	private gatewaySecuritySettingsEditable(): GatewaySecuritySettingsResponse["editable"] {
		return {
			host: !process.env.PI_WEB_HOST?.trim(),
			allowedHosts: !process.env.PI_WEB_ALLOWED_HOSTS?.trim(),
			port: !process.env.PI_WEB_PORT?.trim(),
			runtimePort: this.config.manageRuntime && !process.env.PI_WEB_RUNTIME_PORT?.trim(),
			password: !process.env.PI_WEB_TOKEN?.trim(),
		};
	}

	private async gatewaySecuritySettings(): Promise<GatewaySecuritySettingsResponse> {
		const persisted = await new WebConfigStore(this.config.agentDir, this.config.configPath).loadOrMigrate();
		return {
			host: persisted?.host ?? this.config.host,
			allowedHosts: persisted?.allowedHosts ?? this.config.allowedHosts,
			port: persisted?.port ?? this.config.port,
			runtimePort: this.config.manageRuntime
				? (persisted?.runtimePort ?? this.config.runtimePort ?? DEFAULT_RUNTIME_PORT)
				: (this.config.runtimePort ?? DEFAULT_RUNTIME_PORT),
			passwordConfigured: Boolean(persisted?.password ?? this.config.token),
			editable: this.gatewaySecuritySettingsEditable(),
		};
	}

	private async handleGatewaySecuritySettings(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method === "GET") {
			sendJson(response, 200, await this.gatewaySecuritySettings());
			return;
		}
		if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "该接口不支持当前方法");
		if (!this.restartHandler)
			throw new HttpError(503, "gateway_restart_unavailable", "当前 Gateway 不支持应用安全与访问设置");

		const body = await parseJsonBody(request);
		const store = new WebConfigStore(this.config.agentDir, this.config.configPath);
		const persisted = await store.loadOrMigrate();
		const current = {
			host: persisted?.host ?? this.config.host,
			allowedHosts: persisted?.allowedHosts ?? this.config.allowedHosts,
			port: persisted?.port ?? this.config.port,
			runtimePort: this.config.manageRuntime
				? (persisted?.runtimePort ?? this.config.runtimePort ?? DEFAULT_RUNTIME_PORT)
				: (this.config.runtimePort ?? DEFAULT_RUNTIME_PORT),
			password: persisted?.password ?? this.config.token,
		};
		const editable = this.gatewaySecuritySettingsEditable();
		if (!editable.host && body.host !== undefined && body.host !== current.host)
			throw new HttpError(409, "gateway_host_managed_by_environment", "监听 IP 由启动环境变量管理");
		if (!editable.allowedHosts && body.allowedHosts !== undefined) {
			try {
				if (JSON.stringify(validateAllowedHosts(body.allowedHosts)) !== JSON.stringify(current.allowedHosts))
					throw new HttpError(409, "gateway_allowed_hosts_managed_by_environment", "白名单由启动环境变量管理");
			} catch (error) {
				if (error instanceof HttpError) throw error;
				throw new HttpError(
					400,
					"gateway_allowed_hosts_invalid",
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		if (!editable.port && body.port !== undefined && Number(body.port) !== current.port)
			throw new HttpError(409, "gateway_port_managed_by_environment", "服务端口由启动环境变量管理");
		if (!editable.runtimePort && body.runtimePort !== undefined && Number(body.runtimePort) !== current.runtimePort)
			throw new HttpError(409, "gateway_runtime_port_managed_by_environment", "Runtime 端口由启动环境变量管理");
		if (!editable.password && body.password !== undefined && body.password !== "")
			throw new HttpError(409, "gateway_password_managed_by_environment", "访问密码由启动环境变量管理");
		let host: string;
		let allowedHosts: string[];
		let port: number;
		let runtimePort: number;
		try {
			host = validateGatewayHost(body.host ?? current.host);
			allowedHosts = validateAllowedHosts(body.allowedHosts ?? current.allowedHosts);
			port = parseGatewayPort(body.port ?? current.port);
			runtimePort = parseGatewayPort(body.runtimePort ?? current.runtimePort);
		} catch (error) {
			throw new HttpError(
				400,
				"gateway_network_settings_invalid",
				error instanceof Error ? error.message : String(error),
			);
		}
		let password = current.password;
		let passwordChanged = false;
		if (body.password !== undefined) {
			if (typeof body.password !== "string")
				throw new HttpError(400, "gateway_password_invalid", "连接密钥必须是文本");
			if (body.password.trim()) {
				try {
					password = validateWebPassword(body.password);
					passwordChanged = true;
				} catch (error) {
					throw new HttpError(
						400,
						"gateway_password_invalid",
						error instanceof Error ? error.message : String(error),
					);
				}
			}
		}

		const saved = await store.save({ host, allowedHosts, port, runtimePort, password });
		const result: GatewaySecuritySettingsSaveResponse = {
			host: saved.host,
			allowedHosts: saved.allowedHosts,
			port: saved.port,
			runtimePort: saved.runtimePort,
			passwordConfigured: true,
			editable,
			accepted: true,
			passwordChanged,
			restartPending: true,
			runtimePreserved: true,
		};
		this.restartAfterResponse(response);
		sendJson(response, 202, result, { Connection: "close" });
	}

	private async handleSettings(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		context: BrowserContext,
		parts: string[],
	): Promise<void> {
		if (parts.length === 3 && parts[2] === "imports") {
			const projectId = stringValue(url.searchParams.get("projectId"));
			if (!projectId) throw new HttpError(400, "project_required", "导入资源需要当前项目");
			const project = this.project(projectId);
			const client = await this.getClient(context);
			if (request.method === "GET") {
				sendJson(
					response,
					200,
					await client.request<JsonValue>({ command: "list_harness_imports", cwd: project.cwd }),
				);
				return;
			}
			if (request.method === "POST") {
				const body = await parseJsonBody(request);
				const itemIds = Array.isArray(body.itemIds)
					? body.itemIds.filter((value): value is string => typeof value === "string" && value.length > 0)
					: [];
				if (itemIds.length === 0) throw new HttpError(400, "import_items_required", "没有可迁移的资源");
				sendJson(
					response,
					200,
					await client.request<JsonValue>({
						command: "import_harness_resources",
						cwd: project.cwd,
						itemIds,
						clientInstanceId: context.id,
						clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
					}),
				);
				return;
			}
			throw new HttpError(405, "method_not_allowed", "该接口不支持当前方法");
		}

		if (parts.length === 3 && parts[2] === "subagents") {
			const projectId = stringValue(url.searchParams.get("projectId"));
			if (!projectId) throw new HttpError(400, "project_required", "智能体配置需要当前项目");
			const project = this.project(projectId);
			const client = await this.getClient(context);
			if (request.method === "GET") {
				sendJson(response, 200, {
					subagents: await client.request<SubagentConfig[]>({
						command: "list_subagent_configs",
						cwd: project.cwd,
					}),
				});
				return;
			}
			if (request.method === "POST") {
				const body = await parseJsonBody(request);
				const scope = body.scope === "user" || body.scope === "project" ? body.scope : undefined;
				if (!scope) throw new HttpError(400, "subagent_scope_invalid", "智能体范围无效");
				const name = stringValue(body.name);
				const description = stringValue(body.description);
				if (!name) throw new HttpError(400, "subagent_name_invalid", "智能体名称不能为空");
				if (!description) throw new HttpError(400, "subagent_description_invalid", "智能体描述不能为空");
				if (typeof body.content !== "string")
					throw new HttpError(400, "subagent_content_invalid", "智能体内容必须是文本");
				const tools = Array.isArray(body.tools)
					? body.tools.filter((value): value is string => typeof value === "string" && value.length > 0)
					: undefined;
				const thinkingLevels: ThinkingLevel[] = [
					"off",
					"minimal",
					"low",
					"medium",
					"high",
					"xhigh",
					"max",
					"ultra",
				];
				const thinkingLevel = thinkingLevels.find((value) => value === body.thinkingLevel);
				const subagents = await client.request<SubagentConfig[]>({
					command: "save_subagent_config",
					cwd: project.cwd,
					scope,
					...(typeof body.originalName === "string" ? { originalName: body.originalName } : {}),
					name,
					description,
					...(typeof body.provider === "string" ? { provider: body.provider } : {}),
					...(typeof body.model === "string" ? { model: body.model } : {}),
					...(thinkingLevel ? { thinkingLevel } : {}),
					...(tools ? { tools } : {}),
					content: body.content,
					...(typeof body.expectedHash === "string" ? { expectedHash: body.expectedHash } : {}),
					clientInstanceId: context.id,
					clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
				});
				sendJson(response, 200, { subagents });
				return;
			}
			if (request.method === "DELETE") {
				const body = await parseJsonBody(request);
				const scope = body.scope === "user" || body.scope === "project" ? body.scope : undefined;
				if (!scope) throw new HttpError(400, "subagent_scope_invalid", "智能体范围无效");
				const name = stringValue(body.name);
				const expectedHash = stringValue(body.expectedHash);
				if (!name || !expectedHash)
					throw new HttpError(400, "subagent_delete_invalid", "删除智能体需要名称和文件版本");
				const subagents = await client.request<SubagentConfig[]>({
					command: "delete_subagent_config",
					cwd: project.cwd,
					scope,
					name,
					expectedHash,
					clientInstanceId: context.id,
					clientRequestId: stringValue(body.clientRequestId) ?? randomUUID(),
				});
				sendJson(response, 200, { subagents });
				return;
			}
			throw new HttpError(405, "method_not_allowed", "该接口不支持当前方法");
		}

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
		if (event.type === "model_catalog_changed") {
			const hello = context.client?.getSnapshot().hello;
			const eventKey = `${hello?.serverInstanceId ?? "runtime"}:${event.revision}`;
			if (this.lastRuntimeModelCatalogEvent !== eventKey) {
				this.lastRuntimeModelCatalogEvent = eventKey;
				this.invalidateModelCatalog();
			}
			return;
		}
		if (context.sockets.size === 0) {
			const projected = this.projectEvent(event);
			if (projected?.type === "session_progress" || projected?.type === "subagent_updated") {
				const sessionId = stringValue(projected.sessionId);
				if (sessionId && context.resumeSessionIds.has(sessionId)) {
					if (projected.type === "session_progress")
						this.broadcastSessionProgress(context, projected as WebSessionProgressEvent);
					else this.recordSessionDetail(context, sessionId, projected);
				}
				return;
			}
			this.invalidateBootstrap(context);
			return;
		}
		if (event.type !== "session_progress" && event.type !== "subagent_updated") this.invalidateBootstrap(context);
		const projected = this.projectEvent(event);
		if (!projected) {
			this.invalidateBootstrap(context);
			this.broadcast(context, { type: "sessions_changed" });
			return;
		}
		if (projected.type === "session_progress") {
			this.enqueueProgress(context, projected as WebSessionProgressEvent);
			return;
		}
		this.flushPendingProgress(context);
		if (projected.type === "session_snapshot") {
			this.broadcastSessionSnapshot(
				context,
				projected as {
					type: "session_snapshot";
					sessionId: string;
					snapshot: WebSessionSnapshot;
				},
			);
			return;
		}
		if (projected.type === "session_removed") {
			const sessionId = typeof projected.sessionId === "string" ? projected.sessionId : undefined;
			if (sessionId) {
				context.leases.delete(sessionId);
				context.sessionSummaryState.delete(sessionId);
				context.sessionSnapshotState.delete(sessionId);
				context.sessionDetailState.delete(sessionId);
				for (const socket of context.sockets) this.subscriptionsFor(socket).delete(sessionId);
			}
			this.broadcast(context, projected);
			return;
		}
		if (
			projected.type === "transcript_changed" ||
			projected.type === "transcript_committed" ||
			projected.type === "subagent_updated"
		) {
			const sessionId = typeof projected.sessionId === "string" ? projected.sessionId : undefined;
			if (sessionId) this.recordSessionDetail(context, sessionId, projected);
			return;
		}
		if (projected.type === "operation_updated") {
			this.broadcastSessionOperation(
				context,
				projected as {
					type: "operation_updated";
					operation: WebOperation;
				},
			);
			return;
		}
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
		if (event.type === "subagent_updated") {
			const sessionId = this.sessionIdsByPath.get(event.sessionPath);
			if (!sessionId) return undefined;
			const projected: WebSubagentUpdatedEvent = {
				type: "subagent_updated",
				sessionId,
				snapshot: event.snapshot,
				...(event.progress?.length ? { progress: event.progress } : {}),
			};
			return projected;
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

	private sendWebSocket(socket: WebSocket, payload: string): void {
		if (socket.readyState !== WebSocket.OPEN) return;
		if (socket.bufferedAmount + Buffer.byteLength(payload) > 2 * 1024 * 1024) {
			socket.terminate();
			return;
		}
		socket.send(payload, (error) => {
			if (error) socket.terminate();
		});
	}

	private subscriptionsFor(socket: WebSocket): Set<string> {
		let subscriptions = this.detailSubscriptions.get(socket);
		if (!subscriptions) {
			subscriptions = new Set();
			this.detailSubscriptions.set(socket, subscriptions);
		}
		return subscriptions;
	}

	private projectSubscriptionsFor(socket: WebSocket): Set<string> {
		let subscriptions = this.projectSubscriptions.get(socket);
		if (!subscriptions) {
			subscriptions = new Set();
			this.projectSubscriptions.set(socket, subscriptions);
		}
		return subscriptions;
	}

	private detailStateFor(context: BrowserContext, sessionId: string): SessionDetailState {
		let state = context.sessionDetailState.get(sessionId);
		if (!state) {
			state = { nextSeq: 0, events: [], bytes: 0 };
			context.sessionDetailState.set(sessionId, state);
		}
		return state;
	}

	private recordSessionDetail(context: BrowserContext, sessionId: string, value: unknown): void {
		const state = this.detailStateFor(context, sessionId);
		const seq = state.nextSeq + 1;
		state.nextSeq = seq;
		const payload = JSON.stringify({ ...(object(value) ?? {}), seq });
		const bytes = Buffer.byteLength(payload);
		if (bytes <= MAX_SESSION_DETAIL_BYTES) {
			while (
				state.events.length >= MAX_SESSION_DETAIL_EVENTS ||
				(state.events.length > 0 && state.bytes + bytes > MAX_SESSION_DETAIL_BYTES)
			) {
				const removed = state.events.shift();
				if (removed) state.bytes -= removed.bytes;
			}
			state.events.push({ seq, payload, bytes });
			state.bytes += bytes;
		}
		for (const socket of context.sockets) {
			if (this.subscriptionsFor(socket).has(sessionId)) this.sendWebSocket(socket, payload);
		}
	}

	private subscribeSession(context: BrowserContext, socket: WebSocket, sessionId: string, lastSeq?: number): void {
		this.subscriptionsFor(socket).add(sessionId);
		const lease = context.leases.get(sessionId);
		if (lease) {
			this.sendWebSocket(socket, JSON.stringify({ type: "session_lease", sessionId, lease: publicLease(lease) }));
		}
		const state = context.sessionDetailState.get(sessionId);
		const currentSeq = state?.nextSeq ?? 0;
		if (lastSeq !== undefined) {
			const oldestSeq = state?.events[0]?.seq;
			const gap =
				lastSeq > currentSeq ||
				(currentSeq > lastSeq && oldestSeq === undefined) ||
				(oldestSeq !== undefined && lastSeq < oldestSeq - 1);
			if (!gap) {
				for (const event of state?.events ?? []) {
					if (event.seq > lastSeq) this.sendWebSocket(socket, event.payload);
				}
			}
			this.sendWebSocket(socket, JSON.stringify({ type: "session_subscription", sessionId, seq: currentSeq, gap }));
			return;
		}
		this.sendWebSocket(
			socket,
			JSON.stringify({ type: "session_subscription", sessionId, seq: currentSeq, gap: false }),
		);
	}

	private sendToSessionUnsubscribers(context: BrowserContext, sessionId: string, value: unknown): void {
		const payload = JSON.stringify(value);
		for (const socket of context.sockets) {
			if (!this.subscriptionsFor(socket).has(sessionId)) this.sendWebSocket(socket, payload);
		}
	}

	private broadcastSessionProgress(context: BrowserContext, event: WebSessionProgressEvent): void {
		const activity = sessionActivityFromProgress(event.progress);
		if (activity) this.broadcastSessionActivity(context, event.sessionId, activity);
		this.recordSessionDetail(context, event.sessionId, event);
	}

	private broadcastSessionActivity(
		context: BrowserContext,
		sessionId: string,
		activity: SessionActivity,
		operationUpdatedAt?: number,
	): void {
		const previous = context.sessionSummaryState.get(sessionId);
		if (previous?.activity === activity) {
			if (operationUpdatedAt !== undefined && previous.operationUpdatedAt !== operationUpdatedAt) {
				context.sessionSummaryState.set(sessionId, { ...previous, operationUpdatedAt });
			}
			return;
		}
		context.sessionSummaryState.set(sessionId, {
			name: previous?.name,
			activity,
			...(operationUpdatedAt === undefined ? {} : { operationUpdatedAt }),
		});
		this.sendToSessionUnsubscribers(context, sessionId, {
			type: "session_summary",
			sessionId,
			activity,
			...(operationUpdatedAt === undefined ? {} : { operationUpdatedAt }),
		});
	}

	private broadcastSessionSnapshot(
		context: BrowserContext,
		event: { type: "session_snapshot"; sessionId: string; snapshot: WebSessionSnapshot },
	): void {
		const previousSnapshot = context.sessionSnapshotState.get(event.sessionId);
		context.sessionSnapshotState.set(event.sessionId, event.snapshot);
		const previous = context.sessionSummaryState.get(event.sessionId);
		const changed = previous?.activity !== event.snapshot.activity || previous?.name !== event.snapshot.name;
		context.sessionSummaryState.set(event.sessionId, {
			name: event.snapshot.name,
			activity: event.snapshot.activity,
			...(previous?.operationUpdatedAt === undefined ? {} : { operationUpdatedAt: previous.operationUpdatedAt }),
		});
		if (changed) {
			this.sendToSessionUnsubscribers(context, event.sessionId, {
				type: "session_summary",
				sessionId: event.sessionId,
				activity: event.snapshot.activity,
				...(event.snapshot.name === undefined ? {} : { name: event.snapshot.name }),
			});
		}
		if (previousSnapshot && sameSessionSnapshot(previousSnapshot, event.snapshot)) return;
		this.recordSessionDetail(context, event.sessionId, event);
	}

	private broadcastSessionOperation(
		context: BrowserContext,
		event: { type: "operation_updated"; operation: WebOperation },
	): void {
		const sessionId = event.operation.sessionId;
		if (!sessionId) {
			this.broadcast(context, event);
			return;
		}
		const activity = sessionActivityFromOperation(event.operation.status);
		if (activity) this.broadcastSessionActivity(context, sessionId, activity, event.operation.updatedAt);
		this.recordSessionDetail(context, sessionId, event);
	}

	private broadcastProject(context: BrowserContext, projectId: string, value: unknown): void {
		const payload = JSON.stringify(value);
		for (const socket of context.sockets) {
			if (this.projectSubscriptionsFor(socket).has(projectId)) this.sendWebSocket(socket, payload);
		}
	}

	private broadcast(context: BrowserContext, value: unknown): void {
		const payload = JSON.stringify(value);
		for (const socket of context.sockets) this.sendWebSocket(socket, payload);
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

	private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
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
		const resumeGeneration = context.sockets.size === 0 ? context.resumeGeneration : undefined;
		context.resumeGeneration = undefined;
		context.sockets.add(socket);
		this.touchContext(context);
		this.socketLiveness.set(socket, true);
		const subscriptions = this.subscriptionsFor(socket);
		const projectSubscriptions = this.projectSubscriptionsFor(socket);
		socket.on("message", (raw) => {
			try {
				const message = object(JSON.parse(String(raw)));
				if (message?.type === "subscribe_project" || message?.type === "unsubscribe_project") {
					const projectId = stringValue(message.projectId);
					if (!projectId) return;
					if (message.type === "subscribe_project") projectSubscriptions.add(projectId);
					else projectSubscriptions.delete(projectId);
					return;
				}
				const sessionId = stringValue(message?.sessionId);
				if (!sessionId) return;
				if (message?.type === "subscribe_session") {
					const candidate = message.lastSeq;
					const lastSeq =
						typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
							? candidate
							: undefined;
					this.subscribeSession(context, socket, sessionId, lastSeq);
				} else if (message?.type === "unsubscribe_session") subscriptions.delete(sessionId);
			} catch {
				// 忽略无法识别的客户端订阅消息，避免影响现有连接。
			}
		});
		socket.on("pong", () => {
			this.socketLiveness.set(socket, true);
		});
		let removed = false;
		const removeSocket = () => {
			if (removed) return;
			removed = true;
			context.sockets.delete(socket);
			if (context.sockets.size === 0) {
				this.flushPendingProgress(context);
				context.resumeGeneration = context.bootstrapGeneration;
				context.resumeSessionIds = new Set(subscriptions);
			}
			this.scheduleContextCleanup(context);
		};
		socket.on("close", removeSocket);
		socket.on("error", removeSocket);
		try {
			const cached = context.bootstrapCache;
			if (
				cached &&
				context.connectionState !== "disconnected" &&
				(cached.generation === context.bootstrapGeneration || resumeGeneration === context.bootstrapGeneration)
			) {
				this.sendWebSocket(
					socket,
					JSON.stringify({ type: "connection_state", connected: cached.value.connection.connected, message: "" }),
				);
				return;
			}
			const runtimeRecovery = context.connectionState === "disconnected";
			if (!context.client?.getSnapshot().connected) {
				await this.getClient(context);
				if (runtimeRecovery) return;
			}
			if (socket.readyState !== WebSocket.OPEN) return;
			this.sendWebSocket(socket, JSON.stringify({ type: "connection_state", connected: true, message: "" }));
			const bootstrap = await this.buildBootstrap(context);
			this.sendWebSocket(socket, JSON.stringify({ type: "bootstrap", data: bootstrap }));
		} catch (error) {
			if (socket.readyState === WebSocket.OPEN) socket.close(1011, toError(error).message.slice(0, 120));
		}
	}
}

export async function createWebGatewayServer(): Promise<WebGatewayServer> {
	return new WebGatewayServer(await loadWebGatewayConfig());
}
