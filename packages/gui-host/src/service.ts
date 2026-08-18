import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	assertWorkspaceCommandResult,
	type Capability,
	type ClientMessage,
	type CompletionResult,
	type ExtensionComponentFrame,
	type ExtensionUiState,
	GUI_PROTOCOL_VERSION,
	isSessionProgress,
	type JsonValue,
	type OperationSnapshot,
	type ServerEvent,
	type ServerMessage,
	type SessionProgress,
	type SessionStateSnapshot,
	type SessionSummary,
	type TranscriptItem,
} from "@lystar/code-gui-protocol";
import { ContentStore } from "./content-store.ts";
import { LeaseManager } from "./lease-manager.ts";
import { hashOperationPayload, OperationJournal, OperationJournalCorruptError } from "./operation-journal.ts";
import { projectTranscriptItem } from "./transcript-projection.ts";
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
	"rust-extension-ui",
];

const ACTIVE_OPERATION_STATUSES = new Set<OperationSnapshot["status"]>(["accepted", "running", "waiting_for_input"]);
const TERMINAL_OPERATION_STATUSES = new Set<OperationSnapshot["status"]>([
	"completed",
	"failed",
	"aborted",
	"interrupted",
]);

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
	login_model_provider: true,
	logout_model_provider: true,
	get_project_trust: true,
	set_project_trust: true,
	list_packages: true,
	install_package: true,
	remove_package: true,
	update_packages: true,
	get_session_tree: true,
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
	render_rich_text: true,
	read_image_content: true,
	get_completions: true,
	extension_editor_state: true,
	extension_terminal_input: true,
	extension_component_input: true,
	extension_component_resize: true,
	extension_component_dispose: true,
	extension_component_custom_result: true,
	extension_component_custom_cancel: true,
} as const;

