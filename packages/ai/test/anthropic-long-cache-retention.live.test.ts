import { describe, expect, it } from "vitest";
import { complete } from "../src/compat.ts";
import { getEnvApiKey } from "../src/env-api-keys.ts";
import type { KnownProvider, Model, ProviderStreamOptions } from "../src/types.ts";
import { getAnthropicMessagesCases, selectOneCasePerProvider } from "./anthropic-messages-e2e-test-utils.ts";
import { resolveApiKey } from "./oauth.ts";

const githubCopilotToken = await resolveApiKey("github-copilot");

function getE2EApiKey(provider: KnownProvider): string | undefined {
	if (provider === "github-copilot") {
		return githubCopilotToken;
	}
	return getEnvApiKey(provider);
}

const anthropicMessagesCases = getAnthropicMessagesCases().map((testCase) => ({
	...testCase,
	apiKey: getE2EApiKey(testCase.provider),
}));
const probeCases = selectOneCasePerProvider(anthropicMessagesCases);

function withLongCacheRetention(model: Model<"anthropic-messages">): Model<"anthropic-messages"> {
	return {
		...model,
		compat: {
			...model.compat,
			supportsLongCacheRetention: true,
		},
	};
}

async function expectLongCacheRetentionAccepted(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
): Promise<void> {
	const options: ProviderStreamOptions = {
		apiKey,
		cacheRetention: "long",
		maxTokens: 128,
		thinkingEnabled: false,
	};
	const response = await complete(
		model,
		{
			systemPrompt: "You are a concise assistant.",
			messages: [
				{
					role: "user",
					content: "Reply with exactly: long cache retention accepted",
					timestamp: Date.now(),
				},
			],
		},
		options,
	);

	expect(response.errorMessage, response.errorMessage).toBeFalsy();
	expect(response.stopReason, response.errorMessage).not.toBe("error");
}

describe("Anthropic Messages long cache retention E2E", () => {
	describe("forced long cache retention probe", () => {
		for (const testCase of probeCases) {
			const model = withLongCacheRetention(testCase.model);

			it.skipIf(!testCase.apiKey)(`${testCase.name} accepts long cache retention`, { retry: 2 }, async () => {
				await expectLongCacheRetentionAccepted(model, testCase.apiKey);
			});
		}
	});
});
