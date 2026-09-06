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
	socketLiveness: WeakMap<WebSocket, boolean>;
	sessionIdsByPath: Map<string, string>;
	contexts: Map<string, TestContext>;
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

test("Gateway 合并实时增量并在非进度事件前保持顺序", async (t) => {
	const server = new WebGatewayServer(createConfig());
	t.after(() => void server.close());
	const internal = internals(server);
	const context = internal.createContext("resilience-client");
	const socket = createSocket();
	context.sockets.add(socket.webSocket);
	internal.sessionIdsByPath.set("/tmp/resilience-session.jsonl", "session-1");

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
		{ type: "session_progress", sessionId: "session-1", progress: { type: "assistant_delta", text: "OK" } },
	]);

	internal.handleHostEvent(context, { type: "sessions_changed", cwd: "/tmp" });
	assert.deepEqual(socket.sent.at(-1), { type: "sessions_changed" });
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
