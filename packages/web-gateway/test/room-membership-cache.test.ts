import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RequestOptions, RuntimeProtocolClient, ServerEvent, SessionSummary } from "@lystar/code-web-protocol";
import type { WebGatewayConfig } from "../src/config.ts";
import type { WebProject } from "../src/project-registry.ts";
import type { RoomSessionMembership } from "../src/room-session-visibility.ts";
import { WebGatewayServer } from "../src/server.ts";

test("多浏览器读取会话时复用 Room 成员关系，成员变化及 Runtime 断线后重取", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-room-membership-"));
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "host.sock"),
		token: "room-membership-test",
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	} satisfies WebGatewayConfig);
	t.after(async () => {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	});
	await server.registry.load();
	const project = await server.registry.add({ id: "project", cwd: agentDir });
	const session: SessionSummary = {
		id: "agent",
		path: join(agentDir, "session.jsonl"),
		cwd: agentDir,
		createdAt: 1,
		updatedAt: 1,
		messageCount: 0,
		firstMessage: "",
		activity: "idle",
		writeAccess: "available",
	};
	const calls: string[] = [];
	let memberPresent = true;
	const client = {
		getSnapshot: () => ({ connected: true }),
		request: async ({ command }: { command: string }, options?: RequestOptions) => {
			calls.push(command);
			assert.equal(options?.keepConnectionOnTimeout, true);
			return command === "list_project_sessions"
				? {
						sessions: [session],
						rooms: [{ members: memberPresent ? [{ sessionId: "agent", role: "member" }] : [] }],
					}
				: [session];
		},
	} as unknown as RuntimeProtocolClient;
	const internal = server as unknown as {
		createContext(id: string): { client?: RuntimeProtocolClient };
		listProjectSessions(
			context: { client?: RuntimeProtocolClient },
			project: WebProject,
		): Promise<Array<{ roomMember?: true }>>;
		handleHostEvent(context: { client?: RuntimeProtocolClient }, event: ServerEvent): void;
		handleRuntimeDisconnect(context: { client?: RuntimeProtocolClient }, client: RuntimeProtocolClient): void;
	};
	const first = internal.createContext("first");
	first.client = client;
	const second = internal.createContext("second");
	second.client = client;
	assert.equal((await internal.listProjectSessions(first, project))[0]?.roomMember, true);
	assert.equal((await internal.listProjectSessions(second, project))[0]?.roomMember, true);
	assert.deepEqual(calls, ["list_project_sessions", "list_sessions"]);

	memberPresent = false;
	for (const context of [first, second]) {
		internal.handleHostEvent(context, {
			type: "room_updated",
			cwd: agentDir,
			roomId: "room",
			latestSeq: 0,
			messagesChanged: false,
			tasksChanged: false,
			membersChanged: true,
		});
	}
	assert.equal((await internal.listProjectSessions(first, project))[0]?.roomMember, undefined);
	assert.equal((await internal.listProjectSessions(second, project))[0]?.roomMember, undefined);
	assert.deepEqual(calls.slice(2), ["list_project_sessions", "list_sessions"]);

	internal.handleRuntimeDisconnect(first, client);
	first.client = client;
	await internal.listProjectSessions(first, project);
	assert.deepEqual(calls.slice(4), ["list_project_sessions"]);
});

