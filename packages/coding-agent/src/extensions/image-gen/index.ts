import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	Api,
	AssistantImages,
	ImageContent,
	ImagesApi,
	ImagesContext,
	ImagesModel,
	ImagesOptions,
	Model,
} from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { getAgentDir, getBundledSkillsDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { shortenPath } from "../../core/tools/render-utils.ts";
import { formatToolSummary, getToolSummary } from "../../modes/interactive/components/tool-summary.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";

const MAX_EDIT_IMAGES = 5;
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const IMAGE_PROVIDER_ORDER = ["openai-codex", "openai", "openrouter"] as const;
const OPENAI_COMPATIBLE_IMAGE_APIS = new Set<Api>(["openai-completions", "openai-responses"]);
const CONTENT_POLICY_ERROR = /content[_ -]?policy|content[_ -]?filter|moderation|safety system|safety violation/i;

type ImageProviderId = (typeof IMAGE_PROVIDER_ORDER)[number];

interface ImageGenerationCandidate {
	sourceProvider: string;
	model: ImagesModel<ImagesApi>;
	options?: ImagesOptions;
}

const imageGenSchema = Type.Object(
	{
		prompt: Type.String({ description: "Complete image generation or editing prompt." }),
		referenced_image_paths: Type.Optional(
			Type.Array(Type.String(), {
				maxItems: MAX_EDIT_IMAGES,
				description: "Local image paths used as edit or visual references. Omit or use [] for a new image.",
			}),
		),
		num_last_images_to_include: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: MAX_EDIT_IMAGES,
				description: "Use 1-5 latest conversation images for editing; omit or use 0 for a new image.",
			}),
		),
	},
	{ additionalProperties: false },
);

type ImageGenInput = Static<typeof imageGenSchema>;

export interface ImageGenDetails {
	provider: string;
	model: string;
	savedPath: string;
	prompt: string;
	mode: "generate" | "edit";
}

function imageModelId(provider: string): string {
	return provider === "openrouter" ? "openai/gpt-image-2" : DEFAULT_IMAGE_MODEL;
}

function imageProviderForActiveModel(model: Model<Api>): ImageProviderId | undefined {
	if (model.provider === "openai-codex" || model.api === "openai-codex-responses") return "openai-codex";
	if (model.provider === "openrouter") return "openrouter";
	if (OPENAI_COMPATIBLE_IMAGE_APIS.has(model.api)) return "openai";
	return undefined;
}

function activeImageBaseUrl(model: Model<Api>, provider: ImageProviderId, resolvedBaseUrl?: string): string {
	const baseUrl = resolvedBaseUrl ?? model.baseUrl;
	if (provider !== "openai-codex") return baseUrl;
	const normalized = baseUrl.replace(/\/$/, "");
	return normalized.endsWith("/codex") ? normalized : `${normalized}/codex`;
}

async function getActiveImageCandidate(
	ctx: ExtensionContext,
	failures: string[],
): Promise<ImageGenerationCandidate | undefined> {
	const activeModel = ctx.model;
	if (!activeModel) return undefined;
	const imageProvider = imageProviderForActiveModel(activeModel);
	if (!imageProvider) return undefined;
	const imageModel = ctx.modelRegistry.findImage(imageProvider, imageModelId(imageProvider));
	if (!imageModel) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(activeModel);
	if (!auth.ok) {
		failures.push(`${activeModel.provider}: ${auth.error}`);
		return undefined;
	}
	if (!auth.apiKey) return undefined;
	return {
		sourceProvider: activeModel.provider,
		model: {
			...imageModel,
			baseUrl: activeImageBaseUrl(activeModel, imageProvider, auth.baseUrl),
		},
		options: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
	};
}

