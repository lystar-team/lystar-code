import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantImages,
	type ImagesApi,
	type ImagesModel,
	InMemoryModelsStore,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import imageGenExtension, { createImageGenToolDefinition } from "../src/extensions/image-gen/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

const pngData = "iVBORw0KGgo=";
type TestImageModelId = "gpt-image-2" | "gpt-image-2.5-flare" | "gpt-image-2.5-sunburst";

function imageModel(provider: string, modelId: TestImageModelId = "gpt-image-2"): ImagesModel<ImagesApi> {
	return {
		id: provider === "openrouter" ? `openai/${modelId}` : modelId,
		name: modelId,
		api: provider === "openrouter" ? "openrouter-images" : "openai-images",
		provider,
		baseUrl: "https://example.test",
		input: ["text", "image"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function imageResult(model: ImagesModel<ImagesApi>): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [{ type: "image", data: pngData, mimeType: "image/png" }],
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function imageError(model: ImagesModel<ImagesApi>, errorMessage: string): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function chatModel(provider: string, api: Api, baseUrl: string): Model<Api> {
	return {
		id: "chat-model",
		name: "Chat Model",
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

describe("image_gen extension tool", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "lystar-image-gen-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(tempRoot, "agent"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("registers the hidden Tool and bundled Skill together", async () => {
		expect(builtInExtensions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "image-gen", factory: imageGenExtension, hidden: true }),
			]),
		);
		const extension = await loadExtensionFromFactory(
			imageGenExtension,
			tempRoot,
			createEventBus(),
			createExtensionRuntime(),
			"<inline:image-gen>",
		);
		expect(extension.tools.get("image_gen")?.definition.name).toBe("image_gen");
		const discover = extension.handlers.get("resources_discover")?.[0];
		const resources = (await discover?.(
			{ type: "resources_discover", cwd: tempRoot, reason: "startup" },
			{} as ExtensionToolContext,
		)) as { skillPaths?: string[] } | undefined;
		const skillPath = resources?.skillPaths?.[0];
		expect(skillPath).toMatch(/skills[/\\]imagegen[/\\]SKILL\.md$/);
		expect(skillPath && existsSync(skillPath)).toBe(true);
		expect(skillPath && existsSync(join(skillPath, "..", "references", "model-selection.md"))).toBe(true);
	});

	it("uses auto standard Flare through the active OpenAI-compatible provider and emits stable stages", async () => {
		const openAI = imageModel("openai", "gpt-image-2.5-flare");
		const activeModel = chatModel("company-openai", "openai-responses", "https://gateway.example/v1");
		const generateImages = vi.fn(async (model: ImagesModel<ImagesApi>) => imageResult(model));
		const getImageProviderAuth = vi.fn(async () => undefined);
		const onUpdate = vi.fn();
		const ctx = {
			cwd: tempRoot,
			model: activeModel,
			modelRegistry: {
				findImage: (provider: string, id: string) =>
					provider === "openai" && id === "gpt-image-2.5-flare" ? openAI : undefined,
				getApiKeyAndHeaders: async () => ({
					ok: true,
					apiKey: "provider-key",
					headers: { "x-provider": "company" },
					baseUrl: "https://resolved.example/v1",
				}),
				getImageProviderAuth,
				generateImages,
			},
			sessionManager: { getSessionId: () => "session:1", getBranch: () => [] },
		} as unknown as ExtensionToolContext;

		const result = await createImageGenToolDefinition().execute(
			"call/1",
			{ prompt: "a red circle", referenced_image_paths: [], num_last_images_to_include: 0 },
			undefined,
			onUpdate,
			ctx,
		);

		expect(generateImages).toHaveBeenCalledWith(
			{ ...openAI, baseUrl: "https://resolved.example/v1" },
			{ input: [{ type: "text", text: "a red circle" }] },
			{
				apiKey: "provider-key",
				headers: { "x-provider": "company" },
				env: undefined,
				signal: undefined,
			},
		);
		expect(getImageProviderAuth).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({
			provider: "company-openai",
			model: "gpt-image-2.5-flare",
			requestedModel: "auto",
			profile: "standard",
			mode: "generate",
			mimeType: "image/png",
		});
		expect(result.details?.savedPath).toContain(join("generated_images", "session_1", "call_1.png"));
		expect(readFileSync(result.details!.savedPath).toString("base64")).toBe(pngData);
		expect(result.content.at(-1)).toEqual({ type: "image", data: pngData, mimeType: "image/png" });
		expect(onUpdate.mock.calls.map(([update]) => update.content[0].text)).toEqual([
			"正在准备生成参数",
			"正在使用 company-openai/gpt-image-2.5-flare 生成图片",
			"图片生成完成，正在保存原图",
		]);
	});

	it("uses the configured existing Provider instead of the active LLM Provider", async () => {
		const openAI = imageModel("openai", "gpt-image-2.5-flare");
		const activeModel = chatModel("third-party", "openai-responses", "https://llm.example/v1");
		const configuredModel = chatModel("image-provider", "openai-responses", "https://image.example/v1");
		const generateImages = vi.fn(async (model: ImagesModel<ImagesApi>) => imageResult(model));
		const getApiKeyAndHeaders = vi.fn(async (model: Model<Api>) => ({
			ok: true as const,
			apiKey: model.provider === "image-provider" ? "image-key" : "llm-key",
			baseUrl: "https://resolved-image.example/v1",
		}));
		const getImageModelProviders = vi.fn(() => ({ "gpt-image-2.5-flare": "image-provider" }));
		const getProvider = vi.fn((provider: string) =>
			provider === "image-provider"
				? { id: provider, name: "Image Provider", baseUrl: "https://image.example/v1" }
				: undefined,
		);
		const ctx = {
			cwd: tempRoot,
			model: activeModel,
			modelRegistry: {
				getImageModelProviders,
				getProvider,
				getAll: () => [configuredModel],
				findImage: (provider: string, id: string) =>
					provider === "openai" && id === "gpt-image-2.5-flare" ? openAI : undefined,
				getApiKeyAndHeaders,
				generateImages,
			},
			sessionManager: { getSessionId: () => "session-configured-image", getBranch: () => [] },
		} as unknown as ExtensionToolContext;

		const result = await createImageGenToolDefinition().execute(
			"call-configured-image",
			{ prompt: "a red circle" },
			undefined,
			undefined,
			ctx,
		);

		expect(getImageModelProviders).toHaveBeenCalled();
		expect(getProvider).toHaveBeenCalledWith("image-provider");
		expect(getApiKeyAndHeaders).toHaveBeenCalledWith(configuredModel);
		expect(generateImages).toHaveBeenCalledWith(
			{ ...openAI, baseUrl: "https://resolved-image.example/v1" },
			{ input: [{ type: "text", text: "a red circle" }] },
			{
				apiKey: "image-key",
				headers: undefined,
				env: undefined,
				signal: undefined,
			},
		);
		expect(result.details).toMatchObject({ provider: "image-provider", model: "gpt-image-2.5-flare" });
	});

	it("generates through a custom OpenAI-compatible upstream configured in imageModelProviders", async () => {
		const requests: Array<{ url: string | undefined; authorization: string | undefined; model: string | undefined }> =
			[];
		const server = createServer((request, response) => {
			let raw = "";
			request.on("data", (chunk) => {
				raw += chunk;
			});
			request.on("end", () => {
				const body = JSON.parse(raw) as { model?: string };
				requests.push({ url: request.url, authorization: request.headers.authorization, model: body.model });
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ data: [{ b64_json: pngData }] }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		try {
			const modelsPath = join(tempRoot, "models.json");
			writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						upstream: {
							name: "upstream",
							baseUrl,
							api: "openai-responses",
							apiKey: "sk-upstream",
							authHeader: true,
							models: [
								{
									id: "gpt-6.1-sol",
									name: "GPT 6.1 Sol",
									api: "openai-responses",
									baseUrl,
									reasoning: true,
									input: ["text", "image"],
									contextWindow: 272000,
									maxTokens: 128000,
								},
							],
						},
					},
					imageModelProviders: { "gpt-image-2.5-sunburst": "upstream" },
				}),
			);
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsStore: new InMemoryModelsStore(),
				modelsPath,
				allowModelNetwork: false,
			});
			const ctx = {
				cwd: tempRoot,
				model: runtime.getModel("upstream", "gpt-6.1-sol"),
				modelRegistry: new ModelRegistry(runtime),
				sessionManager: { getSessionId: () => "session-upstream", getBranch: () => [] },
			} as unknown as ExtensionToolContext;

			const result = await createImageGenToolDefinition().execute(
				"call-upstream",
				{ prompt: "a red circle", model: "gpt-image-2.5-sunburst" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.details).toMatchObject({ provider: "upstream", model: "gpt-image-2.5-sunburst" });
			expect(requests).toEqual([
				{ url: "/v1/images/generations", authorization: "Bearer sk-upstream", model: "gpt-image-2.5-sunburst" },
			]);
		} finally {
			server.close();
		}
	});

	it("uses Sunburst for automatic precision work", async () => {
		const sunburst = imageModel("openai", "gpt-image-2.5-sunburst");
		const generateImages = vi.fn(async (model: ImagesModel<ImagesApi>) => imageResult(model));
		const ctx = {
			cwd: tempRoot,
			model: chatModel("anthropic", "anthropic-messages", "https://api.anthropic.com"),
			modelRegistry: {
				findImage: (provider: string, id: string) =>
					provider === "openai" && id === "gpt-image-2.5-sunburst" ? sunburst : undefined,
				getImageProviderAuth: async (provider: string) =>
					provider === "openai" ? { auth: { apiKey: "key" } } : undefined,
				generateImages,
			},
			sessionManager: { getSessionId: () => "session-precision", getBranch: () => [] },
		} as unknown as ExtensionToolContext;

		const result = await createImageGenToolDefinition().execute(
			"call-precision",
			{ prompt: "preserve exact package typography", profile: "precision" },
			undefined,
			undefined,
			ctx,
		);

		expect(generateImages).toHaveBeenCalledWith(
			sunburst,
			{ input: [{ type: "text", text: "preserve exact package typography" }] },
			{ signal: undefined },
		);
		expect(result.details).toMatchObject({
			model: "gpt-image-2.5-sunburst",
			requestedModel: "auto",
			profile: "precision",
		});
	});

	it("falls back from unavailable Codex auth and includes recent conversation images", async () => {
		const codex = imageModel("openai-codex");
		const openAI = imageModel("openai");
		const generateImages = vi.fn(async (model: ImagesModel<ImagesApi>) => imageResult(model));
		const authAttempts: string[] = [];
		const ctx = {
			cwd: tempRoot,
			model: chatModel("anthropic", "anthropic-messages", "https://api.anthropic.com"),
			modelRegistry: {
				findImage: (provider: string, id: string) => {
					if (id !== "gpt-image-2") return undefined;
					return provider === "openai-codex" ? codex : provider === "openai" ? openAI : undefined;
				},
				getImageProviderAuth: async (provider: string) => {
					authAttempts.push(provider);
					return provider === "openai" ? { auth: { apiKey: "key" } } : undefined;
				},
				generateImages,
			},
			sessionManager: {
				getSessionId: () => "session-2",
				getBranch: () => [
					{
						type: "message",
						id: "message-1",
						parentId: null,
						timestamp: new Date().toISOString(),
						message: { role: "user", content: [{ type: "image", data: pngData, mimeType: "image/png" }] },
					},
				],
			},
		} as unknown as ExtensionToolContext;

		await createImageGenToolDefinition().execute(
			"call-2",
			{ prompt: "make it blue", model: "gpt-image-2", num_last_images_to_include: 1 },
			undefined,
			undefined,
			ctx,
		);

		expect(authAttempts).toEqual(["openai-codex", "openai"]);
		expect(generateImages).toHaveBeenCalledWith(
			openAI,
			{
				input: [
					{ type: "text", text: "make it blue" },
					{ type: "image", data: pngData, mimeType: "image/png" },
				],
			},
			{ signal: undefined },
		);
	});

	it("uses GPT Image 2 only as the compatibility fallback for automatic selection", async () => {
		const codex = imageModel("openai-codex");
		const generateImages = vi.fn(async (model: ImagesModel<ImagesApi>) => imageResult(model));
		const ctx = {
			cwd: tempRoot,
			model: chatModel("anthropic", "anthropic-messages", "https://api.anthropic.com"),
			modelRegistry: {
				findImage: (provider: string, id: string) =>
					provider === "openai-codex" && id === "gpt-image-2" ? codex : undefined,
				getImageProviderAuth: async (provider: string) =>
					provider === "openai-codex" ? { auth: { apiKey: "codex-token" } } : undefined,
				generateImages,
			},
			sessionManager: { getSessionId: () => "session-fallback", getBranch: () => [] },
		} as unknown as ExtensionToolContext;

		const result = await createImageGenToolDefinition().execute(
			"call-fallback",
			{ prompt: "a fallback image" },
			undefined,
			undefined,
			ctx,
		);

		expect(generateImages).toHaveBeenCalledTimes(1);
		expect(generateImages.mock.calls[0]?.[0]).toBe(codex);
		expect(result.details).toMatchObject({ model: "gpt-image-2", requestedModel: "auto", profile: "standard" });
	});

	it("continues to the next configured credential when the active provider request fails", async () => {
		const openAI = imageModel("openai");
		const codex = imageModel("openai-codex");
		const generateImages = vi
			.fn()
			.mockImplementationOnce(async (model: ImagesModel<ImagesApi>) => imageError(model, "401 invalid API key"))
			.mockImplementationOnce(async (model: ImagesModel<ImagesApi>) => imageResult(model));
		const ctx = {
			cwd: tempRoot,
			model: chatModel("company-openai", "openai-completions", "https://gateway.example/v1"),
			modelRegistry: {
				findImage: (provider: string, id: string) => {
					if (id !== "gpt-image-2") return undefined;
					return provider === "openai" ? openAI : provider === "openai-codex" ? codex : undefined;
				},
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "bad-key" }),
				getImageProviderAuth: async (provider: string) =>
					provider === "openai-codex" ? { auth: { apiKey: "codex-token" } } : undefined,
				generateImages,
			},
			sessionManager: { getSessionId: () => "session-3", getBranch: () => [] },
		} as unknown as ExtensionToolContext;

		const result = await createImageGenToolDefinition().execute(
			"call-3",
			{ prompt: "a red circle", model: "gpt-image-2" },
			undefined,
			undefined,
			ctx,
		);

		expect(generateImages).toHaveBeenCalledTimes(2);
		expect(generateImages.mock.calls[0]?.[0]).toMatchObject({
			provider: "openai",
			baseUrl: "https://gateway.example/v1",
		});
		expect(generateImages.mock.calls[1]?.[0]).toBe(codex);
		expect(result.details).toMatchObject({ provider: "openai-codex", model: "gpt-image-2" });
	});

	it("maps explicit Sunburst to the OpenRouter model ID", async () => {
		const sunburst = imageModel("openrouter", "gpt-image-2.5-sunburst");
		const generateImages = vi.fn(async (model: ImagesModel<ImagesApi>) => imageResult(model));
		const ctx = {
			cwd: tempRoot,
			model: chatModel("anthropic", "anthropic-messages", "https://api.anthropic.com"),
			modelRegistry: {
				findImage: (provider: string, id: string) =>
					provider === "openrouter" && id === "openai/gpt-image-2.5-sunburst" ? sunburst : undefined,
				getImageProviderAuth: async (provider: string) =>
					provider === "openrouter" ? { auth: { apiKey: "openrouter-key" } } : undefined,
				generateImages,
			},
			sessionManager: { getSessionId: () => "session-openrouter", getBranch: () => [] },
		} as unknown as ExtensionToolContext;

		const result = await createImageGenToolDefinition().execute(
			"call-openrouter",
			{ prompt: "use sunburst", model: "gpt-image-2.5-sunburst" },
			undefined,
			undefined,
			ctx,
		);

		expect(generateImages.mock.calls[0]?.[0]).toBe(sunburst);
		expect(result.details).toMatchObject({
			provider: "openrouter",
			model: "openai/gpt-image-2.5-sunburst",
			requestedModel: "gpt-image-2.5-sunburst",
		});
	});

	it("does not silently change an explicitly requested model", async () => {
		const flare = imageModel("openai", "gpt-image-2.5-flare");
		const compatibility = imageModel("openai-codex");
		const generateImages = vi.fn(async (model: ImagesModel<ImagesApi>) => imageError(model, "model unavailable"));
		const ctx = {
			cwd: tempRoot,
			model: chatModel("anthropic", "anthropic-messages", "https://api.anthropic.com"),
			modelRegistry: {
				findImage: (provider: string, id: string) => {
					if (provider === "openai" && id === "gpt-image-2.5-flare") return flare;
					if (provider === "openai-codex" && id === "gpt-image-2") return compatibility;
					return undefined;
				},
				getImageProviderAuth: async (provider: string) => ({ auth: { apiKey: `${provider}-key` } }),
				generateImages,
			},
			sessionManager: { getSessionId: () => "session-explicit", getBranch: () => [] },
		} as unknown as ExtensionToolContext;

		await expect(
			createImageGenToolDefinition().execute(
				"call-explicit",
				{ prompt: "use flare", model: "gpt-image-2.5-flare" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("gpt-image-2.5-flare");
		expect(generateImages).toHaveBeenCalledTimes(1);
		expect(generateImages.mock.calls[0]?.[0]).toBe(flare);
	});

	it("preserves the Codex image endpoint and does not retry content-policy errors", async () => {
		const codex = imageModel("openai-codex");
		const openAI = imageModel("openai");
		const generateImages = vi.fn(async (model: ImagesModel<ImagesApi>) =>
			imageError(model, "content_policy_violation"),
		);
		const ctx = {
			cwd: tempRoot,
			model: chatModel("openai-codex", "openai-codex-responses", "https://chatgpt.com/backend-api"),
			modelRegistry: {
				findImage: (provider: string, id: string) => {
					if (id !== "gpt-image-2") return undefined;
					return provider === "openai-codex" ? codex : provider === "openai" ? openAI : undefined;
				},
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "codex-token" }),
				getImageProviderAuth: async () => ({ auth: { apiKey: "fallback-key" } }),
				generateImages,
			},
			sessionManager: { getSessionId: () => "session-4", getBranch: () => [] },
		} as unknown as ExtensionToolContext;

		await expect(
			createImageGenToolDefinition().execute(
				"call-4",
				{ prompt: "blocked prompt", model: "gpt-image-2" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("content_policy_violation");
		expect(generateImages).toHaveBeenCalledTimes(1);
		expect(generateImages.mock.calls[0]?.[0]).toMatchObject({
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
		});
	});

	it("rejects conflicting reference modes before selecting a provider", async () => {
		const findImage = vi.fn();
		const ctx = {
			cwd: tempRoot,
			modelRegistry: { findImage },
			sessionManager: { getSessionId: () => "session-3", getBranch: () => [] },
		} as unknown as ExtensionToolContext;

		await expect(
			createImageGenToolDefinition().execute(
				"call-3",
				{ prompt: "edit", referenced_image_paths: ["input.png"], num_last_images_to_include: 1 },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("Provide only one of referenced_image_paths or num_last_images_to_include");
		expect(findImage).not.toHaveBeenCalled();
	});
});
