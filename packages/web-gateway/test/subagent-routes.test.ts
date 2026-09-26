import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
	type Command,
	MAX_TRANSCRIPT_PAGE_SIZE,
	type SubagentSnapshot,
	type TranscriptPage,
} from "@lystar/code-web-protocol";
import type { ProjectRegistry } from "../src/project-registry.ts";
import { WebGatewayServer } from "../src/server.ts";

interface TestContext {
	id: string;
	leases: Map<
		string,
		{ leaseId: string; leaseGeneration: number; sessionPath: string; createdAt: number; updatedAt: number }
	>;
}

interface RouteInternals {
	registry: ProjectRegistry;
	sessions: Map<string, { id: string; path: string; projectId: string; cwd: string }>;
	sessionIdsByPath: Map<string, string>;
	getClient(context: TestContext): Promise<{ request<T>(command: Command): Promise<T> }>;
	handleSessions(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		context: TestContext,
		parts: string[],
	): Promise<void>;
	handleSettings(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		context: TestContext,
		parts: string[],
	): Promise<void>;
}

function responseCapture(): {
	response: ServerResponse;
	result: () => { status: number; body: Record<string, unknown> };
} {
	let status = 0;
	let body = "";
	return {
		response: {
			writeHead(code: number) {
				status = code;
			},
			end(value: string) {
				body = value;
			},
		} as unknown as ServerResponse,
		result: () => ({ status, body: JSON.parse(body) as Record<string, unknown> }),
	};
}

function request(method: string, body?: Record<string, unknown>): IncomingMessage {
	const value = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as unknown as IncomingMessage;
	value.method = method;
	value.headers = {};
	return value;
}

