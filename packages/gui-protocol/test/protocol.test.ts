import { encodeCbor, encodeFrame } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import {
	assertWorkspaceCommandResult,
	type ByteTransport,
	ClientMessageDecoder,
	encodeClientMessage,
	encodeServerMessage,
	encodeTrustedServerMessage,
	GUI_PROTOCOL_VERSION,
	GuiProtocolClient,
	isDiagnostics,
	ServerMessageDecoder,
	WorkspaceCommandResultSchemas,
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
	it("decodes trusted Host frames with the normal server validator", () => {
		const message = {
			type: "response",
			id: "trusted",
			ok: true,
			result: { items: Array.from({ length: 200 }, (_, index) => ({ index, text: `needle ${index}` })) },
		} as const;
		expect(new ServerMessageDecoder().push(encodeTrustedServerMessage(message))).toEqual([message]);
		expect(encodeTrustedServerMessage(message)).toEqual(encodeServerMessage(message));
	});

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
						activity: "idle",
						thinkingLevel: "off",
						attached: true,
						writeAccess: "owned",
						revision: 1,
						leafId: null,
						queuedSteerCount: 0,
						queuedFollowUpCount: 0,
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

	it("accepts optional diff facts in session progress", () => {
		const message = {
			type: "event" as const,
			event: {
				type: "session_progress" as const,
				sessionPath: "/tmp/session.jsonl",
				progress: {
					type: "tool_end" as const,
					toolCallId: "edit-1",
					name: "edit",
					status: "success" as const,
					summary: "已编辑",
					diff: {
						files: [
							{
								path: "src/app.ts",
								additions: 1,
								deletions: 1,
								diff: "--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new",
							},
						],
					},
				},
			},
		};
		expect(new ServerMessageDecoder().push(encodeServerMessage(message))).toEqual([message]);
	});

	it("accepts structured compaction progress", () => {
		const message = {
			type: "event" as const,
			event: {
				type: "session_progress" as const,
				sessionPath: "/tmp/session.jsonl",
				progress: {
					type: "compaction" as const,
					status: "waiting_retry" as const,
					reason: "threshold" as const,
					error: "temporary",
				},
			},
		};
		expect(new ServerMessageDecoder().push(encodeServerMessage(message))).toEqual([message]);
	});

	it("accepts structured retry progress", () => {
		const message = {
			type: "event" as const,
			event: {
				type: "session_progress" as const,
				sessionPath: "/tmp/session.jsonl",
				progress: {
					type: "retry" as const,
					status: "waiting" as const,
					kind: "model" as const,
					attempt: 2,
					maxAttempts: 3,
					delayMs: 1500,
					error: "temporary",
				},
			},
		};
		expect(new ServerMessageDecoder().push(encodeServerMessage(message))).toEqual([message]);
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

	it("accepts legacy diagnostics and optional recovery fields", () => {
		expect(isDiagnostics({ checks: [], platform: "linux", arch: "x64" })).toBe(true);
		expect(
			isDiagnostics({
				checks: [],
				recovery: { sessionActive: false, activeCircuits: 0, metrics: {} },
				lessons: {
					available: false,
					counts: { candidate: 0, verified: 0, active: 0, disabled: 0, expired: 0 },
					error: { code: "lesson_store_corrupt" },
				},
			}),
		).toBe(true);
	});

	it("keeps client hello version validation in the handshake while server messages reject incompatible versions", () => {
		const fraction = {
			type: "response" as const,
			id: "fraction",
			ok: true as const,
			result: { value: 1.5 },
		};
		expect(new ServerMessageDecoder().push(encodeServerMessage(fraction))).toEqual([fraction]);
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(() => encodeServerMessage({ ...fraction, result: { value } } as never)).toThrow();
		}
		for (const version of [0, 2]) {
			const hello = { type: "hello" as const, version, clientInstanceId: "client" };
			expect(new ClientMessageDecoder().push(encodeClientMessage(hello))).toEqual([hello]);
		}
	});

	it("rejects missing and unknown fields during decode", () => {
		const unchecked = (value: unknown) => encodeFrame(encodeCbor(value));
		for (const value of [
			{ type: "hello", version: 1 },
			{ type: "hello", version: 1, clientInstanceId: "client", extra: true },
		]) {
			expect(() => new ClientMessageDecoder().push(unchecked(value))).toThrow();
		}
		for (const value of [
			{
				type: "hello",
				version: 0,
				protocolVersion: 1,
				productVersion: "test",
				serverInstanceId: "server",
				hostInstanceId: "host",
				hostStartedAt: 0,
				capabilities: [],
			},
			{
				type: "hello",
				version: 1,
				protocolVersion: 2,
				productVersion: "test",
				serverInstanceId: "server",
				hostInstanceId: "host",
				hostStartedAt: 0,
				capabilities: [],
			},
			{
				type: "hello",
				version: 1,
				protocolVersion: 1,
				serverInstanceId: "server",
				hostInstanceId: "host",
				hostStartedAt: 0,
				capabilities: [],
			},
			{ type: "event", event: { type: "sessions_changed", cwd: "/tmp", extra: true } },
		]) {
			expect(() => new ServerMessageDecoder().push(unchecked(value))).toThrow();
		}
	});

	it("strictly decodes transcript search commands and rejects blank queries or excess limits", () => {
		const decoder = new ClientMessageDecoder();
		const valid = {
			type: "request",
			id: "search",
			request: { command: "search_transcript", sessionPath: "/tmp/session.jsonl", query: "needle", limit: 100 },
		} as const;
		expect(decoder.push(encodeClientMessage(valid))).toEqual([valid]);
		for (const request of [
			{ command: "search_transcript", sessionPath: "/tmp/session.jsonl", query: "", limit: 1 },
			{ command: "search_transcript", sessionPath: "/tmp/session.jsonl", query: "needle", limit: 101 },
		]) {
			expect(() => encodeClientMessage({ type: "request", id: "invalid-search", request } as never)).toThrow();
		}
	});

	it("rejects Workspace oversized clipboard, tree, package, and settings payloads", () => {
		const decoder = new ClientMessageDecoder();
		expect(() =>
			decoder.push(
				encodeClientMessage({
					type: "request",
					id: "clipboard-overflow",
					request: {
						command: "write_clipboard_text",
						text: "x".repeat(1024 * 1024 + 1),
						clientInstanceId: "client",
						clientRequestId: "overflow",
					},
				}),
			),
		).toThrow();
		expect(() =>
			assertWorkspaceCommandResult(
				"get_session_tree",
				Array.from({ length: 10_001 }, () => ({})),
			),
		).toThrow();
		expect(() =>
			assertWorkspaceCommandResult(
				"list_packages",
				Array.from({ length: 1001 }, () => ({})),
			),
		).toThrow();
		expect(() =>
			assertWorkspaceCommandResult(
				"list_settings",
				Array.from({ length: 1001 }, () => ({})),
			),
		).toThrow();
		expect(WorkspaceCommandResultSchemas.write_clipboard_text).toBeDefined();
		expect(() =>
			assertWorkspaceCommandResult("copy_last_assistant_message", { capability: true, copied: true }),
		).not.toThrow();
		expect(() =>
			assertWorkspaceCommandResult("copy_last_assistant_message", {
				capability: true,
				copied: true,
				text: "secret",
			}),
		).toThrow();
	});

	it("keeps login results as strict model projections without credentials", () => {
		const result = [
			{
				provider: "faux",
				id: "test",
				name: "Faux Test",
				api: "openai-completions",
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				supportedThinkingLevels: ["off"],
				authenticated: true,
				authMethods: ["api_key", "oauth"],
			},
		];
		expect(() => assertWorkspaceCommandResult("login_model_provider", result)).not.toThrow();
		expect(() =>
			assertWorkspaceCommandResult("login_model_provider", [
				{ method: "bearer-token", secret: "credential-secret" },
			]),
		).toThrow("不符合协议");
	});

	it("accepts journaled session exports and validates their result", () => {
		const message = {
			type: "request" as const,
			id: "export",
			request: {
				command: "export_session" as const,
				sessionPath: "/tmp/session.jsonl",
				leaseId: "lease",
				clientInstanceId: "client",
				clientRequestId: "export-1",
				outputPath: "session export.html",
			},
		};
		expect(new ClientMessageDecoder().push(encodeClientMessage(message))).toEqual([message]);
		expect(() => assertWorkspaceCommandResult("export_session", { path: "session export.html" })).not.toThrow();
		expect(() =>
			assertWorkspaceCommandResult("export_session", { path: "session export.html", extra: true }),
		).toThrow();
	});

	it("strictly decodes rendered changelog requests and results", () => {
		const message = {
			type: "request" as const,
			id: "changelog",
			request: {
				command: "get_changelog" as const,
				sessionPath: "/tmp/session.jsonl",
				width: 92,
			},
		};
		expect(new ClientMessageDecoder().push(encodeClientMessage(message))).toEqual([message]);
		expect(() =>
			assertWorkspaceCommandResult("get_changelog", { lines: ["release notes"], contentHash: "hash" }),
		).not.toThrow();
		expect(() =>
			assertWorkspaceCommandResult("get_changelog", {
				lines: ["release notes"],
				contentHash: "hash",
				markdown: "raw",
			}),
		).toThrow();
	});

	it("strictly decodes session import requests", () => {
		const message = {
			type: "request" as const,
			id: "import",
			request: {
				command: "import_session" as const,
				sessionPath: "/tmp/current.jsonl",
				leaseId: "lease",
				clientInstanceId: "client",
				clientRequestId: "import-1",
				inputPath: "path with spaces/session.jsonl",
				cwdOverride: "/work/project",
			},
		};
		expect(new ClientMessageDecoder().push(encodeClientMessage(message))).toEqual([message]);
		expect(() =>
			encodeClientMessage({
				...message,
				request: { ...message.request, inputPath: "" },
			}),
		).toThrow();
	});

	it("strictly decodes session share requests", () => {
		const message = {
			type: "request" as const,
			id: "share",
			request: {
				command: "share_session" as const,
				sessionPath: "/tmp/current.jsonl",
				leaseId: "lease",
				clientInstanceId: "client",
				clientRequestId: "share-1",
			},
		};
		expect(new ClientMessageDecoder().push(encodeClientMessage(message))).toEqual([message]);
	});

	it("strictly decodes resource reload requests and snapshot results", () => {
		const message = {
			type: "request" as const,
			id: "reload",
			request: {
				command: "reload_resources" as const,
				sessionPath: "/tmp/current.jsonl",
				leaseId: "lease",
				clientInstanceId: "client",
				clientRequestId: "reload-1",
			},
		};
		expect(new ClientMessageDecoder().push(encodeClientMessage(message))).toEqual([message]);
		expect(() =>
			encodeClientMessage({
				...message,
				request: { ...message.request, leaseId: undefined },
			} as never),
		).toThrow();
		expect(() =>
			assertWorkspaceCommandResult("reload_resources", {
				id: "session",
				path: "/tmp/current.jsonl",
				cwd: "/tmp",
				createdAt: 1,
				updatedAt: 2,
				phase: "idle",
				activity: "idle",
				thinkingLevel: "off",
				attached: true,
				writeAccess: "owned",
				revision: 2,
				leafId: null,
				queuedSteerCount: 0,
				queuedFollowUpCount: 0,
				transcriptGeneration: "generation",
				transcriptRevision: 0,
			}),
		).not.toThrow();
	});

	it("strictly decodes session information requests and results", () => {
		const message = {
			type: "request" as const,
			id: "session-info",
			request: {
				command: "get_session_info" as const,
				sessionPath: "/tmp/current.jsonl",
				leaseId: "lease",
			},
		};
		const result = {
			name: "当前会话",
			sessionFile: "/tmp/current.jsonl",
			sessionId: "session",
			messages: { total: 4, user: 1, agent: 1, toolCalls: 1, toolResults: 1 },
			tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, total: 180 },
			cost: 0.125,
			usageBreakdown: [{ key: "faux/model", cost: 0.125, tokens: 180 }],
			cacheWaste: { missedTokens: 2048, missedCost: 0.01, missCount: 1 },
		};

		expect(new ClientMessageDecoder().push(encodeClientMessage(message))).toEqual([message]);
		expect(() =>
			encodeClientMessage({ ...message, request: { ...message.request, leaseId: undefined } } as never),
		).toThrow();
		expect(() => assertWorkspaceCommandResult("get_session_info", result)).not.toThrow();
		expect(() =>
			assertWorkspaceCommandResult("get_session_info", {
				...result,
				messages: { ...result.messages, total: -1 },
			}),
		).toThrow();
		expect(() => assertWorkspaceCommandResult("get_session_info", { ...result, extra: true })).toThrow();
	});

	it("strictly decodes fork candidates and fork results", () => {
		const list = {
			type: "request" as const,
			id: "fork-list",
			request: {
				command: "list_fork_messages" as const,
				sessionPath: "/tmp/current.jsonl",
				leaseId: "lease",
			},
		};
		expect(new ClientMessageDecoder().push(encodeClientMessage(list))).toEqual([list]);
		expect(() =>
			encodeClientMessage({ ...list, request: { ...list.request, leaseId: undefined } } as never),
		).toThrow();
		expect(() =>
			assertWorkspaceCommandResult("list_fork_messages", [
				{ entryId: "entry-1", text: "first" },
				{ entryId: "entry-2", text: "latest" },
			]),
		).not.toThrow();
		expect(() =>
			assertWorkspaceCommandResult("fork_session", {
				lease: {
					leaseId: "fork-lease",
					leaseGeneration: 2,
					sessionPath: "/tmp/fork.jsonl",
					clientInstanceId: "client",
					createdAt: 1,
					updatedAt: 2,
				},
				snapshot: {
					id: "fork",
					path: "/tmp/fork.jsonl",
					cwd: "/tmp",
					createdAt: 1,
					updatedAt: 2,
					phase: "idle",
					activity: "idle",
					thinkingLevel: "off",
					attached: true,
					writeAccess: "owned",
					revision: 2,
					leafId: null,
					queuedSteerCount: 0,
					queuedFollowUpCount: 0,
					transcriptGeneration: "generation",
					transcriptRevision: 0,
				},
				selectedText: "full selected prompt",
			}),
		).not.toThrow();
		expect(() =>
			assertWorkspaceCommandResult("fork_session", {
				lease: { leaseId: "fork-lease" },
				snapshot: {},
			}),
		).toThrow();
	});

	it("strictly decodes interactive queue commands and typed progress", () => {
		const decoder = new ClientMessageDecoder();
		for (const request of [
			{
				command: "steer",
				sessionPath: "/tmp/session.jsonl",
				leaseId: "lease",
				clientInstanceId: "client",
				clientRequestId: "steer-1",
				text: "调整",
			},
			{
				command: "follow_up",
				sessionPath: "/tmp/session.jsonl",
				leaseId: "lease",
				clientInstanceId: "client",
				clientRequestId: "follow-1",
				text: "继续",
			},
			{
				command: "clear_queue",
				sessionPath: "/tmp/session.jsonl",
				leaseId: "lease",
				clientInstanceId: "client",
				clientRequestId: "clear-1",
			},
			{
				command: "compact",
				sessionPath: "/tmp/session.jsonl",
				leaseId: "lease",
				clientInstanceId: "client",
				clientRequestId: "compact-1",
				customInstructions: "保留实现决策",
			},
		] as const) {
			expect(
				decoder.push(encodeClientMessage({ type: "request", id: request.clientRequestId, request })),
			).toHaveLength(1);
		}
		expect(() =>
			encodeServerMessage({
				type: "event",
				event: {
					type: "session_progress",
					sessionPath: "/tmp/session.jsonl",
					progress: { type: "unknown_runtime", raw: "no" },
				},
			} as never),
		).toThrow();
		expect(() =>
			decoder.push(
				encodeClientMessage({
					type: "request",
					id: "compact-too-large",
					request: {
						command: "compact",
						sessionPath: "/tmp/session.jsonl",
						leaseId: "lease",
						clientInstanceId: "client",
						clientRequestId: "compact-too-large",
						customInstructions: "x".repeat(64 * 1024 + 1),
					},
				}),
			),
		).toThrow();
	});

	it("strictly decodes model, project, completion, and resource commands", () => {
		const decoder = new ClientMessageDecoder();
		const messages = [
			{
				type: "request",
				id: "login",
				request: {
					command: "login_model_provider",
					provider: "openai",
					authType: "api_key",
					clientInstanceId: "client",
					clientRequestId: "login-1",
				},
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
					clientInstanceId: "client",
					clientRequestId: "invalid-login",
				},
			}),
		).toThrow();
	});
});
