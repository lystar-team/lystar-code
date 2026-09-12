import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeProtocolClient, ServerEvent } from "@lystar/code-web-protocol";
import { WebSocket } from "ws";
import type { WebGatewayConfig } from "../src/config.ts";
import { scopedRuntimeClientId, WebGatewayServer } from "../src/server.ts";

interface TestLease {
	leaseId: string;
	leaseGeneration: number;
	sessionPath: string;
	createdAt: number;
	updatedAt: number;
}

interface TestContext {
	id: string;
	client?: RuntimeProtocolClient;
	leases: Map<string, TestLease>;
	sockets: Set<WebSocket>;
	bootstrapGeneration: number;
	bootstrapCache?: {
		generation: number;
		value: {
			projects: unknown[];
			projectGroups: unknown[];
			capabilities: readonly string[];
			connection: { connected: boolean; host: string };
			pendingUiRequests: unknown[];
			operations: unknown[];
			leases: unknown[];
		};
	};
	resumeGeneration?: number;
	resumeSessionIds: Set<string>;
}

interface TestSocket {
	webSocket: WebSocket;
	sent: unknown[];
	pings: number;
	terminated: number;
	emit(event: string, ...args: unknown[]): void;
}

interface GatewayInternals {
	server: Server;
	createContext(id: string): TestContext;
	handleHostEvent(context: TestContext, event: ServerEvent): void;
	handleWebSocket(socket: WebSocket, request: IncomingMessage): Promise<void>;
	restoreContextLeases(context: TestContext, client: RuntimeProtocolClient): Promise<void>;
	checkWebSocketLiveness(): void;
	sendWebSocket(socket: WebSocket, payload: string): void;
	socketLiveness: WeakMap<WebSocket, boolean>;
	sessionIdsByPath: Map<string, string>;
	contexts: Map<string, TestContext>;
	subscriptionsFor(socket: WebSocket): Set<string>;
	subscribeSession(context: TestContext, socket: WebSocket, sessionId: string, lastSeq?: number): void;
}

function createConfig(): WebGatewayConfig {
	const agentDir = join(tmpdir(), "lystar-web-gateway-resilience");
	return {
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "host.sock"),
		token: "resilience-test-token",
		tokenPath: join(agentDir, "web", "token"),
		allowedHosts: ["127.0.0.1", "localhost"],
		staticDir: agentDir,
		manageRuntime: false,
	};
}

function createSocket(): TestSocket {
	const sent: unknown[] = [];
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	let pings = 0;
	let terminated = 0;
	const socket = {
		readyState: WebSocket.OPEN,
		bufferedAmount: 0,
		send(payload: string, callback?: (error?: Error) => void) {
			sent.push(JSON.parse(payload));
			callback?.();
		},
		ping() {
			pings++;
		},
		terminate() {
			terminated++;
		},
		close() {},
		on(event: string, listener: (...args: unknown[]) => void) {
			const eventListeners = listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
			eventListeners.add(listener);
			listeners.set(event, eventListeners);
			return this;
		},
	} as unknown as WebSocket;
	return {
		webSocket: socket,
		sent,
		get pings() {
			return pings;
		},
		get terminated() {
			return terminated;
		},
		emit(event, ...args) {
			for (const listener of listeners.get(event) ?? []) listener(...args);
		},
	};
}

