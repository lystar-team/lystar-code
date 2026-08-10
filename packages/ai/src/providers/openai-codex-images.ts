import { openAIImagesApi } from "../api/openai-images.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAICodexOAuth } from "../auth/oauth/load.ts";
import { createImagesProvider, type ImagesProvider } from "../images-models.ts";
import type { ImagesModel } from "../types.ts";

export const OPENAI_CODEX_GPT_IMAGE_2: ImagesModel<"openai-images"> = {
	id: "gpt-image-2",
	name: "GPT Image 2",
	api: "openai-images",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	input: ["text", "image"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function openAICodexImagesProvider(): ImagesProvider {
	return createImagesProvider({
		id: "openai-codex",
		name: "OpenAI Codex",
		auth: {
			oauth: lazyOAuth({
				name: "OpenAI (ChatGPT Plus/Pro)",
				isSubscription: true,
				load: loadOpenAICodexOAuth,
			}),
		},
		models: [OPENAI_CODEX_GPT_IMAGE_2],
		api: openAIImagesApi(),
	});
}
