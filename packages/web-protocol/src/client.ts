import { Check } from "typebox/value";
import { encodeClientMessage, ServerMessageDecoder, TrustedServerMessageDecoder } from "./framing.ts";
import {
	assertWorkspaceCommandResult,
	type Command,
	type JsonValue,
	type OperationSnapshot,
	RUNTIME_PROTOCOL_VERSION,
	type ServerEvent,
	type ServerHello,
	type ServerMessage,
	type SessionStateSnapshot,
	type TranscriptPage,
	TranscriptPageSchema,
	WorkspaceCommandResultSchemas,
} from "./schemas.ts";
import { createUuid } from "./uuid.ts";

export interface ByteTransport {
	send(bytes: Uint8Array): Promise<void>;
	close(): Promise<void>;
	onBytes(listener: (bytes: Uint8Array) => void): () => void;
	onClose(listener: (error?: Error) => void): () => void;
}

export interface TranscriptHead {
	generation: string;
	revision: number;
	stale: boolean;
}

export interface RuntimeRequestDiagnostic {
	clientInstanceId: string;
	requestId: string;
	command: Command["command"];
	phase: "start" | "end";
	outcome?: "ok" | "error" | "timeout" | "disconnected";
	elapsedMs?: number;
	errorCode?: string;
}

export interface RequestOptions {
	/** Use 0 only for a command that intentionally has no deadline. */
	timeoutMs?: number;
	timeoutMessage?: string;
	/** 在响应帧位置建立同步基线，必须先于同批后续事件执行。 */
	onResult?: (value: unknown) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 只在创建一项用户逻辑写入动作时调用；重试必须复用返回值。 */
export function createClientRequestId(): string {
	return createUuid();
}

export interface RuntimeClientSnapshot {
	connected: boolean;
	hello?: ServerHello;
	sessions: ReadonlyMap<string, SessionStateSnapshot>;
	operations: ReadonlyMap<string, OperationSnapshot>;
	transcripts: ReadonlyMap<string, TranscriptHead>;
	lastError?: string;
}

export class RuntimeProtocolError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable = false) {
		super(message);
		this.name = "RuntimeProtocolError";
		this.code = code;
		this.retryable = retryable;
	}
}

