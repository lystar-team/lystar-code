import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { supportsFastMode } from "../../src/core/fast-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("session fast mode", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("only accepts supported OpenAI Responses models", () => {
		expect(supportsFastMode({ provider: "openai", api: "openai-responses", id: "gpt-6-sol" })).toBe(true);
		expect(supportsFastMode({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.5" })).toBe(true);
		expect(supportsFastMode({ provider: "upstream", api: "openai-responses", id: "gpt-6-sol" })).toBe(true);
		expect(
			supportsFastMode({ provider: "upstream", api: "openai-responses", id: "gpt-6-sol", fastModeSupported: false }),
		).toBe(false);
		expect(supportsFastMode({ provider: "openrouter", api: "openai-responses", id: "gpt-6-sol" })).toBe(false);
		expect(
			supportsFastMode({ provider: "openrouter", api: "openai-responses", id: "custom", fastModeSupported: true }),
		).toBe(true);
		expect(
			supportsFastMode({
				provider: "upstream",
				api: "openai-completions",
				id: "gpt-6-sol",
				fastModeSupported: true,
			}),
		).toBe(false);
		expect(supportsFastMode({ provider: "openai", api: "openai-responses", id: "gpt-5-mini" })).toBe(false);
	});

	it("records the mode in the session branch and resets it when selecting an unsupported model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const normalModel = harness.getModel();
		harness.session.agent.state.model = {
			...normalModel,
			provider: "upstream",
			api: "openai-responses",
			id: "gpt-6-sol",
		} as Model<"openai-responses">;
		expect(harness.session.fastMode).toBe(false);
		harness.session.setFastMode(true);
		expect(harness.session.fastMode).toBe(true);
		expect(harness.sessionManager.getBranch().at(-1)).toMatchObject({
			type: "custom",
			customType: "fast_mode",
			data: { enabled: true },
		});

		await harness.session.setModel(normalModel);
		expect(harness.session.fastMode).toBe(false);
		expect(harness.sessionManager.getBranch().at(-1)).toMatchObject({
			type: "custom",
			customType: "fast_mode",
			data: { enabled: false },
		});
		harness.session.agent.state.model = {
			...normalModel,
			provider: "upstream",
			api: "openai-responses",
			id: "gpt-6-sol",
		} as Model<"openai-responses">;
		expect(harness.session.fastMode).toBe(false);
	});
});
