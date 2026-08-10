import { openAIImagesApi } from "../api/openai-images.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createImagesProvider, type ImagesProvider } from "../images-models.ts";
import type { ImagesModel } from "../types.ts";

export const OPENAI_GPT_IMAGE_2: ImagesModel<"openai-images"> = {
	id: "gpt-image-2",
	name: "GPT Image 2",
	api: "openai-images",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	input: ["text", "image"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function openAIImagesProvider(): ImagesProvider {
	return createImagesProvider({
		id: "openai",
		name: "OpenAI",
		auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
		models: [OPENAI_GPT_IMAGE_2],
		api: openAIImagesApi(),
	});
}
