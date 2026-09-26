import { describe, expect, it } from "vitest";
import { type ByteTransport, RuntimeProtocolClient, type RuntimeRequestDiagnostic } from "../src/client.ts";
import { ClientMessageDecoder, encodeServerMessage } from "../src/framing.ts";

class DiagnosticTransport implements ByteTransport {
	private readonly decoder = new ClientMessageDecoder();
	private readonly bytesListeners = new Set<(bytes: Uint8Array) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();
	respond = true;

	async send(bytes: Uint8Array): Promise<void> {
		for (const message of this.decoder.push(bytes)) {
			if (message.type !== "request" || !this.respond) continue;
			queueMicrotask(() => {
				for (const listener of this.bytesListeners)
					listener(encodeServerMessage({ type: "response", id: message.id, ok: true, result: {} }));
			});
		}
	}
	async close(): Promise<void> {
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

describe("Runtime 请求诊断", () => {
	it("同一请求记录开始、结果与关联 ID", async () => {
		const records: RuntimeRequestDiagnostic[] = [];
		const client = new RuntimeProtocolClient(new DiagnosticTransport(), "diagnostic-client", {
			trustedServerMessages: true,
			onRequestDiagnostic: (record) => records.push(record),
		});
		await client.connect();
		await client.request({ command: "get_snapshot" });
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			clientInstanceId: "diagnostic-client",
			command: "get_snapshot",
			phase: "start",
		});
		expect(records[1]).toMatchObject({ requestId: records[0].requestId, phase: "end", outcome: "ok" });
		expect(records[1].elapsedMs).toBeGreaterThanOrEqual(0);
		await client.close();
	});

	it("超时只记录一次，后续请求记为连接断开", async () => {
		const transport = new DiagnosticTransport();
		transport.respond = false;
		const records: RuntimeRequestDiagnostic[] = [];
		const client = new RuntimeProtocolClient(transport, "timeout-client", {
			onRequestDiagnostic: (record) => records.push(record),
		});
		await client.connect();
		const first = client.request({ command: "get_snapshot" }, { timeoutMs: 10 });
		const second = client.request({ command: "list_models" }, { timeoutMs: 100 });
		const failures = Promise.allSettled([first, second]);
		expect((await failures).map((result) => result.status)).toEqual(["rejected", "rejected"]);
		expect(records.filter((record) => record.phase === "end")).toEqual([
			expect.objectContaining({ command: "get_snapshot", outcome: "timeout", errorCode: "request_timeout" }),
			expect.objectContaining({ command: "list_models", outcome: "disconnected" }),
		]);
		await client.close();
	});
});
