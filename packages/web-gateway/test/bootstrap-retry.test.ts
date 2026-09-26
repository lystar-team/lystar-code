import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeProtocolClient } from "@lystar/code-web-protocol";
import { WebSocket } from "ws";
import type { WebGatewayConfig } from "../src/config.ts";
import { WebGatewayServer } from "../src/server.ts";

interface RetryContext {
	client?: RuntimeProtocolClient;
	sockets: Set<WebSocket>;
	bootstrapRetryAttempt: number;
	bootstrapRetryTimer?: ReturnType<typeof setTimeout>;
}

interface RetryInternals {
	createContext(id: string): RetryContext;
	pushBootstrap(context: RetryContext): Promise<void>;
	buildBootstrap(context: RetryContext): Promise<unknown>;
}

test("工作区同步失败时在 Runtime 仍连接的情况下重试并恢复页面", async (t) => {
	const agentDir = join(tmpdir(), "web-bootstrap-retry-test");
	const config: WebGatewayConfig = {
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "runtime.sock"),
		token: "test-token",
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	};
	const server = new WebGatewayServer(config);
	t.after(() => void server.close());
	const internals = server as unknown as RetryInternals;
	const context = internals.createContext("retry-client");
	context.client = { getSnapshot: () => ({ connected: true }) } as unknown as RuntimeProtocolClient;
	const messages: Array<{ type: string; connected?: boolean }> = [];
	const socket = {
		readyState: WebSocket.OPEN,
		bufferedAmount: 0,
		send(payload: string, callback?: (error?: Error) => void) {
			messages.push(JSON.parse(payload));
			callback?.();
		},
	} as unknown as WebSocket;
	context.sockets.add(socket);
	let attempts = 0;
	internals.buildBootstrap = async () => {
		attempts++;
		if (attempts === 1) throw new Error("临时同步失败");
		return { projects: [], connection: { connected: true } };
	};
	await internals.pushBootstrap(context);
	assert.deepEqual(messages, [
		{ type: "connection_state", connected: false, message: "Web Host 恢复后读取工作区失败" },
	]);
	await new Promise<void>((resolve, reject) => {
		const check = setInterval(() => {
			if (attempts !== 2 || !messages.some((message) => message.type === "bootstrap")) return;
			clearInterval(check);
			clearTimeout(timer);
			resolve();
		}, 10);
		const timer = setTimeout(() => {
			clearInterval(check);
			reject(new Error("工作区同步没有恢复"));
		}, 1_000);
	});
	assert.equal(context.bootstrapRetryAttempt, 0);
	assert.equal(context.bootstrapRetryTimer, undefined);
	assert.equal(messages.at(-1)?.type, "bootstrap");
});