function internals(server: WebGatewayServer): GatewayInternals {
	return server as unknown as GatewayInternals;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("Gateway 对缺失资源返回 404，只对页面导航回退首页", async (t) => {
	const staticDir = await mkdtemp(join(tmpdir(), "lystar-web-static-"));
	await writeFile(join(staticDir, "index.html"), "<!doctype html><title>LYStar</title>");
	await writeFile(join(staticDir, "sw.js"), "self.addEventListener('fetch', () => {});");
	const server = new WebGatewayServer({ ...createConfig(), staticDir });
	await server.listen();
	t.after(async () => {
		await server.close();
		await rm(staticDir, { recursive: true, force: true });
	});
	const address = internals(server).server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	const missingScript = await fetch(`${baseUrl}/assets/missing.js`, { headers: { Accept: "text/javascript" } });
	assert.equal(missingScript.status, 404);
	assert.match(missingScript.headers.get("content-type") ?? "", /application\/json/u);

	const navigation = await fetch(`${baseUrl}/sessions/example`, { headers: { Accept: "text/html" } });
	assert.equal(navigation.status, 200);
	assert.match(navigation.headers.get("content-type") ?? "", /text\/html/u);
	assert.match(await navigation.text(), /<title>LYStar<\/title>/u);

	const serviceWorker = await fetch(`${baseUrl}/sw.js`);
	assert.equal(serviceWorker.headers.get("cache-control"), "no-cache");
});

test("Gateway 复用当前 bootstrap 时只发送轻量连接确认", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const browserClientId = "bootstrap-cache-client";
	const contextId = scopedRuntimeClientId(undefined, browserClientId);
	const context = internal.createContext(contextId);
	context.bootstrapGeneration = 3;
	context.bootstrapCache = {
		generation: 3,
		value: {
			projects: [],
			projectGroups: [],
			capabilities: [],
			connection: { connected: true, host: "Web Host" },
			pendingUiRequests: [],
			operations: [],
			leases: [],
		},
	};
	internal.contexts.set(contextId, context);
	const socket = createSocket();
	const request = {
		headers: { host: "127.0.0.1", "x-lystar-client-id": browserClientId },
		url: "/ws",
	} as unknown as IncomingMessage;

	await internal.handleWebSocket(socket.webSocket, request);

	assert.deepEqual(socket.sent, [{ type: "connection_state", connected: true, message: "" }]);
});

test("Gateway 同一浏览器未漏事件时复用断线 generation 轻量恢复", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const browserClientId = "bootstrap-resume-client";
	const contextId = scopedRuntimeClientId(undefined, browserClientId);
	const context = internal.createContext(contextId);
	context.bootstrapGeneration = 3;
	context.bootstrapCache = {
		generation: 3,
		value: {
			projects: [],
			projectGroups: [],
			capabilities: [],
			connection: { connected: true, host: "Web Host" },
			pendingUiRequests: [],
			operations: [],
			leases: [],
		},
	};
	internal.contexts.set(contextId, context);
	const request = {
		headers: { host: "127.0.0.1", "x-lystar-client-id": browserClientId },
		url: "/ws",
	} as unknown as IncomingMessage;
	const initialSocket = createSocket();
	await internal.handleWebSocket(initialSocket.webSocket, request);
	internal.handleHostEvent(context, { type: "sessions_changed", cwd: "/tmp" });
	initialSocket.emit("close");
	assert.equal(context.resumeGeneration, 4);

	const resumedSocket = createSocket();
	await internal.handleWebSocket(resumedSocket.webSocket, request);

	assert.deepEqual(resumedSocket.sent, [{ type: "connection_state", connected: true, message: "" }]);
});

test("Gateway Runtime 断开时不复用旧 resume generation", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const browserClientId = "runtime-disconnected-client";
	const contextId = scopedRuntimeClientId(undefined, browserClientId);
	const context = internal.createContext(contextId);
	context.bootstrapGeneration = 4;
	context.bootstrapCache = {
		generation: 3,
		value: {
			projects: [],
			projectGroups: [],
			capabilities: [],
			connection: { connected: true, host: "Web Host" },
			pendingUiRequests: [],
			operations: [],
			leases: [],
		},
	};
	context.resumeGeneration = 4;
	const unavailable = Promise.reject<RuntimeProtocolClient>(new Error("runtime unavailable"));
	void unavailable.catch(() => {});
	Object.assign(context, { connectionState: "disconnected", connectPromise: unavailable });
	internal.contexts.set(contextId, context);
	const socket = createSocket();
	const request = {
		headers: { host: "127.0.0.1", "x-lystar-client-id": browserClientId },
		url: "/ws",
	} as unknown as IncomingMessage;

	await internal.handleWebSocket(socket.webSocket, request);

	assert.deepEqual(socket.sent, []);
});

