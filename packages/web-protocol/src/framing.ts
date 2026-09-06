import {
	DEFAULT_MAX_FRAME_LENGTH,
	decodeCbor,
	encodeCbor,
	encodeFrame,
	FrameDecoder,
	type FrameDecoderOptions,
} from "@earendil-works/pi-protocol";
import { Check, Errors } from "typebox/value";
import {
	type ClientMessage,
	ClientMessageSchema,
	EventEnvelopeSchema,
	ResponseEnvelopeSchema,
	ServerHelloErrorSchema,
	ServerHelloSchema,
	type ServerMessage,
	ServerMessageSchema,
} from "./schemas.ts";

export const RUNTIME_MAX_FRAME_LENGTH = 16 * 1024 * 1024;

export class RuntimeProtocolValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeProtocolValidationError";
	}
}

export function parseClientMessage(value: unknown): ClientMessage {
	if (!Check(ClientMessageSchema, value)) throw new RuntimeProtocolValidationError("Invalid Web client message");
	return value;
}

export function parseServerMessage(value: unknown): ServerMessage {
	if (!Check(ServerMessageSchema, value)) {
		const candidate =
			value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
		const schema =
			candidate.type === "hello"
				? ServerHelloSchema
				: candidate.type === "hello_error"
					? ServerHelloErrorSchema
					: candidate.type === "response"
						? ResponseEnvelopeSchema
						: candidate.type === "event"
							? EventEnvelopeSchema
							: ServerMessageSchema;
		const details = [...Errors(schema, value)]
			.filter((error) => error.instancePath !== "/type" && error.instancePath !== "/event/type")
			.slice(-3)
			.map((error) => `${error.instancePath || "/"}: ${error.message}`)
			.join("; ");
		const kind =
			candidate.type === "event" && candidate.event && typeof candidate.event === "object"
				? `event:${String((candidate.event as Record<string, unknown>).type)}`
				: String(candidate.type ?? "unknown");
		throw new RuntimeProtocolValidationError(
			`Invalid Web Runtime server message (${kind}${details ? `; ${details}` : ""})`,
		);
	}
	return value;
}

export function parseTrustedServerMessage(value: unknown): ServerMessage {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new RuntimeProtocolValidationError("Invalid trusted Web Runtime server message");
	const candidate = value as Record<string, unknown>;
	if (
		candidate.type !== "hello" &&
		candidate.type !== "hello_error" &&
		candidate.type !== "response" &&
		candidate.type !== "event"
	)
		throw new RuntimeProtocolValidationError("Invalid trusted Web Runtime server message type");
	if (candidate.type === "response" && typeof candidate.id !== "string")
		throw new RuntimeProtocolValidationError("Invalid trusted Web Runtime response envelope");
	if (candidate.type === "event") {
		const event = candidate.event;
		if (
			!event ||
			typeof event !== "object" ||
			Array.isArray(event) ||
			typeof (event as Record<string, unknown>).type !== "string"
		)
			throw new RuntimeProtocolValidationError("Invalid trusted Web Runtime event envelope");
	}
	return value as ServerMessage;
}

function encodeFramedMessage(value: unknown): Uint8Array {
	return encodeFrame(encodeCbor(value, { maxByteLength: RUNTIME_MAX_FRAME_LENGTH }));
}

function encodeMessage(value: unknown, parse: (candidate: unknown) => unknown): Uint8Array {
	return encodeFramedMessage(parse(value));
}

export function encodeClientMessage(message: ClientMessage): Uint8Array {
	return encodeMessage(message, parseClientMessage);
}

export function encodeServerMessage(message: ServerMessage): Uint8Array {
	return encodeMessage(message, parseServerMessage);
}

// Web Runtime 输出由 TypeScript 合同构造；接收端仍会完整校验跨进程消息。
export function encodeTrustedServerMessage(message: ServerMessage): Uint8Array {
	return encodeFramedMessage(message);
}

class RuntimeMessageDecoder<T> {
	private readonly frames: FrameDecoder;
	private readonly parse: (value: unknown) => T;
	private failed = false;

	constructor(
		parse: (value: unknown) => T,
		options: FrameDecoderOptions = { maxFrameLength: RUNTIME_MAX_FRAME_LENGTH },
	) {
		this.parse = parse;
		this.frames = new FrameDecoder({
			maxFrameLength: Math.min(options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH, RUNTIME_MAX_FRAME_LENGTH),
		});
	}

	push(chunk: Uint8Array): T[] {
		if (this.failed) throw new RuntimeProtocolValidationError("Web Runtime message decoder has failed");
		try {
			return this.frames
				.push(chunk)
				.map((frame) => this.parse(decodeCbor(frame, { maxByteLength: RUNTIME_MAX_FRAME_LENGTH })));
		} catch (error) {
			this.failed = true;
			throw error;
		}
	}

	end(): void {
		this.frames.end();
	}
}

export class ClientMessageDecoder extends RuntimeMessageDecoder<ClientMessage> {
	constructor(options?: FrameDecoderOptions) {
		super(parseClientMessage, options);
	}
}

export class ServerMessageDecoder extends RuntimeMessageDecoder<ServerMessage> {
	constructor(options?: FrameDecoderOptions) {
		super(parseServerMessage, options);
	}
}

export class TrustedServerMessageDecoder extends RuntimeMessageDecoder<ServerMessage> {
	constructor(options?: FrameDecoderOptions) {
		super(parseTrustedServerMessage, options);
	}
}
