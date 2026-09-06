import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	assertWorkspaceCommandResult,
	type Capability,
	type ClientMessage,
	type CompletionResult,
	isSessionProgress,
	type JsonValue,
	type OperationSnapshot,
	RUNTIME_PROTOCOL_VERSION,
	type ServerEvent,
	type ServerMessage,
	type SessionActivity,
	type SessionProgress,
	type SessionStateSnapshot,
	type SessionSummary,
	type StartupInput,
	type TranscriptItem,
} from "@lystar/code-web-protocol";
import { ContentStore } from "./content-store.ts";
import { LeaseManager } from "./lease-manager.ts";
import { hashOperationPayload, OperationJournal, OperationJournalCorruptError } from "./operation-journal.ts";
import { BUILTIN_SLASH_COMMANDS } from "./runtime-adapter.ts";
import { projectTranscriptBatch } from "./transcript-projection.ts";
import { TranscriptReader } from "./transcript-reader.ts";
import type { RuntimeAdapter, RuntimeSession, UiRequestHandler } from "./types.ts";

const BASE_CAPABILITIES: Capability[] = [
	"session-paging",
	"session-control",
	"operation-journal",
	"project-trust-ui",
	"models",
	"models-auth",
	"skills",
	"git-inspector",
	"content-ref",
	"about",
	"diagnostics",
	"connections",
	"updates",
	"session-observation",
	"project-instructions",
	"host-instructions",
	"completion",
	"project-resources",
	"directory-browser",
	"external-resources",
	"workspace-api",
];

const SESSION_FILE_POLL_INTERVAL_MS = 1_000;
const PROGRESS_BATCH_MS = 50;
const MAX_PENDING_PROGRESS = 64;

const ACTIVE_OPERATION_STATUSES = new Set<OperationSnapshot["status"]>(["accepted", "running", "waiting_for_input"]);
const BOOTSTRAP_OPERATION_LIMIT = 200;
const TERMINAL_OPERATION_STATUSES = new Set<OperationSnapshot["status"]>([
	"completed",
	"failed",
	"aborted",
	"interrupted",
]);

function sessionActivityFromOperation(status: OperationSnapshot["status"]): SessionActivity {
	switch (status) {
		case "accepted":
		case "running":
			return "running";
		case "waiting_for_input":
			return "waiting_for_input";
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "aborted":
			return "aborted";
		case "interrupted":
			return "interrupted";
	}
}

function isActiveSessionActivity(activity: SessionActivity): boolean {
	return activity === "running" || activity === "waiting_for_input";
}

const WORKSPACE_COMMANDS = {
	list_skills: true,
	set_skill_enabled: true,
	list_project_instructions: true,
	save_project_instruction: true,
	list_host_instructions: true,
	save_host_instruction: true,
	get_git_status: true,
	get_git_diff: true,
	check_for_updates: true,
	list_settings: true,
	set_setting: true,
	list_models: true,
	list_model_providers: true,
	set_session_model: true,
	set_session_thinking: true,
	cycle_session_model: true,
	cycle_session_thinking: true,
	login_model_provider: true,
	logout_model_provider: true,
	get_project_trust: true,
	set_project_trust: true,
	list_packages: true,
	install_package: true,
	remove_package: true,
	update_packages: true,
	get_session_tree: true,
	get_session_info: true,
	list_fork_messages: true,
	fork_session: true,
	set_entry_label: true,
	navigate_session_tree: true,
	list_subagents: true,
	read_subagent: true,
	abort_subagent: true,
	continue_subagent: true,
	read_clipboard_text: true,
	read_clipboard_image: true,
	read_project_image: true,
	write_clipboard_text: true,
	get_changelog: true,
	render_rich_text: true,
	read_image_content: true,
	get_completions: true,
} as const;

function fallbackResourceCompletions(
	text: string,
	cursor: number,
	skills: ReadonlyArray<{ name: string; description?: string }>,
): CompletionResult | undefined {
	const before = text.slice(0, cursor);
	const slash = /^\/([^\s]*)$/.exec(before);
	if (slash) {
		const query = slash[1].toLowerCase();
		const items: CompletionResult["items"] = [
			...BUILTIN_SLASH_COMMANDS.map((command) => ({
				value: `/${command.name} `,
				label: command.name,
				description: command.description,
				kind: "command" as const,
			})),
			...skills.map((skill) => ({
				value: `/skill:${skill.name} `,
				label: `skill:${skill.name}`,
				description: skill.description,
				kind: "skill" as const,
			})),
		];
		return {
			prefixStart: 0,
			prefixEnd: cursor,
			items: items
				.filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(query))
				.slice(0, 50),
		};
	}

	const skill = /(?:^|\s)\$(\[?)([a-z0-9-]*)$/i.exec(before);
	if (!skill) return undefined;
	const query = skill[2].toLowerCase();
	const prefix = `$${skill[1]}${skill[2]}`;
	return {
		prefixStart: cursor - prefix.length,
		prefixEnd: cursor,
		items: skills
			.filter((candidate) => `${candidate.name} ${candidate.description ?? ""}`.toLowerCase().includes(query))
			.slice(0, 30)
			.map((candidate) => ({
				value: `$[${candidate.name}] `,
				label: candidate.name,
				description: candidate.description,
				kind: "skill" as const,
			})),
	};
}

function projectSessionProgress(value: JsonValue | SessionProgress): SessionProgress {
	if (isSessionProgress(value)) return value;
	const record =
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>) : undefined;
	return {
		type: "status",
		status: record?.type === "extension_error" ? "扩展运行失败" : "运行状态已更新",
	};
}

interface PendingSessionProgress {
	key?: string;
	progress: SessionProgress;
}

function sessionProgressKey(progress: SessionProgress): string | undefined {
	switch (progress.type) {
		case "assistant_delta":
		case "thinking_delta":
		case "phase":
		case "queue_update":
		case "status":
		case "usage":
			return progress.type;
		case "tool_update":
			return `${progress.type}:${progress.toolCallId}`;
		default:
			return undefined;
	}
}

function mergeSessionProgress(left: SessionProgress, right: SessionProgress): SessionProgress {
	if (left.type === "assistant_delta" && right.type === "assistant_delta")
		return { type: "assistant_delta", text: left.text + right.text };
	if (left.type === "thinking_delta" && right.type === "thinking_delta")
		return { type: "thinking_delta", text: left.text + right.text };
	return right;
}

interface ClientConnection {
	id: string;
	clientInstanceId?: string;
	send(message: ServerMessage): Promise<void>;
}

interface PendingUiRequest {
	operationId: string;
	clientInstanceId?: string;
	event: Extract<ServerEvent, { type: "ui_request" }>;
	resolve(response: { value?: JsonValue; confirmed?: boolean; cancelled?: boolean }): void;
	timer?: ReturnType<typeof setTimeout>;
	cleanup?: () => void;
}

interface SessionFileFact {
	updatedAt: number;
	messageCount: number;
	name?: string;
	writerLocked: boolean;
}

interface RuntimeTranscriptFact {
	updatedAt: number;
	revision: number;
}

function protocolError(error: unknown): { code: string; message: string; retryable?: boolean; details?: JsonValue } {
	if (typeof error === "object" && error !== null) {
		const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown };
		return {
			code: typeof candidate.code === "string" ? candidate.code : "internal_error",
			message: typeof candidate.message === "string" ? candidate.message : String(error),
			retryable: typeof candidate.retryable === "boolean" ? candidate.retryable : undefined,
			...(candidate.details === undefined ? {} : { details: jsonValue(candidate.details) }),
		};
	}
	return { code: "internal_error", message: String(error) };
}

function canonicalSessionPath(sessionPath: string): string {
	const resolvedPath = resolve(sessionPath);
	if (existsSync(resolvedPath)) return realpathSync(resolvedPath);
	return join(realpathSync(dirname(resolvedPath)), basename(resolvedPath));
}

function canonicalProjectCwd(cwd: string): string {
	return realpathSync(resolve(cwd));
}

function jsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function projectFileCompletion(text: string, cursor: number): { prefixStart: number; query: string } | undefined {
	const before = text.slice(0, cursor);
	const match = /(?:^|[\s=(])(@"[^"]*|@[^\s]*)$/.exec(before);
	if (!match) return undefined;
	return {
		prefixStart: cursor - match[1].length,
		query: match[1].startsWith('@"') ? match[1].slice(2) : match[1].slice(1),
	};
}

function attachFileCompletion(text: string, cursor: number): { prefixStart: number; query: string } | undefined {
	const before = text.slice(0, cursor);
	const match = /^\/attach\s+(?:"([^"]*)|([^\n]*))$/.exec(before);
	if (!match) return undefined;
	const query = match[1] ?? match[2] ?? "";
	return { prefixStart: cursor - query.length - (match[1] === undefined ? 0 : 1), query };
}

function attachCompletionValue(value: string): string {
	const candidate = value.startsWith("@") ? value.slice(1).trimEnd() : value;
	return candidate.startsWith('"') && candidate.endsWith('"') ? candidate.slice(1, -1) : candidate;
}

export class WebRuntimeService {
	readonly serverInstanceId = randomUUID();
	readonly hostInstanceId = randomUUID();
	readonly hostStartedAt = Date.now();
	private readonly clients = new Map<string, ClientConnection>();
	private readonly runtimes = new Map<string, RuntimeSession>();
	private readonly runtimeUnsubscribers = new Map<string, () => void>();
	private readonly activeOperationBySession = new Map<string, string>();
	private readonly scheduledOperations = new Set<string>();
	private readonly operationAbortControllers = new Map<string, AbortController>();
	private readonly journalWritePromises = new Map<string, Promise<JsonValue>>();
	private readonly writeScopeQueues = new Map<string, Promise<void>>();
	private readonly snapshotRevisions = new Map<string, number>();
	private readonly snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly pendingProgress = new Map<string, PendingSessionProgress[]>();
	private readonly pendingUi = new Map<string, PendingUiRequest>();
	private readonly leases = new LeaseManager();
	private readonly transcriptReader = new TranscriptReader();
	private readonly contentStore = new ContentStore();
	private readonly journal: OperationJournal;
	private readonly adapter: RuntimeAdapter;
	private readonly capabilities: Capability[];
	private readonly persistent: boolean;
	private readonly startupInput?: StartupInput;
	private readonly startupSessionPath?: string;
	private readonly watchedSessionFacts = new Map<string, Map<string, SessionFileFact>>();
	private readonly runtimeTranscriptFacts = new Map<string, RuntimeTranscriptFact>();
	private readonly sessionPollTimer: ReturnType<typeof setInterval>;
	private pollingSessions = false;