test("Gateway 发送前把本条消息计入积压上限", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const socket = createSocket();
	internals(server).sendWebSocket(socket.webSocket, "x".repeat(2 * 1024 * 1024 + 1));
	assert.equal(socket.terminated, 1);
	assert.equal(socket.sent.length, 0);
});

test("Gateway 合并实时增量并在非进度事件前保持顺序", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("resilience-client");
	const socket = createSocket();
	context.sockets.add(socket.webSocket);
	internal.sessionIdsByPath.set("/tmp/resilience-session.jsonl", "session-1");
	internal.subscriptionsFor(socket.webSocket).add("session-1");

	internal.handleHostEvent(context, {
		type: "session_progress",
		sessionPath: "/tmp/resilience-session.jsonl",
		progress: { type: "assistant_delta", text: "O" },
	});
	internal.handleHostEvent(context, {
		type: "session_progress",
		sessionPath: "/tmp/resilience-session.jsonl",
		progress: { type: "assistant_delta", text: "K" },
	});
	await wait(75);

	assert.deepEqual(socket.sent, [
		{ type: "session_progress", sessionId: "session-1", progress: { type: "assistant_delta", text: "OK" }, seq: 1 },
	]);

	internal.handleHostEvent(context, { type: "sessions_changed", cwd: "/tmp" });
	assert.deepEqual(socket.sent.at(-1), { type: "sessions_changed" });
});

test("Gateway 工具生命周期即时发送并合并持续输出", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("tool-progress-client");
	const socket = createSocket();
	context.sockets.add(socket.webSocket);
	internal.sessionIdsByPath.set("/tmp/tool-progress-session.jsonl", "session-1");
	internal.subscriptionsFor(socket.webSocket).add("session-1");

	const activity = {
		activityEpoch: "epoch",
		revision: 1,
		toolCallId: "edit-1",
		name: "edit",
		state: "running" as const,
		summary: "src/app.ts",
		updatedAt: 1,
	};
	internal.handleHostEvent(context, {
		type: "session_progress",
		sessionPath: "/tmp/tool-progress-session.jsonl",
		progress: { type: "tool_state", activity },
	});
	assert.equal(socket.sent.length, 1);

	socket.sent.length = 0;
	internal.handleHostEvent(context, {
		type: "session_progress",
		sessionPath: "/tmp/tool-progress-session.jsonl",
		progress: { type: "tool_state", activity: { ...activity, revision: 2, progress: "第一段" } },
	});
	internal.handleHostEvent(context, {
		type: "session_progress",
		sessionPath: "/tmp/tool-progress-session.jsonl",
		progress: { type: "tool_state", activity: { ...activity, revision: 3, progress: "第二段" } },
	});
	assert.equal(socket.sent.length, 0);
	await wait(75);
	assert.deepEqual(socket.sent, [
		{
			type: "session_progress",
			sessionId: "session-1",
			progress: { type: "tool_state", activity: { ...activity, revision: 3, progress: "第二段" } },
			seq: 2,
		},
	]);
});

test("Gateway 只向订阅者发送会话详情，其他连接接收摘要", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("subscription-client");
	const subscribed = createSocket();
	const summaryOnly = createSocket();
	context.sockets.add(subscribed.webSocket);
	context.sockets.add(summaryOnly.webSocket);
	internal.sessionIdsByPath.set("/tmp/subscription-session.jsonl", "session-1");
	internal.subscriptionsFor(subscribed.webSocket).add("session-1");

	internal.handleHostEvent(context, {
		type: "session_progress",
		sessionPath: "/tmp/subscription-session.jsonl",
		progress: { type: "assistant_delta", text: "详情" },
	});
	await wait(75);

	assert.deepEqual(subscribed.sent, [
		{ type: "session_progress", sessionId: "session-1", progress: { type: "assistant_delta", text: "详情" }, seq: 1 },
	]);
	assert.deepEqual(summaryOnly.sent, [{ type: "session_summary", sessionId: "session-1", activity: "running" }]);
});

