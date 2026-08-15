import type { ImagesModel } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const generatedPng = "iVBORw0KGgo=";

describe("ModelRuntime image provider attribution", () => {
	it("adds OpenRouter attribution to image requests while preserving caller header overrides", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				openrouter: { type: "api_key", key: "test-key" },
			}),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const model = runtime.getImageModel("openrouter", "openai/gpt-image-2") as ImagesModel<"openrouter-images">;
		let requestHeaders = new Headers();

		const result = await runtime.generateImages(
			model,
			{ input: [{ type: "text", text: "a red circle" }] },
			{
				headers: { "X-OpenRouter-Title": "Caller title", "X-Caller": "custom" },
				fetch: async (_input, init) => {
					requestHeaders = new Headers(init?.headers);
					return new Response(
						JSON.stringify({
							id: "image-1",
							choices: [{ message: { images: [{ image_url: `data:image/png;base64,${generatedPng}` }] } }],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				},
			},
		);

		expect(result.stopReason).toBe("stop");
		expect(requestHeaders.get("http-referer")).toBe("https://github.com/lystar-team/lystar-code");
		expect(requestHeaders.get("x-openrouter-title")).toBe("Caller title");
		expect(requestHeaders.get("x-openrouter-categories")).toBe("cli-agent");
		expect(requestHeaders.get("x-caller")).toBe("custom");
	});
});