	constructor(
		adapter: RuntimeAdapter,
		options: {
			agentDir: string;
			journalPath?: string;
			persistent?: boolean;
			startupInput?: StartupInput;
			startupSessionPath?: string;
		},
	) {
		this.adapter = adapter;
		this.persistent = options.persistent === true;
		this.startupInput = options.startupInput;
		this.startupSessionPath = options.startupSessionPath
			? canonicalSessionPath(options.startupSessionPath)
			: undefined;
		this.capabilities = options.persistent ? [...BASE_CAPABILITIES, "remote-detach"] : BASE_CAPABILITIES;
		this.journal = new OperationJournal(options.journalPath ?? join(options.agentDir, "host", "operations.jsonl"));
		try {
			this.journal.markInterrupted();
		} catch (error) {
			if (!(error instanceof OperationJournalCorruptError)) throw error;
		}
		this.sessionPollTimer = setInterval(() => void this.pollSessionFiles(), SESSION_FILE_POLL_INTERVAL_MS);
		this.sessionPollTimer.unref?.();
	}

	createConnection(send: (message: ServerMessage) => Promise<void>): {
		id: string;
		handle(message: ClientMessage): Promise<void>;
		close(): Promise<void>;
	} {
		const connection: ClientConnection = { id: randomUUID(), send };
		this.clients.set(connection.id, connection);
		return {
			id: connection.id,
			handle: (message) => this.handle(connection, message),
			close: () => this.detachConnection(connection),
		};
	}

	private abortClientAuthenticationOperations(clientInstanceId: string): void {
		for (const operation of this.journal.list()) {
			if (
				operation.type !== "login_model_provider" ||
				operation.clientInstanceId !== clientInstanceId ||
				TERMINAL_OPERATION_STATUSES.has(operation.status) ||
				this.activeOperationBySession.get(operation.sessionPath) !== operation.operationId
			)
				continue;
			this.updateOperation(operation.operationId, "aborted");
			this.cancelPendingUi(operation.operationId);
			this.operationAbortControllers.get(operation.operationId)?.abort();
		}
	}

	private async detachConnection(connection: ClientConnection): Promise<void> {
		this.clients.delete(connection.id);
		if (!connection.clientInstanceId) return;
		if ([...this.clients.values()].some((client) => client.clientInstanceId === connection.clientInstanceId)) return;
		this.abortClientAuthenticationOperations(connection.clientInstanceId);
		for (const sessionPath of this.leases.releaseClient(connection.clientInstanceId)) {
			const runtime = this.runtimes.get(sessionPath);
			if (runtime) await this.sendSessionSnapshots(runtime, this.leases.has(sessionPath));
			this.releaseAcceptedReservation(sessionPath);
			if (!this.leases.has(sessionPath) && !this.activeOperationBySession.has(sessionPath))
				await this.disposeRuntime(sessionPath);
		}
	}

	async dispose(): Promise<void> {
		clearInterval(this.sessionPollTimer);
		for (const controller of this.operationAbortControllers.values()) controller.abort();
		this.operationAbortControllers.clear();
		for (const runtime of this.runtimes.values()) await runtime.dispose();
		this.runtimes.clear();
		this.runtimeUnsubscribers.clear();
		for (const request of this.pendingUi.values()) {
			if (request.timer) clearTimeout(request.timer);
			request.cleanup?.();
			request.resolve({ cancelled: true });
		}
		this.pendingUi.clear();
		this.snapshotRevisions.clear();
		for (const timer of this.snapshotTimers.values()) clearTimeout(timer);
		this.snapshotTimers.clear();
		for (const timer of this.progressTimers.values()) clearTimeout(timer);
		this.progressTimers.clear();
		this.pendingProgress.clear();
		this.contentStore.clear();
	}

	private async handle(connection: ClientConnection, message: ClientMessage): Promise<void> {
		if (message.type === "hello") {
			if (message.version !== RUNTIME_PROTOCOL_VERSION) {
				await connection.send({
					type: "hello_error",
					error: {
						code: "version",
						message: `Web Runtime Protocol ${message.version} is unsupported; Host requires ${RUNTIME_PROTOCOL_VERSION}`,
						retryable: false,
					},
				});
				return;
			}
			connection.clientInstanceId = message.clientInstanceId;
			const about = this.adapter.getAbout() as { productVersion?: JsonValue };
			await connection.send({
				type: "hello",
				version: RUNTIME_PROTOCOL_VERSION,
				productVersion: typeof about.productVersion === "string" ? about.productVersion : "unknown",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				serverInstanceId: this.serverInstanceId,
				hostInstanceId: this.hostInstanceId,
				hostStartedAt: this.hostStartedAt,
				capabilities: this.capabilities,
			});
			return;
		}

		if (message.type === "ui_response") {
			if (!connection.clientInstanceId) return;
			const pending = this.pendingUi.get(message.id);
			if (!pending || (pending.clientInstanceId && pending.clientInstanceId !== connection.clientInstanceId)) return;
			const operation = this.journal.get(pending.operationId);
			if (operation && operation.clientInstanceId !== connection.clientInstanceId) return;
			this.pendingUi.delete(message.id);
			if (pending.timer) clearTimeout(pending.timer);
			pending.cleanup?.();
			this.restoreOperationAfterUi(pending.operationId);
			pending.resolve({ value: message.value, confirmed: message.confirmed, cancelled: message.cancelled });
			return;
		}

		if (!connection.clientInstanceId) {
			await connection.send({
				type: "response",
				id: message.id,
				ok: false,
				error: { code: "hello_required", message: "Client hello must be sent first", retryable: false },
			});
			return;
		}

		let afterResponse: (() => void) | undefined;
		let result: JsonValue;
		try {
			result = jsonValue(
				await this.executeCommand(connection, message.request, (action) => {
					afterResponse = action;
				}),
			);
			if (message.request.command in WORKSPACE_COMMANDS) {
				assertWorkspaceCommandResult(
					message.request.command as Parameters<typeof assertWorkspaceCommandResult>[0],
					result,
				);
			}
		} catch (error) {
			await connection.send({ type: "response", id: message.id, ok: false, error: protocolError(error) });
			return;
		}
		try {
			await connection.send({ type: "response", id: message.id, ok: true, result });
			afterResponse?.();
		} catch {
			// 回包失败时不启动 accepted operation；同一请求在重新取得租约后可安全补调度。
		}
	}