async function getConfiguredImageCandidate(
	ctx: ExtensionContext,
	provider: ImageProviderId,
	failures: string[],
): Promise<ImageGenerationCandidate | undefined> {
	const model = ctx.modelRegistry.findImage(provider, imageModelId(provider));
	if (!model) return undefined;
	try {
		const auth = await ctx.modelRegistry.getImageProviderAuth(provider);
		return auth?.auth.apiKey ? { sourceProvider: provider, model } : undefined;
	} catch (error) {
		failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

async function tryImageCandidate(
	ctx: ExtensionContext,
	candidate: ImageGenerationCandidate,
	context: ImagesContext,
	failures: string[],
	signal?: AbortSignal,
): Promise<AssistantImages | undefined> {
	signal?.throwIfAborted();
	const result = await ctx.modelRegistry.generateImages(candidate.model, context, {
		...candidate.options,
		signal,
	});
	if (result.stopReason === "stop") return result;
	if (result.stopReason === "aborted") {
		signal?.throwIfAborted();
		throw new Error(result.errorMessage ?? "Image generation aborted.");
	}
	const message = result.errorMessage ?? `Image generation ${result.stopReason}.`;
	failures.push(`${candidate.sourceProvider}: ${message}`);
	if (CONTENT_POLICY_ERROR.test(message)) throw new Error(message);
	return undefined;
}

async function generateWithProviderFallback(
	ctx: ExtensionContext,
	context: ImagesContext,
	signal?: AbortSignal,
): Promise<{
	candidate: ImageGenerationCandidate;
	result: AssistantImages;
}> {
	const failures: string[] = [];
	let configuredCandidates = 0;
	const activeCandidate = await getActiveImageCandidate(ctx, failures);
	if (activeCandidate) {
		configuredCandidates++;
		const result = await tryImageCandidate(ctx, activeCandidate, context, failures, signal);
		if (result) return { candidate: activeCandidate, result };
	}

	for (const provider of IMAGE_PROVIDER_ORDER) {
		if (activeCandidate?.sourceProvider === provider) continue;
		const candidate = await getConfiguredImageCandidate(ctx, provider, failures);
		if (!candidate) continue;
		configuredCandidates++;
		const result = await tryImageCandidate(ctx, candidate, context, failures, signal);
		if (result) return { candidate, result };
	}

	if (configuredCandidates === 0) {
		const detail = failures.length > 0 ? ` (${failures.join("; ")})` : "";
		throw new Error(
			`No image provider is configured. Configure the active OpenAI-compatible provider, sign in to OpenAI Codex, set OPENAI_API_KEY, or configure OpenRouter.${detail}`,
		);
	}
	throw new Error(`Image generation failed for all configured providers. ${failures.join("; ")}`);
}

async function loadImage(filePath: string, cwd: string): Promise<ImageContent> {
	const absolutePath = resolveToCwd(filePath, cwd);
	await access(absolutePath);
	const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
	if (!mimeType) throw new Error(`Unsupported image file: ${filePath}`);
	const processed = await processImage(await readFile(absolutePath), mimeType, { autoResizeImages: true });
	if (!processed.ok) throw new Error(`Unable to process referenced image ${filePath}: ${processed.message}`);
	return { type: "image", data: processed.data, mimeType: processed.mimeType };
}

function imagesFromContent(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(item): item is ImageContent =>
			typeof item === "object" &&
			item !== null &&
			(item as { type?: unknown }).type === "image" &&
			typeof (item as { data?: unknown }).data === "string" &&
			typeof (item as { mimeType?: unknown }).mimeType === "string",
	);
}

function imagesFromEntry(entry: SessionEntry): ImageContent[] {
	if (entry.type === "custom_message") return imagesFromContent(entry.content);
	if (entry.type !== "message") return [];
	return "content" in entry.message ? imagesFromContent(entry.message.content) : [];
}

function recentImages(entries: readonly SessionEntry[], count: number): ImageContent[] {
	const images: ImageContent[] = [];
	for (let index = entries.length - 1; index >= 0 && images.length < count; index--) {
		const entryImages = imagesFromEntry(entries[index]);
		for (let imageIndex = entryImages.length - 1; imageIndex >= 0 && images.length < count; imageIndex--) {
			images.push(entryImages[imageIndex]);
		}
	}
	return images.reverse();
}

async function resolveReferences(input: ImageGenInput, ctx: ExtensionContext): Promise<ImageContent[]> {
	const paths = input.referenced_image_paths ?? [];
	if (paths.length > 0 && input.num_last_images_to_include !== undefined && input.num_last_images_to_include > 0) {
		throw new Error("Provide only one of referenced_image_paths or num_last_images_to_include.");
	}
	if (paths.length > MAX_EDIT_IMAGES)
		throw new Error(`referenced_image_paths accepts at most ${MAX_EDIT_IMAGES} files.`);
	if (paths.length > 0) return Promise.all(paths.map((filePath) => loadImage(filePath, ctx.cwd)));
	if (!input.num_last_images_to_include) return [];
	const images = recentImages(ctx.sessionManager.getBranch(), input.num_last_images_to_include);
	if (images.length !== input.num_last_images_to_include) {
		throw new Error(
			`Requested the last ${input.num_last_images_to_include} conversation images, but only ${images.length} were available.`,
		);
	}
	return images;
}

function sanitizePathPart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_");
	return sanitized || "generated_image";
}

