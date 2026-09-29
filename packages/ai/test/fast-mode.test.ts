import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as streamCodexSimple } from "../src/api/openai-codex-responses.ts";
import { streamSimple as streamOpenAISimple } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const context = normalizeContext({
	systemPrompt: "sys",
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
});

function completedResponse(): Response {
	return new Response(
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				service_tier: "priority",
				usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
			},
		})}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

describe("OpenAI simple-stream fast mode", () => {
	afterEach(() => vi.restoreAllMocks());

	it("passes the selected tier to the OpenAI Responses request", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return completedResponse();
		});
		const model = getModel("openai", "gpt-5.4");
		await streamOpenAISimple(model, context, { apiKey: "test-key", serviceTier: "priority" }).result();
		await streamOpenAISimple(model, context, { apiKey: "test-key", serviceTier: "default" }).result();
		expect(bodies.map((body) => body.service_tier)).toEqual(["priority", "default"]);
	});

	it("passes the selected tier to the ChatGPT Codex request", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			const body = init?.body;
			const text =
				body instanceof Uint8Array ? Buffer.from(zstdDecompressSync(body)).toString("utf8") : String(body);
			bodies.push(JSON.parse(text) as Record<string, unknown>);
			return completedResponse();
		});
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const account = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		).toString("base64");
		const result = await streamCodexSimple(model, context, {
			apiKey: `aaa.${account}.bbb`,
			serviceTier: "priority",
			transport: "sse",
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(bodies.some((body) => body.service_tier === "priority")).toBe(true);
	});
});