	private async executeCommand(
		connection: ClientConnection,
		request: Extract<ClientMessage, { type: "request" }>["request"],
		afterResponse: (action: () => void) => void,
	): Promise<JsonValue> {
		switch (request.command) {
			case "get_snapshot": {
				let startupSession: { path: string; cwd: string } | undefined;
				if (this.startupSessionPath) {
					try {
						const snapshot = this.adapter.inspectSession(this.startupSessionPath);
						startupSession = { path: snapshot.path, cwd: snapshot.cwd };
					} catch {
						// 交接文件可能已被删除，普通 Web Runtime 启动仍应继续。
					}
				}
				return jsonValue({
					operations: this.journal
						.list()
						.slice(0, BOOTSTRAP_OPERATION_LIMIT)
						.map(({ result: _result, ...operation }) => operation),
					pendingUiRequests: [...this.pendingUi.values()]
						.filter(
							(request) => !request.clientInstanceId || request.clientInstanceId === connection.clientInstanceId,
						)
						.map((request) => request.event),
					sessions: [...this.runtimes.values()].map((runtime) =>
						this.runtimeSnapshot(
							runtime,
							this.writeAccess(canonicalSessionPath(runtime.sessionPath), connection),
						),
					),
					...(startupSession ? { startupSessionPath: startupSession.path, startupCwd: startupSession.cwd } : {}),
				});
			}
			case "list_sessions": {
				const cwd = canonicalProjectCwd(request.cwd);
				const sessions = await this.listSessionSummaries(cwd, connection, request.metadataOnly === true);
				this.rememberSessionFacts(cwd, sessions);
				if (!request.query) return sessions;
				const query = request.query.toLowerCase();
				return sessions.filter((session) => JSON.stringify(session).toLowerCase().includes(query));
			}
			case "read_transcript": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				const page = await this.transcriptReader.read(sessionPath, {
					...request,
					emptyGeneration: this.runtimes.get(sessionPath)?.getSnapshot(this.writeAccess(sessionPath, connection))
						.transcriptGeneration,
				});
				return jsonValue({
					...page,
					requestContext: request.context,
					items: this.projectTranscriptItems(sessionPath, page.items),
				});
			}
			case "search_transcript": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				return jsonValue(
					await this.transcriptReader.search(sessionPath, {
						...request,
						emptyGeneration: this.runtimes
							.get(sessionPath)
							?.getSnapshot(this.writeAccess(sessionPath, connection)).transcriptGeneration,
					}),
				);
			}
			case "create_session": {
				const cwd = canonicalProjectCwd(request.cwd);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session-collection:${cwd}`,
					payload: { cwd },
					run: async () => {
						let sessionPath: string | undefined;
						const controlOperationId = `control:${request.clientInstanceId}`;
						const runtime = await this.adapter.createSession(
							cwd,
							this.createUiRequestHandler(
								() =>
									sessionPath
										? (this.activeOperationBySession.get(sessionPath) ?? controlOperationId)
										: controlOperationId,
								() => sessionPath,
								request.clientInstanceId,
							),
						);
						sessionPath = canonicalSessionPath(runtime.sessionPath);
						let lease: ReturnType<LeaseManager["acquire"]> | undefined;
						try {
							lease = this.leases.acquire(sessionPath, request.clientInstanceId);
							this.attachRuntime(runtime);
							await this.sendSessionSnapshots(runtime);
							return jsonValue({ lease, snapshot: this.runtimeSnapshot(runtime, "owned") });
						} catch (error) {
							if (lease) this.leases.release(sessionPath, lease.leaseId);
							if (this.runtimes.get(sessionPath) === runtime) await this.disposeRuntime(sessionPath);
							else await runtime.dispose();
							throw error;
						}
					},
				});
			}
			case "acquire_session": {
				this.assertClient(request.clientInstanceId, connection);
				this.journal.assertWritable();
				const sessionPath = canonicalSessionPath(request.sessionPath);
				const lease = this.leases.acquire(sessionPath, request.clientInstanceId);
				try {
					const runtime = await this.ensureRuntime(
						sessionPath,
						this.createUiRequestHandler(
							() => this.activeOperationBySession.get(sessionPath) ?? `control:${lease.leaseId}`,
							sessionPath,
							request.clientInstanceId,
						),
					);
					await this.sendSessionSnapshots(runtime);
					return jsonValue({
						lease,
						snapshot: this.runtimeSnapshot(runtime, "owned"),
						...(this.startupInput && this.startupSessionPath === sessionPath
							? { startupInput: this.startupInput }
							: {}),
					});
				} catch (error) {
					this.leases.release(sessionPath, lease.leaseId);
					throw error;
				}
			}
			case "inspect_session": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				const snapshot = this.adapter.inspectSession(sessionPath);
				return jsonValue({
					...snapshot,
					path: sessionPath,
					writeAccess: this.sessionWriteAccess(sessionPath, connection),
				});
			}
			case "release_session": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				this.leases.assert(sessionPath, request.leaseId, connection.clientInstanceId);
				this.releaseAcceptedReservation(sessionPath);
				const activeOperationId = this.activeOperationBySession.get(sessionPath);
				const active = activeOperationId
					? ACTIVE_OPERATION_STATUSES.has(this.journal.get(activeOperationId)?.status ?? "completed")
					: false;
				if (active) {
					throw Object.assign(new Error("会话存在正在执行的任务"), {
						code: "session_operation_active",
						retryable: true,
					});
				}
				this.leases.release(sessionPath, request.leaseId);
				const runtime = this.runtimes.get(sessionPath);
				if (runtime) await this.sendSessionSnapshots(runtime, this.leases.has(sessionPath));
				if (!this.leases.has(sessionPath)) await this.disposeRuntime(sessionPath);
				return { released: true };
			}
			case "prompt":
				return this.acceptOperation(
					connection,
					request,
					{ text: request.text, images: request.images ?? [] },
					async (runtime, operation) => {
						await runtime.prompt(request.text, request.images);
						return { sessionPath: canonicalSessionPath(runtime.sessionPath), operationId: operation.operationId };
					},
					afterResponse,
				);
			case "steer":
				return this.acceptQueueOperation(
					connection,
					request,
					{ text: request.text, images: request.images ?? [] },
					async (runtime) => {
						await runtime.steer(request.text, request.images);
						return {};
					},
				);
			case "follow_up":
				return this.acceptQueueOperation(
					connection,
					request,
					{ text: request.text, images: request.images ?? [] },
					async (runtime) => {
						await runtime.followUp(request.text, request.images);
						return {};
					},
				);
			case "clear_queue":
				return this.acceptQueueOperation(connection, request, {}, async (runtime) =>
					jsonValue(await runtime.clearQueue()),
				);
			case "compact":
				return this.acceptOperation(
					connection,
					request,
					{ customInstructions: request.customInstructions ?? null },
					async (runtime, operation) => {
						await runtime.compact(request.customInstructions);
						return { sessionPath: canonicalSessionPath(runtime.sessionPath), operationId: operation.operationId };
					},
					afterResponse,
				);
			case "share_session":
				return this.acceptOperation(
					connection,
					request,
					{},
					async (runtime, _operation, signal) => runtime.shareSession(signal),
					afterResponse,
				);
			case "export_session": {
				const { runtime, sessionPath } = this.assertExtensionSession(connection, request);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `export:${sessionPath}`,
					payload: { sessionPath, outputPath: request.outputPath ?? null },
					run: async () => jsonValue(await runtime.exportSession(request.outputPath)),
				});
			}
			case "run_bash":
				return this.acceptOperation(
					connection,
					request,
					{ commandText: request.commandText, excludeFromContext: request.excludeFromContext },
					async (runtime, operation) => {
						let output = "";
						let truncated = false;
						const update = () => {
							this.updateOperation(operation.operationId, "running", {
								progress: {
									type: "bash",
									command: request.commandText.slice(0, 16 * 1024),
									output,
									...(truncated ? { truncated: true } : {}),
								},
							});
						};
						update();
						return runtime.runBash(request.commandText, request.excludeFromContext, (chunk) => {
							output += chunk;
							if (output.length > 16 * 1024) {
								output = output.slice(-16 * 1024);
								truncated = true;
							}
							update();
						});
					},
					afterResponse,
				);
			case "abort_operation": {
				this.journal.assertWritable();
				const operation = this.journal.get(request.operationId);
				if (!operation) throw Object.assign(new Error("未找到任务"), { code: "not_found" });
				if (operation.type === "login_model_provider") {
					if (operation.clientInstanceId !== connection.clientInstanceId) {
						throw Object.assign(new Error("客户端无权取消此任务"), {
							code: "client_instance_mismatch",
							retryable: false,
						});
					}
				} else {
					this.leases.assert(operation.sessionPath, request.leaseId, connection.clientInstanceId);
				}
				if (TERMINAL_OPERATION_STATUSES.has(operation.status)) return operation;
				if (this.activeOperationBySession.get(operation.sessionPath) !== operation.operationId) {
					throw Object.assign(new Error("任务当前未在执行"), {
						code: "operation_not_active",
						retryable: false,
					});
				}
				this.updateOperation(operation.operationId, "aborted");
				this.cancelPendingUi(operation.operationId);
				this.operationAbortControllers.get(operation.operationId)?.abort();
				if (operation.type !== "share_session") await this.runtimes.get(operation.sessionPath)?.abort();
				return this.journal.get(operation.operationId) ?? operation;
			}
			case "get_operation": {
				const operation = this.journal.get(request.operationId);
				if (!operation) throw Object.assign(new Error("未找到任务"), { code: "not_found" });
				return operation;
			}
			case "list_operations":
				return this.journal.list(request.sessionPath ? canonicalSessionPath(request.sessionPath) : undefined);
			case "list_models":
				return jsonValue(await this.adapter.listModels());
			case "list_model_providers":
				return jsonValue(await this.adapter.listModelProviders());
			case "add_model_provider":
			case "add_provider_model":
			case "sync_model_provider":
			case "login_model_provider":
			case "logout_model_provider": {
				const provider = request.provider;
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `provider:${provider}`,
					lockSessionPath: request.command === "login_model_provider" ? `provider:${provider}` : undefined,
					payload: request,
					run: async (operation, signal) => {
						switch (request.command) {
							case "add_model_provider":
								return jsonValue(await this.adapter.addModelProvider(request));
							case "add_provider_model":
								return jsonValue(await this.adapter.addProviderModel(request));
							case "sync_model_provider":
								return jsonValue(await this.adapter.syncModelProvider(request.provider));
							case "login_model_provider":
								return jsonValue(
									await this.adapter.loginModelProvider(
										request.provider,
										request.authType,
										this.createUiRequestHandler(operation.operationId, undefined, request.clientInstanceId),
										signal,
									),
								);
							case "logout_model_provider":
								return jsonValue(await this.adapter.logoutModelProvider(request.provider));
						}
					},
				});
			}
			case "rename_session": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session:${sessionPath}`,
					payload: { sessionPath, name: request.name },
					run: async () => {
						const { runtime } = this.assertSessionControl(sessionPath, request.leaseId, connection);
						await runtime.rename(request.name);
						await this.sendSessionSnapshots(runtime);
						return this.runtimeSnapshot(runtime, "owned");
					},
				});
			}
			case "set_session_model": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session:${sessionPath}`,
					payload: { sessionPath, model: request.model },
					run: async () => {
						const { runtime } = this.assertSessionControl(sessionPath, request.leaseId, connection);
						await runtime.setModel(request.model);
						await this.sendSessionSnapshots(runtime);
						return this.runtimeSnapshot(runtime, "owned");
					},
				});
			}
			case "set_session_thinking": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session:${sessionPath}`,
					payload: { sessionPath, level: request.level },
					run: async () => {
						const { runtime } = this.assertSessionControl(sessionPath, request.leaseId, connection);
						await runtime.setThinkingLevel(request.level);
						await this.sendSessionSnapshots(runtime);
						return this.runtimeSnapshot(runtime, "owned");
					},
				});
			}
			case "cycle_session_model": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session:${sessionPath}`,
					payload: { sessionPath, direction: request.direction },
					run: async () => {
						const { runtime } = this.assertSessionControl(sessionPath, request.leaseId, connection);
						const result = await runtime.cycleModel(request.direction);
						await this.sendSessionSnapshots(runtime);
						return { snapshot: this.runtimeSnapshot(runtime, "owned"), ...result };
					},
				});
			}
			case "cycle_session_thinking": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session:${sessionPath}`,
					payload: { sessionPath },
					run: async () => {
						const { runtime } = this.assertSessionControl(sessionPath, request.leaseId, connection);
						const result = await runtime.cycleThinkingLevel();
						await this.sendSessionSnapshots(runtime);
						return { snapshot: this.runtimeSnapshot(runtime, "owned"), ...result };
					},
				});
			}
			case "reload_resources": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				this.assertExtensionSession(connection, request);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session:${sessionPath}`,
					lockSessionPath: sessionPath,
					payload: { sessionPath },
					run: async () => {
						const { runtime } = this.assertExtensionSession(connection, request);
						await runtime.reloadResources();
						await this.sendSessionSnapshots(runtime);
						return this.runtimeSnapshot(runtime, "owned");
					},
				});
			}
			case "fork_session": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session:${sessionPath}`,
					lockSessionPath: sessionPath,
					payload: {
						sessionPath,
						entryId: request.entryId,
						...(request.position ? { position: request.position } : {}),
					},
					run: async (operation) => {
						const { runtime } = this.assertExtensionSession(connection, request);
						const detachedCompanion = this.isDetachedCompanion(runtime, "session_fork");
						if (!detachedCompanion) this.detachRuntimeProjection(sessionPath);
						let result: Awaited<ReturnType<RuntimeSession["fork"]>> | undefined;
						let failure: unknown;
						try {
							result = await runtime.fork(request.entryId, request.position);
						} catch (error) {
							failure = error;
						}
						const nextSessionPath = canonicalSessionPath(result?.sessionPath ?? runtime.sessionPath);
						if (failure) throw failure;
						if (!result) throw new Error("会话分叉未返回结果");
						if (detachedCompanion && nextSessionPath !== sessionPath && runtime.sessionPath === sessionPath) {
							const nextRuntime = await this.openDetachedRuntime(
								nextSessionPath,
								operation.operationId,
								request.clientInstanceId,
							);
							const lease = this.leases.move(sessionPath, nextSessionPath, request.leaseId);
							this.activeOperationBySession.set(nextSessionPath, operation.operationId);
							this.snapshotRevisions.delete(sessionPath);
							await this.sendSessionSnapshots(nextRuntime);
							await this.broadcast({
								type: "sessions_changed",
								cwd: nextRuntime.getSnapshot("available").cwd,
							});
							return jsonValue({
								lease,
								snapshot: this.runtimeSnapshot(nextRuntime, "owned"),
								selectedText: result.selectedText,
							});
						}
						if (nextSessionPath !== sessionPath) {
							this.leases.move(sessionPath, nextSessionPath, request.leaseId);
							const operationId = this.activeOperationBySession.get(sessionPath);
							if (operationId) this.activeOperationBySession.set(nextSessionPath, operationId);
							this.snapshotRevisions.delete(sessionPath);
							await this.broadcast({ type: "session_removed", sessionPath });
						}
						this.attachRuntime(runtime);
						await this.sendSessionSnapshots(runtime);
						if (failure) throw failure;
						if (!result) throw new Error("会话分叉未返回结果");
						return jsonValue({
							lease: this.leases.get(nextSessionPath, request.clientInstanceId),
							snapshot: this.runtimeSnapshot(runtime, "owned"),
							selectedText: result.selectedText,
						});
					},
				});
			}
			case "import_session": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session:${sessionPath}`,
					payload: {
						sessionPath,
						inputPath: request.inputPath,
						cwdOverride: request.cwdOverride ?? null,
					},
					run: async (operation) => {
						const { runtime } = this.assertSessionControl(sessionPath, request.leaseId, connection);
						const detachedCompanion = this.isDetachedCompanion(runtime, "session_import");
						if (!detachedCompanion) this.detachRuntimeProjection(sessionPath);
						let result: Awaited<ReturnType<RuntimeSession["importSession"]>> | undefined;
						let failure: unknown;
						try {
							result = await runtime.importSession(request.inputPath, request.cwdOverride);
						} catch (error) {
							failure = error;
						}
						if (failure) {
							if (canonicalSessionPath(runtime.sessionPath) === sessionPath) {
								this.attachRuntime(runtime);
								await this.sendSessionSnapshots(runtime);
							}
							throw failure;
						}
						if (!result) throw new Error("会话导入未返回结果");
						if (result.cancelled) return { cancelled: true };
						const nextSessionPath = canonicalSessionPath(result.sessionPath ?? runtime.sessionPath);
						if (detachedCompanion && nextSessionPath !== sessionPath && runtime.sessionPath === sessionPath) {
							const nextRuntime = await this.openDetachedRuntime(
								nextSessionPath,
								operation.operationId,
								request.clientInstanceId,
							);
							const lease = this.leases.move(sessionPath, nextSessionPath, request.leaseId);
							this.activeOperationBySession.set(nextSessionPath, operation.operationId);
							this.snapshotRevisions.delete(sessionPath);
							await this.sendSessionSnapshots(nextRuntime);
							await this.broadcast({
								type: "sessions_changed",
								cwd: nextRuntime.getSnapshot("available").cwd,
							});
							return jsonValue({
								cancelled: false,
								lease,
								snapshot: this.runtimeSnapshot(nextRuntime, "owned"),
							});
						}
						if (nextSessionPath !== sessionPath) {
							this.leases.move(sessionPath, nextSessionPath, request.leaseId);
							this.snapshotRevisions.delete(sessionPath);
							await this.broadcast({ type: "session_removed", sessionPath });
						}
						this.attachRuntime(runtime);
						await this.sendSessionSnapshots(runtime);
						return jsonValue({
							cancelled: false,
							lease: this.leases.get(nextSessionPath, request.clientInstanceId),
							snapshot: this.runtimeSnapshot(runtime, "owned"),
						});
					},
				});
			}
			case "delete_session": {
				const cwd = canonicalProjectCwd(request.cwd);
				const sessionPath = canonicalSessionPath(request.sessionPath);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session-collection:${cwd}`,
					payload: { cwd, sessionPath },
					run: async () => {
						if (this.runtimes.has(sessionPath) || this.leases.has(sessionPath)) {
							throw Object.assign(new Error("会话当前仍被占用"), {
								code: "session_attached",
								retryable: true,
							});
						}
						if (
							this.journal.list(sessionPath).some((operation) => ACTIVE_OPERATION_STATUSES.has(operation.status))
						) {
							throw Object.assign(new Error("会话存在正在执行的任务"), {
								code: "session_operation_active",
								retryable: true,
							});
						}
						if (!existsSync(sessionPath)) throw Object.assign(new Error("未找到会话"), { code: "not_found" });
						await this.adapter.deleteSession(sessionPath);
						await this.broadcast({ type: "session_removed", sessionPath });
						return { deleted: true };
					},
				});
			}
			case "list_skills":
				this.journal.assertWritable();
				return jsonValue(
					await this.adapter.listSkills(
						request.cwd,
						this.createUiRequestHandler(`skills:${connection.id}`, undefined, connection.clientInstanceId),
					),
				);
			case "set_skill_enabled": {
				const cwd = canonicalProjectCwd(request.cwd);
				const sessionPath = this.mutationSessionPath(request);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `project:${cwd}`,
					lockSessionPath: sessionPath,
					payload: {
						...(sessionPath ? { sessionPath } : {}),
						cwd,
						path: request.path,
						scope: request.scope,
						enabled: request.enabled,
					},
					run: async () => {
						const runtime = this.assertMutationSession(connection, request, cwd);
						const result = await this.adapter.setSkillEnabled(
							cwd,
							request.path,
							request.scope,
							request.enabled,
							this.createUiRequestHandler(
								`skills:${request.clientRequestId}`,
								undefined,
								request.clientInstanceId,
							),
						);
						await this.reloadMutationResources(runtime, request.scope === "project" ? cwd : undefined);
						return jsonValue({ ...result, path: request.path, scope: request.scope, enabled: request.enabled });
					},
				});
			}
			case "list_project_instructions":
				return jsonValue(this.adapter.listProjectInstructions(canonicalProjectCwd(request.cwd)));
			case "save_project_instruction": {
				const cwd = canonicalProjectCwd(request.cwd);
				const sessionPath = this.mutationSessionPath(request);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `project:${cwd}`,
					lockSessionPath: sessionPath,
					payload: {
						...(sessionPath ? { sessionPath } : {}),
						cwd,
						fileName: request.fileName,
						content: request.content,
						...(request.expectedHash ? { expectedHash: request.expectedHash } : {}),
					},
					run: async () => {
						const runtime = this.assertMutationSession(connection, request, cwd);
						const result = await this.adapter.saveProjectInstruction(
							cwd,
							request.fileName,
							request.content,
							request.expectedHash,
						);
						await this.reloadMutationResources(runtime, cwd);
						return jsonValue(result);
					},
				});
			}
			case "list_host_instructions":
				return jsonValue(this.adapter.listHostInstructions());
			case "save_host_instruction": {
				const sessionPath = this.mutationSessionPath(request);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: "host:instructions",
					lockSessionPath: sessionPath,
					payload: {
						...(sessionPath ? { sessionPath } : {}),
						fileName: request.fileName,
						content: request.content,
						...(request.expectedHash ? { expectedHash: request.expectedHash } : {}),
					},
					run: async () => {
						const runtime = this.assertMutationSession(connection, request);
						const result = await this.adapter.saveHostInstruction(
							request.fileName,
							request.content,
							request.expectedHash,
						);
						await this.reloadMutationResources(runtime);
						return jsonValue(result);
					},
				});
			}
			case "list_directories":
				return jsonValue(this.adapter.listDirectories(request.path));
			case "get_completions": {
				const sessionPath = request.sessionPath ? canonicalSessionPath(request.sessionPath) : undefined;
				const runtime = sessionPath ? this.runtimes.get(sessionPath) : undefined;
				const attachmentQuery = attachFileCompletion(request.text, request.cursor);
				if (attachmentQuery) {
					const files = this.adapter
						.completeProjectFiles(request.cwd, attachmentQuery.query, 40)
						.map((item) => ({ ...item, value: attachCompletionValue(item.value) }));
					return jsonValue({
						prefixStart: attachmentQuery.prefixStart,
						prefixEnd: request.cursor,
						items: files,
					} satisfies CompletionResult);
				}
				const runtimeResult = runtime ? await runtime.getCompletions(request.text, request.cursor) : undefined;
				if (!runtimeResult) {
					const fallback = fallbackResourceCompletions(request.text, request.cursor, []);
					if (fallback) {
						const needsSkills = true;
						if (needsSkills) {
							const skills = await this.adapter.listSkills(
								request.cwd,
								this.createUiRequestHandler(
									`completion:${connection.id}`,
									undefined,
									connection.clientInstanceId,
								),
							);
							return jsonValue(fallbackResourceCompletions(request.text, request.cursor, skills.skills));
						}
						return jsonValue(fallback);
					}
				}
				const fileQuery = projectFileCompletion(request.text, request.cursor);
				if (!fileQuery) {
					return jsonValue(runtimeResult ?? { prefixStart: request.cursor, prefixEnd: request.cursor, items: [] });
				}
				const files = this.adapter.completeProjectFiles(request.cwd, fileQuery.query, 40);
				const runtimeItems = runtimeResult?.prefixStart === fileQuery.prefixStart ? runtimeResult.items : [];
				return jsonValue({
					prefixStart: fileQuery.prefixStart,
					prefixEnd: request.cursor,
					items: [...runtimeItems, ...files].slice(0, 50),
				} satisfies CompletionResult);
			}
			case "get_about":
				return this.adapter.getAbout();
			case "get_changelog": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				const runtime = this.runtimes.get(sessionPath);
				return this.adapter.getChangelog(sessionPath, request.width, runtime?.getSnapshot("available").cwd);
			}
			case "get_diagnostics": {
				const cwd = request.cwd ? canonicalProjectCwd(request.cwd) : undefined;
				const runtime = [...this.runtimes.values()].find(
					(candidate) => !cwd || canonicalProjectCwd(candidate.getSnapshot("available").cwd) === cwd,
				);
				const diagnostics = await this.adapter.getDiagnostics(cwd, runtime?.getToolRecoveryDiagnostics());
				return diagnostics;
			}
			case "get_connection_status":
				return {
					connected: true,
					transport: "local",
					persistent: this.persistent,
					hostInstanceId: this.hostInstanceId,
					serverInstanceId: this.serverInstanceId,
					hostStartedAt: this.hostStartedAt,
					platform: process.platform,
					arch: process.arch,
					remoteProfilesSupported: false,
					remoteBlockedReason: "持久 SSH 后台配置、凭据引用、探测和恢复契约尚未实现。",
				};
			case "get_git_status":
				return this.adapter.getGitStatus(request.cwd);
			case "get_git_diff":
				return this.adapter.getGitDiff(request.cwd, request.path, request.staged);
			case "check_for_updates":
				return this.adapter.checkForUpdates();
			case "resolve_project_resource":
				return this.adapter.resolveProjectResource(request.cwd, request.target, request.line, request.column);
			case "resolve_external_resource":
				return this.adapter.resolveExternalResource(request.target, request.line, request.column);
			case "read_project_resource":
				return this.adapter.readProjectResource(request.cwd, request.path, request.offset, request.limit);
			case "read_external_resource":
				return this.adapter.readExternalResource(request.path, request.accessToken, request.offset, request.limit);
			case "read_content":
				return this.contentStore.read(
					canonicalSessionPath(request.sessionPath),
					request.contentRef,
					request.offset,
					request.limit,
				);
			case "render_rich_text": {
				const requestedPath = request.sessionPath ? canonicalSessionPath(request.sessionPath) : undefined;
				const runtime = requestedPath
					? this.runtimes.get(requestedPath)
					: [...this.runtimes.values()].find(
							(candidate) =>
								this.sessionWriteAccess(canonicalSessionPath(candidate.sessionPath), connection) === "owned",
						);
				const renderer =
					runtime?.renderRichText &&
					this.sessionWriteAccess(canonicalSessionPath(runtime.sessionPath), connection) === "owned"
						? runtime.renderRichText.bind(runtime)
						: requestedPath && this.adapter.renderRichText
							? (input: Parameters<NonNullable<RuntimeAdapter["renderRichText"]>>[1]) =>
									this.adapter.renderRichText!(requestedPath, input)
							: undefined;
				if (!renderer) {
					throw Object.assign(new Error("富文本渲染需要当前会话"), {
						code: "rich_text_session_required",
						retryable: false,
					});
				}
				return renderer({
					text: request.text,
					width: request.width,
					messageType: request.messageType,
					isStreaming: request.isStreaming,
				});
			}
			case "read_image_content":
				return this.contentStore.readImage(canonicalSessionPath(request.sessionPath), request.contentRef);
			case "list_settings": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				const runtime = this.runtimes.get(sessionPath);
				return runtime
					? runtime.listSettingsAsync
						? await runtime.listSettingsAsync()
						: runtime.listSettings()
					: this.adapter.listSettings(sessionPath);
			}
			case "set_setting": {
				const { runtime, sessionPath } = this.assertSessionControl(
					request.sessionPath,
					request.leaseId,
					connection,
				);
				const settings = runtime.listSettingsAsync ? await runtime.listSettingsAsync() : runtime.listSettings();
				const setting = settings.find((candidate) => candidate.id === request.id);
				const scope =
					setting?.scope === "global"
						? "host:settings"
						: `project:${canonicalProjectCwd(runtime.getSnapshot("available").cwd)}`;
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope,
					payload: { sessionPath, id: request.id, value: request.value },
					run: () => runtime.setSetting(request.id, request.value),
				});
			}
			case "get_project_trust":
				return this.adapter.getProjectTrust(canonicalProjectCwd(request.cwd));
			case "set_project_trust": {
				const cwd = canonicalProjectCwd(request.cwd);
				const sessionPath = canonicalSessionPath(request.sessionPath);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `project:${cwd}`,
					lockSessionPath: sessionPath,
					payload: { sessionPath, cwd, trusted: request.trusted },
					run: async () => {
						const { runtime } = this.assertExtensionSession(connection, request);
						if (canonicalProjectCwd(runtime.getSnapshot("available").cwd) !== cwd) {
							throw Object.assign(new Error("项目信任目录与当前会话不一致"), {
								code: "project_trust_session_mismatch",
								retryable: false,
							});
						}
						const previousDecision = this.adapter.getProjectTrustDecision(cwd);
						const result = await this.adapter.setProjectTrust(cwd, request.trusted);
						const reloadProjectRuntimes = async () => {
							for (const runtime of this.runtimes.values()) {
								if (canonicalProjectCwd(runtime.getSnapshot("available").cwd) === cwd)
									await runtime.reloadResources();
							}
						};
						try {
							await reloadProjectRuntimes();
						} catch (error) {
							await this.adapter.setProjectTrust(cwd, previousDecision);
							await reloadProjectRuntimes();
							throw error;
						}
						return result;
					},
				});
			}
			case "list_packages":
				return this.adapter.listPackages(canonicalProjectCwd(request.cwd));
			case "install_package":
			case "remove_package": {
				const cwd = canonicalProjectCwd(request.cwd);
				const sessionPath = this.mutationSessionPath(request);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: request.scope === "user" ? "host:packages" : `project:${cwd}`,
					lockSessionPath: sessionPath,
					payload: { ...(sessionPath ? { sessionPath } : {}), cwd, source: request.source, scope: request.scope },
					run: async () => {
						const runtime = this.assertMutationSession(connection, request, cwd);
						const result = await (request.command === "install_package"
							? this.adapter.installPackage(cwd, request.source, request.scope)
							: this.adapter.removePackage(cwd, request.source, request.scope));
						await this.reloadMutationResources(runtime, request.scope === "project" ? cwd : undefined);
						return jsonValue({
							...result,
							source: request.source,
							scope: request.scope,
							packages: this.adapter.listPackages(cwd),
						});
					},
				});
			}
			case "update_packages": {
				const cwd = canonicalProjectCwd(request.cwd);
				const sessionPath = this.mutationSessionPath(request);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `project:${cwd}`,
					lockSessionPath: sessionPath,
					payload: {
						...(sessionPath ? { sessionPath } : {}),
						cwd,
						...(request.source ? { source: request.source } : {}),
					},
					run: async () => {
						const runtime = this.assertMutationSession(connection, request, cwd);
						const result = await this.adapter.updatePackages(cwd, request.source);
						await this.reloadMutationResources(runtime);
						return jsonValue({
							...result,
							...(request.source ? { source: request.source } : {}),
							packages: this.adapter.listPackages(cwd),
						});
					},
				});
			}
			case "get_session_tree": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				const runtime = this.runtimes.get(sessionPath);
				return runtime
					? runtime.getSessionTreeAsync
						? await runtime.getSessionTreeAsync()
						: runtime.getSessionTree()
					: this.adapter.getSessionTree(sessionPath);
			}
			case "get_session_info": {
				const { runtime } = this.assertSessionControl(request.sessionPath, request.leaseId, connection);
				return runtime.getSessionInfoAsync ? await runtime.getSessionInfoAsync() : runtime.getSessionInfo();
			}
			case "list_fork_messages": {
				const { runtime } = this.assertSessionControl(request.sessionPath, request.leaseId, connection);
				return runtime.listForkMessagesAsync ? await runtime.listForkMessagesAsync() : runtime.listForkMessages();
			}
			case "set_entry_label": {
				const { runtime, sessionPath } = this.assertSessionControl(
					request.sessionPath,
					request.leaseId,
					connection,
				);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session:${sessionPath}`,
					payload: { entryId: request.entryId, ...(request.label ? { label: request.label } : {}) },
					run: async () => {
						await runtime.setEntryLabel(request.entryId, request.label);
						return { changed: true };
					},
				});
			}
			case "navigate_session_tree": {
				const { runtime, sessionPath } = this.assertSessionControl(
					request.sessionPath,
					request.leaseId,
					connection,
				);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session:${sessionPath}`,
					payload: { entryId: request.entryId, summarize: request.summarize === true },
					run: () => runtime.navigateSessionTree(request.entryId, request.summarize === true),
				});
			}
			case "list_subagents": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				const runtime = this.runtimes.get(sessionPath);
				return runtime && this.sessionWriteAccess(sessionPath, connection) === "owned"
					? runtime.listSubagentsAsync
						? await runtime.listSubagentsAsync()
						: runtime.listSubagents()
					: this.adapter.listSubagents(sessionPath);
			}
			case "read_subagent": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				const runtime = this.runtimes.get(sessionPath);
				return runtime && this.sessionWriteAccess(sessionPath, connection) === "owned"
					? runtime.readSubagentAsync
						? await runtime.readSubagentAsync(request.agentId)
						: runtime.readSubagent(request.agentId)
					: this.adapter.readSubagent(sessionPath, request.agentId);
			}
			case "abort_subagent": {
				const { runtime, sessionPath } = this.assertSessionControl(
					request.sessionPath,
					request.leaseId,
					connection,
				);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session:${sessionPath}`,
					payload: { agentId: request.agentId },
					run: async () => {
						await runtime.abortSubagent(request.agentId);
						return { changed: true, message: "已请求停止 Subagent" };
					},
				});
			}
			case "continue_subagent": {
				const { runtime, sessionPath } = this.assertSessionControl(
					request.sessionPath,
					request.leaseId,
					connection,
				);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session:${sessionPath}`,
					payload: { agentId: request.agentId, text: request.text },
					run: async () => {
						await runtime.continueSubagent(request.agentId, request.text);
						return { changed: true, message: "已继续 Subagent" };
					},
				});
			}
			case "read_clipboard_text":
				return this.adapter.readClipboardText();
			case "read_clipboard_image":
				return this.adapter.readClipboardImage();
			case "read_project_image":
				return this.adapter.readProjectImage(canonicalProjectCwd(request.cwd), request.path);
			case "write_clipboard_text":
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: "host:clipboard",
					payload: { text: request.text },
					run: () => this.adapter.writeClipboardText(request.text),
				});
			case "copy_last_assistant_message": {
				this.assertClient(request.clientInstanceId, connection);
				this.journal.assertWritable();
				const sessionPath = canonicalSessionPath(request.sessionPath);
				const runtime = this.runtimes.get(sessionPath);
				if (!runtime) throw Object.assign(new Error("尚未获取会话运行时"), { code: "session_not_acquired" });
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: "host:clipboard",
					payload: { sessionPath },
					run: async () => {
						const text = runtime.getLastAssistantTextAsync
							? await runtime.getLastAssistantTextAsync()
							: runtime.getLastAssistantText();
						if (!text) return { capability: true, copied: false };
						const result = await this.adapter.writeClipboardText(text);
						return { capability: result.capability, copied: result.capability };
					},
				});
			}
			default:
				throw new Error("Unsupported workspace command");
		}
	}

	private latestOperation(sessionPath: string): OperationSnapshot | undefined {
		return this.journal
			.list(sessionPath)
			.reduce<OperationSnapshot | undefined>(
				(latest, operation) => (!latest || operation.updatedAt > latest.updatedAt ? operation : latest),
				undefined,
			);
	}

	private async observedSessionActivity(
		sessionPath: string,
		connection?: ClientConnection,
	): Promise<SessionActivity | undefined> {
		const runtime = this.runtimes.get(sessionPath);
		if (runtime) {
			try {
				return runtime.getSnapshot(connection ? this.writeAccess(sessionPath, connection) : "available").activity;
			} catch {
				return undefined;
			}
		}
		if (!this.adapter.inspectSessionActivity || !this.adapter.isSessionWriterLocked(sessionPath)) return undefined;
		try {
			return await this.adapter.inspectSessionActivity(sessionPath);
		} catch {
			return undefined;
		}
	}

	private async resolveSessionActivity(
		sessionPath: string,
		fallback: SessionActivity,
		latestOperation: OperationSnapshot | undefined,
		connection?: ClientConnection,
	): Promise<SessionActivity> {
		const operationActivity = latestOperation ? sessionActivityFromOperation(latestOperation.status) : undefined;
		if (operationActivity && isActiveSessionActivity(operationActivity)) return operationActivity;

		const observedActivity = await this.observedSessionActivity(sessionPath, connection);
		if (observedActivity && isActiveSessionActivity(observedActivity)) return observedActivity;
		return operationActivity ?? observedActivity ?? fallback;
	}

	private async listSessionSummaries(
		cwd: string,
		connection: ClientConnection,
		metadataOnly = false,
	): Promise<SessionSummary[]> {
		const sessions = await this.adapter.listSessions(cwd, { metadataOnly });
		const summaries = await Promise.all(
			sessions.map(async (session) => {
				const sessionPath = canonicalSessionPath(session.path);
				const latestOperation = this.latestOperation(sessionPath);
				return {
					...session,
					path: sessionPath,
					activity: await this.resolveSessionActivity(sessionPath, session.activity, latestOperation, connection),
					writeAccess: this.sessionWriteAccess(sessionPath, connection),
					...(latestOperation ? { operationUpdatedAt: latestOperation.updatedAt } : {}),
				};
			}),
		);
		const listedPaths = new Set(summaries.map((session) => session.path));
		for (const runtime of this.runtimes.values()) {
			const sessionPath = canonicalSessionPath(runtime.sessionPath);
			if (listedPaths.has(sessionPath)) continue;
			const snapshot = this.runtimeSnapshot(runtime, this.writeAccess(sessionPath, connection));
			if (canonicalProjectCwd(snapshot.cwd) !== cwd) continue;
			const latestOperation = this.latestOperation(sessionPath);
			summaries.push({
				path: sessionPath,
				id: snapshot.id,
				cwd: snapshot.cwd,
				...(snapshot.name ? { name: snapshot.name } : {}),
				createdAt: snapshot.createdAt,
				updatedAt: snapshot.updatedAt,
				messageCount: 0,
				firstMessage: "未命名会话",
				activity: await this.resolveSessionActivity(sessionPath, snapshot.activity, latestOperation, connection),
				writeAccess: snapshot.writeAccess,
				...(latestOperation ? { operationUpdatedAt: latestOperation.updatedAt } : {}),
			});
		}
		summaries.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
		return summaries;
	}

	private projectTranscriptItems(sessionPath: string, items: readonly TranscriptItem[]): TranscriptItem[] {
		const compactItems = items.map((item) => this.contentStore.compactTranscriptItem(sessionPath, item));
		return projectTranscriptBatch(compactItems);
	}

	private rememberSessionFacts(cwd: string, sessions: readonly SessionSummary[]): void {
		this.watchedSessionFacts.set(
			cwd,
			new Map(
				sessions.map((session) => [
					session.path,
					{
						updatedAt: session.updatedAt,
						messageCount: session.messageCount,
						...(session.name ? { name: session.name } : {}),
						writerLocked: this.adapter.isSessionWriterLocked(session.path),
					},
				]),
			),
		);
	}

	private async pollSessionFiles(): Promise<void> {
		if (this.pollingSessions || this.clients.size === 0 || this.watchedSessionFacts.size === 0) return;
		this.pollingSessions = true;
		try {
			for (const [cwd, previous] of this.watchedSessionFacts) {
				let sessions: Awaited<ReturnType<RuntimeAdapter["listSessions"]>>;
				try {
					sessions = await this.adapter.listSessions(cwd, { metadataOnly: true });
				} catch {
					continue;
				}
				const next = new Map<string, SessionFileFact>();
				const transcriptChanges: string[] = [];
				let sessionListChanged = false;
				for (const session of sessions) {
					const sessionPath = canonicalSessionPath(session.path);
					const fact: SessionFileFact = {
						updatedAt: session.updatedAt,
						messageCount: session.messageCount,
						...(session.name ? { name: session.name } : {}),
						writerLocked: this.adapter.isSessionWriterLocked(sessionPath),
					};
					next.set(sessionPath, fact);
					const old = previous.get(sessionPath);
					if (!old) {
						sessionListChanged = true;
						continue;
					}
					if (
						old.updatedAt !== fact.updatedAt ||
						old.messageCount !== fact.messageCount ||
						old.name !== fact.name
					) {
						if (old.name !== fact.name || (fact.writerLocked && old.updatedAt !== fact.updatedAt))
							sessionListChanged = true;
						const runtime = this.runtimes.get(sessionPath);
						if (!runtime) transcriptChanges.push(sessionPath);
						else {
							const snapshot = runtime.getSnapshot?.("available");
							const known = this.runtimeTranscriptFacts.get(sessionPath);
							if (
								snapshot &&
								(!known ||
									known.updatedAt !== snapshot.updatedAt ||
									known.revision !== snapshot.transcriptRevision)
							) {
								transcriptChanges.push(sessionPath);
								this.runtimeTranscriptFacts.set(sessionPath, {
									updatedAt: snapshot.updatedAt,
									revision: snapshot.transcriptRevision,
								});
							}
						}
					}
					if (old.writerLocked !== fact.writerLocked) sessionListChanged = true;
				}
				for (const runtime of this.runtimes.values()) {
					const snapshot = runtime.getSnapshot("available");
					const sessionPath = canonicalSessionPath(runtime.sessionPath);
					if (canonicalProjectCwd(snapshot.cwd) !== cwd || next.has(sessionPath)) continue;
					const fact: SessionFileFact = {
						updatedAt: snapshot.updatedAt,
						messageCount: 0,
						...(snapshot.name ? { name: snapshot.name } : {}),
						writerLocked: this.adapter.isSessionWriterLocked(sessionPath),
					};
					next.set(sessionPath, fact);
					const old = previous.get(sessionPath);
					if (!old) {
						sessionListChanged = true;
						continue;
					}
					if (old.updatedAt !== fact.updatedAt || old.name !== fact.name) {
						if (old.name !== fact.name || (fact.writerLocked && old.updatedAt !== fact.updatedAt))
							sessionListChanged = true;
					}
					if (old.writerLocked !== fact.writerLocked) sessionListChanged = true;
				}
				if (next.size !== previous.size) sessionListChanged = true;
				for (const sessionPath of previous.keys()) {
					if (next.has(sessionPath)) continue;
					sessionListChanged = true;
					await this.broadcast({ type: "session_removed", sessionPath });
				}
				this.watchedSessionFacts.set(cwd, next);
				for (const sessionPath of transcriptChanges) {
					await this.broadcast({ type: "transcript_changed", sessionPath });
				}
				if (sessionListChanged) await this.broadcast({ type: "sessions_changed", cwd });
			}
		} finally {
			this.pollingSessions = false;
		}
	}

	private async executeJournaledWrite(
		connection: ClientConnection,
		input: {
			command: string;
			clientInstanceId: string;
			clientRequestId: string;
			scope: string;
			lockSessionPath?: string;
			payload: JsonValue;
			run: (operation: OperationSnapshot, signal: AbortSignal) => Promise<JsonValue>;
		},
	): Promise<JsonValue> {
		this.assertClient(input.clientInstanceId, connection);
		this.journal.assertWritable();
		const payloadHash = hashOperationPayload({ command: input.command, scope: input.scope, payload: input.payload });
		const existing = this.journal.find(input.clientInstanceId, input.clientRequestId, payloadHash);
		if (existing) {
			const pending = this.journalWritePromises.get(existing.operationId);
			if (pending) return pending;
			if (existing.status === "completed" && existing.result !== undefined) return existing.result;
			throw Object.assign(new Error(existing.error ?? "此前写入未完成"), {
				code: "operation_failed",
				retryable: false,
			});
		}
		if (input.lockSessionPath && this.activeOperationBySession.has(input.lockSessionPath)) {
			throw Object.assign(new Error("会话存在正在执行的任务"), {
				code: "session_operation_active",
				retryable: true,
			});
		}
		const accepted = this.journal.accept({
			clientInstanceId: input.clientInstanceId,
			clientRequestId: input.clientRequestId,
			sessionPath: input.scope,
			type: input.command,
			payloadHash,
		});
		if (input.lockSessionPath) {
			this.activeOperationBySession.set(input.lockSessionPath, accepted.operation.operationId);
		}
		const controller = new AbortController();
		this.operationAbortControllers.set(accepted.operation.operationId, controller);
		const execution = this.enqueueWriteScope(input.scope, async () => {
			try {
				this.updateOperation(accepted.operation.operationId, "running");
				const result = await input.run(accepted.operation, controller.signal);
				this.updateOperation(accepted.operation.operationId, "completed", { result });
				return result;
			} catch (error) {
				if (controller.signal.aborted) {
					throw Object.assign(new Error("任务已取消"), {
						code: "operation_aborted",
						retryable: false,
					});
				}
				this.updateOperation(accepted.operation.operationId, "failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			} finally {
				if (input.lockSessionPath) {
					for (const [sessionPath, operationId] of this.activeOperationBySession) {
						if (operationId === accepted.operation.operationId) this.activeOperationBySession.delete(sessionPath);
					}
				}
				this.operationAbortControllers.delete(accepted.operation.operationId);
			}
		});
		this.journalWritePromises.set(accepted.operation.operationId, execution);
		void execution.finally(() => this.journalWritePromises.delete(accepted.operation.operationId)).catch(() => {});
		return execution;
	}

	private enqueueWriteScope<T>(scope: string, run: () => Promise<T>): Promise<T> {
		const previous = this.writeScopeQueues.get(scope) ?? Promise.resolve();
		const execution = previous.catch(() => {}).then(run);
		const tail = execution.then(
			() => undefined,
			() => undefined,
		);
		this.writeScopeQueues.set(scope, tail);
		void tail.then(() => {
			if (this.writeScopeQueues.get(scope) === tail) this.writeScopeQueues.delete(scope);
		});
		return execution;
	}

	private async runQueueOperation(
		runtime: RuntimeSession,
		operation: OperationSnapshot,
		run: (runtime: RuntimeSession) => Promise<JsonValue>,
	): Promise<OperationSnapshot> {
		try {
			this.updateOperation(operation.operationId, "running");
			const result = await run(runtime);
			return this.updateOperation(operation.operationId, "completed", { result });
		} catch (error) {
			return this.updateOperation(operation.operationId, "failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async acceptQueueOperation(
		connection: ClientConnection,
		request: Extract<
			Extract<ClientMessage, { type: "request" }>["request"],
			{ command: "steer" | "follow_up" | "clear_queue" }
		>,
		payload: JsonValue,
		run: (runtime: RuntimeSession) => Promise<JsonValue>,
	): Promise<JsonValue> {
		this.assertClient(request.clientInstanceId, connection);
		this.journal.assertWritable();
		const sessionPath = canonicalSessionPath(request.sessionPath);
		this.leases.assert(sessionPath, request.leaseId, request.clientInstanceId);
		const runtime = this.runtimes.get(sessionPath);
		if (!runtime) throw Object.assign(new Error("尚未获取会话运行时"), { code: "session_not_acquired" });
		const payloadHash = hashOperationPayload({ command: request.command, sessionPath, payload });
		const existing = this.journal.find(request.clientInstanceId, request.clientRequestId, payloadHash);
		if (existing) return { operation: existing, duplicate: true };
		if (request.command !== "clear_queue" && !this.isRuntimeActive(runtime)) {
			throw Object.assign(new Error("会话当前不接受引导或后续消息"), {
				code: "session_not_active",
				retryable: false,
			});
		}
		const accepted = this.journal.accept({
			clientInstanceId: request.clientInstanceId,
			clientRequestId: request.clientRequestId,
			sessionPath,
			type: request.command,
			payloadHash,
		});
		const operation = await this.runQueueOperation(runtime, accepted.operation, run);
		return { operation, duplicate: false };
	}

	private isRuntimeActive(runtime: RuntimeSession): boolean {
		const snapshot = runtime.getSnapshot("owned");
		return (
			snapshot.activity === "running" ||
			snapshot.activity === "waiting_for_input" ||
			["turn", "compaction", "retry", "waiting_for_input"].includes(snapshot.phase)
		);
	}

	private releaseAcceptedReservation(sessionPath: string): boolean {
		const operationId = this.activeOperationBySession.get(sessionPath);
		if (!operationId || this.scheduledOperations.has(operationId)) return false;
		if (this.journal.get(operationId)?.status !== "accepted") return false;
		this.activeOperationBySession.delete(sessionPath);
		return true;
	}

	private async acceptOperation(
		connection: ClientConnection,
		request: Extract<
			Extract<ClientMessage, { type: "request" }>["request"],
			{ command: "prompt" | "compact" | "share_session" | "run_bash" }
		>,
		payload: JsonValue,
		run: (runtime: RuntimeSession, operation: OperationSnapshot, signal: AbortSignal) => Promise<JsonValue>,
		afterResponse: (action: () => void) => void,
	): Promise<JsonValue> {
		this.assertClient(request.clientInstanceId, connection);
		this.journal.assertWritable();
		const sessionPath = canonicalSessionPath(request.sessionPath);
		this.leases.assert(sessionPath, request.leaseId, request.clientInstanceId);
		const payloadHash = hashOperationPayload({
			command: request.command,
			sessionPath,
			payload,
		});
		const existing = this.journal.find(request.clientInstanceId, request.clientRequestId, payloadHash);
		if (existing) {
			if (existing.status === "accepted") {
				const runtime = this.runtimes.get(sessionPath);
				if (!runtime) throw Object.assign(new Error("尚未获取会话运行时"), { code: "session_not_acquired" });
				afterResponse(() => this.scheduleOperation(runtime, existing, run));
			}
			return { operation: existing, duplicate: true };
		}
		const activeOperationId = this.activeOperationBySession.get(sessionPath);
		if (activeOperationId) {
			throw Object.assign(new Error("会话已有正在执行的任务"), {
				code: "session_operation_active",
				retryable: true,
			});
		}
		const runtime = this.runtimes.get(sessionPath);
		if (!runtime) throw Object.assign(new Error("尚未获取会话运行时"), { code: "session_not_acquired" });
		const accepted = this.journal.accept({
			clientInstanceId: request.clientInstanceId,
			clientRequestId: request.clientRequestId,
			sessionPath,
			type: request.command,
			payloadHash,
		});
		this.activeOperationBySession.set(sessionPath, accepted.operation.operationId);
		afterResponse(() => this.scheduleOperation(runtime, accepted.operation, run));
		return { operation: accepted.operation, duplicate: false };
	}

	private scheduleOperation(
		runtime: RuntimeSession,
		operation: OperationSnapshot,
		run: (runtime: RuntimeSession, operation: OperationSnapshot, signal: AbortSignal) => Promise<JsonValue>,
	): void {
		if (operation.status !== "accepted" || this.scheduledOperations.has(operation.operationId)) return;
		this.scheduledOperations.add(operation.operationId);
		const controller = new AbortController();
		this.operationAbortControllers.set(operation.operationId, controller);
		void this.runOperation(runtime, operation, run, controller.signal)
			.catch(() => {})
			.finally(() => {
				this.operationAbortControllers.delete(operation.operationId);
				this.scheduledOperations.delete(operation.operationId);
			});
	}

	private async runOperation(
		runtime: RuntimeSession,
		operation: OperationSnapshot,
		run: (runtime: RuntimeSession, operation: OperationSnapshot, signal: AbortSignal) => Promise<JsonValue>,
		signal: AbortSignal,
	): Promise<void> {
		try {
			this.updateOperation(operation.operationId, "running");
			const result = await run(runtime, operation, signal);
			const current = this.journal.get(operation.operationId);
			if (current && !TERMINAL_OPERATION_STATUSES.has(current.status)) {
				this.updateOperation(operation.operationId, "completed", { result });
			}
		} catch (error) {
			const current = this.journal.get(operation.operationId);
			if (current && !TERMINAL_OPERATION_STATUSES.has(current.status)) {
				this.updateOperation(operation.operationId, "failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			if (this.activeOperationBySession.get(operation.sessionPath) === operation.operationId) {
				this.activeOperationBySession.delete(operation.sessionPath);
			}
			this.cancelPendingUi(operation.operationId);
			if (!this.leases.has(operation.sessionPath)) await this.disposeRuntime(operation.sessionPath);
		}
	}

	private updateOperation(
		operationId: string,
		status: OperationSnapshot["status"],
		options?: { progress?: SessionProgress; result?: JsonValue; error?: string },
	): OperationSnapshot {
		const current = this.journal.get(operationId);
		if (current && TERMINAL_OPERATION_STATUSES.has(current.status)) return current;
		const operation = this.journal.update(operationId, status, options);
		void this.broadcast({ type: "operation_updated", operation });
		return operation;
	}

	private attachRuntime(runtime: RuntimeSession): void {
		const sessionPath = canonicalSessionPath(runtime.sessionPath);
		const existing = this.runtimes.get(sessionPath);
		if (existing === runtime) return;
		if (existing) throw new Error(`Session runtime is already attached: ${sessionPath}`);
		this.runtimes.set(sessionPath, runtime);
		this.rememberRuntimeTranscriptFact(runtime);
		this.runtimeUnsubscribers.set(
			sessionPath,
			runtime.onEvent((event) => {
				if (event.type === "state_changed") {
					this.scheduleSessionSnapshots(runtime);
				} else if (event.type === "entry_committed") {
					this.flushSessionProgress(sessionPath);
					const payload = event.payload as {
						items: never[];
						transcriptGeneration: string;
						fromRevision: number;
						transcriptRevision: number;
					};
					this.rememberRuntimeTranscriptFact(runtime, payload.transcriptRevision);
					void this.broadcast({
						type: "transcript_committed",
						sessionPath,
						transcriptGeneration: payload.transcriptGeneration,
						fromRevision: payload.fromRevision,
						toRevision: payload.transcriptRevision,
						items: this.projectTranscriptItems(sessionPath, payload.items),
					});
				} else {
					this.enqueueSessionProgress(sessionPath, projectSessionProgress(event.payload));
				}
			}),
		);
	}

	private rememberRuntimeTranscriptFact(runtime: RuntimeSession, revision?: number): void {
		const snapshot = runtime.getSnapshot?.("available");
		if (!snapshot) return;
		this.runtimeTranscriptFacts.set(canonicalSessionPath(runtime.sessionPath), {
			updatedAt: snapshot.updatedAt,
			revision: revision ?? snapshot.transcriptRevision,
		});
	}

	private clearPendingSessionProgress(sessionPath: string): void {
		const timer = this.progressTimers.get(sessionPath);
		if (timer) {
			clearTimeout(timer);
			this.progressTimers.delete(sessionPath);
		}
		this.pendingProgress.delete(sessionPath);
	}

	private flushSessionProgress(sessionPath: string): void {
		const timer = this.progressTimers.get(sessionPath);
		if (timer) {
			clearTimeout(timer);
			this.progressTimers.delete(sessionPath);
		}
		const pending = this.pendingProgress.get(sessionPath);
		if (!pending || pending.length === 0) return;
		this.pendingProgress.delete(sessionPath);
		for (const entry of pending) {
			void this.broadcast({ type: "session_progress", sessionPath, progress: entry.progress });
		}
	}

	private enqueueSessionProgress(sessionPath: string, progress: SessionProgress): void {
		const pending = this.pendingProgress.get(sessionPath) ?? [];
		const key = sessionProgressKey(progress);
		const previous = pending.at(-1);
		if (key && previous?.key === key) previous.progress = mergeSessionProgress(previous.progress, progress);
		else pending.push({ key, progress });
		this.pendingProgress.set(sessionPath, pending);
		if (pending.length >= MAX_PENDING_PROGRESS) {
			this.flushSessionProgress(sessionPath);
			return;
		}
		if (this.progressTimers.has(sessionPath)) return;
		const timer = setTimeout(() => {
			this.progressTimers.delete(sessionPath);
			this.flushSessionProgress(sessionPath);
		}, PROGRESS_BATCH_MS);
		timer.unref?.();
		this.progressTimers.set(sessionPath, timer);
	}

	private scheduleSessionSnapshots(runtime: RuntimeSession): void {
		const sessionPath = canonicalSessionPath(runtime.sessionPath);
		if (this.snapshotTimers.has(sessionPath)) return;
		const timer = setTimeout(() => {
			this.snapshotTimers.delete(sessionPath);
			if (this.runtimes.get(sessionPath) !== runtime) return;
			void this.sendSessionSnapshots(runtime).catch(() => {});
		}, 50);
		timer.unref?.();
		this.snapshotTimers.set(sessionPath, timer);
	}

	private detachRuntimeProjection(sessionPath: string): void {
		const timer = this.snapshotTimers.get(sessionPath);
		if (timer) {
			clearTimeout(timer);
			this.snapshotTimers.delete(sessionPath);
		}
		this.clearPendingSessionProgress(sessionPath);
		this.runtimeUnsubscribers.get(sessionPath)?.();
		this.runtimeUnsubscribers.delete(sessionPath);
		this.runtimeTranscriptFacts.delete(sessionPath);
		this.runtimes.delete(sessionPath);
	}

	private runtimeSnapshot(
		runtime: RuntimeSession,
		writeAccess: SessionStateSnapshot["writeAccess"],
		attached = true,
		revision?: number,
	): SessionStateSnapshot {
		const snapshot = runtime.getSnapshot(writeAccess);
		const sessionPath = canonicalSessionPath(runtime.sessionPath);
		const projectedRevision = revision ?? Math.max(snapshot.revision, this.snapshotRevisions.get(sessionPath) ?? 0);
		this.snapshotRevisions.set(sessionPath, projectedRevision);
		return {
			...snapshot,
			path: sessionPath,
			attached,
			revision: projectedRevision,
		};
	}

	private async sendSessionSnapshots(runtime: RuntimeSession, attached = true): Promise<void> {
		const sessionPath = canonicalSessionPath(runtime.sessionPath);
		const timer = this.snapshotTimers.get(sessionPath);
		if (timer) {
			clearTimeout(timer);
			this.snapshotTimers.delete(sessionPath);
		}
		const runtimeRevision = runtime.getSnapshot("available").revision;
		const revision = Math.max(runtimeRevision, (this.snapshotRevisions.get(sessionPath) ?? -1) + 1);
		this.snapshotRevisions.set(sessionPath, revision);
		await Promise.allSettled(
			[...this.clients.values()]
				.filter((client) => client.clientInstanceId)
				.map((client) =>
					client.send({
						type: "event",
						event: {
							type: "session_snapshot",
							snapshot: this.runtimeSnapshot(runtime, this.writeAccess(sessionPath, client), attached, revision),
						},
					}),
				),
		);
	}

	private async ensureRuntime(sessionPath: string, onUiRequest: UiRequestHandler): Promise<RuntimeSession> {
		const current = this.runtimes.get(sessionPath);
		if (current) return current;
		const runtime = await this.adapter.openSession(sessionPath, onUiRequest);
		if (canonicalSessionPath(runtime.sessionPath) !== sessionPath) {
			await runtime.dispose();
			throw new Error("运行时打开了不同的会话路径");
		}
		this.attachRuntime(runtime);
		return runtime;
	}

	private isDetachedCompanion(runtime: RuntimeSession, capability: "session_fork" | "session_import"): boolean {
		return runtime.getCapabilities?.().includes(capability) === true;
	}

	private async openDetachedRuntime(
		sessionPath: string,
		operationId: string,
		clientInstanceId: string,
	): Promise<RuntimeSession> {
		return this.ensureRuntime(sessionPath, this.createUiRequestHandler(operationId, sessionPath, clientInstanceId));
	}
	private async disposeRuntime(sessionPath: string): Promise<void> {
		const timer = this.snapshotTimers.get(sessionPath);
		if (timer) {
			clearTimeout(timer);
			this.snapshotTimers.delete(sessionPath);
		}
		const runtime = this.runtimes.get(sessionPath);
		this.detachRuntimeProjection(sessionPath);
		await runtime?.dispose();
	}

	private mutationSessionPath(request: { sessionPath?: string; leaseId?: string }): string | undefined {
		if (request.sessionPath === undefined && request.leaseId === undefined) return undefined;
		if (!request.sessionPath || !request.leaseId) {
			throw Object.assign(new Error("会话路径和租约必须同时提供"), {
				code: "session_control_incomplete",
				retryable: false,
			});
		}
		return canonicalSessionPath(request.sessionPath);
	}

	private assertMutationSession(
		connection: ClientConnection,
		request: { sessionPath?: string; leaseId?: string; clientInstanceId: string },
		cwd?: string,
	): RuntimeSession | undefined {
		if (!request.sessionPath || !request.leaseId) return undefined;
		const { runtime } = this.assertExtensionSession(connection, {
			sessionPath: request.sessionPath,
			leaseId: request.leaseId,
			clientInstanceId: request.clientInstanceId,
		});
		if (cwd && canonicalProjectCwd(runtime.getSnapshot("available").cwd) !== cwd) {
			throw Object.assign(new Error("资源目录与当前会话不一致"), {
				code: "resource_session_mismatch",
				retryable: false,
			});
		}
		return runtime;
	}

	private async reloadMutationResources(runtime: RuntimeSession | undefined, cwd?: string): Promise<void> {
		for (const candidate of this.runtimes.values()) {
			if ((!cwd || canonicalProjectCwd(candidate.getSnapshot("available").cwd) === cwd) && candidate !== runtime) {
				await candidate.reloadResources();
			}
		}
		if (runtime) await runtime.reloadResources();
	}

	private assertExtensionSession(
		connection: ClientConnection,
		request: { sessionPath: string; leaseId: string; clientInstanceId: string },
	): { runtime: RuntimeSession; sessionPath: string } {
		this.assertClient(request.clientInstanceId, connection);
		this.journal.assertWritable();
		const sessionPath = canonicalSessionPath(request.sessionPath);
		this.leases.assert(sessionPath, request.leaseId, connection.clientInstanceId);
		const runtime = this.runtimes.get(sessionPath);
		if (!runtime) throw Object.assign(new Error("尚未获取会话运行时"), { code: "session_not_acquired" });
		return { runtime, sessionPath };
	}

	private assertSessionControl(
		sessionPathInput: string,
		leaseId: string,
		connection: ClientConnection,
	): { runtime: RuntimeSession; sessionPath: string } {
		this.journal.assertWritable();
		const sessionPath = canonicalSessionPath(sessionPathInput);
		this.leases.assert(sessionPath, leaseId, connection.clientInstanceId);
		if (this.activeOperationBySession.has(sessionPath)) {
			throw Object.assign(new Error("会话存在正在执行的任务"), {
				code: "session_operation_active",
				retryable: true,
			});
		}
		const runtime = this.runtimes.get(sessionPath);
		if (!runtime) {
			throw Object.assign(new Error("尚未获取会话运行时"), { code: "session_not_acquired" });
		}
		return { runtime, sessionPath };
	}

	private sessionWriteAccess(sessionPath: string, connection: ClientConnection): SessionStateSnapshot["writeAccess"] {
		const lease = this.leases.get(sessionPath, connection.clientInstanceId);
		if (lease) return "owned";
		if (this.runtimes.has(sessionPath) || this.leases.has(sessionPath)) return "controlled_elsewhere";
		return this.adapter.isSessionWriterLocked(sessionPath) ? "locked_externally" : "available";
	}

	private writeAccess(sessionPath: string, connection: ClientConnection): SessionStateSnapshot["writeAccess"] {
		return this.sessionWriteAccess(sessionPath, connection);
	}

	private assertClient(clientInstanceId: string, connection: ClientConnection): void {
		if (connection.clientInstanceId !== clientInstanceId) {
			throw Object.assign(new Error("客户端实例标识与当前连接不一致"), {
				code: "client_instance_mismatch",
			});
		}
	}

	private createUiRequestHandler(
		operationId: string | (() => string),
		sessionPath?: string | (() => string | undefined),
		clientInstanceId?: string,
	): UiRequestHandler {
		return async (request) => {
			const resolvedOperationId = typeof operationId === "function" ? operationId() : operationId;
			const resolvedSessionPath = typeof sessionPath === "function" ? sessionPath() : sessionPath;
			const event: Extract<ServerEvent, { type: "ui_request" }> = {
				type: "ui_request",
				id: request.id,
				operationId: resolvedOperationId,
				kind: request.kind,
				title: request.title,
				payload: request.payload,
				timeoutMs: request.timeoutMs,
			};
			if (request.kind === "notify") {
				await this.sendUiEvent(event, clientInstanceId);
				return {};
			}

			const response = new Promise<{ value?: JsonValue; confirmed?: boolean; cancelled?: boolean }>((resolve) => {
				const pending: PendingUiRequest = {
					operationId: resolvedOperationId,
					clientInstanceId,
					event,
					resolve,
				};
				const cancel = () => {
					if (!this.pendingUi.delete(request.id)) return;
					if (pending.timer) clearTimeout(pending.timer);
					this.restoreOperationAfterUi(resolvedOperationId);
					resolve({ cancelled: true });
				};
				if (request.signal) {
					pending.cleanup = () => request.signal?.removeEventListener("abort", cancel);
					if (request.signal.aborted) queueMicrotask(cancel);
					else request.signal.addEventListener("abort", cancel, { once: true });
				}
				if (request.timeoutMs) pending.timer = setTimeout(cancel, request.timeoutMs);
				this.pendingUi.set(request.id, pending);
			});
			const operation = this.journal.get(resolvedOperationId);
			if (operation && (!resolvedSessionPath || operation.sessionPath === resolvedSessionPath)) {
				this.updateOperation(resolvedOperationId, "waiting_for_input");
			}
			await this.sendUiEvent(event, clientInstanceId);
			return response;
		};
	}

	private async sendUiEvent(
		event: Extract<ServerEvent, { type: "ui_request" }>,
		clientInstanceId?: string,
	): Promise<void> {
		const clients = [...this.clients.values()].filter(
			(client) => !clientInstanceId || client.clientInstanceId === clientInstanceId,
		);
		await Promise.allSettled(clients.map((client) => client.send({ type: "event", event })));
	}

	private restoreOperationAfterUi(operationId: string): void {
		const operation = this.journal.get(operationId);
		if (operation?.status === "waiting_for_input") this.updateOperation(operationId, "running");
	}

	private cancelPendingUi(operationId: string): void {
		for (const [requestId, pending] of this.pendingUi) {
			if (pending.operationId !== operationId) continue;
			this.pendingUi.delete(requestId);
			if (pending.timer) clearTimeout(pending.timer);
			pending.cleanup?.();
			pending.resolve({ cancelled: true });
		}
	}

	private async broadcast(event: ServerEvent): Promise<void> {
		await Promise.allSettled([...this.clients.values()].map((client) => client.send({ type: "event", event })));
	}
}
