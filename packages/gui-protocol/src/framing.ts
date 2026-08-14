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

export const GUI_MAX_FRAME_LENGTH = 16 * 1024 * 1024;

export class GuiProtocolValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GuiProtocolValidationError";
	}
}

export function parseClientMessage(value: unknown): ClientMessage {
	if (!Check(ClientMessageSchema, value)) throw new GuiProtocolValidationError("Invalid GUI client message");
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
		throw new GuiProtocolValidationError(`Invalid GUI server message (${kind}${details ? `; ${details}` : ""})`);
	}
	return value;
}

function encodeMessage(value: unknown, parse: (candidate: unknown) => unknown): Uint8Array {
	const validated = parse(value);
	return encodeFrame(encodeCbor(validated, { maxByteLength: GUI_MAX_FRAME_LENGTH }));
}

export function encodeClientMessage(message: ClientMessage): Uint8Array {
	return encodeMessage(message, parseClientMessage);
}

export function encodeServerMessage(message: ServerMessage): Uint8Array {
	return encodeMessage(message, parseServerMessage);
}

class GuiMessageDecoder<T> {
	private readonly frames: FrameDecoder;
	private readonly parse: (value: unknown) => T;
	private failed = false;

	constructor(parse: (value: unknown) => T, options: FrameDecoderOptions = { maxFrameLength: GUI_MAX_FRAME_LENGTH }) {
		this.parse = parse;
		this.frames = new FrameDecoder({
			maxFrameLength: Math.min(options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH, GUI_MAX_FRAME_LENGTH),
		});
	}

	push(chunk: Uint8Array): T[] {
		if (this.failed) throw new GuiProtocolValidationError("GUI message decoder has failed");
		try {
			return this.frames
				.push(chunk)
				.map((frame) => this.parse(decodeCbor(frame, { maxByteLength: GUI_MAX_FRAME_LENGTH })));
		} catch (error) {
			this.failed = true;
			throw error;
		}
	}

	end(): void {
		this.frames.end();
	}
}

export class ClientMessageDecoder extends GuiMessageDecoder<ClientMessage> {
	constructor(options?: FrameDecoderOptions) {
		super(parseClientMessage, options);
	}
}

export class ServerMessageDecoder extends GuiMessageDecoder<ServerMessage> {
	constructor(options?: FrameDecoderOptions) {
		super(parseServerMessage, options);
	}
}
