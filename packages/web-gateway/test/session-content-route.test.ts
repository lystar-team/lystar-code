import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import type { RuntimeProtocolClient } from "@lystar/code-web-protocol";
import { WebGatewayServer } from "../src/server.ts";

test("Assistant 全文路由按字节偏移读取当前会话内容", async (t) => {
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir: "/tmp/conversation-content-route",
		runtimeEndpoint: "/tmp/conversation-content-route/host.sock",
		token: "test-token",
		tokenPath: "/tmp/conversation-content-route/token",
		allowedHosts: ["127.0.0.1"],
		staticDir: "/tmp/conversation-content-route",
		manageRuntime: false,
	});
	t.after(() => void server.close());
	const internal = server as unknown as {
		createContext(id: string): { client?: RuntimeProtocolClient };
		sessions: Map<string, { id: string; path: string; projectId: string; cwd: string }>;
		handleSessions(
			request: IncomingMessage,
			response: ServerResponse,
			url: URL,
			context: unknown,
			parts: string[],
		): Promise<void>;
	};
	const context = internal.createContext("content-browser");
	internal.sessions.set("session-1", {
		id: "session-1",
		path: "/tmp/session-1.jsonl",
		projectId: "project-1",
		cwd: "/tmp",
	});
	const chunk = {
		contentRef: "full-text",
		offset: 262144,
		nextOffset: 262150,
		byteLength: 262150,
		data: Buffer.from("结尾").toString("base64"),
		encoding: "base64",
		done: true,
	};
	const requests: unknown[] = [];
	context.client = {
		getSnapshot: () => ({ connected: true }),
		request<T>(request: unknown): Promise<T> {
			requests.push(request);
			return Promise.resolve(chunk as T);
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
	const parts = ["api", "sessions", "session-1", "content", "full-text"];
	await internal.handleSessions(
		request,
		response,
		new URL("http://localhost/api/sessions/session-1/content/full-text?offset=262144"),
		context,
		parts,
	);
	assert.equal(status, 200);
	assert.deepEqual(JSON.parse(body), chunk);
	assert.deepEqual(requests, [
		{
			command: "read_content",
			sessionPath: "/tmp/session-1.jsonl",
			contentRef: "full-text",
			offset: 262144,
			limit: 262144,
		},
	]);
	await assert.rejects(
		internal.handleSessions(
			request,
			response,
			new URL("http://localhost/api/sessions/session-1/content/full-text?offset=-1"),
			context,
			parts,
		),
		/内容偏移无效/,
	);
	assert.equal(requests.length, 1);
});
