import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfig, removeModelsJsonModels, setModelsJsonModelDisabled } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryModelsPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "lystar-composer-disabled-"));
	temporaryDirectories.push(directory);
	return join(directory, "models.json");
}

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "demo",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function builtinProvider() {
	return createProvider({
		id: "demo",
		name: "Demo",
		models: [model("alpha"), model("beta")],
		auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
		api: {
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		},
	});
}

describe("models.json disabled models", () => {
	it("内置 Provider 只写 disabledModels 时仍然合法，并过滤被禁用的模型", async () => {
		const path = temporaryModelsPath();
		writeFileSync(path, JSON.stringify({ providers: { demo: { disabledModels: ["beta"] } } }));

		const provider = composeModelProvider("demo", builtinProvider(), await ModelConfig.load(path), undefined);

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["alpha"]);
		expect(provider.name).toBe("Demo");
	});

	it("启用后模型重新出现在模型列表中", async () => {
		const path = temporaryModelsPath();
		writeFileSync(path, JSON.stringify({ providers: { demo: { disabledModels: ["alpha", "beta"] } } }));
		const config = await ModelConfig.load(path);
		expect(composeModelProvider("demo", builtinProvider(), config, undefined).getModels()).toHaveLength(0);

		await setModelsJsonModelDisabled(path, "demo", "beta", false);
		const updated = await ModelConfig.load(path);
		expect(
			composeModelProvider("demo", builtinProvider(), updated, undefined)
				.getModels()
				.map((entry) => entry.id),
		).toEqual(["beta"]);
	});

	it("过滤发生在自定义模型与目录模型合并之后", async () => {
		const path = temporaryModelsPath();
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					demo: {
						baseUrl: "https://example.test/v1",
						apiKey: "test-key",
						disabledModels: ["gamma"],
						models: [
							{
								id: "gamma",
								name: "Gamma",
								api: "openai-completions",
								baseUrl: "https://example.test/v1",
								input: ["text"],
							},
						],
					},
				},
			}),
		);

		const provider = composeModelProvider("demo", builtinProvider(), await ModelConfig.load(path), undefined);

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["alpha", "beta"]);
	});

	it("移除模型时同步清理禁用标记", async () => {
		const path = temporaryModelsPath();
		writeFileSync(path, JSON.stringify({ providers: { demo: { disabledModels: ["beta"] } } }));

		await removeModelsJsonModels(path, "demo", ["beta"]);

		const value = JSON.parse(readFileSync(path, "utf8")) as { providers: { demo: { disabledModels?: string[] } } };
		expect(value.providers.demo.disabledModels).toBeUndefined();
	});
});