test("并发浏览器复用在途 Room 成员，保留各自的会话写入权限", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-concurrent-rooms-"));
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "host.sock"),
		token: "concurrent-rooms-test",
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	} satisfies WebGatewayConfig);
	t.after(async () => {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	});
	await server.registry.load();
	const project = await server.registry.add({ id: "project", cwd: agentDir });
	const session: SessionSummary = {
		id: "agent",
		path: join(agentDir, "agent.jsonl"),
		cwd: agentDir,
		createdAt: 1,
		updatedAt: 1,
		messageCount: 0,
		firstMessage: "",
		activity: "idle",
		writeAccess: "owned",
	};
	const rooms: RoomSessionMembership[] = [{ members: [{ sessionId: "agent", role: "member" }] }];
	let notifyStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		notifyStarted = resolve;
	});
	let notifySecondStarted!: () => void;
	const secondStarted = new Promise<void>((resolve) => {
		notifySecondStarted = resolve;
	});
	let finishCombined!: (result: { sessions: SessionSummary[]; rooms: RoomSessionMembership[] }) => void;
	const combined = new Promise<{ sessions: SessionSummary[]; rooms: RoomSessionMembership[] }>((resolve) => {
		finishCombined = resolve;
	});
	const calls: string[] = [];
	const firstClient = {
		getSnapshot: () => ({ connected: true }),
		request: ({ command }: { command: string }) => {
			calls.push(`first:${command}`);
			notifyStarted();
			return combined;
		},
	} as unknown as RuntimeProtocolClient;
	const secondClient = {
		getSnapshot: () => ({ connected: true }),
		request: ({ command }: { command: string }) => {
			calls.push(`second:${command}`);
			notifySecondStarted();
			return Promise.resolve([{ ...session, writeAccess: "available" }]);
		},
	} as unknown as RuntimeProtocolClient;
	const internal = server as unknown as {
		createContext(id: string): { client?: RuntimeProtocolClient };
		listProjectSessions(
			context: { client?: RuntimeProtocolClient },
			project: WebProject,
		): Promise<Array<{ roomMember?: true; writeAccess: string }>>;
	};
	const first = internal.createContext("first");
	first.client = firstClient;
	const second = internal.createContext("second");
	second.client = secondClient;
	const firstResult = internal.listProjectSessions(first, project);
	await started;
	const secondResult = internal.listProjectSessions(second, project);
	await secondStarted;
	assert.deepEqual(calls, ["first:list_project_sessions", "second:list_sessions"]);
	finishCombined({ sessions: [session], rooms });
	const [owned, available] = await Promise.all([firstResult, secondResult]);
	assert.deepEqual(calls, ["first:list_project_sessions", "second:list_sessions"]);
	assert.equal(owned[0]?.writeAccess, "owned");
	assert.equal(available[0]?.writeAccess, "available");
	assert.equal(owned[0]?.roomMember, true);
	assert.equal(available[0]?.roomMember, true);
});

test("共享查询的连接失败后，其他浏览器独立读取 Room 成员", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-failed-rooms-"));
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "host.sock"),
		token: "failed-rooms-test",
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	} satisfies WebGatewayConfig);
	t.after(async () => {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	});
	await server.registry.load();
	const project = await server.registry.add({ id: "project", cwd: agentDir });
	const session: SessionSummary = {
		id: "agent",
		path: join(agentDir, "agent.jsonl"),
		cwd: agentDir,
		createdAt: 1,
		updatedAt: 1,
		messageCount: 0,
		firstMessage: "",
		activity: "idle",
		writeAccess: "available",
	};
	let notifyFirst!: () => void;
	const firstStarted = new Promise<void>((resolve) => {
		notifyFirst = resolve;
	});
	let notifySecond!: () => void;
	const secondStarted = new Promise<void>((resolve) => {
		notifySecond = resolve;
	});
	let rejectFirst!: (error: Error) => void;
	const failedRequest = new Promise<never>((_resolve, reject) => {
		rejectFirst = reject;
	});
	const calls: string[] = [];
	const firstClient = {
		getSnapshot: () => ({ connected: true }),
		request: ({ command }: { command: string }) => {
			calls.push(`first:${command}`);
			notifyFirst();
			return failedRequest;
		},
	} as unknown as RuntimeProtocolClient;
	const secondClient = {
		getSnapshot: () => ({ connected: true }),
		request: ({ command }: { command: string }) => {
			calls.push(`second:${command}`);
			if (command === "list_sessions") notifySecond();
			return Promise.resolve(
				command === "list_sessions" ? [session] : [{ members: [{ sessionId: "agent", role: "member" }] }],
			);
		},
	} as unknown as RuntimeProtocolClient;
	const internal = server as unknown as {
		createContext(id: string): { client?: RuntimeProtocolClient };
		listProjectSessions(
			context: { client?: RuntimeProtocolClient },
			project: WebProject,
		): Promise<Array<{ roomMember?: true }>>;
	};
	const first = internal.createContext("first");
	first.client = firstClient;
	const second = internal.createContext("second");
	second.client = secondClient;
	const firstResult = internal.listProjectSessions(first, project);
	await firstStarted;
	const secondResult = internal.listProjectSessions(second, project);
	await secondStarted;
	rejectFirst(new Error("request_timeout"));
	await assert.rejects(firstResult, /request_timeout/);
	assert.equal((await secondResult)[0]?.roomMember, true);
	assert.deepEqual(calls, ["first:list_project_sessions", "second:list_sessions", "second:room_project_list"]);
	const third = internal.createContext("third");
	third.client = secondClient;
	assert.equal((await internal.listProjectSessions(third, project))[0]?.roomMember, true);
	assert.equal(calls.at(-1), "second:list_sessions");
});

