import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import type { Api, AssistantMessage, Message, Model, NativeSteeringInput, StreamOptions } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { type AssistantMessageEventStream, EventStream } from "../utils/event-stream.ts";
import { type OpenAIResponsesStreamOptions, processResponsesStream } from "./openai-responses-shared.ts";

interface ResponsesSocket {
	send(data: string): void;
	addEventListener(type: "message" | "error" | "close", listener: (event: unknown) => void): void;
	removeEventListener(type: "message" | "error" | "close", listener: (event: unknown) => void): void;
}

type WireEvent = Record<string, unknown> & { type: string };

interface PendingSteer extends NativeSteeringInput {
	parentId: string;
	serverId?: string;
	resumed?: boolean;
}

class UnsupportedResponsesSteeringError extends Error {}

class ResponsesSocketReader {
	readonly pending: PendingSteer[] = [];
	parentId?: string;
	steeringUnsupported = false;
	clearPendingAbort?: () => void;
	private readonly socket: ResponsesSocket;
	private readonly events = new EventStream<WireEvent, void>(
		() => false,
		() => undefined,
	);
	private readonly iterator = this.events[Symbol.asyncIterator]();
	private chain = Promise.resolve();
	private failure?: Error;

	constructor(socket: ResponsesSocket) {
		this.socket = socket;
		socket.addEventListener("message", this.onMessage);
		socket.addEventListener("error", this.onError);
		socket.addEventListener("close", this.onClose);
	}

	private readonly onMessage = (event: unknown): void => {
		// Blob 解码异步完成，串行处理以保留 accepted、终态与后续响应的顺序。
		this.chain = this.chain
			.then(async () => {
				if (!event || typeof event !== "object" || !("data" in event)) return;
				const data: unknown = event.data;
				let text: string;
				if (typeof data === "string") text = data;
				else if (data instanceof Blob) text = await data.text();
				else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
				else if (ArrayBuffer.isView(data))
					text = new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
				else throw new Error("Unsupported Responses WebSocket message");
				const parsed: unknown = JSON.parse(text);
				if (!parsed || typeof parsed !== "object" || !("type" in parsed) || typeof parsed.type !== "string") {
					throw new Error("Invalid Responses WebSocket event");
				}
				this.events.push(parsed as WireEvent);
			})
			.catch((error: unknown) => this.fail(error));
	};

	private readonly onError = (event: unknown): void => {
		const cause = event && typeof event === "object" && "error" in event ? event.error : undefined;
		this.fail(cause ?? new Error("Responses WebSocket error"));
	};

	private readonly onClose = (event: unknown): void => {
		const close = event as { code?: number; reason?: string };
		const details = [close.code, close.reason].filter((value) => value !== undefined && value !== "").join(": ");
		// close 可紧跟最后一帧，先完成已经收到的帧，避免把完整响应误判为断线。
		const message = `Responses WebSocket closed${details ? ` (${details})` : ""}`;
		const failure =
			close.code === 1008 && close.reason === "unsupported websocket request type: response.steer"
				? new UnsupportedResponsesSteeringError(message)
				: new Error(message);
		void this.chain.then(() => this.fail(failure));
	};

	fail(error: unknown): void {
		this.failure = error instanceof Error ? error : new Error(String(error));
		this.events.end();
	}

	async next(signal?: AbortSignal, timeoutMs?: number): Promise<WireEvent> {
		const timeout = timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
		const readSignal = signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout);
		const result = await raceWithAbortSignal(this.iterator.next(), operationSignal(readSignal));
		if (result.done) throw this.failure ?? new Error("Responses WebSocket ended before a terminal event");
		return result.value;
	}

	throwIfFailed(): void {
		if (this.failure) throw this.failure;
	}

	dispose(): void {
		this.clearPendingAbort?.();
		this.clearPendingAbort = undefined;
		this.socket.removeEventListener("message", this.onMessage);
		this.socket.removeEventListener("error", this.onError);
		this.socket.removeEventListener("close", this.onClose);
		this.events.end();
	}
}

const readers = new WeakMap<ResponsesSocket, ResponsesSocketReader>();

export function supportsNativeResponsesSteering(model: Pick<Model<Api>, "id" | "nativeSteering">): boolean {
	return model.nativeSteering !== "off" && (model.nativeSteering === "on" || /^gpt-6(?:[.-]|$)/iu.test(model.id));
}

interface NativeResponsesRequest {
	connection: { socket: ResponsesSocket; release: (options?: { keep?: boolean }) => void };
	body: ResponseCreateParamsStreaming;
	messages: readonly Message[];
	convertMessages: (messages: Message[]) => ResponseInput;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	model: Model<Api>;
	options?: StreamOptions;
	processOptions?: OpenAIResponsesStreamOptions;
	onOutput: (message: AssistantMessage) => void;
	onStart: () => void;
}

