import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import type { RuntimeSession } from "../src/types.ts";

describe("Web Runtime model defaults", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
	});

	it("persists model and thinking selections for new sessions", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-model-defaults-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		const provider = "faux-model-defaults";
		const modelDefinitions = [
			{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol", reasoning: true },
			{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna", reasoning: true },
		];
		const faux = registerFauxProvider({ provider, api: "faux-model-defaults", models: modelDefinitions });
		for (const dir of [agentDir, cwd]) mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[provider]: {
						baseUrl: faux.models[0].baseUrl,
						apiKey: "faux-key",
						api: faux.api,
						models: modelDefinitions,
					},
				},
			}),
		);
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				defaultProvider: provider,
				defaultModel: "gpt-5.6-luna",
				defaultThinkingLevel: "off",
				defaultProjectTrust: "always",
			}),
		);

		let runtime: RuntimeSession | undefined;
		cleanups.push(async () => {
			await runtime?.dispose();
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		});

		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		expect(runtime.getSnapshot("owned")).toMatchObject({
			model: { provider, id: "gpt-5.6-luna" },
			thinkingLevel: "off",
		});

		await runtime.setModel({ provider, id: "gpt-5.6-sol" });
		await runtime.setThinkingLevel("high");
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
			defaultProvider: provider,
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "high",
		});

		await runtime.dispose();
		runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		expect(runtime.getSnapshot("owned")).toMatchObject({
			model: { provider, id: "gpt-5.6-sol" },
			thinkingLevel: "high",
		});
	});
});