export class RuntimeProtocolClient {
	private readonly decoder: ServerMessageDecoder | TrustedServerMessageDecoder;
	private readonly pending = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			onResult?: (value: unknown) => void;
			finish: (outcome: "ok" | "error" | "timeout" | "disconnected", errorCode?: string) => void;
			timeout?: ReturnType<typeof setTimeout>;
		}
	>();
	private readonly listeners = new Set<() => void>();
	private readonly eventListeners = new Set<(event: ServerEvent) => void>();
	private readonly sessions = new Map<string, SessionStateSnapshot>();
	private readonly operations = new Map<string, OperationSnapshot>();
	private readonly transcripts = new Map<string, TranscriptHead>();
	private snapshot: RuntimeClientSnapshot = {
		connected: false,
		sessions: this.sessions,
		operations: this.operations,
		transcripts: this.transcripts,
	};
	private unsubscribeBytes?: () => void;
	private unsubscribeClose?: () => void;
	private readonly transport: ByteTransport;
	private readonly trustedServerMessages: boolean;
	private readonly protocolVersion: number;
	private readonly onRequestDiagnostic?: (diagnostic: RuntimeRequestDiagnostic) => void;
	private closed = false;
	readonly clientInstanceId: string;

	constructor(
		transport: ByteTransport,
		clientInstanceId: string,
		options: {
			trustedServerMessages?: boolean;
			protocolVersion?: number;
			onRequestDiagnostic?: (diagnostic: RuntimeRequestDiagnostic) => void;
		} = {},
	) {
		const protocolVersion = options.protocolVersion ?? RUNTIME_PROTOCOL_VERSION;
		if (!Number.isInteger(protocolVersion) || protocolVersion < 0)
			throw new RangeError("Web Runtime Protocol version must be a non-negative integer");
		this.transport = transport;
		this.clientInstanceId = clientInstanceId;
		this.trustedServerMessages = options.trustedServerMessages === true;
		this.protocolVersion = protocolVersion;
		this.onRequestDiagnostic = options.onRequestDiagnostic;
		this.decoder = options.trustedServerMessages ? new TrustedServerMessageDecoder() : new ServerMessageDecoder();
	}

	getSnapshot = (): RuntimeClientSnapshot => this.snapshot;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	onEvent(listener: (event: ServerEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	async connect(): Promise<void> {
		this.unsubscribeBytes = this.transport.onBytes((bytes) => {
			if (this.closed) return;
			try {
				for (const message of this.decoder.push(bytes)) this.handleMessage(message);
			} catch (error) {
				this.handleClose(error instanceof Error ? error : new Error(String(error)));
				void this.transport.close().catch(() => {});
			}
		});
		this.unsubscribeClose = this.transport.onClose((error) => this.handleClose(error));
		await this.transport.send(
			encodeClientMessage({
				type: "hello",
				version: this.protocolVersion,
				clientInstanceId: this.clientInstanceId,
			}),
		);
	}

	async request<T = unknown>(request: Command, options: RequestOptions = {}): Promise<T> {
		if (this.closed) throw new Error("Web Runtime 连接已关闭");
		const id = createClientRequestId();
		const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const startedAt = Date.now();
		const report = (
			phase: RuntimeRequestDiagnostic["phase"],
			outcome?: RuntimeRequestDiagnostic["outcome"],
			errorCode?: string,
		) => {
			try {
				this.onRequestDiagnostic?.({
					clientInstanceId: this.clientInstanceId,
					requestId: id,
					command: request.command,
					phase,
					...(outcome ? { outcome, elapsedMs: Date.now() - startedAt } : {}),
					...(errorCode ? { errorCode } : {}),
				});
			} catch {
				// 诊断回调不能改变请求的结果或传输状态。
			}
		};
		const result = new Promise<T>((resolve, reject) => {
			const pending = {
				resolve: (value: unknown) => resolve(value as T),
				reject,
				onResult: options.onResult,
				finish: (outcome: "ok" | "error" | "timeout" | "disconnected", errorCode?: string) =>
					report("end", outcome, errorCode),
				timeout: undefined as ReturnType<typeof setTimeout> | undefined,
			};
			if (timeoutMs > 0) {
				pending.timeout = globalThis.setTimeout(() => {
					if (!this.pending.delete(id)) return;
					const timeoutError = new Error(options.timeoutMessage ?? `Web Runtime请求超时：${request.command}`);
					pending.finish("timeout", "request_timeout");
					reject(timeoutError);
					this.handleClose(timeoutError);
					void this.transport.close().catch(() => {});
				}, timeoutMs);
			}
			this.pending.set(id, pending);
		});
		report("start");
		// 响应等待与发送并行：发送受阻时，请求超时也必须能够结束调用。
		void Promise.resolve()
			.then(() => this.transport.send(encodeClientMessage({ type: "request", id, request })))
			.catch((error) => {
				this.handleClose(error instanceof Error ? error : new Error(String(error)));
				void this.transport.close().catch(() => {});
			});
		const value = await result;
		if (request.command === "read_transcript") {
			if (this.trustedServerMessages) {
				const page = value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
				if (
					page &&
					typeof (page as Record<string, unknown>).transcriptGeneration === "string" &&
					Number.isInteger((page as Record<string, unknown>).transcriptRevision)
				)
					this.applyTranscriptPage(request.sessionPath, value as TranscriptPage);
			} else if (Check(TranscriptPageSchema, value)) {
				this.applyTranscriptPage(request.sessionPath, value);
			}
		}
		if (request.command in WorkspaceCommandResultSchemas) {
			assertWorkspaceCommandResult(request.command as keyof typeof WorkspaceCommandResultSchemas, value);
		}
		return value;
	}

	async respondToUi(
		id: string,
		response: { value?: JsonValue; confirmed?: boolean; cancelled?: boolean },
	): Promise<void> {
		await this.transport.send(
			encodeClientMessage({
				type: "ui_response",
				id,
				value: response.value,
				confirmed: response.confirmed,
				cancelled: response.cancelled,
			}),
		);
	}

	async close(): Promise<void> {
		this.unsubscribeBytes?.();
		this.unsubscribeClose?.();
		this.handleClose();
		await this.transport.close();
	}

	private handleMessage(message: ServerMessage): void {
		if (message.type === "hello") {
			this.publish({ connected: true, hello: message, lastError: undefined });
			return;
		}
		if (message.type === "hello_error") {
			this.handleClose(new RuntimeProtocolError(message.error.code, message.error.message, message.error.retryable));
			return;
		}
		if (message.type === "response") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (pending.timeout) globalThis.clearTimeout(pending.timeout);
			if (message.ok) {
				try {
					pending.onResult?.(message.result);
					pending.finish("ok");
					pending.resolve(message.result);
				} catch (error) {
					pending.finish("error", "result_callback_error");
					pending.reject(error instanceof Error ? error : new Error(String(error)));
					throw error;
				}
			} else {
				pending.finish("error", message.error.code);
				pending.reject(
					new RuntimeProtocolError(message.error.code, message.error.message, message.error.retryable),
				);
			}
			return;
		}
		this.applyEvent(message.event);
	}

	private applyEvent(event: ServerEvent): void {
		if (event.type === "session_snapshot") {
			const current = this.sessions.get(event.snapshot.path);
			if (current && event.snapshot.revision < current.revision) return;
			this.sessions.set(event.snapshot.path, event.snapshot);
		}
		if (event.type === "session_removed") {
			this.sessions.delete(event.sessionPath);
			this.transcripts.delete(event.sessionPath);
		}
		if (event.type === "transcript_committed") {
			const current = this.transcripts.get(event.sessionPath);
			if (!current) {
				this.transcripts.set(event.sessionPath, {
					generation: event.transcriptGeneration,
					revision: event.toRevision,
					stale: event.fromRevision !== 0,
				});
			} else if (event.transcriptGeneration !== current.generation) {
				this.transcripts.set(event.sessionPath, {
					generation: event.transcriptGeneration,
					revision: event.toRevision,
					stale: true,
				});
			} else if (event.toRevision <= current.revision) {
				return;
			} else {
				this.transcripts.set(event.sessionPath, {
					generation: current.generation,
					revision: event.toRevision,
					stale: current.stale || event.fromRevision !== current.revision,
				});
			}
		}
		if (event.type === "operation_updated") {
			const current = this.operations.get(event.operation.operationId);
			if (current && event.operation.updatedAt < current.updatedAt) return;
			this.operations.set(event.operation.operationId, event.operation);
		}
		for (const listener of this.eventListeners) listener(event);
		this.publish();
	}

	private applyTranscriptPage(sessionPath: string, page: TranscriptPage): void {
		this.transcripts.set(sessionPath, {
			generation: page.transcriptGeneration,
			revision: page.transcriptRevision,
			stale: false,
		});
		this.publish();
	}

	private handleClose(error?: Error): void {
		if (this.closed) return;
		this.closed = true;
		const reason = error ?? new Error("Web Runtime连接已关闭");
		for (const pending of this.pending.values()) {
			if (pending.timeout) globalThis.clearTimeout(pending.timeout);
			pending.finish("disconnected", error instanceof RuntimeProtocolError ? error.code : "connection_closed");
			pending.reject(reason);
		}
		this.pending.clear();
		this.publish({ connected: false, lastError: reason.message });
	}

	private publish(update?: Partial<Pick<RuntimeClientSnapshot, "connected" | "hello" | "lastError">>): void {
		this.snapshot = {
			...this.snapshot,
			...update,
			sessions: new Map(this.sessions),
			operations: new Map(this.operations),
			transcripts: new Map(this.transcripts),
		};
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
