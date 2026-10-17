import { WebSocket } from "ws";

interface PendingMessage {
	payload: string;
	bytes: number;
}

export class WebSocketWriter {
	private readonly socket: WebSocket;
	private readonly maxBytes: number;
	private readonly onBackpressure: (fields: {
		bufferedBytes: number;
		queuedBytes: number;
		payloadBytes: number;
	}) => void;
	private readonly onError: (error: Error) => void;
	private readonly pending = new Map<string | symbol, PendingMessage>();
	private queuedBytes = 0;
	private inFlightBytes = 0;
	private writing = false;
	private closed = false;

	constructor(
		socket: WebSocket,
		maxBytes: number,
		onBackpressure: WebSocketWriter["onBackpressure"],
		onError: WebSocketWriter["onError"],
	) {
		this.socket = socket;
		this.maxBytes = maxBytes;
		this.onBackpressure = onBackpressure;
		this.onError = onError;
		socket.on("close", () => this.clear());
	}

	get bufferedBytes(): number {
		return Math.max(this.socket.bufferedAmount, this.inFlightBytes) + this.queuedBytes;
	}

	send(payload: string, replacementKey?: string): void {
		if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
		const key = replacementKey ?? Symbol();
		const previous = this.pending.get(key);
		if (previous) {
			this.queuedBytes -= previous.bytes;
			this.pending.delete(key);
		}
		const bytes = Buffer.byteLength(payload);
		if (this.bufferedBytes + bytes > this.maxBytes) {
			this.onBackpressure({
				bufferedBytes: Math.max(this.socket.bufferedAmount, this.inFlightBytes),
				queuedBytes: this.queuedBytes,
				payloadBytes: bytes,
			});
			this.clear();
			this.socket.terminate();
			return;
		}
		// 只替换尚未发送的完整状态，并移到队尾；正文增量和结果事件始终按序保留。
		this.pending.set(key, { payload, bytes });
		this.queuedBytes += bytes;
		this.pump();
	}

	private pump(): void {
		if (this.closed || this.writing || this.socket.readyState !== WebSocket.OPEN) return;
		const next = this.pending.entries().next().value;
		if (!next) return;
		const [key, message] = next;
		this.pending.delete(key);
		this.queuedBytes -= message.bytes;
		this.writing = true;
		this.inFlightBytes = message.bytes;
		try {
			this.socket.send(message.payload, (error) => {
				this.writing = false;
				this.inFlightBytes = 0;
				if (error) {
					this.fail(error);
					return;
				}
				if (this.pending.size > 0) queueMicrotask(() => this.pump());
			});
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.onError(error);
		this.clear();
		this.socket.terminate();
	}

	private clear(): void {
		this.closed = true;
		this.pending.clear();
		this.queuedBytes = 0;
		this.inFlightBytes = 0;
	}
}
