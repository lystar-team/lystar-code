import { openAIImagesApi } from "../api/openai-images.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createImagesProvider, type ImagesProvider } from "../images-models.ts";
import type { ImagesModel } from "../types.ts";

function openAIImageModel(id: string, name: string): ImagesModel<"openai-images"> {
	return {
		id,
		name,
		api: "openai-images",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		input: ["text", "image"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

export const OPENAI_GPT_IMAGE_2 = openAIImageModel("gpt-image-2", "GPT Image 2");
export const OPENAI_GPT_IMAGE_2_5_FLARE = openAIImageModel("gpt-image-2.5-flare", "GPT Image 2.5 Flare");
export const OPENAI_GPT_IMAGE_2_5_SUNBURST = openAIImageModel("gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst");

export function openAIImagesProvider(): ImagesProvider {
	return createImagesProvider({
		id: "openai",
		name: "OpenAI",
		auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
		models: [OPENAI_GPT_IMAGE_2_5_FLARE, OPENAI_GPT_IMAGE_2_5_SUNBURST, OPENAI_GPT_IMAGE_2],
		api: openAIImagesApi(),
	});
}
