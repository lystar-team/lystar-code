import { afterEach, describe, expect, it, vi } from "vitest";
import { WebApi } from "../src/adapters/host-protocol/api.ts";

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

		expect(requests).toHaveLength(2);
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
	});
});
