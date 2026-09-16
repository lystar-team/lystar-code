import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { assertWorkspaceCommandResult } from "@lystar/code-web-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import type { RuntimeSession } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];

function temporaryAgentDir(prefix: string): string {
	const tempDir = mkdtempSync(join(tmpdir(), prefix));
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
	return agentDir;
}

function readModelsJson(agentDir: string): {
	providers: Record<
		string,
		| {
				models?: Array<{ id: string }>;
				disabledModels?: string[];
				syncedModels?: string[];
		  }
		| undefined
	>;
} {
	return JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
}

afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanups.length) await cleanups.pop()?.();
});

describe("Web Runtime model provider settings", () => {
	it("uses builtin model metadata when a custom provider only returns model ids", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-provider-catalog-"));
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					upstream: {
						name: "Upstream",
						baseUrl: "https://upstream.test/v1",
						apiKey: "test-key",
						api: "openai-completions",
					},
				},
			}),
		);
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [
						{ id: "gpt-6-astra", name: "GPT 6 Astra" },
						{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const models = await adapter.syncModelProvider("upstream");
		const astra = models.find((model) => model.provider === "upstream" && model.id === "gpt-6-astra");

		expect(astra).toMatchObject({
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 272_000,
			maxTokens: 128_000,
			supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
		});
		expect(astra?.capabilitiesPending).toBeUndefined();
		expect(astra?.thinkingLevelMap).toMatchObject({ low: "low", medium: "medium", high: "high", max: "max" });

		const persisted = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as {
			providers: { upstream: { models: Array<Record<string, unknown>> } };
		};
		expect(persisted.providers.upstream.models.find((model) => model.id === "gpt-6-astra")).toMatchObject({
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 272_000,
			maxTokens: 128_000,
		});
	});

	it("returns only authenticated prompt models with compact fields", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-model-options-"));
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					ready: {
						name: "Ready Provider",
						baseUrl: "https://ready.test/v1",
						apiKey: "ready-key",
						api: "openai-completions",
						models: [
							{
								id: "ready-model",
								name: "Ready Model",
								api: "openai-completions",
								baseUrl: "https://ready.test/v1",
								reasoning: true,
								input: ["text"],
								contextWindow: 64_000,
								maxTokens: 8_000,
							},
						],
					},
					locked: {
						name: "Locked Provider",
						baseUrl: "https://locked.test/v1",
						api: "openai-completions",
						models: [
							{
								id: "locked-model",
								name: "Locked Model",
								api: "openai-completions",
								baseUrl: "https://locked.test/v1",
								input: ["text"],
								contextWindow: 32_000,
								maxTokens: 4_000,
							},
						],
					},
				},
			}),
		);
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));

		const result = await new CodingAgentRuntimeAdapter(agentDir).listModelOptions();
		const ready = result.models.find((model) => model.provider === "ready" && model.id === "ready-model");

		expect(ready).toEqual({
			provider: "ready",
			id: "ready-model",
			name: "Ready Model",
			reasoning: true,
			contextWindow: 64_000,
			supportedThinkingLevels: ["off", "minimal", "low", "medium", "high"],
		});
		expect(result.models.some((model) => model.provider === "locked")).toBe(false);
		expect(result.providers).toContainEqual({ id: "ready", name: "Ready Provider", builtIn: false });
		expect(() => assertWorkspaceCommandResult("list_model_options", result)).not.toThrow();

		const included = await new CodingAgentRuntimeAdapter(agentDir).listModelOptions({ includeProviders: ["locked"] });
		expect(included.models).toContainEqual({
			provider: "locked",
			id: "locked-model",
			name: "Locked Model",
			reasoning: false,
			contextWindow: 32_000,
			supportedThinkingLevels: ["off"],
		});
	});

	it("refreshes the active session before applying a saved thinking level", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-provider-refresh-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		const provider = "faux-provider-refresh";
		const modelId = "reasoning-model";
		const faux = registerFauxProvider({
			provider,
			api: "faux-provider-refresh",
			models: [{ id: modelId, name: "Reasoning Model", reasoning: true }],
		});
		for (const directory of [agentDir, cwd]) mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[provider]: {
						baseUrl: faux.models[0].baseUrl,
						apiKey: "faux-key",
						api: faux.api,
						models: [
							{
								id: modelId,
								name: "Reasoning Model",
								api: faux.api,
								baseUrl: faux.models[0].baseUrl,
								reasoning: true,
								thinkingLevelMap: { max: null },
								input: ["text"],
								contextWindow: 64_000,
								maxTokens: 16_000,
							},
						],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: provider,
				defaultModel: modelId,
				defaultThinkingLevel: "low",
				defaultProjectTrust: "always",
			}),
		);

		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		let runtime: RuntimeSession | undefined;
		cleanups.push(async () => {
			await runtime?.dispose();
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		});
		runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		expect(runtime.getSnapshot("owned")).toMatchObject({ thinkingLevel: "low", contextWindow: 64_000 });

		await adapter.addProviderModel({
			provider,
			id: modelId,
			reasoning: true,
			thinkingLevelMap: { off: "off", minimal: null, low: "low", medium: "medium", high: "high", max: "max" },
			input: ["text"],
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		await runtime.setThinkingLevel("max");

		expect(runtime.getSnapshot("owned")).toMatchObject({ thinkingLevel: "max", contextWindow: 200_000 });
	});

	it("解析启动时凭据引用并在 /v1/models 回退发现模型", async () => {
		const agentDir = temporaryAgentDir("web-runtime-provider-keyref-");
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					keyref: {
						name: "Key Ref",
						baseUrl: "https://gateway.test/anthropic",
						api: "anthropic-messages",
						apiKey: "$WEB_RUNTIME_TEST_KEY",
					},
				},
			}),
		);
		vi.stubEnv("WEB_RUNTIME_TEST_KEY", "resolved-key");
		cleanups.push(() => {
			vi.unstubAllEnvs();
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === "https://gateway.test/anthropic/models") return new Response("not found", { status: 404 });
			if (url === "https://gateway.test/anthropic/v1/models")
				return new Response(JSON.stringify({ data: [{ id: "claude-x", name: "Claude X" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			throw new Error(`unexpected fetch ${url}`);
		});

		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const models = await adapter.syncModelProvider("keyref");

		expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
			"https://gateway.test/anthropic/models",
			"https://gateway.test/anthropic/v1/models",
		]);
		const headers = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer resolved-key");
		expect(headers["x-api-key"]).toBe("resolved-key");
		expect(models).toContainEqual(expect.objectContaining({ provider: "keyref", id: "claude-x", name: "Claude X" }));
		expect(readModelsJson(agentDir).providers.keyref?.syncedModels).toEqual(["claude-x"]);
	});

	it("凭据解析失败时停止同步，不退化为匿名请求", async () => {
		const agentDir = temporaryAgentDir("web-runtime-provider-auth-error-");
		const envName = "WEB_RUNTIME_TEST_MISSING_PROVIDER_KEY";
		const previous = process.env[envName];
		delete process.env[envName];
		cleanups.push(() => {
			if (previous === undefined) delete process.env[envName];
			else process.env[envName] = previous;
		});
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"missing-key": {
						baseUrl: "https://gateway.test/v1",
						api: "openai-completions",
						apiKey: `$${envName}`,
					},
				},
			}),
		);
		const fetchMock = vi.spyOn(globalThis, "fetch");

		await expect(new CodingAgentRuntimeAdapter(agentDir).syncModelProvider("missing-key")).rejects.toThrow(
			"API key auth failed for provider missing-key",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("同步时删除远端已消失的同步模型，保留手工模型", async () => {
		const agentDir = temporaryAgentDir("web-runtime-provider-stale-");
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					sync: {
						name: "Sync",
						baseUrl: "https://sync.test/v1",
						apiKey: "test-key",
						api: "openai-completions",
						syncedModels: ["stale"],
						models: [
							{
								id: "manual",
								name: "Manual",
								api: "openai-completions",
								baseUrl: "https://sync.test/v1",
								input: ["text"],
							},
							{
								id: "stale",
								name: "Stale",
								api: "openai-completions",
								baseUrl: "https://sync.test/v1",
								input: ["text"],
							},
						],
					},
				},
			}),
		);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ data: [{ id: "fresh", name: "Fresh" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const models = await adapter.syncModelProvider("sync");

		expect(
			models
				.filter((model) => model.provider === "sync")
				.map((model) => model.id)
				.sort(),
		).toEqual(["fresh", "manual"]);
		const persisted = readModelsJson(agentDir).providers.sync;
		expect(persisted?.models?.map((model) => model.id).sort()).toEqual(["fresh", "manual"]);
		expect(persisted?.syncedModels).toEqual(["fresh"]);
	});

	it("远端模型与手工模型同名时不接管手工模型", async () => {
		const agentDir = temporaryAgentDir("web-runtime-provider-manual-overlap-");
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					sync: {
						name: "Sync",
						baseUrl: "https://sync.test/v1",
						apiKey: "test-key",
						api: "openai-completions",
						models: [
							{
								id: "manual",
								name: "Manual",
								api: "openai-completions",
								baseUrl: "https://sync.test/v1",
								input: ["text"],
							},
						],
					},
				},
			}),
		);
		let syncCount = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			syncCount += 1;
			const modelIds = syncCount === 1 ? ["manual", "fresh"] : ["fresh"];
			return new Response(JSON.stringify({ data: modelIds.map((id) => ({ id })) }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		await adapter.syncModelProvider("sync");
		expect(readModelsJson(agentDir).providers.sync?.syncedModels).toEqual(["fresh"]);

		const models = await adapter.syncModelProvider("sync");
		expect(
			models
				.filter((model) => model.provider === "sync")
				.map((model) => model.id)
				.sort(),
		).toEqual(["fresh", "manual"]);
		expect(
			readModelsJson(agentDir)
				.providers.sync?.models?.map((model) => model.id)
				.sort(),
		).toEqual(["fresh", "manual"]);
	});

	it("按模型启用与禁用，并同步到模型选择器", async () => {
		const agentDir = temporaryAgentDir("web-runtime-model-toggle-");
		const definitions = ["alpha", "beta"].map((id) => ({
			id,
			name: id.toUpperCase(),
			api: "openai-completions",
			baseUrl: "https://proxy.test/v1",
			input: ["text"],
		}));
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					proxy: {
						name: "Proxy",
						baseUrl: "https://proxy.test/v1",
						apiKey: "test-key",
						api: "openai-completions",
						models: definitions,
					},
				},
			}),
		);

		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const enabled = () =>
			adapter
				.listModels()
				.then((models) => models.filter((model) => model.provider === "proxy").map((model) => model.id));
		expect(await enabled()).toEqual(["alpha", "beta"]);

		await adapter.setProviderModelEnabled("proxy", "beta", false);

		expect(await enabled()).toEqual(["alpha"]);
		expect(readModelsJson(agentDir).providers.proxy?.disabledModels).toEqual(["beta"]);
		expect(await adapter.listModelProviders()).toContainEqual(
			expect.objectContaining({ id: "proxy", modelCount: 1, disabledModels: ["beta"], hasCustomConfig: true }),
		);
		const options = await adapter.listModelOptions();
		expect(options.models.some((model) => model.provider === "proxy" && model.id === "beta")).toBe(false);

		await adapter.setProviderModelEnabled("proxy", "beta", true);

		expect(await enabled()).toEqual(["alpha", "beta"]);
		expect(readModelsJson(agentDir).providers.proxy?.disabledModels).toBeUndefined();
	});

	it("删除自定义 Provider，并仅为内置 Provider 清除自定义配置", async () => {
		const agentDir = temporaryAgentDir("web-runtime-provider-remove-");
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					proxy: {
						name: "Proxy",
						baseUrl: "https://proxy.test/v1",
						apiKey: "test-key",
						api: "openai-completions",
						models: [
							{
								id: "alpha",
								name: "Alpha",
								api: "openai-completions",
								baseUrl: "https://proxy.test/v1",
								input: ["text"],
							},
						],
					},
				},
			}),
		);

		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const providers = await adapter.removeModelProvider("proxy");

		expect(providers.some((provider) => provider.id === "proxy")).toBe(false);
		expect((await adapter.listModels()).some((model) => model.provider === "proxy")).toBe(false);
		expect(readModelsJson(agentDir).providers.proxy).toBeUndefined();
		await expect(adapter.removeModelProvider("proxy")).rejects.toThrow("未找到 Provider");
		await expect(adapter.removeModelProvider("anthropic")).rejects.toThrow("没有可清除的自定义配置");

		await adapter.addModelProvider({
			provider: "anthropic",
			baseUrl: "https://proxy.test/anthropic",
			api: "anthropic-messages",
			apiKey: "test-key",
		});
		const cleared = await adapter.removeModelProvider("anthropic");
		expect(cleared).toContainEqual(
			expect.objectContaining({ id: "anthropic", builtIn: true, hasCustomConfig: false }),
		);
		expect(readModelsJson(agentDir).providers.anthropic).toBeUndefined();
	});
});
