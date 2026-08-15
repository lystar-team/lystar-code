import { type BuiltinProvider, getModels, getProviders } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";

export interface AnthropicMessagesE2ECase {
	name: string;
	provider: BuiltinProvider;
	model: Model<"anthropic-messages">;
}

export function getAnthropicMessagesModels(provider: BuiltinProvider): Model<"anthropic-messages">[] {
	const models = getModels(provider) as Model<Api>[];
	return models.filter((model) => model.api === "anthropic-messages") as Model<"anthropic-messages">[];
}

export function getAnthropicMessagesCases(): AnthropicMessagesE2ECase[] {
	return getProviders().flatMap((provider) =>
		getAnthropicMessagesModels(provider).map((model) => ({
			name: `${provider}/${model.id}`,
			provider,
			model,
		})),
	);
}

function getProbePriority(model: Model<"anthropic-messages">): number {
	const modelId = model.id.toLowerCase();
	const cost = model.cost.input + model.cost.output;
	let priority = cost;

	if (modelId.includes("haiku") && (modelId.includes("4-5") || modelId.includes("4.5"))) {
		priority -= 1000;
	} else if (modelId.includes("sonnet") && (modelId.includes("4-") || modelId.includes("4."))) {
		priority -= 750;
	} else if (modelId.includes("claude") && (modelId.includes("4-") || modelId.includes("4."))) {
		priority -= 500;
	}

	return priority;
}

export function selectOneCasePerProvider<T extends AnthropicMessagesE2ECase>(cases: T[]): T[] {
	const byProvider = new Map<BuiltinProvider, T[]>();
	for (const testCase of cases) {
		const providerCases = byProvider.get(testCase.provider) ?? [];
		providerCases.push(testCase);
		byProvider.set(testCase.provider, providerCases);
	}

	return Array.from(byProvider.values()).map(
		(providerCases) =>
			providerCases.sort(
				(a, b) => getProbePriority(a.model) - getProbePriority(b.model) || a.model.id.localeCompare(b.model.id),
			)[0],
	);
}