function projectSessionProgress(value: JsonValue | SessionProgress): SessionProgress {
	if (isSessionProgress(value)) return value;
	const serialized = JSON.stringify(value);
	const preview = Buffer.from(serialized)
		.subarray(0, 1024)
		.toString("utf8")
		.replace(/\uFFFD$/u, "");
	return {
		type: "status",
		status: preview || "运行状态已更新",
		...(serialized.length > preview.length ? { truncated: true } : {}),
	};
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

export class GuiHostService {
	readonly serverInstanceId = randomUUID();
	readonly hostInstanceId = randomUUID();
	readonly hostStartedAt = Date.now();
	private readonly clients = new Map<string, ClientConnection>();
	private readonly runtimes = new Map<string, RuntimeSession>();
	private readonly runtimeUnsubscribers = new Map<string, () => void>();
	private readonly activeOperationBySession = new Map<string, string>();
	private readonly scheduledOperations = new Set<string>();
	private readonly journalWritePromises = new Map<string, Promise<JsonValue>>();
	private readonly writeScopeQueues = new Map<string, Promise<void>>();
	private readonly snapshotRevisions = new Map<string, number>();
	private readonly extensionEditorRevisions = new Map<string, number>();
	private readonly pendingUi = new Map<string, PendingUiRequest>();
	private readonly leases = new LeaseManager();
	private readonly transcriptReader = new TranscriptReader();
	private readonly contentStore = new ContentStore();
	private readonly journal: OperationJournal;
	private readonly adapter: RuntimeAdapter;
	private readonly capabilities: Capability[];
	private readonly persistent: boolean;
	private readonly watchedSessionFacts = new Map<string, Map<string, SessionFileFact>>();
	private readonly sessionPollTimer: ReturnType<typeof setInterval>;
	private pollingSessions = false;

	constructor(adapter: RuntimeAdapter, options: { agentDir: string; journalPath?: string; persistent?: boolean }) {
		this.adapter = adapter;
		this.persistent = options.persistent === true;
		this.capabilities = options.persistent ? [...BASE_CAPABILITIES, "remote-detach"] : BASE_CAPABILITIES;
		this.journal = new OperationJournal(options.journalPath ?? join(options.agentDir, "host", "operations.jsonl"));
		try {
			this.journal.markInterrupted();
		} catch (error) {
			if (!(error instanceof OperationJournalCorruptError)) throw error;
		}
		this.sessionPollTimer = setInterval(() => void this.pollSessionFiles(), 500);
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

	private async detachConnection(connection: ClientConnection): Promise<void> {
		this.clients.delete(connection.id);
		if (!connection.clientInstanceId) return;
		if ([...this.clients.values()].some((client) => client.clientInstanceId === connection.clientInstanceId)) return;
		for (const sessionPath of this.leases.releaseClient(connection.clientInstanceId)) {
			const runtime = this.runtimes.get(sessionPath);
			if (runtime) await this.sendSessionSnapshots(runtime, false);
			this.releaseAcceptedReservation(sessionPath);
			if (!this.activeOperationBySession.has(sessionPath)) await this.disposeRuntime(sessionPath);
		}
	}

	async dispose(): Promise<void> {
		clearInterval(this.sessionPollTimer);
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
		this.contentStore.clear();
	}

	private async handle(connection: ClientConnection, message: ClientMessage): Promise<void> {
		if (message.type === "hello") {
			if (message.version !== GUI_PROTOCOL_VERSION) {
				await connection.send({
					type: "hello_error",
					error: {
						code: "version",
						message: `GUI Protocol ${message.version} is unsupported; Host requires ${GUI_PROTOCOL_VERSION}`,
						retryable: false,
					},
				});
				return;
			}
			connection.clientInstanceId = message.clientInstanceId;
			const about = this.adapter.getAbout() as { productVersion?: JsonValue };
			await connection.send({
				type: "hello",
				version: GUI_PROTOCOL_VERSION,
				productVersion: typeof about.productVersion === "string" ? about.productVersion : "unknown",
				protocolVersion: GUI_PROTOCOL_VERSION,
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
			case "get_snapshot":
				return jsonValue({
					operations: this.journal.list(),
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
				});
			case "list_sessions": {
				const cwd = canonicalProjectCwd(request.cwd);
				const sessions = await this.listSessionSummaries(cwd, connection);
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
					items: page.items.map((item) => this.projectTranscriptItem(sessionPath, item)),
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
					return jsonValue({ lease, snapshot: this.runtimeSnapshot(runtime, "owned") });
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
				if (runtime) await this.sendSessionSnapshots(runtime, false);
				await this.disposeRuntime(sessionPath);
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
					{ commandText: request.commandText },
					async (runtime, operation) => {
						return runtime.runBash(request.commandText, (chunk) => {
							this.updateOperation(operation.operationId, "running", {
								progress: {
									type: "status",
									status: chunk.slice(0, 1024),
									...(chunk.length > 1024 ? { truncated: true } : {}),
								},
							});
						});
					},
					afterResponse,
				);
			case "abort_operation": {
				this.journal.assertWritable();
				const operation = this.journal.get(request.operationId);
				if (!operation) throw Object.assign(new Error("未找到任务"), { code: "not_found" });
				this.leases.assert(operation.sessionPath, request.leaseId, connection.clientInstanceId);
				if (TERMINAL_OPERATION_STATUSES.has(operation.status)) return operation;
				if (this.activeOperationBySession.get(operation.sessionPath) !== operation.operationId) {
					throw Object.assign(new Error("任务当前未在执行"), {
						code: "operation_not_active",
						retryable: false,
					});
				}
				this.updateOperation(operation.operationId, "aborted");
				this.cancelPendingUi(operation.operationId);
				await this.runtimes.get(operation.sessionPath)?.abort();
				return this.journal.get(operation.operationId) ?? operation;
			}
			case "get_operation": {
				const operation = this.journal.get(request.operationId);
				if (!operation) throw Object.assign(new Error("未找到任务"), { code: "not_found" });
				return operation;
			}
			case "list_operations":
				return this.journal.list(request.sessionPath ? canonicalSessionPath(request.sessionPath) : undefined);
			case "extension_editor_state": {
				const { runtime, sessionPath } = this.assertExtensionSession(connection, request);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `extension:${sessionPath}`,
					payload: { sessionPath, revision: request.revision, text: request.text, cursor: request.cursor },
					run: async () => {
						const key = `${sessionPath}:${request.leaseId}:${request.clientInstanceId}`;
						const previous = this.extensionEditorRevisions.get(key) ?? -1;
						if (request.revision <= previous) {
							throw Object.assign(new Error("编辑器状态修订已过期"), { code: "stale_editor_revision" });
						}
						this.extensionEditorRevisions.set(key, request.revision);
						return { revision: runtime.updateExtensionEditorState?.(request.text, request.revision) ?? 0 };
					},
				});
			}
			case "extension_terminal_input": {
				const { runtime, sessionPath } = this.assertExtensionSession(connection, request);
				if (Buffer.byteLength(request.data, "utf8") > 64 * 1024)
					throw Object.assign(new Error("扩展原始输入超过 64 KiB 限制"), {
						code: "extension_input_too_large",
						retryable: false,
					});
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `extension:${sessionPath}`,
					payload: { sessionPath, data: request.data },
					run: async () => runtime.dispatchExtensionTerminalInput?.(request.data) ?? { consume: false },
				});
			}
			case "extension_component_input": {
				const { runtime, sessionPath } = this.assertExtensionSession(connection, request);
				if (Buffer.byteLength(request.data, "utf8") > 64 * 1024)
					throw Object.assign(new Error("扩展原始输入超过 64 KiB 限制"), {
						code: "extension_input_too_large",
						retryable: false,
					});
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `extension:${sessionPath}`,
					payload: {
						sessionPath,
						componentId: request.componentId,
						generation: request.generation,
						data: request.data,
					},
					run: async () =>
						runtime.dispatchExtensionComponentInput?.(request.componentId, request.generation, request.data) ?? {
							accepted: false,
						},
				});
			}
			case "extension_component_resize": {
				const { runtime, sessionPath } = this.assertExtensionSession(connection, request);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `extension:${sessionPath}`,
					payload: { sessionPath, width: request.width, height: request.height },
					run: async () => ({
						accepted: runtime.resizeExtensionComponents?.(request.width, request.height) === true,
					}),
				});
			}
			case "extension_component_dispose": {
				const { runtime, sessionPath } = this.assertExtensionSession(connection, request);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `extension:${sessionPath}`,
					payload: { sessionPath, componentId: request.componentId, generation: request.generation },
					run: async () => ({
						accepted: runtime.disposeExtensionComponent?.(request.componentId, request.generation) === true,
					}),
				});
			}
			case "extension_component_custom_result":
			case "extension_component_custom_cancel": {
				const { runtime, sessionPath } = this.assertExtensionSession(connection, request);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `extension:${sessionPath}`,
					payload: {
						sessionPath,
						componentId: request.componentId,
						generation: request.generation,
						...(request.command === "extension_component_custom_result" ? { value: request.value } : {}),
					},
					run: async () => ({
						accepted:
							runtime.completeExtensionCustom?.(
								request.componentId,
								request.generation,
								request.command === "extension_component_custom_result" ? request.value : undefined,
								request.command === "extension_component_custom_cancel",
							) === true,
					}),
				});
			}
			case "list_models":
				return jsonValue(await this.adapter.listModels());
			case "list_model_providers":
				return jsonValue(await this.adapter.listModelProviders());
			case "add_model_provider":
			case "add_provider_model":
			case "login_model_provider":
			case "logout_model_provider": {
				const provider = request.provider;
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `provider:${provider}`,
					payload: request,
					run: async () => {
						switch (request.command) {
							case "add_model_provider":
								return jsonValue(await this.adapter.addModelProvider(request));
							case "add_provider_model":
								return jsonValue(await this.adapter.addProviderModel(request));
							case "login_model_provider":
								return jsonValue(
									await this.adapter.loginModelProvider(
										request.provider,
										request.authType,
										this.createUiRequestHandler(
											`models-auth:${request.clientRequestId}`,
											undefined,
											request.clientInstanceId,
										),
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
			case "fork_session": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `session:${sessionPath}`,
					payload: {
						sessionPath,
						entryId: request.entryId,
						...(request.position ? { position: request.position } : {}),
					},
					run: async () => {
						const { runtime } = this.assertSessionControl(sessionPath, request.leaseId, connection);
						this.detachRuntimeProjection(sessionPath);
						let result: Awaited<ReturnType<RuntimeSession["fork"]>> | undefined;
						let failure: unknown;
						try {
							result = await runtime.fork(request.entryId, request.position);
						} catch (error) {
							failure = error;
						}
						const nextSessionPath = canonicalSessionPath(runtime.sessionPath);
						if (nextSessionPath !== sessionPath) {
							this.leases.move(sessionPath, nextSessionPath, request.leaseId);
							this.snapshotRevisions.delete(sessionPath);
							await this.broadcast({ type: "session_removed", sessionPath });
						}
						this.attachRuntime(runtime);
						await this.sendSessionSnapshots(runtime);
						if (failure) throw failure;
						if (!result) throw new Error("会话分叉未返回结果");
						return jsonValue({
							lease: this.leases.get(nextSessionPath),
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
					run: async () => {
						const { runtime } = this.assertSessionControl(sessionPath, request.leaseId, connection);
						this.detachRuntimeProjection(sessionPath);
						let result: Awaited<ReturnType<RuntimeSession["importSession"]>> | undefined;
						let failure: unknown;
						try {
							result = await runtime.importSession(request.inputPath, request.cwdOverride);
						} catch (error) {
							failure = error;
						}
						const nextSessionPath = canonicalSessionPath(runtime.sessionPath);
						if (nextSessionPath !== sessionPath) {
							this.leases.move(sessionPath, nextSessionPath, request.leaseId);
							this.snapshotRevisions.delete(sessionPath);
							await this.broadcast({ type: "session_removed", sessionPath });
						}
						this.attachRuntime(runtime);
						await this.sendSessionSnapshots(runtime);
						if (failure) throw failure;
						if (!result) throw new Error("会话导入未返回结果");
						if (result.cancelled) return { cancelled: true };
						return jsonValue({
							cancelled: false,
							lease: this.leases.get(nextSessionPath),
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
						if (this.runtimes.has(sessionPath) || this.leases.get(sessionPath)) {
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
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `project:${cwd}`,
					payload: { cwd, path: request.path, scope: request.scope, enabled: request.enabled },
					run: async () =>
						jsonValue(
							await this.adapter.setSkillEnabled(
								cwd,
								request.path,
								request.scope,
								request.enabled,
								this.createUiRequestHandler(
									`skills:${request.clientRequestId}`,
									undefined,
									request.clientInstanceId,
								),
							),
						),
				});
			}
			case "list_project_instructions":
				return jsonValue(this.adapter.listProjectInstructions(canonicalProjectCwd(request.cwd)));
			case "save_project_instruction": {
				const cwd = canonicalProjectCwd(request.cwd);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `project:${cwd}`,
					payload: {
						cwd,
						fileName: request.fileName,
						content: request.content,
						...(request.expectedHash ? { expectedHash: request.expectedHash } : {}),
					},
					run: async () => {
						const result = await this.adapter.saveProjectInstruction(
							cwd,
							request.fileName,
							request.content,
							request.expectedHash,
						);
						for (const runtime of this.runtimes.values()) {
							if (canonicalProjectCwd(runtime.getSnapshot("available").cwd) === cwd)
								await runtime.reloadResources();
						}
						return jsonValue(result);
					},
				});
			}
			case "list_host_instructions":
				return jsonValue(this.adapter.listHostInstructions());
			case "save_host_instruction":
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: "host:instructions",
					payload: {
						fileName: request.fileName,
						content: request.content,
						...(request.expectedHash ? { expectedHash: request.expectedHash } : {}),
					},
					run: async () => {
						const result = await this.adapter.saveHostInstruction(
							request.fileName,
							request.content,
							request.expectedHash,
						);
						for (const runtime of this.runtimes.values()) await runtime.reloadResources();
						return jsonValue(result);
					},
				});
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
				const runtimeResult = runtime?.getCompletions(request.text, request.cursor);
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
			case "get_diagnostics": {
				const cwd = request.cwd ? canonicalProjectCwd(request.cwd) : undefined;
				const runtime = [...this.runtimes.values()].find(
					(candidate) => !cwd || canonicalProjectCwd(candidate.getSnapshot("available").cwd) === cwd,
				);
				const diagnostics = await this.adapter.getDiagnostics(cwd, runtime?.getToolRecoveryDiagnostics());
				const componentDiagnostics = runtime?.getExtensionComponentDiagnostics?.();
				return componentDiagnostics
					? { ...(diagnostics as Record<string, JsonValue>), extensionComponents: componentDiagnostics }
					: diagnostics;
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
				return this.runtimes.get(sessionPath)?.listSettings() ?? this.adapter.listSettings(sessionPath);
			}
			case "set_setting": {
				const { runtime, sessionPath } = this.assertSessionControl(
					request.sessionPath,
					request.leaseId,
					connection,
				);
				const setting = runtime.listSettings().find((candidate) => candidate.id === request.id);
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
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `project:${cwd}`,
					payload: { cwd, trusted: request.trusted },
					run: async () => {
						const result = await this.adapter.setProjectTrust(cwd, request.trusted);
						for (const runtime of this.runtimes.values()) {
							if (canonicalProjectCwd(runtime.getSnapshot("available").cwd) === cwd)
								await runtime.reloadResources();
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
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: request.scope === "user" ? "host:packages" : `project:${cwd}`,
					payload: { cwd, source: request.source, scope: request.scope },
					run: () =>
						request.command === "install_package"
							? this.adapter.installPackage(cwd, request.source, request.scope)
							: this.adapter.removePackage(cwd, request.source, request.scope),
				});
			}
			case "update_packages": {
				const cwd = canonicalProjectCwd(request.cwd);
				return this.executeJournaledWrite(connection, {
					command: request.command,
					clientInstanceId: request.clientInstanceId,
					clientRequestId: request.clientRequestId,
					scope: `project:${cwd}`,
					payload: { cwd, ...(request.source ? { source: request.source } : {}) },
					run: () => this.adapter.updatePackages(cwd, request.source),
				});
			}
			case "get_session_tree": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				return this.adapter.getSessionTree(sessionPath);
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
					? runtime.listSubagents()
					: this.adapter.listSubagents(sessionPath);
			}
			case "read_subagent": {
				const sessionPath = canonicalSessionPath(request.sessionPath);
				const runtime = this.runtimes.get(sessionPath);
				return runtime && this.sessionWriteAccess(sessionPath, connection) === "owned"
					? runtime.readSubagent(request.agentId)
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
		}
	}

	private async listSessionSummaries(cwd: string, connection: ClientConnection): Promise<SessionSummary[]> {
		const sessions = await this.adapter.listSessions(cwd);
		return sessions.map((session) => {
			const sessionPath = canonicalSessionPath(session.path);
			const latestOperation = this.journal
				.list(sessionPath)
				.reduce<OperationSnapshot | undefined>(
					(latest, operation) => (!latest || operation.updatedAt > latest.updatedAt ? operation : latest),
					undefined,
				);
			const activity =
				latestOperation?.status === "accepted" ? "running" : (latestOperation?.status ?? session.activity);
			return {
				...session,
				path: sessionPath,
				activity,
				writeAccess: this.sessionWriteAccess(sessionPath, connection),
				...(latestOperation ? { operationUpdatedAt: latestOperation.updatedAt } : {}),
			};
		});
	}

	private projectTranscriptItem(sessionPath: string, item: TranscriptItem) {
		const compact = this.contentStore.compactTranscriptItem(sessionPath, item);
		return { ...compact, view: projectTranscriptItem(compact) };
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
					sessions = await this.adapter.listSessions(cwd);
				} catch {
					continue;
				}
				const next = new Map<string, SessionFileFact>();
				const transcriptChanges: string[] = [];
				let changed = sessions.length !== previous.size;
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
						changed = true;
						continue;
					}
					if (
						old.updatedAt !== fact.updatedAt ||
						old.messageCount !== fact.messageCount ||
						old.name !== fact.name
					) {
						changed = true;
						transcriptChanges.push(sessionPath);
					}
					if (old.writerLocked !== fact.writerLocked) changed = true;
				}
				for (const sessionPath of previous.keys()) {
					if (next.has(sessionPath)) continue;
					changed = true;
					await this.broadcast({ type: "session_removed", sessionPath });
				}
				this.watchedSessionFacts.set(cwd, next);
				for (const sessionPath of transcriptChanges) {
					await this.broadcast({ type: "transcript_changed", sessionPath });
				}
				if (changed) await this.broadcast({ type: "sessions_changed", cwd });
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
			payload: JsonValue;
			run: () => Promise<JsonValue>;
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
		const accepted = this.journal.accept({
			clientInstanceId: input.clientInstanceId,
			clientRequestId: input.clientRequestId,
			sessionPath: input.scope,
			type: input.command,
			payloadHash,
		});
		const execution = this.enqueueWriteScope(input.scope, async () => {
			try {
				this.updateOperation(accepted.operation.operationId, "running");
				const result = await input.run();
				this.updateOperation(accepted.operation.operationId, "completed", { result });
				return result;
			} catch (error) {
				this.updateOperation(accepted.operation.operationId, "failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
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
			{ command: "prompt" | "compact" | "run_bash" }
		>,
		payload: JsonValue,
		run: (runtime: RuntimeSession, operation: OperationSnapshot) => Promise<JsonValue>,
		afterResponse: (action: () => void) => void,
	): Promise<JsonValue> {
		this.assertClient(request.clientInstanceId, connection);
		this.journal.assertWritable();
		const sessionPath = canonicalSessionPath(request.sessionPath);
		this.leases.assert(sessionPath, request.leaseId, request.clientInstanceId);
		const runtime = this.runtimes.get(sessionPath);
		if (!runtime) throw Object.assign(new Error("尚未获取会话运行时"), { code: "session_not_acquired" });
		const payloadHash = hashOperationPayload({
			command: request.command,
			sessionPath,
			payload,
		});
		const existing = this.journal.find(request.clientInstanceId, request.clientRequestId, payloadHash);
		if (existing) {
			if (existing.status === "accepted") afterResponse(() => this.scheduleOperation(runtime, existing, run));
			return { operation: existing, duplicate: true };
		}
		const activeOperationId = this.activeOperationBySession.get(sessionPath);
		if (activeOperationId) {
			throw Object.assign(new Error("会话已有正在执行的任务"), {
				code: "session_operation_active",
				retryable: true,
			});
		}
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
		run: (runtime: RuntimeSession, operation: OperationSnapshot) => Promise<JsonValue>,
	): void {
		if (operation.status !== "accepted" || this.scheduledOperations.has(operation.operationId)) return;
		this.scheduledOperations.add(operation.operationId);
		void this.runOperation(runtime, operation, run)
			.catch(() => {})
			.finally(() => this.scheduledOperations.delete(operation.operationId));
	}

	private async runOperation(
		runtime: RuntimeSession,
		operation: OperationSnapshot,
		run: (runtime: RuntimeSession, operation: OperationSnapshot) => Promise<JsonValue>,
	): Promise<void> {
		try {
			this.updateOperation(operation.operationId, "running");
			const result = await run(runtime, operation);
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
			if (!this.leases.get(operation.sessionPath)) await this.disposeRuntime(operation.sessionPath);
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
		this.runtimeUnsubscribers.set(
			sessionPath,
			runtime.onEvent((event) => {
				if (event.type === "state_changed") {
					void this.sendSessionSnapshots(runtime);
				} else if (event.type === "entry_committed") {
					const payload = event.payload as {
						items: never[];
						transcriptGeneration: string;
						fromRevision: number;
						transcriptRevision: number;
					};
					void this.broadcast({
						type: "transcript_committed",
						sessionPath,
						transcriptGeneration: payload.transcriptGeneration,
						fromRevision: payload.fromRevision,
						toRevision: payload.transcriptRevision,
						items: payload.items.map((item) => this.projectTranscriptItem(sessionPath, item)),
					});
				} else if (event.type === "extension_ui") {
					const payload = event.payload as
						| { type: "snapshot"; state: ExtensionUiState }
						| {
								type: "delta";
								delta: Omit<Partial<ExtensionUiState>, "revision"> & { revision: number };
						  }
						| {
								type: "editor_action";
								action: { action: "paste" | "set"; text: string; revision: number };
						  }
						| { type: "editor_submit"; text: string; revision: number }
						| { type: "editor_app_action"; action: string; data?: string; revision: number }
						| {
								type: "component_mount";
								componentId: string;
								generation: number;
								placement: "widget_above" | "widget_below" | "header" | "footer" | "custom_overlay";
								visible: boolean;
								overlayOptions?: JsonValue;
								frame: ExtensionComponentFrame;
						  }
						| { type: "component_frame"; componentId: string; generation: number; frame: ExtensionComponentFrame }
						| { type: "component_invalidate"; componentId: string; generation: number; visible: boolean }
						| {
								type: "component_unmount";
								componentId: string;
								generation: number;
								reason: "replace" | "clear" | "dispose" | "error" | "done" | "cancel";
						  };
					if (payload.type === "snapshot") {
						void this.broadcast({ type: "extension_ui_snapshot", sessionPath, state: payload.state });
					} else if (payload.type === "delta") {
						void this.broadcast({ type: "extension_ui_delta", sessionPath, delta: payload.delta });
					} else if (payload.type === "editor_action") {
						void this.broadcast({ type: "extension_editor_action", sessionPath, action: payload.action });
					} else if (payload.type === "editor_submit") {
						void this.broadcast({
							type: "extension_editor_submit",
							sessionPath,
							submit: { text: payload.text, revision: payload.revision },
						});
					} else if (payload.type === "editor_app_action") {
						void this.broadcast({
							type: "extension_editor_app_action",
							sessionPath,
							action: {
								action: payload.action,
								...(payload.data ? { data: payload.data } : {}),
								revision: payload.revision,
							},
						});
					} else if (payload.type === "component_mount") {
						void this.broadcast({
							type: "extension_component_mount",
							sessionPath,
							componentId: payload.componentId,
							generation: payload.generation,
							placement: payload.placement,
							visible: payload.visible,
							...(payload.overlayOptions ? { overlayOptions: payload.overlayOptions as never } : {}),
							frame: payload.frame,
						});
					} else if (payload.type === "component_frame") {
						void this.broadcast({
							type: "extension_component_frame",
							sessionPath,
							componentId: payload.componentId,
							generation: payload.generation,
							frame: payload.frame,
						});
					} else if (payload.type === "component_invalidate") {
						void this.broadcast({
							type: "extension_component_invalidate",
							sessionPath,
							componentId: payload.componentId,
							generation: payload.generation,
							visible: payload.visible,
						});
					} else {
						void this.broadcast({
							type: "extension_component_unmount",
							sessionPath,
							componentId: payload.componentId,
							generation: payload.generation,
							reason: payload.reason,
						});
					}
				} else {
					void this.broadcast({
						type: "session_progress",
						sessionPath,
						progress: projectSessionProgress(event.payload),
					});
				}
			}),
		);
		const extensionUi = runtime.getExtensionUiSnapshot?.();
		if (extensionUi) {
			void this.broadcast({ type: "extension_ui_snapshot", sessionPath, state: extensionUi });
			runtime.publishExtensionComponents?.();
		}
	}

	private detachRuntimeProjection(sessionPath: string): void {
		this.runtimeUnsubscribers.get(sessionPath)?.();
		this.runtimeUnsubscribers.delete(sessionPath);
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

	private async disposeRuntime(sessionPath: string): Promise<void> {
		const runtime = this.runtimes.get(sessionPath);
		this.detachRuntimeProjection(sessionPath);
		await runtime?.dispose();
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
		const lease = this.leases.get(sessionPath);
		if (lease) return lease.clientInstanceId === connection.clientInstanceId ? "owned" : "controlled_elsewhere";
		if (this.runtimes.has(sessionPath)) return "controlled_elsewhere";
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