test("成员变化会撤销在途结果，旧查询完成不能覆盖新缓存", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-inflight-rooms-"));
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "host.sock"),
		token: "inflight-rooms-test",
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	} satisfies WebGatewayConfig);
	t.after(async () => {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	});
	await server.registry.load();
	const project = await server.registry.add({ id: "project", cwd: agentDir });
	const session: SessionSummary = {
		id: "agent",
		path: join(agentDir, "agent.jsonl"),
		cwd: agentDir,
		createdAt: 1,
		updatedAt: 1,
		messageCount: 0,
		firstMessage: "",
		activity: "idle",
		writeAccess: "available",
	};
	let notifyStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		notifyStarted = resolve;
	});
	let finishOld!: (result: { sessions: SessionSummary[]; rooms: RoomSessionMembership[] }) => void;
	const oldRequest = new Promise<{ sessions: SessionSummary[]; rooms: RoomSessionMembership[] }>((resolve) => {
		finishOld = resolve;
	});
	const calls: string[] = [];
	const client = {
		getSnapshot: () => ({ connected: true }),
		request: ({ command }: { command: string }) => {
			calls.push(command);
			if (command === "list_project_sessions" && calls.length === 1) {
				notifyStarted();
				return oldRequest;
			}
			return command === "list_project_sessions"
				? Promise.resolve({ sessions: [session], rooms: [] })
				: Promise.resolve([session]);
		},
	} as unknown as RuntimeProtocolClient;
	const internal = server as unknown as {
		createContext(id: string): { client?: RuntimeProtocolClient };
		listProjectSessions(
			context: { client?: RuntimeProtocolClient },
			project: WebProject,
		): Promise<Array<{ roomMember?: true }>>;
		handleHostEvent(context: { client?: RuntimeProtocolClient }, event: ServerEvent): void;
	};
	const first = internal.createContext("first");
	first.client = client;
	const oldResult = internal.listProjectSessions(first, project);
	await started;
	internal.handleHostEvent(first, {
		type: "room_updated",
		cwd: agentDir,
		roomId: "room",
		latestSeq: 0,
		messagesChanged: false,
		tasksChanged: false,
		membersChanged: true,
	});
	const second = internal.createContext("second");
	second.client = client;
	assert.equal((await internal.listProjectSessions(second, project))[0]?.roomMember, undefined);
	finishOld({ sessions: [session], rooms: [{ members: [{ sessionId: "agent", role: "member" }] }] });
	await oldResult;
	const third = internal.createContext("third");
	third.client = client;
	assert.equal((await internal.listProjectSessions(third, project))[0]?.roomMember, undefined);
	assert.deepEqual(calls, ["list_project_sessions", "list_project_sessions", "list_sessions"]);
});

test("空会话项目仅请求一次，出现会话后从缓存标记 Room 成员", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-empty-project-"));
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "host.sock"),
		token: "empty-project-test",
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	} satisfies WebGatewayConfig);
	t.after(async () => {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	});
	await server.registry.load();
	const project = await server.registry.add({ id: "empty", cwd: agentDir });
	const calls: string[] = [];
	let hasSession = false;
	const client = {
		getSnapshot: () => ({ connected: true }),
		request: async ({ command }: { command: string }) => {
			calls.push(command);
			const sessions = hasSession
				? [
						{
							id: "agent",
							path: join(agentDir, "agent.jsonl"),
							cwd: agentDir,
							createdAt: 1,
							updatedAt: 1,
							messageCount: 0,
							firstMessage: "",
							activity: "idle",
							writeAccess: "available",
						},
					]
				: [];
			return command === "list_project_sessions"
				? { sessions, rooms: [{ members: [{ sessionId: "agent", role: "member" }] }] }
				: sessions;
		},
	} as unknown as RuntimeProtocolClient;
	const internal = server as unknown as {
		createContext(id: string): { client?: RuntimeProtocolClient };
		listProjectSessions(
			context: { client?: RuntimeProtocolClient },
			project: WebProject,
		): Promise<Array<{ roomMember?: true }>>;
	};
	const first = internal.createContext("empty-project");
	first.client = client;
	assert.deepEqual(await internal.listProjectSessions(first, project), []);
	assert.deepEqual(calls, ["list_project_sessions"]);

	hasSession = true;
	const second = internal.createContext("new-session");
	second.client = client;
	assert.equal((await internal.listProjectSessions(second, project))[0]?.roomMember, true);
	assert.deepEqual(calls, ["list_project_sessions", "list_sessions"]);
});
