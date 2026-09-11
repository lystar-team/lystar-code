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
import { uiGlyphs } from "../../modes/interactive/ui-glyphs.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";

const MAX_EDIT_IMAGES = 5;
const IMAGE_PROVIDER_ORDER = ["openai-codex", "openai", "openrouter"] as const;
const IMAGE_MODEL_IDS = ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const;
const OPENAI_COMPATIBLE_IMAGE_APIS = new Set<Api>(["openai-completions", "openai-responses"]);
const CONTENT_POLICY_ERROR = /content[_ -]?policy|content[_ -]?filter|moderation|safety system|safety violation/i;

type ImageProviderId = (typeof IMAGE_PROVIDER_ORDER)[number];
type ImageModelId = (typeof IMAGE_MODEL_IDS)[number];
type ImageModelPreference = "auto" | ImageModelId;
type ImageProfile = "fast" | "standard" | "precision";
type ImageMode = "generate" | "edit";

interface ImageGenerationCandidate {
	sourceProvider: string;
	model: ImagesModel<ImagesApi>;
	options?: ImagesOptions;
}

interface ImageModelSelection {
	requestedModel: ImageModelPreference;
	profile: ImageProfile;
	modelIds: ImageModelId[];
}

const imageGenSchema = Type.Object(
	{
		prompt: Type.String({ description: "Complete image generation or editing prompt." }),
		model: Type.Optional(
			Type.Union(
				[
					Type.Literal("auto"),
					Type.Literal("gpt-image-2"),
					Type.Literal("gpt-image-2.5-flare"),
					Type.Literal("gpt-image-2.5-sunburst"),
				],
				{
					description:
						"Image model. Default: auto. Flare is the normal fast model; Sunburst is for precision-sensitive work; GPT Image 2 is compatibility-only unless explicitly requested.",
				},
			),
		),
		profile: Type.Optional(
			Type.Union([Type.Literal("fast"), Type.Literal("standard"), Type.Literal("precision")], {
				description:
					"Selection profile used when model is auto. fast and standard select Flare; precision selects Sunburst. Defaults to precision for edits and standard for new images.",
			}),
		),
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
	requestedModel: ImageModelPreference;
	profile: ImageProfile;
	savedPath: string;
	mimeType: string;
	prompt: string;
	mode: ImageMode;
}

function imageModelId(provider: ImageProviderId, modelId: ImageModelId): string {
	return provider === "openrouter" ? `openai/${modelId}` : modelId;
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

function resolveImageModelSelection(input: ImageGenInput, mode: ImageMode): ImageModelSelection {
	const requestedModel = input.model ?? "auto";
	const profile = input.profile ?? (mode === "edit" ? "precision" : "standard");
	if (requestedModel !== "auto") return { requestedModel, profile, modelIds: [requestedModel] };
	const primary = profile === "precision" ? "gpt-image-2.5-sunburst" : "gpt-image-2.5-flare";
	return { requestedModel, profile, modelIds: [primary, "gpt-image-2"] };
}

async function getActiveImageCandidate(
	ctx: ExtensionContext,
	modelId: ImageModelId,
	failures: string[],
): Promise<ImageGenerationCandidate | undefined> {
	const activeModel = ctx.model;
	if (!activeModel) return undefined;
	const imageProvider = imageProviderForActiveModel(activeModel);
	if (!imageProvider) return undefined;
	const imageModel = ctx.modelRegistry.findImage(imageProvider, imageModelId(imageProvider, modelId));
	if (!imageModel) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(activeModel);
	if (!auth.ok) {
		failures.push(`${activeModel.provider}/${imageModel.id}: ${auth.error}`);
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
	modelId: ImageModelId,
	failures: string[],
): Promise<ImageGenerationCandidate | undefined> {
	const model = ctx.modelRegistry.findImage(provider, imageModelId(provider, modelId));
	if (!model) return undefined;
	try {
		const auth = await ctx.modelRegistry.getImageProviderAuth(provider);
		return auth?.auth.apiKey ? { sourceProvider: provider, model } : undefined;
	} catch (error) {
		failures.push(`${provider}/${model.id}: ${error instanceof Error ? error.message : String(error)}`);
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
	failures.push(`${candidate.sourceProvider}/${candidate.model.id}: ${message}`);
	if (CONTENT_POLICY_ERROR.test(message)) throw new Error(message);
	return undefined;
}

async function generateWithProviderFallback(
	ctx: ExtensionContext,
	context: ImagesContext,
	selection: ImageModelSelection,
	signal?: AbortSignal,
	onAttempt?: (candidate: ImageGenerationCandidate) => void,
): Promise<{
	candidate: ImageGenerationCandidate;
	result: AssistantImages;
}> {
	const failures: string[] = [];
	let configuredCandidates = 0;

	for (const modelId of selection.modelIds) {
		const activeCandidate = await getActiveImageCandidate(ctx, modelId, failures);
		if (activeCandidate) {
			configuredCandidates++;
			onAttempt?.(activeCandidate);
			const result = await tryImageCandidate(ctx, activeCandidate, context, failures, signal);
			if (result) return { candidate: activeCandidate, result };
		}

		for (const provider of IMAGE_PROVIDER_ORDER) {
			if (activeCandidate?.sourceProvider === provider) continue;
			const candidate = await getConfiguredImageCandidate(ctx, provider, modelId, failures);
			if (!candidate) continue;
			configuredCandidates++;
			onAttempt?.(candidate);
			const result = await tryImageCandidate(ctx, candidate, context, failures, signal);
			if (result) return { candidate, result };
		}
	}

	const requested = selection.requestedModel === "auto" ? selection.modelIds.join(" -> ") : selection.requestedModel;
	if (configuredCandidates === 0) {
		const detail = failures.length > 0 ? ` (${failures.join("; ")})` : "";
		throw new Error(
			`No image provider is configured for ${requested}. Configure the active OpenAI-compatible provider, sign in to OpenAI Codex, set OPENAI_API_KEY, or configure OpenRouter.${detail}`,
		);
	}
	throw new Error(`Image generation failed for ${requested}. ${failures.join("; ")}`);
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

function extensionForMimeType(mimeType: string): string {
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/webp") return "webp";
	return "png";
}

async function saveGeneratedImage(
	sessionId: string,
	toolCallId: string,
	data: string,
	mimeType: string,
): Promise<string> {
	const directory = join(getAgentDir(), "generated_images", sanitizePathPart(sessionId));
	await mkdir(directory, { recursive: true });
	const extension = extensionForMimeType(mimeType);
	let filePath = join(directory, `${sanitizePathPart(toolCallId)}.${extension}`);
	try {
		await access(filePath);
		filePath = join(directory, `${sanitizePathPart(toolCallId)}-${randomUUID().slice(0, 8)}.${extension}`);
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

function plannedMode(input: ImageGenInput): ImageMode {
	return (input.referenced_image_paths?.length ?? 0) > 0 || (input.num_last_images_to_include ?? 0) > 0
		? "edit"
		: "generate";
}

export function createImageGenToolDefinition(): ToolDefinition<typeof imageGenSchema, ImageGenDetails> {
	return {
		name: "image_gen",
		label: "image_gen",
		description:
			"Generate a raster image or edit local/recent images. Supports automatic, Flare, Sunburst, and GPT Image 2 model selection, then saves the result locally.",
		promptSnippet: "Generate or edit raster images with deterministic image-model selection.",
		promptGuidelines: [
			"Use image_gen for AI-created raster images; use native code or existing vector assets when they fit better.",
			"For model=auto, use profile=fast or standard for normal Flare generation and profile=precision for Sunburst precision work.",
			"Use precision for invariant-sensitive edits, identity preservation, exact text/layout, complex compositing, or explicit highest-fidelity requests.",
			"Use gpt-image-2 only when the user explicitly requests it; automatic selection may use it as a compatibility fallback.",
			"For a new image, omit reference fields; if the provider requires all schema fields, use referenced_image_paths=[] and num_last_images_to_include=0.",
			"For project assets, copy the selected generated image into the workspace before finishing.",
		],
		parameters: imageGenSchema,
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			const prompt = input.prompt.trim();
			if (!prompt) throw new Error("prompt must not be empty.");
			signal?.throwIfAborted();
			const mode = plannedMode(input);
			const selection = resolveImageModelSelection(input, mode);
			const progressDetails: ImageGenDetails = {
				provider: "",
				model: selection.modelIds[0],
				requestedModel: selection.requestedModel,
				profile: selection.profile,
				savedPath: "",
				mimeType: "",
				prompt,
				mode,
			};
			onUpdate?.({
				content: [{ type: "text", text: mode === "edit" ? "正在准备参考图片" : "正在准备生成参数" }],
				details: progressDetails,
			});
			const references = await resolveReferences(input, ctx);
			const { candidate, result } = await generateWithProviderFallback(
				ctx,
				{ input: [{ type: "text", text: prompt }, ...references] },
				selection,
				signal,
				(attempt) =>
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `正在使用 ${attempt.sourceProvider}/${attempt.model.id} 生成图片`,
							},
						],
						details: {
							...progressDetails,
							provider: attempt.sourceProvider,
							model: attempt.model.id,
						},
					}),
			);
			const image = result.output.find((item): item is ImageContent => item.type === "image");
			if (!image) throw new Error("Image provider returned no image data.");
			signal?.throwIfAborted();
			onUpdate?.({
				content: [{ type: "text", text: "图片生成完成，正在保存原图" }],
				details: {
					...progressDetails,
					provider: candidate.sourceProvider,
					model: candidate.model.id,
					mimeType: image.mimeType,
				},
			});
			const savedPath = await saveGeneratedImage(
				ctx.sessionManager.getSessionId(),
				toolCallId,
				image.data,
				image.mimeType,
			);
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
					requestedModel: selection.requestedModel,
					profile: selection.profile,
					savedPath,
					mimeType: image.mimeType,
					prompt,
					mode: references.length > 0 ? "edit" : "generate",
				},
				usage: result.usage,
			};
		},
		renderCall(args, _theme, context) {
			const summary = getToolSummary(context.lastComponent);
			summary.setText(
				formatToolSummary({
					icon: uiGlyphs.image,
					subject: args.prompt?.trim() ?? "",
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
							`${result.details.provider}/${result.details.model} · ${result.details.profile}\n${shortenPath(result.details.savedPath)}\n${result.details.prompt}`,
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
