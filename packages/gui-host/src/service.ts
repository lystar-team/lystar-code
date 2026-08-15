import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	type Capability,
	type ClientMessage,
	type CompletionResult,
	GUI_PROTOCOL_VERSION,
	type JsonValue,
	type OperationSnapshot,
	type ServerEvent,
	type ServerMessage,
	type SessionStateSnapshot,
	type SessionSummary,
} from "@lystar/code-gui-protocol";
import { ContentStore } from "./content-store.ts";
import { LeaseManager } from "./lease-manager.ts";
import { hashOperationPayload, OperationJournal, OperationJournalCorruptError } from "./operation-journal.ts";
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
];

const ACTIVE_OPERATION_STATUSES = new Set<OperationSnapshot["status"]>(["accepted", "running", "waiting_for_input"]);
const TERMINAL_OPERATION_STATUSES = new Set<OperationSnapshot["status"]>([
	"completed",
	"failed",
	"aborted",
	"interrupted",
]);

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

function protocolError(error: unknown): { code: string; message: string; retryable?: boolean } {
	if (typeof error === "object" && error !== null) {
		const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
		return {
			code: typeof candidate.code === "string" ? candidate.code : "internal_error",
			message: typeof candidate.message === "string" ? candidate.message : String(error),
			retryable: typeof candidate.retryable === "boolean" ? candidate.retryable : undefined,
		};
	}
	return { code: "internal_error", message: String(error) };
}

