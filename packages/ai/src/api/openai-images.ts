import OpenAI, { toFile } from "openai";
import type {
	AssistantImages,
	ImageContent,
	ImagesContext,
	ImagesFunction,
	ImagesModel,
	ImagesOptions,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { extractOpenAICodexAccountId } from "./openai-codex-auth.ts";

interface ImageResponse {
	data?: Array<{ b64_json?: string }>;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
	};
}

export const generateImages: ImagesFunction<"openai-images", ImagesOptions> = async (
	model: ImagesModel<"openai-images">,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
		const response =
			model.provider === "openai-codex"
				? await requestCodexImages(model, context, options.apiKey, options)
				: await requestOpenAIImages(model, context, options.apiKey, options);
		for (const image of response.data ?? []) {
			if (!image.b64_json) continue;
			output.output.push({ type: "image", mimeType: "image/png", data: image.b64_json });
		}
		if (output.output.length === 0) throw new Error("Image generation returned no image data");
		if (response.usage) output.usage = parseUsage(response.usage);
		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
};

async function requestOpenAIImages(
	model: ImagesModel<"openai-images">,
	context: ImagesContext,
	apiKey: string,
	options: ImagesOptions,
): Promise<ImageResponse> {
	const client = new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch: options.fetch,
		defaultHeaders: providerHeadersToRecord({ ...model.headers, ...options.headers }),
	});
	const prompt = getPrompt(context);
	const images = context.input.filter((item): item is ImageContent => item.type === "image");
	let payload: Record<string, unknown>;
	if (images.length > 0) {
		payload = {
			image: await Promise.all(
				images.map((image, index) => {
					const name = `reference-${index + 1}.${extensionForMimeType(image.mimeType)}`;
					return toFile(Buffer.from(image.data, "base64"), name, { type: image.mimeType });
				}),
			),
			prompt,
			model: model.id,
			background: "auto",
			quality: "auto",
			size: "auto",
		};
	} else {
		payload = { prompt, model: model.id, background: "auto", quality: "auto", size: "auto" };
	}
	const nextPayload = await options.onPayload?.(payload, model);
	if (nextPayload !== undefined) payload = nextPayload as Record<string, unknown>;
	const requestOptions = {
		...(options.signal ? { signal: options.signal } : {}),
		...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
		maxRetries: 0,
	};
	const request = () =>
		(images.length > 0
			? client.images.edit(payload as never, requestOptions)
			: client.images.generate(payload as never, requestOptions)
		).withResponse();
	const { data, response } = await retryProviderRequest(request, {
		maxRetries: options.maxRetries,
		maxRetryDelayMs: options.maxRetryDelayMs,
		signal: options.signal,
	});
	await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	return data as ImageResponse;
}

async function requestCodexImages(
	model: ImagesModel<"openai-images">,
	context: ImagesContext,
	apiKey: string,
	options: ImagesOptions,
): Promise<ImageResponse> {
	const images = context.input.filter((item): item is ImageContent => item.type === "image");
	let payload: Record<string, unknown> = {
		prompt: getPrompt(context),
		model: model.id,
		background: "auto",
		quality: "auto",
		size: "auto",
	};
	if (images.length > 0) {
		payload.images = images.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` }));
	}
	const nextPayload = await options.onPayload?.(payload, model);
	if (nextPayload !== undefined) payload = nextPayload as Record<string, unknown>;
	const headers = new Headers(providerHeadersToRecord({ ...model.headers, ...options.headers }));
	headers.set("Authorization", `Bearer ${apiKey}`);
	headers.set("chatgpt-account-id", extractOpenAICodexAccountId(apiKey));
	headers.set("originator", "pi");
	headers.set("content-type", "application/json");
	const endpoint = images.length > 0 ? "images/edits" : "images/generations";
	const fetchFn = options.fetch ?? globalThis.fetch;
	const response = await retryProviderRequest(
		async () => {
			const result = await fetchFn(`${model.baseUrl.replace(/\/$/, "")}/${endpoint}`, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: options.signal,
			});
			if (!result.ok) {
				const error = new Error(`OpenAI Codex image request failed with status ${result.status}`) as Error & {
					status?: number;
					error?: unknown;
				};
				error.status = result.status;
				const text = await result.text();
				try {
					error.error = JSON.parse(text);
				} catch {
					error.error = text ? { message: text } : undefined;
				}
				throw error;
			}
			return result;
		},
		{ maxRetries: options.maxRetries, maxRetryDelayMs: options.maxRetryDelayMs, signal: options.signal },
	);
	await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	return (await response.json()) as ImageResponse;
}

function getPrompt(context: ImagesContext): string {
	const prompt = context.input
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
	if (!prompt) throw new Error("Image prompt is required");
	return prompt;
}

function extensionForMimeType(mimeType: string): string {
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/webp") return "webp";
	return "png";
}

function parseUsage(raw: NonNullable<ImageResponse["usage"]>) {
	const input = raw.input_tokens ?? 0;
	const output = raw.output_tokens ?? 0;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: raw.total_tokens ?? input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
