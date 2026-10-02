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

test("Web 停止路由按 session.id 调用 stop_session 并返回最新快照", async (t) => {
	const agentDir = join(tmpdir(), "web-session-abort-route-test");
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
		activity: "idle",
	} as SessionStateSnapshot;
	routes.getClient = async () => ({
		request: async (command) => {
			commands.push(command);
			if (command.command === "stop_session") return { stopped: true };
			if (command.command === "inspect_session") return snapshot;
			throw new Error(`unexpected command: ${command.command}`);
		},
	});
	routes.resolveSession = async (_context, id) => {
		assert.equal(id, "session-one");
		return { path: snapshot.path };
	};
	let leaseChecked = false;
	routes.requireLease = async (context, id) => {
		assert.equal(context.id, "browser-one");
		assert.equal(id, "session-one");
		leaseChecked = true;
		return { leaseId: "lease-one" };
	};
	let status = 0;
	let body = "";
	const request = Readable.from([]) as unknown as IncomingMessage;
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
		new URL("http://localhost/api/sessions/session-one/abort"),
		{ id: "browser-one" },
		["api", "sessions", "session-one", "abort"],
	);

	assert.equal(leaseChecked, true);
	assert.deepEqual(commands, [
		{ command: "stop_session", sessionId: "session-one" },
		{ command: "inspect_session", sessionPath: snapshot.path },
	]);
	assert.equal(status, 200);
	assert.deepEqual(JSON.parse(body), {
		stopped: true,
		session: { id: "session-one", phase: "idle", activity: "idle" },
	});
});