function canonicalSessionPath(sessionPath: string): string {
	const resolvedPath = resolve(sessionPath);
	if (existsSync(resolvedPath)) return realpathSync(resolvedPath);
	return join(realpathSync(dirname(resolvedPath)), basename(resolvedPath));
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

export class GuiHostService {
	readonly serverInstanceId = randomUUID();
	readonly hostInstanceId = randomUUID();
	readonly hostStartedAt = Date.now();
	private readonly clients = new Map<string, ClientConnection>();
	private readonly runtimes = new Map<string, RuntimeSession>();
	private readonly runtimeUnsubscribers = new Map<string, () => void>();
	private readonly activeOperationBySession = new Map<string, string>();
	private readonly snapshotRevisions = new Map<string, number>();
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
		} catch (error) {
			await connection.send({ type: "response", id: message.id, ok: false, error: protocolError(error) });
			return;
		}
		try {
			await connection.send({ type: "response", id: message.id, ok: true, result });
		} finally {
			afterResponse?.();
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
				const sessions = await this.listSessionSummaries(request.cwd, connection);
				this.rememberSessionFacts(request.cwd, sessions);
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
					items: page.items.map((item) => this.contentStore.compactTranscriptItem(sessionPath, item)),
				});
			}
			case "create_session": {
				this.assertClient(request.clientInstanceId, connection);
				this.journal.assertWritable();
				const controlOperationId = `control:${connection.clientInstanceId}`;
				let sessionPath: string | undefined;
				const runtime = await this.adapter.createSession(
					request.cwd,
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
				const active = this.journal
					.list(sessionPath)
					.some((operation) => ACTIVE_OPERATION_STATUSES.has(operation.status));
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
			case "run_bash":
				return this.acceptOperation(
					connection,
					request,
					{ commandText: request.commandText },
					async (runtime, operation) => {
						return runtime.runBash(request.commandText, (chunk) => {
							this.updateOperation(operation.operationId, "running", { progress: { chunk } });
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
			case "list_models":
				return jsonValue(await this.adapter.listModels());
			case "list_model_providers":
				return jsonValue(await this.adapter.listModelProviders());
			case "add_model_provider":
				this.journal.assertWritable();
				return jsonValue(await this.adapter.addModelProvider(request));
			case "add_provider_model":
				this.journal.assertWritable();
				return jsonValue(await this.adapter.addProviderModel(request));
			case "login_model_provider":
				this.journal.assertWritable();
				return jsonValue(
					await this.adapter.loginModelProvider(
						request.provider,
						request.authType,
						this.createUiRequestHandler(`models-auth:${connection.id}`, undefined, connection.clientInstanceId),
					),
				);
			case "logout_model_provider":
				this.journal.assertWritable();
				return jsonValue(await this.adapter.logoutModelProvider(request.provider));
			case "rename_session": {
				const { runtime } = this.assertSessionControl(request.sessionPath, request.leaseId, connection);
				await runtime.rename(request.name);
				await this.sendSessionSnapshots(runtime);
				return this.runtimeSnapshot(runtime, "owned");
			}
			case "set_session_model": {
				const { runtime } = this.assertSessionControl(request.sessionPath, request.leaseId, connection);
				await runtime.setModel(request.model);
				await this.sendSessionSnapshots(runtime);
				return this.runtimeSnapshot(runtime, "owned");
			}
			case "set_session_thinking": {
				const { runtime } = this.assertSessionControl(request.sessionPath, request.leaseId, connection);
				await runtime.setThinkingLevel(request.level);
				await this.sendSessionSnapshots(runtime);
				return this.runtimeSnapshot(runtime, "owned");
			}
			case "fork_session": {
				const { runtime, sessionPath } = this.assertSessionControl(
					request.sessionPath,
					request.leaseId,
					connection,
				);
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
			}
			case "delete_session": {
				this.journal.assertWritable();
				const sessionPath = canonicalSessionPath(request.sessionPath);
				if (this.runtimes.has(sessionPath) || this.leases.get(sessionPath)) {
					throw Object.assign(new Error("会话当前仍被占用"), {
						code: "session_attached",
						retryable: true,
					});
				}
				if (this.journal.list(sessionPath).some((operation) => ACTIVE_OPERATION_STATUSES.has(operation.status))) {
					throw Object.assign(new Error("会话存在正在执行的任务"), {
						code: "session_operation_active",
						retryable: true,
					});
				}
				if (!existsSync(sessionPath)) {
					throw Object.assign(new Error("未找到会话"), { code: "not_found" });
				}
				await this.adapter.deleteSession(sessionPath);
				await this.broadcast({ type: "session_removed", sessionPath });
				return { deleted: true };
			}
			case "list_skills":
				this.journal.assertWritable();
				return jsonValue(
					await this.adapter.listSkills(
						request.cwd,
						this.createUiRequestHandler(`skills:${connection.id}`, undefined, connection.clientInstanceId),
					),
				);
			case "set_skill_enabled":
				this.journal.assertWritable();
				return jsonValue(
					await this.adapter.setSkillEnabled(
						request.cwd,
						request.path,
						request.scope,
						request.enabled,
						this.createUiRequestHandler(`skills:${connection.id}`, undefined, connection.clientInstanceId),
					),
				);
			case "list_project_instructions":
				return jsonValue(this.adapter.listProjectInstructions(request.cwd));
			case "save_project_instruction": {
				this.journal.assertWritable();
				const result = this.adapter.saveProjectInstruction(
					request.cwd,
					request.fileName,
					request.content,
					request.expectedHash,
				);
				for (const runtime of this.runtimes.values()) {
					if (resolve(runtime.getSnapshot("available").cwd) === resolve(request.cwd))
						await runtime.reloadResources();
				}
				return jsonValue(result);
			}
			case "list_host_instructions":
				return jsonValue(this.adapter.listHostInstructions());
			case "save_host_instruction": {
				this.journal.assertWritable();
				const result = this.adapter.saveHostInstruction(request.fileName, request.content, request.expectedHash);
				for (const runtime of this.runtimes.values()) await runtime.reloadResources();
				return jsonValue(result);
			}
			case "list_directories":
				return jsonValue(this.adapter.listDirectories(request.path));
			case "get_completions": {
				const sessionPath = request.sessionPath ? canonicalSessionPath(request.sessionPath) : undefined;
				const runtime = sessionPath ? this.runtimes.get(sessionPath) : undefined;
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
				const runtime = [...this.runtimes.values()].find(
					(candidate) => !request.cwd || resolve(candidate.getSnapshot("available").cwd) === resolve(request.cwd),
				);
				return this.adapter.getDiagnostics(request.cwd, runtime?.getToolRecoveryDiagnostics());
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

	private async acceptOperation(
		connection: ClientConnection,
		request: Extract<Extract<ClientMessage, { type: "request" }>["request"], { command: "prompt" | "run_bash" }>,
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
		if (existing) return { operation: existing, duplicate: true };
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
		afterResponse(() => void this.runOperation(runtime, accepted.operation, run).catch(() => {}));
		return { operation: accepted.operation, duplicate: false };
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
		options?: { progress?: JsonValue; result?: JsonValue; error?: string },
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
						items: payload.items.map((item) => this.contentStore.compactTranscriptItem(sessionPath, item)),
					});
				} else {
					void this.broadcast({
						type: "session_progress",
						sessionPath,
						progress: event.payload,
					});
				}
			}),
		);
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
