import type { Readable, Writable } from "node:stream";
import { ClientMessageDecoder, encodeTrustedServerMessage, type ServerMessage } from "@lystar/code-web-protocol";
import type { WebRuntimeService } from "./service.ts";

export function writeBounded(stream: Writable, bytes: Uint8Array): Promise<void> {
	try {
		if (stream.write(bytes)) return Promise.resolve();
	} catch (error) {
		return Promise.reject(error instanceof Error ? error : new Error(String(error)));
	}
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			stream.off("drain", onDrain);
			stream.off("error", onError);
		};
		const onDrain = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		stream.once("drain", onDrain);
		stream.once("error", onError);
	});
}

export function createBoundedWriter(stream: Writable): (bytes: Uint8Array) => Promise<void> {
	let queue = Promise.resolve();
	let failure: Error | undefined;
	return (bytes) => {
		if (failure) return Promise.reject(failure);
		const write = queue.then(() => {
			if (failure) throw failure;
			return writeBounded(stream, bytes);
		});
		queue = write.catch((error) => {
			failure = error instanceof Error ? error : new Error(String(error));
		});
		return write;
	};
}

export async function runRuntimeStream(service: WebRuntimeService, input: Readable, output: Writable): Promise<void> {
	const write = createBoundedWriter(output);
	const connection = service.createConnection((message: ServerMessage) => write(encodeTrustedServerMessage(message)));
	const decoder = new ClientMessageDecoder();
	let processing = Promise.resolve();
	const controlMessages = new Set<Promise<void>>();
	let streamError: Error | undefined;
	try {
		input.on("data", (chunk: Buffer) => {
			try {
				for (const message of decoder.push(chunk)) {
					if (message.type === "ui_response") {
						const task = connection.handle(message).catch((error) => {
							streamError = error instanceof Error ? error : new Error(String(error));
							input.destroy(streamError);
						});
						controlMessages.add(task);
						void task.finally(() => controlMessages.delete(task));
					} else {
						processing = processing.then(() => connection.handle(message));
					}
				}
			} catch (error) {
				streamError = error instanceof Error ? error : new Error(String(error));
				input.destroy(streamError);
			}
		});
		await new Promise<void>((resolve, reject) => {
			input.once("end", resolve);
			input.once("close", resolve);
			input.once("error", reject);
		});
		decoder.end();
		await processing;
		await Promise.all(controlMessages);
		if (streamError) throw streamError;
	} finally {
		await connection.close();
	}
}
