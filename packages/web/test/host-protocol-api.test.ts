import { afterEach, describe, expect, it, vi } from "vitest";
import { WebApi } from "../src/adapters/host-protocol/api.ts";

function createSubscriptionSocket(): {
	socket: WebSocket;
	sent: string[];
	open(): void;
} {
	let readyState = 0;
	const sent: string[] = [];
	const listeners = new Map<string, Set<() => void>>();
	const socket = {
		get readyState() {
			return readyState;
		},
		send(payload: string) {
			sent.push(payload);
		},
		addEventListener(type: string, listener: () => void) {
			const current = listeners.get(type) ?? new Set<() => void>();
			current.add(listener);
			listeners.set(type, current);
		},
		removeEventListener(type: string, listener: () => void) {
			listeners.get(type)?.delete(listener);
		},
	} as unknown as WebSocket;
	return {
		socket,
		sent,
		open() {
			readyState = 1;
			for (const listener of listeners.get("open") ?? []) listener();
		},
	};
}

describe("WebApi read cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("取消发生在响应体读取期间时返回取消错误，不把响应当成成功", async () => {
		vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
		const controller = new AbortController();
		const response = new Response("{}", { status: 200 });
		let finishBody!: (value: { items: [] }) => void;
		const body = vi.spyOn(response, "json").mockImplementation(
			() =>
				new Promise((resolve) => {
					finishBody = resolve;
				}),
		);
		const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => response);
		vi.stubGlobal("fetch", fetchMock);
		const pending = new WebApi().transcript("session", { signal: controller.signal });
		await vi.waitFor(() => expect(body).toHaveBeenCalledTimes(1));
		controller.abort();
		finishBody({ items: [] });
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
	});

	it("已取消的读取不解析响应，写入请求没有共享取消信号", async () => {
		vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
		const controller = new AbortController();
		controller.abort();
		const response = new Response("{}", { status: 200 });
		const body = vi.spyOn(response, "json");
		const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => response);
		vi.stubGlobal("fetch", fetchMock);
		const api = new WebApi();
		await expect(api.operations("session", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(body).not.toHaveBeenCalled();
		await api.prompt("session", "任务");
		expect(fetchMock.mock.calls[1]?.[1]?.signal).toBeUndefined();
		expect(body).toHaveBeenCalledTimes(1);
	});
});

describe("WebApi prompt admission", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reuses the candidate queue ID for prompt admission and sends it on follow-up fallback", async () => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		});
		const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({
					path: String(input),
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				});
				return new Response(JSON.stringify({ accepted: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);
		const api = new WebApi();

		await api.prompt("session", "first", "prompt", undefined, "queue-1");
		await api.prompt("session", "first", "follow-up", undefined, "queue-1");
		await api.prompt("session", "adjust", "steer", undefined, "queue-2");

		expect(requests).toHaveLength(3);
		expect(requests[0]).toMatchObject({
			path: "/api/sessions/session/prompt",
			body: { text: "first", clientRequestId: "queue-1" },
		});
		expect(requests[0]?.body).not.toHaveProperty("queueId");
		expect(requests[1]).toMatchObject({
			path: "/api/sessions/session/follow-up",
			body: { text: "first", queueId: "queue-1" },
		});
		expect(requests[1]?.body.clientRequestId).not.toBe("queue-1");
		expect(requests[2]).toMatchObject({
			path: "/api/sessions/session/steer",
			body: { text: "adjust", queueId: "queue-2" },
		});
	});
});

describe("WebApi session creation", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends Room startup notification policy only when requested", async () => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		});
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify({ session: {}, lease: {} }), {
					status: 201,
					headers: { "Content-Type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const api = new WebApi();

		await api.createSession("project-1", "reviewer", { roomAgent: true, suppressInfoNotifications: true });
		await api.createSession("project-1");

		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			projectId: "project-1",
			profileId: "reviewer",
			roomAgent: true,
			suppressInfoNotifications: true,
		});
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ projectId: "project-1" });
	});
});

describe("WebApi fast mode", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("updates the session with an explicit mode and request ID", async () => {
		vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify({ session: { fastMode: true } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const result = await new WebApi().fastMode("session/1", true);

		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions/session%2F1/fast-mode");
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			enabled: true,
			clientRequestId: expect.any(String),
		});
		expect(result.session.fastMode).toBe(true);
	});
});

describe("WebApi session abort", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("stops the session without sending an operation ID", async () => {
		vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify({ stopped: true, session: { id: "session/1", phase: "idle" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await new WebApi().abort("session/1");

		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions/session%2F1/abort");
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty("operationId");
		expect(result).toEqual({ stopped: true, session: { id: "session/1", phase: "idle" } });
	});
});

describe("WebApi WebSocket subscriptions", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("flushes pending session and project subscriptions when the socket opens", () => {
		vi.stubGlobal("WebSocket", { CONNECTING: 0, OPEN: 1, CLOSED: 3 });
		const api = new WebApi();
		const connection = createSubscriptionSocket();

		api.subscribeSession(connection.socket, "session-1", 7);
		api.subscribeProject(connection.socket, "project-1");
		api.unsubscribeProject(connection.socket, "project-1");
		api.subscribeProject(connection.socket, "project-2");
		connection.open();

		expect(connection.sent.map((payload) => JSON.parse(payload))).toEqual([
			{ type: "subscribe_session", sessionId: "session-1", lastSeq: 7 },
			{ type: "subscribe_project", projectId: "project-2" },
		]);

		api.unsubscribeProject(connection.socket, "project-2");
		expect(JSON.parse(connection.sent.at(-1)!)).toEqual({
			type: "unsubscribe_project",
			projectId: "project-2",
		});
	});
});
