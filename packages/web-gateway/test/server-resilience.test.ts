import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ServerEvent } from "@lystar/code-web-protocol";
import { WebSocket } from "ws";
import type { WebGatewayConfig } from "../src/config.ts";
import { WebGatewayServer } from "../src/server.ts";

interface TestContext {
	sockets: Set<WebSocket>;
}

interface TestSocket {
	webSocket: WebSocket;
	sent: unknown[];
	pings: number;
	terminated: number;
}

interface GatewayInternals {
	createContext(id: string): TestContext;
	handleHostEvent(context: TestContext, event: ServerEvent): void;
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
	};
}

function internals(server: WebGatewayServer): GatewayInternals {
	return server as unknown as GatewayInternals;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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

test("Gateway 丢弃只有 revision 变化的重复会话快照", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("snapshot-dedupe-client");
	const socket = createSocket();
	context.sockets.add(socket.webSocket);
	internal.subscriptionsFor(socket.webSocket).add("session-1");

	const snapshot = {
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
		queuedFollowUpCount: 0,
		transcriptGeneration: "generation",
		transcriptRevision: 10,
	} as const;
	internal.handleHostEvent(context, { type: "session_snapshot", snapshot });
	internal.handleHostEvent(context, { type: "session_snapshot", snapshot: { ...snapshot, revision: 2 } });

	assert.equal(socket.sent.length, 1);
	assert.equal((socket.sent[0] as { seq?: number }).seq, 1);

	internal.handleHostEvent(context, {
		type: "session_snapshot",
		snapshot: { ...snapshot, revision: 3, activity: "idle" },
	});
	assert.equal(socket.sent.length, 2);
	assert.equal((socket.sent[1] as { seq?: number }).seq, 2);
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

test("Gateway 在没有浏览器连接时丢弃高频 session_progress", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("offline-client");

	internal.handleHostEvent(context, {
		type: "session_progress",
		sessionPath: "/tmp/offline-session.jsonl",
		progress: { type: "assistant_delta", text: "ignored" },
	});
	await wait(75);

	assert.equal(context.sockets.size, 0);
});
