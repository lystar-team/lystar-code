import { describe, expect, it } from "vitest";
import { generateImages } from "../src/api/openai-images.ts";
import { OPENAI_CODEX_GPT_IMAGE_2 } from "../src/providers/openai-codex-images.ts";
import { OPENAI_GPT_IMAGE_2 } from "../src/providers/openai-images.ts";
import type { ImagesContext } from "../src/types.ts";

const generatedPng = "iVBORw0KGgo=";
const promptContext: ImagesContext = { input: [{ type: "text", text: "a red circle" }] };

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function codexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("openai images provider", () => {
	it("uses the OpenAI generations endpoint for text-only requests", async () => {
		let requestUrl = "";
		let requestBody: Record<string, unknown> = {};
		const result = await generateImages(OPENAI_GPT_IMAGE_2, promptContext, {
			apiKey: "test-key",
			fetch: async (input, init) => {
				requestUrl = String(input);
				requestBody = JSON.parse(String(init?.body));
				return jsonResponse({ data: [{ b64_json: generatedPng }], usage: { input_tokens: 3, output_tokens: 5 } });
			},
		});

		expect(requestUrl).toBe("https://api.openai.com/v1/images/generations");
		expect(requestBody).toMatchObject({ prompt: "a red circle", model: "gpt-image-2", size: "auto" });
		expect(result.output).toEqual([{ type: "image", data: generatedPng, mimeType: "image/png" }]);
		expect(result.usage?.totalTokens).toBe(8);
	});

	it("honors an active provider API key, headers, and custom base URL", async () => {
		let requestUrl = "";
		let requestHeaders = new Headers();
		const result = await generateImages(
			{ ...OPENAI_GPT_IMAGE_2, baseUrl: "https://gateway.example/v1" },
			promptContext,
			{
				apiKey: "provider-key",
				headers: { "x-provider": "company" },
				fetch: async (input, init) => {
					requestUrl = String(input);
					requestHeaders = new Headers(init?.headers);
					return jsonResponse({ data: [{ b64_json: generatedPng }] });
				},
			},
		);

		expect(requestUrl).toBe("https://gateway.example/v1/images/generations");
		expect(requestHeaders.get("authorization")).toBe("Bearer provider-key");
		expect(requestHeaders.get("x-provider")).toBe("company");
		expect(result.stopReason).toBe("stop");
	});

	it("uses multipart OpenAI edits when reference images are present", async () => {
		let requestUrl = "";
		let requestBody: unknown;
		const result = await generateImages(
			OPENAI_GPT_IMAGE_2,
			{
				input: [
					{ type: "text", text: "make it blue" },
					{ type: "image", data: generatedPng, mimeType: "image/png" },
				],
			},
			{
				apiKey: "test-key",
				fetch: async (input, init) => {
					requestUrl = String(input);
					requestBody = init?.body;
					return jsonResponse({ data: [{ b64_json: generatedPng }] });
				},
			},
		);

		expect(requestUrl).toBe("https://api.openai.com/v1/images/edits");
		expect(requestBody).toBeInstanceOf(FormData);
		const form = requestBody as FormData;
		expect(form.get("prompt")).toBe("make it blue");
		expect(form.get("model")).toBe("gpt-image-2");
		expect(form.getAll("image[]")).toHaveLength(1);
		expect(result.stopReason).toBe("stop");
	});

	it("uses Codex OAuth headers and JSON image references", async () => {
		let requestUrl = "";
		let requestHeaders = new Headers();
		let requestBody: Record<string, unknown> = {};
		const token = codexToken("account-123");
		const result = await generateImages(
			OPENAI_CODEX_GPT_IMAGE_2,
			{
				input: [
					{ type: "text", text: "preserve composition; change color" },
					{ type: "image", data: generatedPng, mimeType: "image/png" },
				],
			},
			{
				apiKey: token,
				fetch: async (input, init) => {
					requestUrl = String(input);
					requestHeaders = new Headers(init?.headers);
					requestBody = JSON.parse(String(init?.body));
					return jsonResponse({ data: [{ b64_json: generatedPng }] });
				},
			},
		);

		expect(requestUrl).toBe("https://chatgpt.com/backend-api/codex/images/edits");
		expect(requestHeaders.get("authorization")).toBe(`Bearer ${token}`);
		expect(requestHeaders.get("chatgpt-account-id")).toBe("account-123");
		expect(requestHeaders.get("originator")).toBe("pi");
		expect(requestBody.images).toEqual([{ image_url: `data:image/png;base64,${generatedPng}` }]);
		expect(result.stopReason).toBe("stop");
	});

	it("returns a normal error result when credentials are missing", async () => {
		const result = await generateImages(OPENAI_GPT_IMAGE_2, promptContext);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("No API key for provider: openai");
	});
});
