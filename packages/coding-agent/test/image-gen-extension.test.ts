import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantImages, ImagesApi, ImagesModel, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import imageGenExtension, { createImageGenToolDefinition } from "../src/extensions/image-gen/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

const pngData = "iVBORw0KGgo=";

function imageModel(provider: string): ImagesModel<ImagesApi> {
	return {
		id: provider === "openrouter" ? "openai/gpt-image-2" : "gpt-image-2",
		name: "GPT Image 2",
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
			{} as ExtensionContext,
		)) as { skillPaths?: string[] } | undefined;
		const skillPath = resources?.skillPaths?.[0];
		expect(skillPath).toMatch(/skills[/\\]imagegen[/\\]SKILL\.md$/);
		expect(skillPath && existsSync(skillPath)).toBe(true);
	});

	it("uses the active OpenAI-compatible provider key, headers, and base URL first", async () => {
		const openAI = imageModel("openai");
		const activeModel = chatModel("company-openai", "openai-responses", "https://gateway.example/v1");
		const generateImages = vi.fn(async (model: ImagesModel<ImagesApi>) => imageResult(model));
		const getImageProviderAuth = vi.fn(async () => undefined);
		const ctx = {
			cwd: tempRoot,
			model: activeModel,
			modelRegistry: {
				findImage: (provider: string) => (provider === "openai" ? openAI : undefined),
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
		} as unknown as ExtensionContext;

		const result = await createImageGenToolDefinition().execute(
			"call/1",
			{ prompt: "a red circle", referenced_image_paths: [], num_last_images_to_include: 0 },
			undefined,
			undefined,
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
		expect(result.details).toMatchObject({ provider: "company-openai", model: "gpt-image-2", mode: "generate" });
		expect(result.details?.savedPath).toContain(join("generated_images", "session_1", "call_1.png"));
		expect(readFileSync(result.details!.savedPath).toString("base64")).toBe(pngData);
		expect(result.content.at(-1)).toEqual({ type: "image", data: pngData, mimeType: "image/png" });
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
				findImage: (provider: string) =>
					provider === "openai-codex" ? codex : provider === "openai" ? openAI : undefined,
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
		} as unknown as ExtensionContext;

		await createImageGenToolDefinition().execute(
			"call-2",
			{ prompt: "make it blue", num_last_images_to_include: 1 },
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
				findImage: (provider: string) =>
					provider === "openai" ? openAI : provider === "openai-codex" ? codex : undefined,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "bad-key" }),
				getImageProviderAuth: async (provider: string) =>
					provider === "openai-codex" ? { auth: { apiKey: "codex-token" } } : undefined,
				generateImages,
			},
			sessionManager: { getSessionId: () => "session-3", getBranch: () => [] },
		} as unknown as ExtensionContext;

		const result = await createImageGenToolDefinition().execute(
			"call-3",
			{ prompt: "a red circle" },
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
				findImage: (provider: string) =>
					provider === "openai-codex" ? codex : provider === "openai" ? openAI : undefined,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "codex-token" }),
				getImageProviderAuth: async () => ({ auth: { apiKey: "fallback-key" } }),
				generateImages,
			},
			sessionManager: { getSessionId: () => "session-4", getBranch: () => [] },
		} as unknown as ExtensionContext;

		await expect(
			createImageGenToolDefinition().execute("call-4", { prompt: "blocked prompt" }, undefined, undefined, ctx),
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
		} as unknown as ExtensionContext;

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