test("Gateway 订阅确认前同步当前会话租约", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("lease-subscription-client");
	const socket = createSocket();
	context.sockets.add(socket.webSocket);
	context.leases.set("session-1", {
		leaseId: "lease-1",
		leaseGeneration: 2,
		sessionPath: "/tmp/lease-session.jsonl",
		createdAt: 1,
		updatedAt: 2,
	});

	internal.subscribeSession(context, socket.webSocket, "session-1");

	assert.deepEqual(socket.sent, [
		{
			type: "session_lease",
			sessionId: "session-1",
			lease: { leaseId: "lease-1", leaseGeneration: 2, createdAt: 1, updatedAt: 2 },
		},
		{ type: "session_subscription", sessionId: "session-1", seq: 0, gap: false },
	]);
});

test("Gateway 优先恢复已订阅会话的租约", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("lease-restore-client");
	const socket = createSocket();
	context.sockets.add(socket.webSocket);
	internal.subscriptionsFor(socket.webSocket).add("active-session");
	context.leases.set("inactive-session", {
		leaseId: "old-inactive",
		leaseGeneration: 1,
		sessionPath: "/tmp/inactive-session.jsonl",
		createdAt: 1,
		updatedAt: 1,
	});
	context.leases.set("active-session", {
		leaseId: "old-active",
		leaseGeneration: 1,
		sessionPath: "/tmp/active-session.jsonl",
		createdAt: 1,
		updatedAt: 1,
	});
	const restoredPaths: string[] = [];
	const client = {
		request<T>(request: { command: string; sessionPath?: string }): Promise<T> {
			const sessionPath = request.sessionPath ?? "";
			restoredPaths.push(sessionPath);
			return Promise.resolve({
				lease: {
					leaseId: `restored:${sessionPath}`,
					leaseGeneration: 2,
					sessionPath,
					createdAt: 2,
					updatedAt: 2,
				},
			} as unknown as T);
		},
	} as unknown as RuntimeProtocolClient;
	context.client = client;

	await internal.restoreContextLeases(context, client);

	assert.deepEqual(restoredPaths, ["/tmp/active-session.jsonl", "/tmp/inactive-session.jsonl"]);
	assert.deepEqual(socket.sent, [
		{
			type: "session_lease",
			sessionId: "active-session",
			lease: {
				leaseId: "restored:/tmp/active-session.jsonl",
				leaseGeneration: 2,
				createdAt: 2,
				updatedAt: 2,
			},
		},
	]);
});

test("Gateway 首次订阅也返回确认序号", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("initial-subscription-client");
	const socket = createSocket();
	context.sockets.add(socket.webSocket);

	internal.subscribeSession(context, socket.webSocket, "session-1");

	assert.deepEqual(socket.sent, [{ type: "session_subscription", sessionId: "session-1", seq: 0, gap: false }]);
});
test("Gateway 可用 lastSeq 重放未订阅期间的详情事件", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("replay-client");
	const socket = createSocket();
	context.sockets.add(socket.webSocket);
	internal.sessionIdsByPath.set("/tmp/replay-session.jsonl", "session-1");

	internal.handleHostEvent(context, {
		type: "session_progress",
		sessionPath: "/tmp/replay-session.jsonl",
		progress: { type: "assistant_delta", text: "补齐" },
	});
	await wait(75);
	internal.subscribeSession(context, socket.webSocket, "session-1", 0);

	assert.deepEqual(socket.sent, [
		{ type: "session_summary", sessionId: "session-1", activity: "running" },
		{ type: "session_progress", sessionId: "session-1", progress: { type: "assistant_delta", text: "补齐" }, seq: 1 },
		{ type: "session_subscription", sessionId: "session-1", seq: 1, gap: false },
	]);
});