/** 一条连接承接原生插话、自动后续响应和跨工具调用的续接。 */
export async function processNativeResponsesStream(request: NativeResponsesRequest): Promise<AssistantMessage> {
	const { connection, body, stream, model, options } = request;
	const { socket, release } = connection;
	let reader = readers.get(socket);
	if (!reader) {
		reader = new ResponsesSocketReader(socket);
		readers.set(socket, reader);
	}
	const state = reader;
	state.clearPendingAbort?.();
	state.clearPendingAbort = undefined;
	const steering = options?.sessionId && supportsNativeResponsesSteering(model) ? options.steering : undefined;
	let activeResponseId: string | undefined;
	let steeringSignal: AbortSignal | undefined;
	let sending: Promise<void> | undefined;
	let output = request.output;
	let keep = true;
	let finished = false;
	let requestBody = body;

	const armSteering = (): void => {
		steeringSignal?.removeEventListener("abort", submitSteer);
		steeringSignal = undefined;
		if (
			finished ||
			!steering ||
			state.steeringUnsupported ||
			!activeResponseId ||
			state.pending.length > 0 ||
			sending
		)
			return;
		steeringSignal = steering.getSignal();
		if (steeringSignal?.aborted) submitSteer();
		else steeringSignal?.addEventListener("abort", submitSteer, { once: true });
	};
	const submitSteer = (): void => {
		if (!steering || sending || !activeResponseId || state.pending.length > 0 || state.steeringUnsupported) return;
		const parentId = activeResponseId;
		sending = (async () => {
			const input = await steering.getInput();
			if (!input || activeResponseId !== parentId || finished) return;
			// 此事件只接受 user 消息，不能携带 configuration_update、工具结果或 stream_id。
			const messages = request
				.convertMessages(input.messages)
				.filter((item) => "role" in item && item.role === "user");
			if (messages.length === 0) return;
			state.pending.push({ ...input, parentId });
			socket.send(JSON.stringify({ type: "response.steer", previous_response_id: parentId, input: messages }));
		})()
			.catch((error: unknown) => state.fail(error))
			.finally(() => {
				sending = undefined;
				armSteering();
			});
	};
	const control = async (event: WireEvent): Promise<boolean> => {
		if (!event.type.startsWith("response.steer.")) return false;
		await options?.onProviderStreamEvent?.(event, model);
		const steer = event.steer as { id?: string; previous_response_id?: string; input?: unknown } | undefined;
		if (event.type === "response.steer.accepted") {
			const pending = state.pending.find(
				(input) => !input.serverId && input.parentId === steer?.previous_response_id,
			);
			if (!pending || !steer?.id) throw new Error("Responses steering acknowledgement has no matching input");
			pending.serverId = steer.id;
		} else if (event.type === "response.steer.failed") {
			const index = state.pending.findIndex((input) =>
				steer?.id ? input.serverId === steer.id : input.parentId === steer?.previous_response_id && !input.serverId,
			);
			if (index === -1) throw new Error("Responses steering failure has no matching input");
			const [failed] = state.pending.splice(index, 1);
			const error = event.error as { code?: string; message?: string } | undefined;
			if (failed?.resumed) throw new Error(`原生插话续接失败：${error?.message ?? error?.code ?? "unknown error"}`);
			// 拒绝的输入由 Agent 在回复结束后放回队列，本次回复内保留原有顺序。
			state.steeringUnsupported = true;
			if (error?.code === "steering_not_supported") {
				await steering?.onUnsupported?.(new Error(error.message ?? error.code));
			}
		}
		return true;
	};

	try {
		if (state.pending.length > 0) {
			const parentIndex = request.messages.findIndex(
				(message) => message.role === "assistant" && message.responseId === state.parentId,
			);
			if (parentIndex === -1 || !state.parentId)
				throw new Error("Cannot resume accepted steering without its parent response");
			for (const input of state.pending) input.resumed = true;
			const accepted = state.pending.flatMap((input) => input.messages);
			const delta = request.messages.slice(parentIndex + 1).filter((message) => {
				if (message.role !== "user") return true;
				const index = accepted.findIndex(
					(input) => JSON.stringify(input.content) === JSON.stringify(message.content),
				);
				if (index === -1) return true;
				accepted.splice(index, 1);
				return false;
			});
			if (accepted.length > 0) throw new Error("Accepted steering is missing from the resumed transcript");
			requestBody = { ...body, previous_response_id: state.parentId, input: request.convertMessages(delta) };
		}
		// 监听先于发送安装，工具运行期间也保留监听，以免丢失 pending 或 failed。
		socket.send(JSON.stringify({ ...requestBody, type: "response.create", stream: undefined }));
		let first: WireEvent | undefined;
		let inputIds: string[] | undefined;
		let previous: AssistantMessage | undefined;
		for (;;) {
			let startEmitted = false;
			const startedAt = performance.now();
			async function* responseEvents(): AsyncGenerator<ResponseStreamEvent> {
				let event = first ?? (await state.next(options?.signal, options?.timeoutMs));
				first = undefined;
				for (;;) {
					if (await control(event)) {
						event = await state.next(options?.signal, options?.timeoutMs);
						continue;
					}
					if (event.type === "error" && !startEmitted) {
						await options?.onProviderStreamEvent?.(event, model);
						const error = event.error as { code?: string; message?: string } | undefined;
						throw Object.assign(
							new Error(String(event.message ?? error?.message ?? "Responses WebSocket request failed")),
							{
								code: event.code ?? error?.code,
							},
						);
					}
					request.onStart();
					if (event.type === "response.created") {
						const response = event.response as { id?: string } | undefined;
						if (!response?.id) throw new Error("Responses WebSocket response.created is missing its id");
						activeResponseId = response.id;
						if (!previous) state.pending.length = 0;
					}
					if (!startEmitted) {
						startEmitted = true;
						request.onOutput(output);
						stream.push({
							type: "start",
							partial: output,
							...(previous && inputIds ? { steering: { inputIds, previous } } : {}),
						});
					}
					const terminal =
						event.type === "response.completed" ||
						event.type === "response.incomplete" ||
						event.type === "response.failed" ||
						event.type === "response.done";
					if (terminal) activeResponseId = undefined;
					if (event.type === "response.done") event = { ...event, type: "response.completed" };
					yield event as unknown as ResponseStreamEvent;
					if (terminal) return;
					armSteering();
					event = await state.next(options?.signal, options?.timeoutMs);
				}
			}
			await processResponsesStream(responseEvents(), output, stream, model, request.processOptions);
			output.durationMs = Math.max(0, Math.round(performance.now() - startedAt));
			await sending;
			state.parentId = output.responseId;
			state.throwIfFailed();
			if (output.stopReason === "toolUse") {
				while (state.pending.some((input) => !input.serverId)) {
					const event = await state.next(options?.signal, options?.timeoutMs);
					if (!(await control(event)))
						throw new Error(`Expected steering acknowledgement, received ${event.type}`);
				}
				return output;
			}
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				keep = false;
				return output;
			}
			while (state.pending.length > 0) {
				const event = await state.next(options?.signal, options?.timeoutMs);
				if (await control(event)) {
					if (event.type === "response.steer.pending")
						throw new Error("Responses steering requires tool input not present in the response");
					continue;
				}
				if (event.type !== "response.created")
					throw new Error(`Expected steering successor, received ${event.type}`);
				inputIds = state.pending.map((input) => input.id);
				state.pending.length = 0;
				previous = output;
				output = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [],
					stopReason: "pending",
					timestamp: Date.now(),
					providerThinkingLevel: previous.providerThinkingLevel,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				first = event;
				break;
			}
			if (!first) return output;
		}
	} catch (error) {
		keep = false;
		// 已实测的网关拒绝会关闭连接。仅恢复明确未接收的插话，不重放已执行的工具。
		if (
			error instanceof UnsupportedResponsesSteeringError &&
			state.pending.length > 0 &&
			state.pending.every((input) => !input.serverId) &&
			!options?.signal?.aborted
		) {
			await steering?.onUnsupported?.(error);
			if (output.stopReason === "pending") {
				output.content = output.content
					.filter((block) => block.type === "text")
					.map((block) => ({ type: "text" as const, text: block.text }));
				output.stopReason = "stop";
				output.durationMs = Math.max(0, Date.now() - output.timestamp);
			}
			if (output.stopReason === "stop" || output.stopReason === "length" || output.stopReason === "toolUse")
				return output;
		}
		throw error;
	} finally {
		finished = true;
		steeringSignal?.removeEventListener("abort", submitSteer);
		await sending;
		if (!keep || state.pending.length === 0 || !options?.sessionId) {
			state.dispose();
			readers.delete(socket);
		} else if (options?.signal) {
			const pendingSignal = options.signal;
			const cancelPending = () => {
				state.dispose();
				readers.delete(socket);
				release({ keep: false });
			};
			pendingSignal.addEventListener("abort", cancelPending, { once: true });
			state.clearPendingAbort = () => pendingSignal.removeEventListener("abort", cancelPending);
			if (pendingSignal.aborted) {
				keep = false;
				cancelPending();
			}
		}
		release({ keep });
	}
}
