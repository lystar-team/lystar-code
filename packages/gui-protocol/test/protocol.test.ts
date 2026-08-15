import { describe, expect, it } from "vitest";
import {
	type ByteTransport,
	ClientMessageDecoder,
	encodeClientMessage,
	encodeServerMessage,
	GUI_PROTOCOL_VERSION,
	GuiProtocolClient,
	ServerMessageDecoder,
} from "../src/index.ts";

class MemoryTransport implements ByteTransport {
	peer?: MemoryTransport;
	sendCount = 0;
	private bytesListeners = new Set<(bytes: Uint8Array) => void>();
	private closeListeners = new Set<(error?: Error) => void>();

	async send(bytes: Uint8Array): Promise<void> {
		this.sendCount++;
		for (const listener of this.peer?.bytesListeners ?? []) listener(bytes);
	}
	disconnect(error?: Error): void {
		for (const listener of this.closeListeners) listener(error);
	}
	async close(): Promise<void> {
		this.disconnect();
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

describe("GUI Protocol v1", () => {
	it("decodes fragmented and coalesced framed messages", () => {
		const first = encodeClientMessage({ type: "hello", version: GUI_PROTOCOL_VERSION, clientInstanceId: "client" });
		const second = encodeClientMessage({ type: "request", id: "1", request: { command: "get_snapshot" } });
		const wire = new Uint8Array(first.length + second.length);
		wire.set(first);
		wire.set(second, first.length);
		const decoder = new ClientMessageDecoder();
		const messages = [...decoder.push(wire.subarray(0, 7)), ...decoder.push(wire.subarray(7))];
		expect(messages.map((message) => message.type)).toEqual(["hello", "request"]);
	});

	it("tracks snapshots, operation order, and transcript gaps", async () => {
		const clientTransport = new MemoryTransport();
		const serverTransport = new MemoryTransport();
		clientTransport.peer = serverTransport;
		serverTransport.peer = clientTransport;
		const serverDecoder = new ClientMessageDecoder();
		serverTransport.onBytes((bytes) => serverDecoder.push(bytes));
		const client = new GuiProtocolClient(clientTransport, "client");
		await client.connect();
		const disconnectedSnapshot = client.getSnapshot();
		await serverTransport.send(
			encodeServerMessage({
				type: "hello",
				version: GUI_PROTOCOL_VERSION,
				productVersion: "test",
				protocolVersion: GUI_PROTOCOL_VERSION,
				serverInstanceId: "server",
				hostInstanceId: "host",
				hostStartedAt: 1,
				capabilities: ["operation-journal"],
			}),
		);
		const operation = {
			operationId: "op",
			clientInstanceId: "client",
			clientRequestId: "request",
			sessionPath: "/tmp/session.jsonl",
			type: "prompt",
			status: "running" as const,
			acceptedAt: 1,
			updatedAt: 2,
			payloadHash: "hash",
		};
		await serverTransport.send(
			encodeServerMessage({ type: "event", event: { type: "operation_updated", operation } }),
		);
		await serverTransport.send(
			encodeServerMessage({
				type: "event",
				event: {
					type: "session_snapshot",
					snapshot: {
						id: "session",
						path: "/tmp/session.jsonl",
						cwd: "/tmp",
						createdAt: 1,
						updatedAt: 1,
						phase: "idle",
						thinkingLevel: "off",
						attached: true,
						writeAccess: "owned",
						revision: 1,
						leafId: null,
						queuedSteerCount: 0,
						transcriptGeneration: "generation",
						transcriptRevision: 0,
					},
				},
			}),
		);
		await serverTransport.send(
			encodeServerMessage({
				type: "event",
				event: { type: "operation_updated", operation: { ...operation, status: "accepted", updatedAt: 1 } },
			}),
		);
		expect(client.getSnapshot().connected).toBe(true);
		expect(client.getSnapshot()).not.toBe(disconnectedSnapshot);
		expect(client.getSnapshot().operations.get("op")?.status).toBe("running");

		await serverTransport.send(
			encodeServerMessage({
				type: "event",
				event: {
					type: "transcript_committed",
					sessionPath: "/tmp/session.jsonl",
					transcriptGeneration: "generation",
					fromRevision: 0,
					toRevision: 1,
					items: [],
				},
			}),
		);
		expect(client.getSnapshot().transcripts.get("/tmp/session.jsonl")).toEqual({
			generation: "generation",
			revision: 1,
			stale: false,
		});
		await serverTransport.send(
			encodeServerMessage({
				type: "event",
				event: {
					type: "transcript_committed",
					sessionPath: "/tmp/session.jsonl",
					transcriptGeneration: "generation",
					fromRevision: 3,
					toRevision: 4,
					items: [],
				},
			}),
		);
		expect(client.getSnapshot().transcripts.get("/tmp/session.jsonl")?.stale).toBe(true);
		await serverTransport.send(
			encodeServerMessage({
				type: "event",
				event: { type: "session_removed", sessionPath: "/tmp/session.jsonl" },
			}),
		);
		expect(client.getSnapshot().sessions.has("/tmp/session.jsonl")).toBe(false);
		expect(client.getSnapshot().transcripts.has("/tmp/session.jsonl")).toBe(false);
	});

	it("fails pending input on disconnect without resending it", async () => {
		const clientTransport = new MemoryTransport();
		const serverTransport = new MemoryTransport();
		clientTransport.peer = serverTransport;
		serverTransport.peer = clientTransport;
		const received = new ClientMessageDecoder();
		const requests: unknown[] = [];
		serverTransport.onBytes((bytes) => requests.push(...received.push(bytes)));
		const client = new GuiProtocolClient(clientTransport, "client");
		await client.connect();
		const pending = client.request({ command: "get_snapshot" });
		clientTransport.disconnect(new Error("connection lost"));

		await expect(pending).rejects.toThrow("connection lost");
		expect(requests).toHaveLength(2);
		expect(clientTransport.sendCount).toBe(2);
		expect(client.getSnapshot().connected).toBe(false);
	});

	it("removes a request when the host does not respond before its deadline", async () => {
		const clientTransport = new MemoryTransport();
		const serverTransport = new MemoryTransport();
		clientTransport.peer = serverTransport;
		serverTransport.peer = clientTransport;
		const client = new GuiProtocolClient(clientTransport, "client");
		await client.connect();

		await expect(
			client.request({ command: "get_snapshot" }, { timeoutMs: 5, timeoutMessage: "项目后台响应超时" }),
		).rejects.toThrow("项目后台响应超时");
		clientTransport.disconnect(new Error("late disconnect"));
		expect(client.getSnapshot().connected).toBe(false);
	});

	it("decodes a readable version error", () => {
		const [message] = new ServerMessageDecoder().push(
			encodeServerMessage({
				type: "hello_error",
				error: { code: "version", message: "GUI Protocol 2 is unsupported", retryable: false },
			}),
		);
		expect(message).toEqual({
			type: "hello_error",
			error: { code: "version", message: "GUI Protocol 2 is unsupported", retryable: false },
		});
	});

	it("reports the invalid server message kind without serializing its values", () => {
		expect(() =>
			encodeServerMessage({
				type: "event",
				event: { type: "operation_updated", operation: {} },
			} as never),
		).toThrow("Invalid GUI server message (event:operation_updated");
	});

	it("strictly decodes model, project, completion, and resource commands", () => {
		const decoder = new ClientMessageDecoder();
		const messages = [
			{
				type: "request",
				id: "login",
				request: { command: "login_model_provider", provider: "openai", authType: "api_key" },
			},
			{ type: "request", id: "connections", request: { command: "get_connection_status" } },
			{ type: "request", id: "updates", request: { command: "check_for_updates" } },
			{ type: "request", id: "inspect", request: { command: "inspect_session", sessionPath: "/tmp/session.jsonl" } },
			{
				type: "request",
				id: "instructions",
				request: { command: "list_project_instructions", cwd: "/tmp/project" },
			},
			{
				type: "request",
				id: "completion",
				request: { command: "get_completions", cwd: "/tmp/project", text: "@src", cursor: 4 },
			},
			{
				type: "request",
				id: "resource",
				request: { command: "resolve_project_resource", cwd: "/tmp/project", target: "src/app.ts:12" },
			},
		] as const;
		for (const message of messages) expect(decoder.push(encodeClientMessage(message))).toEqual([message]);
		const event = {
			type: "event",
			event: { type: "sessions_changed", cwd: "/tmp/project" },
		} as const;
		expect(new ServerMessageDecoder().push(encodeServerMessage(event))).toEqual([event]);
		expect(() =>
			encodeClientMessage({
				type: "request",
				id: "invalid",
				request: {
					command: "login_model_provider",
					provider: "openai",
					authType: "password" as "api_key",
				},
			}),
		).toThrow();
	});
});