test("Settings 智能体路由转发并清理标签", async (t) => {
	const tempDir = await mkdtemp(join(tmpdir(), "web-settings-subagent-tags-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "project");
	await mkdir(cwd, { recursive: true });
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
	t.after(async () => {
		await server.close();
		await rm(tempDir, { recursive: true, force: true });
	});
	const routes = server as unknown as RouteInternals;
	await routes.registry.load();
	const project = await routes.registry.add({ id: "project-one", cwd, name: "Project One" });
	const context: TestContext = { id: "browser-one", leases: new Map() };
	const commands: Command[] = [];
	routes.getClient = async () => ({
		request: async <T>(command: Command): Promise<T> => {
			commands.push(command);
			return [] as T;
		},
	});

	const response = responseCapture();
	await routes.handleSettings(
		request("POST", {
			scope: "user",
			name: "designer",
			description: "负责设计和原型",
			tags: ["开发", " 设计 ", "", "开发"],
			content: "完成设计任务",
			clientRequestId: "request-one",
		}),
		response.response,
		new URL(`http://localhost/api/settings/subagents?projectId=${project.id}`),
		context,
		["api", "settings", "subagents"],
	);

	assert.equal(response.result().status, 200);
	const command = commands[0];
	assert.equal(command?.command, "save_subagent_config");
	if (command?.command === "save_subagent_config") {
		assert.deepEqual(command.tags, ["开发", "设计"]);
		assert.equal(command.clientRequestId, "request-one");
	}
});

test("Subagent 会话路由复用父会话归属和控制 Lease", async (t) => {
	const tempDir = await mkdtemp(join(tmpdir(), "web-subagent-routes-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "project");
	const childSessionPath = join(tempDir, "child.jsonl");
	await mkdir(cwd, { recursive: true });
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
	t.after(async () => {
		await server.close();
		await rm(tempDir, { recursive: true, force: true });
	});
	const routes = server as unknown as RouteInternals;
	await routes.registry.load();
	const project = await routes.registry.add({ id: "project-one", cwd, name: "Project One" });
	const sessionPath = join(tempDir, "parent.jsonl");
	routes.sessions.set("session-one", { id: "session-one", path: sessionPath, projectId: project.id, cwd });
	routes.sessionIdsByPath.set(sessionPath, "session-one");
	const context: TestContext = {
		id: "browser-one",
		leases: new Map([
			[
				"session-one",
				{
					leaseId: "lease-one",
					leaseGeneration: 3,
					sessionPath,
					createdAt: 1,
					updatedAt: 2,
				},
			],
		]),
	};
	const snapshot: SubagentSnapshot = {
		runId: "run-1",
		agentId: "run-1:1",
		agent: "reviewer",
		agentSource: "user",
		task: "检查实现",
		state: "waiting",
		startedAt: 1,
		updatedAt: 2,
		elapsedMs: 1,
		controllable: true,
		session: {
			version: 1,
			sessionId: "child-one",
			sessionFile: childSessionPath,
			parentSessionFile: sessionPath,
			cwd,
			createdAt: 1,
		},
	};
	const transcriptPage = {
		items: [
			{
				entryId: "entry-one",
				parentId: null,
				timestamp: "2026-09-17T00:00:00Z",
				kind: "message",
				payload: { type: "message", message: { role: "assistant", content: [{ type: "text", text: "完成" }] } },
			},
		],
		hasMorePrevious: false,
		leafId: "entry-one",
		transcriptGeneration: "generation-one",
		transcriptRevision: 7,
		complete: true,
	} as unknown as TranscriptPage;
	const commands: Command[] = [];
	routes.getClient = async () => ({
		request: async <T>(command: Command): Promise<T> => {
			commands.push(command);
			switch (command.command) {
				case "list_subagents":
					return [snapshot] as T;
				case "read_subagent":
					return { live: snapshot } as T;
				case "read_transcript":
					return transcriptPage as T;
				case "abort_subagent":
					return { changed: true } as T;
				case "continue_subagent":
					return { changed: true } as T;
				default:
					throw new Error(`Unexpected command: ${command.command}`);
			}
		},
	});

	const list = responseCapture();
	await routes.handleSessions(
		request("GET"),
		list.response,
		new URL("http://localhost/api/sessions/session-one/subagents"),
		context,
		["api", "sessions", "session-one", "subagents"],
	);
	assert.deepEqual(list.result(), { status: 200, body: { subagents: [snapshot] } });

	const details = responseCapture();
	await routes.handleSessions(
		request("GET"),
		details.response,
		new URL("http://localhost/api/sessions/session-one/subagents/run-1%3A1"),
		context,
		["api", "sessions", "session-one", "subagents", "run-1:1"],
	);
	assert.deepEqual(details.result(), { status: 200, body: { live: snapshot } });

	const transcript = responseCapture();
	await routes.handleSessions(
		request("GET"),
		transcript.response,
		new URL("http://localhost/api/sessions/session-one/subagents/run-1%3A1/transcript?cursor=older&limit=40"),
		context,
		["api", "sessions", "session-one", "subagents", "run-1:1", "transcript"],
	);
	assert.equal(transcript.result().status, 200);
	assert.deepEqual(transcript.result().body, {
		...transcriptPage,
		items: [{ entryId: "entry-one", parentId: null, timestamp: "2026-09-17T00:00:00Z", kind: "message" }],
	});

	const abort = responseCapture();
	await routes.handleSessions(
		request("POST"),
		abort.response,
		new URL("http://localhost/api/sessions/session-one/subagents/run-1%3A1/abort"),
		context,
		["api", "sessions", "session-one", "subagents", "run-1:1", "abort"],
	);
	assert.deepEqual(abort.result(), { status: 200, body: { changed: true } });

	const continuation = responseCapture();
	await routes.handleSessions(
		request("POST", { text: "继续检查", clientRequestId: "continue-one" }),
		continuation.response,
		new URL("http://localhost/api/sessions/session-one/subagents/run-1%3A1/continue"),
		context,
		["api", "sessions", "session-one", "subagents", "run-1:1", "continue"],
	);
	assert.deepEqual(continuation.result(), { status: 200, body: { changed: true } });

	assert.deepEqual(
		commands.map((command) => command.command),
		["list_subagents", "read_subagent", "read_subagent", "read_transcript", "abort_subagent", "continue_subagent"],
	);
	assert.deepEqual(commands[0], { command: "list_subagents", sessionPath });
	assert.deepEqual(commands[1], { command: "read_subagent", sessionPath, agentId: "run-1:1" });
	assert.deepEqual(commands[2], { command: "read_subagent", sessionPath, agentId: "run-1:1" });
	assert.deepEqual(commands[3], {
		command: "read_transcript",
		sessionPath: childSessionPath,
		cursor: "older",
		limit: 40,
	});
	const abortCommand = commands[4];
	assert.equal(abortCommand?.command, "abort_subagent");
	if (abortCommand?.command === "abort_subagent") {
		assert.deepEqual(abortCommand, {
			command: "abort_subagent",
			sessionPath,
			agentId: "run-1:1",
			leaseId: "lease-one",
			clientInstanceId: "browser-one",
			clientRequestId: abortCommand.clientRequestId,
		});
		assert.notEqual(abortCommand.clientRequestId, "");
	}
	assert.deepEqual(commands[5], {
		command: "continue_subagent",
		sessionPath,
		agentId: "run-1:1",
		text: "继续检查",
		leaseId: "lease-one",
		clientInstanceId: "browser-one",
		clientRequestId: "continue-one",
	});

	const parentPage = responseCapture();
	await routes.handleSessions(
		request("GET"),
		parentPage.response,
		new URL("http://localhost/api/sessions/session-one/transcript?limit=999"),
		context,
		["api", "sessions", "session-one", "transcript"],
	);
	assert.equal(parentPage.result().status, 200);
	assert.deepEqual(commands.at(-1), { command: "read_transcript", sessionPath, limit: MAX_TRANSCRIPT_PAGE_SIZE });

	const childPage = responseCapture();
	await routes.handleSessions(
		request("GET"),
		childPage.response,
		new URL("http://localhost/api/sessions/session-one/subagents/run-1%3A1/transcript?limit=999"),
		context,
		["api", "sessions", "session-one", "subagents", "run-1:1", "transcript"],
	);
	assert.equal(childPage.result().status, 200);
	assert.deepEqual(commands.at(-1), {
		command: "read_transcript",
		sessionPath: childSessionPath,
		limit: MAX_TRANSCRIPT_PAGE_SIZE,
	});
});