test("Gateway 在队列数量不变但消息内容替换时广播会话快照", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("snapshot-dedupe-client");
	const socket = createSocket();
	context.sockets.add(socket.webSocket);
	internal.subscriptionsFor(socket.webSocket).add("session-1");

	const snapshot: Extract<ServerEvent, { type: "session_snapshot" }>["snapshot"] = {
		id: "session-1",
		path: "/tmp/snapshot-session.jsonl",
		cwd: "/tmp",
		createdAt: 1,
		updatedAt: 2,
		phase: "turn",
		activity: "running",
		thinkingLevel: "off",
		attached: true,
		writeAccess: "owned",
		revision: 1,
		leafId: null,
		queuedSteerCount: 0,
		queuedFollowUpCount: 1,
		queuedFollowUpMessages: [{ id: "queue-1", text: "第一条" }],
		transcriptGeneration: "generation",
		transcriptRevision: 10,
	};
	internal.handleHostEvent(context, { type: "session_snapshot", snapshot });
	internal.handleHostEvent(context, { type: "session_snapshot", snapshot: { ...snapshot, revision: 2 } });
	assert.equal(socket.sent.length, 1);
	internal.handleHostEvent(context, {
		type: "session_snapshot",
		snapshot: { ...snapshot, revision: 3, queuedFollowUpMessages: [{ id: "queue-2", text: "第二条" }] },
	});

	assert.equal(socket.sent.length, 2);
	assert.deepEqual(
		(socket.sent[1] as { snapshot?: { queuedFollowUpMessages?: unknown } }).snapshot?.queuedFollowUpMessages,
		[{ id: "queue-2", text: "第二条" }],
	);

	internal.handleHostEvent(context, {
		type: "session_snapshot",
		snapshot: {
			...snapshot,
			revision: 4,
			activity: "idle",
			queuedFollowUpCount: 0,
			queuedFollowUpMessages: [],
		},
	});
	assert.equal(socket.sent.length, 3);
});

test("Gateway 心跳会终止连续未响应的 WebSocket", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("heartbeat-client");
	internal.contexts.set("heartbeat-client", context);
	const socket = createSocket();
	context.sockets.add(socket.webSocket);
	internal.socketLiveness.set(socket.webSocket, true);

	internal.checkWebSocketLiveness();
	assert.equal(socket.pings, 1);
	assert.equal(socket.terminated, 0);
	assert.equal(internal.socketLiveness.get(socket.webSocket), false);

	internal.checkWebSocketLiveness();
	assert.equal(socket.terminated, 1);
});

test("Gateway 断线期间保留上次订阅会话的进度序列", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("offline-resume-client");
	context.resumeSessionIds.add("session-1");
	internal.sessionIdsByPath.set("/tmp/offline-resume-session.jsonl", "session-1");

	internal.handleHostEvent(context, {
		type: "session_progress",
		sessionPath: "/tmp/offline-resume-session.jsonl",
		progress: { type: "assistant_delta", text: "补齐" },
	});
	const socket = createSocket();
	internal.subscribeSession(context, socket.webSocket, "session-1", 0);

	assert.deepEqual(socket.sent, [
		{ type: "session_progress", sessionId: "session-1", progress: { type: "assistant_delta", text: "补齐" }, seq: 1 },
		{ type: "session_subscription", sessionId: "session-1", seq: 1, gap: false },
	]);
});

test("Gateway 在没有浏览器连接时丢弃未订阅会话的高频 session_progress", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("offline-client");
	internal.sessionIdsByPath.set("/tmp/offline-session.jsonl", "session-1");

	internal.handleHostEvent(context, {
		type: "session_progress",
		sessionPath: "/tmp/offline-session.jsonl",
		progress: { type: "assistant_delta", text: "ignored" },
	});
	await wait(75);
	const socket = createSocket();
	internal.subscribeSession(context, socket.webSocket, "session-1", 0);

	assert.deepEqual(socket.sent, [{ type: "session_subscription", sessionId: "session-1", seq: 0, gap: false }]);
});