async function saveGeneratedImage(sessionId: string, toolCallId: string, data: string): Promise<string> {
	const directory = join(getAgentDir(), "generated_images", sanitizePathPart(sessionId));
	await mkdir(directory, { recursive: true });
	let filePath = join(directory, `${sanitizePathPart(toolCallId)}.png`);
	try {
		await access(filePath);
		filePath = join(directory, `${sanitizePathPart(toolCallId)}-${randomUUID().slice(0, 8)}.png`);
	} catch {}
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, Buffer.from(data, "base64"), { flag: "wx" });
		await rename(temporaryPath, filePath);
		return filePath;
	} catch (error) {
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

export function createImageGenToolDefinition(): ToolDefinition<typeof imageGenSchema, ImageGenDetails> {
	return {
		name: "image_gen",
		label: "image_gen",
		description:
			"Generate a new raster image or edit images from local paths or recent conversation context. Returns and saves a PNG.",
		promptSnippet: "Generate or edit raster images with the configured image provider.",
		promptGuidelines: [
			"Use image_gen for AI-created raster images; use native code or existing vector assets when they fit better.",
			"For a new image, omit reference fields; if the provider requires all schema fields, use referenced_image_paths=[] and num_last_images_to_include=0.",
			"For project assets, copy the selected generated image into the workspace before finishing.",
		],
		parameters: imageGenSchema,
		async execute(toolCallId, input, signal, _onUpdate, ctx) {
			const prompt = input.prompt.trim();
			if (!prompt) throw new Error("prompt must not be empty.");
			signal?.throwIfAborted();
			const references = await resolveReferences(input, ctx);
			const { candidate, result } = await generateWithProviderFallback(
				ctx,
				{ input: [{ type: "text", text: prompt }, ...references] },
				signal,
			);
			const image = result.output.find((item): item is ImageContent => item.type === "image");
			if (!image) throw new Error("Image provider returned no image data.");
			signal?.throwIfAborted();
			const savedPath = await saveGeneratedImage(ctx.sessionManager.getSessionId(), toolCallId, image.data);
			const mode = references.length > 0 ? "edit" : "generate";
			return {
				content: [
					{
						type: "text",
						text: `Generated image saved to ${savedPath}. Copy it into the workspace for project use; leave the original in place unless the user asks to delete it.`,
					},
					image,
				],
				details: {
					provider: candidate.sourceProvider,
					model: candidate.model.id,
					savedPath,
					prompt,
					mode,
				},
				usage: result.usage,
			};
		},
		renderCall(args, _theme, context) {
			const summary = getToolSummary(context.lastComponent);
			summary.setText(
				formatToolSummary({
					icon: "◫",
					subject: args.prompt?.trim() ?? "",
					expanded: context.expanded,
					isPartial: context.isPartial,
					isError: context.isError,
					labels: { running: "正在生成图片", success: "已生成图片", error: "图片生成失败" },
				}),
			);
			return summary;
		},
		renderResult(result, options, theme, context) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (context.isError) {
				const message = result.content.find((item) => item.type === "text")?.text;
				if (message) component.addChild(new Text(theme.fg("error", message), 0, 0));
				return component;
			}
			if (options.expanded && result.details) {
				component.addChild(
					new Text(
						theme.fg(
							"muted",
							`${result.details.provider}/${result.details.model}\n${shortenPath(result.details.savedPath)}\n${result.details.prompt}`,
						),
						0,
						0,
					),
				);
			}
			return component;
		},
	};
}

export default function imageGenExtension(pi: ExtensionAPI): void {
	pi.registerTool(createImageGenToolDefinition());
	pi.on("resources_discover", () => ({ skillPaths: [join(getBundledSkillsDir(), "imagegen", "SKILL.md")] }));
}
