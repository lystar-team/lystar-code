import { describe, expect, it } from "vitest";
import { getProviders } from "../src/compat.ts";
import { getAnthropicMessagesCases, getAnthropicMessagesModels } from "./anthropic-messages-e2e-test-utils.ts";

const anthropicMessagesCases = getAnthropicMessagesCases();

describe("Anthropic Messages long cache retention", () => {
	it("covers every generated anthropic-messages model", () => {
		const expectedModels = getProviders().flatMap((provider) =>
			getAnthropicMessagesModels(provider).map((model) => `${provider}/${model.id}`),
		);
		expect(anthropicMessagesCases.map((testCase) => testCase.name).sort()).toEqual(expectedModels.sort());
	});
});
