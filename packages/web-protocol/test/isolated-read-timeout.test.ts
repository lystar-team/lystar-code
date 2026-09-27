import { describe, expect, it } from "vitest";
import { type ByteTransport, RuntimeProtocolClient, type RuntimeRequestDiagnostic } from "../src/client.ts";
import { ClientMessageDecoder, encodeServerMessage } from "../src/framing.ts";
import { RUNTIME_PROTOCOL_VERSION } from "../src/schemas.ts";

class SelectiveTransport implements ByteTransport {
	private readonly decoder = new ClientMessageDecoder();
	private readonly bytesListeners = new Set<(bytes: Uint8Array) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();
	blockedRequestId?: string;
	readonly queuedRequestIds: string[] = [];
	autoRespond = true;
	blockSend = false;
	closed = false;

	async send(bytes: Uint8Array): Promise<void> {
		for (const message of this.decoder.push(bytes)) {
			if (message.type !== "request") continue;
			if (this.blockSend) return new Promise<void>(() => {});
			if (!this.blockedRequestId) {
				this.blockedRequestId = message.id;
				continue;
			}
			if (this.autoRespond) queueMicrotask(() => this.respond(message.id));
			else this.queuedRequestIds.push(message.id);
		}
	}

	respond(id: string): void {
		this.emit(encodeServerMessage({ type: "response", id, ok: true, result: [] }));
	}

	emit(bytes: Uint8Array): void {
		for (const listener of this.bytesListeners) listener(bytes);
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const listener of this.closeListeners) listener();
	}

	onBytes(listener: (bytes: Uint8Array) => void): () => void {
		this.bytesListeners.add(listener);
		return () => this.bytesListeners.delete(listener);
	}

	onClose(listener: (error?: Error) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}
}

describe("只读请求超时", () => {
	it("已发送的读取超时不会关闭其他请求，迟到响应不会污染下一次读取", async () => {
		const transport = new SelectiveTransport();
		const diagnostics: RuntimeRequestDiagnostic[] = [];
		const client = new RuntimeProtocolClient(transport, "isolated-read", {
			onRequestDiagnostic: (record) => diagnostics.push(record),
		});
		await client.connect();
		transport.emit(
			encodeServerMessage({
				type: "hello",
				version: RUNTIME_PROTOCOL_VERSION,
				productVersion: "test",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				serverInstanceId: "server",
				hostInstanceId: "host",
				hostStartedAt: 1,
				capabilities: [],
			}),
		);
		transport.autoRespond = false;
		const stalled = client.request(
			{ command: "list_sessions", cwd: "/tmp" },
			{ timeoutMs: 10, keepConnectionOnTimeout: true },
		);
		const other = client.request({ command: "list_sessions", cwd: "/tmp" }, { timeoutMs: 1_000 });
		await expect(stalled).rejects.toThrow("超时");
		expect(transport.closed).toBe(false);
		expect(client.getSnapshot().connected).toBe(true);
		transport.respond(transport.queuedRequestIds[0]!);
		await expect(other).resolves.toEqual([]);
		transport.respond(transport.blockedRequestId!);
		transport.autoRespond = true;
		await expect(client.request({ command: "list_sessions", cwd: "/tmp" })).resolves.toEqual([]);
		expect(diagnostics.filter((record) => record.outcome === "timeout")).toHaveLength(1);
		expect(diagnostics.filter((record) => record.outcome === "ok")).toHaveLength(2);
		await client.close();
	});

	it("连接级只读策略生效，单次请求可覆盖该策略", async () => {
		const transport = new SelectiveTransport();
		const client = new RuntimeProtocolClient(transport, "read-policy", {
			keepConnectionOnRequestTimeout: (request) => request.command === "list_subagents",
		});
		await client.connect();
		await expect(
			client.request({ command: "list_subagents", sessionPath: "/session" }, { timeoutMs: 10 }),
		).rejects.toThrow("超时");
		expect(transport.closed).toBe(false);
		await client.close();

		const overrideTransport = new SelectiveTransport();
		const overrideClient = new RuntimeProtocolClient(overrideTransport, "read-override", {
			keepConnectionOnRequestTimeout: () => true,
		});
		await overrideClient.connect();
		await expect(
			overrideClient.request(
				{ command: "list_subagents", sessionPath: "/session" },
				{ timeoutMs: 10, keepConnectionOnTimeout: false },
			),
		).rejects.toThrow("超时");
		expect(overrideTransport.closed).toBe(true);
	});

	it("请求发送受阻时仍关闭连接", async () => {
		const transport = new SelectiveTransport();
		const client = new RuntimeProtocolClient(transport, "blocked-read");
		await client.connect();
		transport.blockSend = true;
		await expect(
			client.request({ command: "list_sessions", cwd: "/tmp" }, { timeoutMs: 10, keepConnectionOnTimeout: true }),
		).rejects.toThrow("超时");
		expect(transport.closed).toBe(true);
	});
});
