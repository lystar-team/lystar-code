import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import type { RuntimeProtocolClient } from "@lystar/code-web-protocol";
import type { WebGatewayConfig } from "../src/config.ts";
import { WebGatewayServer } from "../src/server.ts";

test("session usage route returns token totals for the controlled session", async (t) => {
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir: "/tmp/lystar-session-usage-route",
		runtimeEndpoint: "/tmp/lystar-session-usage-route/host.sock",
		token: "test-token",
		tokenPath: "/tmp/lystar-session-usage-route/token",
		allowedHosts: ["127.0.0.1"],
		staticDir: "/tmp/lystar-session-usage-route",
		manageRuntime: false,
	} satisfies WebGatewayConfig);
	t.after(() => void server.close());
	const internal = server as unknown as {
		createContext(id: string): {
			client?: RuntimeProtocolClient;
			leases: Map<
				string,
				{ leaseId: string; sessionPath: string; leaseGeneration: number; createdAt: number; updatedAt: number }
			>;
		};
		sessions: Map<string, { id: string; path: string; projectId: string; cwd: string }>;
		handleSessions(
			request: IncomingMessage,
			response: ServerResponse,
			url: URL,
			context: unknown,
			parts: string[],
		): Promise<void>;
	};
	const context = internal.createContext("session-usage-browser");
	internal.sessions.set("session-1", {
		id: "session-1",
		path: "/tmp/session-1.jsonl",
		projectId: "project-1",
		cwd: "/tmp",
	});
	context.leases.set("session-1", {
		leaseId: "lease-1",
		sessionPath: "/tmp/session-1.jsonl",
		leaseGeneration: 1,
		createdAt: 1,
		updatedAt: 1,
	});
	const requests: unknown[] = [];
	context.client = {
		getSnapshot() {
			return { connected: true };
		},
		request<T>(request: unknown): Promise<T> {
			requests.push(request);
			return Promise.resolve({
				tokens: { input: 20, cacheRead: 80, cacheWrite: 0, output: 12, total: 112 },
				sessionFile: "/tmp/session-1.jsonl",
			} as T);
		},
	} as unknown as RuntimeProtocolClient;
	let status = 0;
	let body = "";
	const response = {
		writeHead(value: number) {
			status = value;
			return this;
		},
		end(value: string) {
			body = value;
			return this;
		},
	} as unknown as ServerResponse;
	const request = { method: "GET" } as IncomingMessage;
	const url = new URL("http://localhost/api/sessions/session-1/usage");
	await internal.handleSessions(request, response, url, context, ["api", "sessions", "session-1", "usage"]);
	assert.equal(status, 200);
	assert.deepEqual(JSON.parse(body), { tokens: { input: 20, cacheRead: 80, cacheWrite: 0, output: 12, total: 112 } });
	assert.deepEqual(requests, [
		{ command: "get_session_info", sessionPath: "/tmp/session-1.jsonl", leaseId: "lease-1" },
	]);

	context.leases.delete("session-1");
	await assert.rejects(
		internal.handleSessions(request, response, url, context, ["api", "sessions", "session-1", "usage"]),
		/请先取得当前会话的控制权/u,
	);
	assert.equal(requests.length, 1);
});
