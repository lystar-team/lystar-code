import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { assertWorkspaceCommandResult } from "@lystar/code-web-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import type { RuntimeSession } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];

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
});
