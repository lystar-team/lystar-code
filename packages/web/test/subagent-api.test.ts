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

	it("sends the stable role id for session creation, editing and deletion, not the display name", async () => {
		vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
		const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ path: String(input), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
				return new Response(JSON.stringify({ subagents: [], session: { id: "session" }, lease: {} }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);
		const api = new WebApi();
		await api.createSession("project", "frontend-developer");
		await api.saveSubagentConfig("project", {
			scope: "user",
			id: "frontend-developer",
			name: "页面开发",
			description: "实现页面",
			content: "只处理页面。",
			expectedHash: "hash",
		});
		await api.deleteSubagentConfig("project", { scope: "user", id: "frontend-developer", contentHash: "hash" });
		expect(requests[0]!.body).toMatchObject({ profileId: "frontend-developer" });
		expect(requests[1]!.body).toMatchObject({ id: "frontend-developer", name: "页面开发", expectedHash: "hash" });
		expect(requests[1]!.body).not.toHaveProperty("originalName");
		expect(requests[2]!.body).toMatchObject({ scope: "user", id: "frontend-developer", expectedHash: "hash" });
		expect(requests[2]!.body).not.toHaveProperty("name");
	});
});
