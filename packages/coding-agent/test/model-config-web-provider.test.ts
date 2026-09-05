import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearModelsJsonModelOverride,
	clearModelsJsonProviderCatalogProvider,
	saveModelsJsonModelOverride,
	saveModelsJsonModels,
	saveModelsJsonProvider,
} from "../src/core/model-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("models.json web provider mutations", () => {
	it("保存 Provider、批量模型和覆盖，并支持恢复自动匹配", async () => {
		const directory = mkdtempSync(join(tmpdir(), "lystar-model-config-test-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "models.json");

		await saveModelsJsonProvider(path, "proxy", {
			name: "代理",
			api: "openai-completions",
			baseUrl: "https://example.test/v1",
			apiKey: "test-key",
			catalogProvider: "openai",
		});
		await saveModelsJsonModels(path, "proxy", [
			{
				id: "remote-model",
				name: "Remote Model",
				api: "openai-completions",
				baseUrl: "https://example.test/v1",
				input: ["text"],
			},
		]);
		await saveModelsJsonModelOverride(path, "proxy", "remote-model", {
			contextWindow: 200_000,
			maxTokens: 64_000,
			reasoning: true,
		});

		let value = JSON.parse(readFileSync(path, "utf8")) as {
			providers: Record<
				string,
				{ apiKey?: string; catalogProvider?: string; models?: unknown[]; modelOverrides?: Record<string, unknown> }
			>;
		};
		expect(value.providers.proxy.apiKey).toBe("test-key");
		expect(value.providers.proxy.catalogProvider).toBe("openai");
		expect(value.providers.proxy.models).toHaveLength(1);
		expect(value.providers.proxy.modelOverrides?.["remote-model"]).toMatchObject({ contextWindow: 200_000 });

		await clearModelsJsonModelOverride(path, "proxy", "remote-model");
		await clearModelsJsonProviderCatalogProvider(path, "proxy");
		value = JSON.parse(readFileSync(path, "utf8"));
		expect(value.providers.proxy.catalogProvider).toBeUndefined();
		expect(value.providers.proxy.modelOverrides).toBeUndefined();
	});
});
