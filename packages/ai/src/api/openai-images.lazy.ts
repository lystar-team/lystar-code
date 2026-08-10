import type { ImagesModel, ProviderImages } from "../types.ts";

export const openAIImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./openai-images.ts")).generateImages(model as ImagesModel<"openai-images">, context, options),
});
