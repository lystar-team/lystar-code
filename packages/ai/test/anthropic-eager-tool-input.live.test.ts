import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { complete } from "../src/compat.ts";
import { getEnvApiKey } from "../src/env-api-keys.ts";
import type { KnownProvider, Model, ProviderStreamOptions, Tool } from "../src/types.ts";
import { getAnthropicMessagesCases, selectOneCasePerProvider } from "./anthropic-messages-e2e-test-utils.ts";
import { resolveApiKey } from "./oauth.ts";

const githubCopilotToken = await resolveApiKey("github-copilot");

const echoToolSchema = Type.Object({
	value: Type.String({ description: "The value to echo" }),
});

const echoTool: Tool<typeof echoToolSchema> = {
	name: "echo_value",
	description: "Echo a string value",
	parameters: echoToolSchema,
};

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
const generatedCompatCases = selectOneCasePerProvider(anthropicMessagesCases);
const forcedEagerProbeCases = selectOneCasePerProvider(
	anthropicMessagesCases.filter((testCase) => testCase.model.compat?.supportsEagerToolInputStreaming !== false),
);

function withEagerToolInputStreaming(model: Model<"anthropic-messages">): Model<"anthropic-messages"> {
	return {
		...model,
		compat: {
			...model.compat,
			supportsEagerToolInputStreaming: true,
		},
	};
}

async function expectToolEnabledRequestAccepted(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
): Promise<void> {
	const options: ProviderStreamOptions = {
		apiKey,
		maxTokens: 128,
		thinkingEnabled: false,
	};
	const response = await complete(
		model,
		{
			systemPrompt: "You are a concise assistant. Use tools when useful.",
			messages: [
				{
					role: "user",
					content: "Call echo_value with value set to eager-input-streaming-compat.",
					timestamp: Date.now(),
				},
			],
			tools: [echoTool],
		},
		options,
	);

	expect(response.errorMessage, response.errorMessage).toBeFalsy();
	expect(response.stopReason, response.errorMessage).not.toBe("error");
}

describe("Anthropic Messages eager tool input streaming E2E", () => {
	describe("generated compatibility settings", () => {
		for (const testCase of generatedCompatCases) {
			it.skipIf(!testCase.apiKey)(`${testCase.name} accepts configured tool streaming`, { retry: 2 }, async () => {
				await expectToolEnabledRequestAccepted(testCase.model, testCase.apiKey);
			});
		}
	});

	describe("forced eager_input_streaming probe", () => {
		for (const testCase of forcedEagerProbeCases) {
			const model = withEagerToolInputStreaming(testCase.model);

			it.skipIf(!testCase.apiKey)(
				`${testCase.name} accepts forced eager_input_streaming`,
				{ retry: 2 },
				async () => {
					await expectToolEnabledRequestAccepted(model, testCase.apiKey);
				},
			);
		}
	});
});
