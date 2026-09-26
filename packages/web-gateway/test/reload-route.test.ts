import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Command, SessionStateSnapshot } from "@lystar/code-web-protocol";
import { WebGatewayServer } from "../src/server.ts";

interface RouteInternals {
	getClient(context: { id: string }): Promise<{ request(command: Command): Promise<unknown> }>;
	resolveSession(context: { id: string }, id: string): Promise<{ path: string }>;
	requireLease(context: { id: string }, id: string): Promise<{ leaseId: string }>;
	handleSessions(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		context: { id: string },
		parts: string[],
	): Promise<void>;
}

test("Web 批量删除路由只发送一个 Runtime 请求", async (t) => {
	const agentDir = join(tmpdir(), "web-batch-delete-route-test");
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "host.sock"),
		token: "test-token",
		tokenPath: join(agentDir, "token"),
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	});
	t.after(() => server.close());
	const routes = server as unknown as RouteInternals;
	const commands: Command[] = [];
	let requestCount = 0;
	routes.getClient = async () => ({
		request: async (command) => {
			commands.push(command);
			requestCount++;
			if (command.command !== "delete_sessions") throw new Error("unexpected command");
			return {
				deletedPaths: command.items.map((item) => item.sessionPath),
				failures: [],
			};
		},
	});
	routes.resolveSession = async (_context, id) => ({
		id,
		path: `/tmp/${id}.jsonl`,
		projectId: "project-one",
		cwd: "/tmp/project",
	});
	let status = 0;
	let body = "";
	const request = Readable.from([
		Buffer.from(JSON.stringify({ sessionIds: ["session-one", "session-two", "session-three"] })),
	]) as unknown as IncomingMessage;
	request.method = "DELETE";
	request.headers = {};
	const response = {
		writeHead(code: number) {
			status = code;
		},
		end(value: string) {
			body = value;
		},
	} as unknown as ServerResponse;
	const context = {
		id: "browser-one",
		leases: new Map(),
		leasesToRestore: new Set(),
		sockets: new Set(),
		sessionListPromises: new Map(),
		sessionListCache: new Map(),
		bootstrapGeneration: 0,
		sessionListGeneration: 0,
		activeRequests: 1,
	};

	await routes.handleSessions(request, response, new URL("http://localhost/api/sessions"), context, [
		"api",
		"sessions",
	]);

	assert.equal(status, 200);
	assert.deepEqual(JSON.parse(body), {
		deletedIds: ["session-one", "session-two", "session-three"],
		failures: [],
	});
	assert.equal(requestCount, 1);
	assert.deepEqual(commands, [
		{
			command: "delete_sessions",
			items: [
				{ cwd: "/tmp/project", sessionPath: "/tmp/session-one.jsonl" },
				{ cwd: "/tmp/project", sessionPath: "/tmp/session-two.jsonl" },
				{ cwd: "/tmp/project", sessionPath: "/tmp/session-three.jsonl" },
			],
			clientInstanceId: "browser-one",
			clientRequestId: commands[0]?.command === "delete_sessions" ? commands[0].clientRequestId : "",
		},
	]);
});

test("Web reload 路由使用当前会话 lease 调用 reload_resources 并返回快照", async (t) => {
	const agentDir = join(tmpdir(), "web-reload-route-test");
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "host.sock"),
		token: "test-token",
		tokenPath: join(agentDir, "token"),
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	});
	t.after(() => server.close());
	const routes = server as unknown as RouteInternals;
	const commands: Command[] = [];
	const snapshot = {
		id: "session-one",
		path: "/tmp/session-one.jsonl",
		cwd: "/tmp",
		phase: "idle",
	} as SessionStateSnapshot;
	routes.getClient = async () => ({
		request: async (command) => {
			commands.push(command);
			return snapshot;
		},
	});
	routes.resolveSession = async (_context, id) => {
		assert.equal(id, "session-one");
		return { path: snapshot.path };
	};
	routes.requireLease = async (context, id) => {
		assert.equal(context.id, "browser-one");
		assert.equal(id, "session-one");
		return { leaseId: "lease-one" };
	};
	let status = 0;
	let body = "";
	const request = Readable.from([
		Buffer.from(JSON.stringify({ clientRequestId: "request-one" })),
	]) as unknown as IncomingMessage;
	request.method = "POST";
	request.headers = {};
	const response = {
		writeHead(code: number) {
			status = code;
		},
		end(value: string) {
			body = value;
		},
	} as unknown as ServerResponse;
	await routes.handleSessions(
		request,
		response,
		new URL("http://localhost/api/sessions/session-one/reload"),
		{ id: "browser-one" },
		["api", "sessions", "session-one", "reload"],
	);
	assert.deepEqual(commands, [
		{
			command: "reload_resources",
			sessionPath: snapshot.path,
			leaseId: "lease-one",
			clientInstanceId: "browser-one",
			clientRequestId: "request-one",
		},
	]);
	assert.equal(status, 200);
	assert.deepEqual(JSON.parse(body), { session: { id: "session-one", phase: "idle" } });
});

test("Web follow-up 路由转发稳定 queueId", async (t) => {
	const agentDir = join(tmpdir(), "web-follow-up-route-test");
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "host.sock"),
		token: "test-token",
		tokenPath: join(agentDir, "token"),
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	});
	t.after(() => server.close());
	const routes = server as unknown as RouteInternals;
	const commands: Command[] = [];
	const snapshot = {
		id: "session-one",
		path: "/tmp/session-one.jsonl",
		cwd: "/tmp",
		phase: "turn",
	} as SessionStateSnapshot;
	routes.getClient = async () => ({
		request: async (command) => {
			commands.push(command);
			return {};
		},
	});
	routes.resolveSession = async (_context, id) => {
		assert.equal(id, "session-one");
		return { path: snapshot.path };
	};
	routes.requireLease = async (_context, id) => {
		assert.equal(id, "session-one");
		return { leaseId: "lease-one" };
	};
	let status = 0;
	let body = "";
	const request = Readable.from([
		Buffer.from(JSON.stringify({ text: "后续任务", queueId: "queue-42", clientRequestId: "request-one" })),
	]) as unknown as IncomingMessage;
	request.method = "POST";
	request.headers = {};
	const response = {
		writeHead(code: number) {
			status = code;
		},
		end(value: string) {
			body = value;
		},
	} as unknown as ServerResponse;

	await routes.handleSessions(
		request,
		response,
		new URL("http://localhost/api/sessions/session-one/follow-up"),
		{ id: "browser-one" },
		["api", "sessions", "session-one", "follow-up"],
	);

	assert.deepEqual(commands, [
		{
			command: "follow_up",
			sessionPath: snapshot.path,
			leaseId: "lease-one",
			clientInstanceId: "browser-one",
			clientRequestId: "request-one",
			text: "后续任务",
			queueId: "queue-42",
		},
	]);
	assert.equal(status, 200);
	assert.deepEqual(JSON.parse(body), { accepted: true });
});
