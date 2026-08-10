import type { generateImages as generateImagesOpenAIFunction } from "../../api/openai-images.ts";
import type { generateImages as generateImagesOpenRouterFunction } from "../../api/openrouter-images.ts";
import { registerImagesApiProvider } from "../../images-api-registry.ts";
import type { AssistantImages, ImagesContext, ImagesFunction, ImagesModel, ImagesOptions } from "../../types.ts";

interface OpenAIImagesProviderModule {
	generateImages: typeof generateImagesOpenAIFunction;
}

interface OpenRouterImagesProviderModule {
	generateImages: typeof generateImagesOpenRouterFunction;
}

let openAIImagesProviderModulePromise: Promise<OpenAIImagesProviderModule> | undefined;
let openRouterImagesProviderModulePromise: Promise<OpenRouterImagesProviderModule> | undefined;

function createLazyLoadErrorImages(
	model: ImagesModel<"openai-images" | "openrouter-images">,
	error: unknown,
): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function loadOpenAIImagesProviderModule(): Promise<OpenAIImagesProviderModule> {
	openAIImagesProviderModulePromise ||= import("../../api/openai-images.ts").then(
		(module) => module as OpenAIImagesProviderModule,
	);
	return openAIImagesProviderModulePromise;
}

function loadOpenRouterImagesProviderModule(): Promise<OpenRouterImagesProviderModule> {
	openRouterImagesProviderModulePromise ||= import("../../api/openrouter-images.ts").then(
		(module) => module as OpenRouterImagesProviderModule,
	);
	return openRouterImagesProviderModulePromise;
}

export const generateImagesOpenAI: ImagesFunction<"openai-images", ImagesOptions> = async (
	model: ImagesModel<"openai-images">,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	try {
		const module = await loadOpenAIImagesProviderModule();
		return await module.generateImages(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

export const generateImagesOpenRouter: ImagesFunction<"openrouter-images", ImagesOptions> = async (
	model: ImagesModel<"openrouter-images">,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	try {
		const module = await loadOpenRouterImagesProviderModule();
		return await module.generateImages(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

export function registerBuiltInImagesApiProviders(): void {
	registerImagesApiProvider({ api: "openai-images", generateImages: generateImagesOpenAI });
	registerImagesApiProvider({ api: "openrouter-images", generateImages: generateImagesOpenRouter });
}

registerBuiltInImagesApiProviders();
