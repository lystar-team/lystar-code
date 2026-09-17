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
