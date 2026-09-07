import type { Readable, Writable } from "node:stream";
import { ClientMessageDecoder, encodeTrustedServerMessage, type ServerMessage } from "@lystar/code-web-protocol";
import type { WebRuntimeService } from "./service.ts";

export const MAX_RUNTIME_WRITE_BYTES = 32 * 1024 * 1024;
const WRITE_TIMEOUT_MS = 10_000;

export function writeBounded(stream: Writable, bytes: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		if (stream.destroyed || !stream.writable) {
			reject(new Error("Runtime 输出连接已关闭"));
			return;
		}
		const finish = (error?: Error) => {
			clearTimeout(timer);
			stream.off("drain", onDrain);
			stream.off("error", onError);
			stream.off("close", onClose);
			if (error) reject(error);
			else resolve();
		};
		const onDrain = () => finish();
		const onError = (error: Error) => finish(error);
		const onClose = () => finish(new Error("Runtime 输出连接已关闭"));
		const timer = setTimeout(() => finish(new Error("Runtime 输出连接发送超时")), WRITE_TIMEOUT_MS);
		timer.unref?.();
		stream.once("drain", onDrain);
		stream.once("error", onError);
		stream.once("close", onClose);
		try {
			if (stream.write(bytes)) finish();
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

export function createBoundedWriter(stream: Writable): (bytes: Uint8Array) => Promise<void> {
	const queue: Array<{ bytes: Uint8Array; resolve(): void; reject(error: Error): void }> = [];
	let queuedBytes = 0;
	let writing = false;
	let failure: Error | undefined;
	const fail = (error: Error) => {
		if (failure) return;
		failure = error;
		for (const entry of queue.splice(0)) entry.reject(error);
		queuedBytes = 0;
		stream.destroy(error);
	};
	stream.on("error", fail);
	stream.once("close", () => {
		fail(new Error("Runtime 输出连接已关闭"));
		stream.off("error", fail);
	});
	const pump = async () => {
		if (writing) return;
		writing = true;
		try {
			while (!failure && queue.length > 0) {
				const entry = queue[0];
				await writeBounded(stream, entry.bytes);
				if (failure) break;
				queue.shift();
				queuedBytes -= entry.bytes.byteLength;
				entry.resolve();
			}
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		} finally {
			writing = false;
		}
	};
	return (bytes) => {
		if (failure) return Promise.reject(failure);
		if (queuedBytes + bytes.byteLength > MAX_RUNTIME_WRITE_BYTES) {
			fail(new Error("Runtime 输出队列超过大小限制，需要重新同步"));
			return Promise.reject(failure);
		}
		const result = new Promise<void>((resolve, reject) => {
			queue.push({ bytes, resolve, reject });
			queuedBytes += bytes.byteLength;
		});
		void pump();
		return result;
	};
}

export async function runRuntimeStream(service: WebRuntimeService, input: Readable, output: Writable): Promise<void> {
	const write = createBoundedWriter(output);
	const connection = service.createConnection((message: ServerMessage) => write(encodeTrustedServerMessage(message)));
	const decoder = new ClientMessageDecoder();
	let processing = Promise.resolve();
	let queuedRequests = 0;
	let queuedBytes = 0;
	let closed = false;
	const fail = (error: unknown) => {
		input.destroy(error instanceof Error ? error : new Error(String(error)));
	};
	const onData = (chunk: Buffer) => {
		try {
			for (const message of decoder.push(chunk)) {
				const byteLength = Buffer.byteLength(JSON.stringify(message));
				queuedBytes += byteLength;
				if (++queuedRequests > 128 || queuedBytes > MAX_RUNTIME_WRITE_BYTES)
					throw new Error("Runtime 输入队列超过限制");
				const handle = async () => {
					try {
						if (!closed) await connection.handle(message);
					} finally {
						queuedRequests--;
						queuedBytes -= byteLength;
					}
				};
				if (message.type === "ui_response") void handle().catch(fail);
				else processing = processing.then(handle).catch(fail);
			}
		} catch (error) {
			fail(error);
		}
	};
	try {
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				input.off("end", onEnd);
				input.off("close", onClose);
				input.off("error", onError);
			};
			const onEnd = () => {
				try {
					decoder.end();
					void processing.then(() => {
						cleanup();
						resolve();
					}, onError);
				} catch (error) {
					onError(error instanceof Error ? error : new Error(String(error)));
				}
			};
			const onClose = () => {
				cleanup();
				resolve();
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			input.on("data", onData);
			input.once("end", onEnd);
			input.once("close", onClose);
			input.once("error", onError);
		});
	} finally {
		closed = true;
		input.off("data", onData);
		await connection.close();
	}
}
