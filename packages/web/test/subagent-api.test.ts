import { afterEach, describe, expect, it, vi } from "vitest";
import { WebApi } from "../src/adapters/host-protocol/api.ts";

describe("WebApi Subagent endpoints", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses the parent session routes and sends control request bodies", async () => {
		vi.stubGlobal("localStorage", {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
		});
		const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({
					path: String(input),
					method: init?.method ?? "GET",
					...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
				});
				return new Response(JSON.stringify({ subagents: [], items: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);
		const api = new WebApi();

		await api.subagents("parent");
		await api.subagent("parent", "run-1:1");
		await api.subagentTranscript("parent", "run-1:1", { cursor: "cursor-1", limit: 40 });
		await api.abortSubagent("parent", "run-1:1");
		await api.continueSubagent("parent", "run-1:1", "补充检查");

		expect(requests).toEqual([
			{ path: "/api/sessions/parent/subagents", method: "GET" },
			{ path: "/api/sessions/parent/subagents/run-1%3A1", method: "GET" },
			{
				path: "/api/sessions/parent/subagents/run-1%3A1/transcript?cursor=cursor-1&limit=40",
				method: "GET",
			},
			{
				path: "/api/sessions/parent/subagents/run-1%3A1/abort",
				method: "POST",
				body: { clientRequestId: expect.any(String) },
			},
			{
				path: "/api/sessions/parent/subagents/run-1%3A1/continue",
				method: "POST",
				body: { text: "补充检查", clientRequestId: expect.any(String) },
			},
		]);
	});
});
