import type { Context } from "@deepseek-ai/cordis";
import { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import { resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm";
import {
	DeepSeekAdapter,
	type DeepSeekRequestAuth,
	PUBLIC_BASE_URL,
	resolveAdapterOptions,
} from "@deepseek-ai/dsh-llm-deepseek";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelGateway } from "./model-gateway.ts";

const nativeCatalog = resolveAdapterOptions({}).models;

/** Official models use the original Messages transport, including native replay and tool updates. */
export function nativeDeepSeekAdapter(
	context: Context,
	gateway: ModelGateway,
	model: Model<Api>,
	home: string,
	authentication?: Awaited<ReturnType<NonNullable<ModelGateway["auth"]>>>,
): DeepSeekAdapter | undefined {
	const resolveAuth = gateway.auth;
	if (model.provider !== "deepseek" || model.api !== "openai-completions" || !resolveAuth) return undefined;
	if (authentication?.headers && Object.values(authentication.headers).some((value) => value === null))
		return undefined;
	const url = new URL(authentication?.baseUrl ?? model.baseUrl);
	if (
		url.origin !== new URL(PUBLIC_BASE_URL).origin ||
		!["", "/", "/v1", "/v1/", "/anthropic", "/anthropic/"].includes(url.pathname)
	)
		return undefined;
	const catalogModel = nativeCatalog.find((entry) => entry.id === model.id);
	if (!catalogModel) return undefined;
	const compatibility = model.compat;
	const options = resolveAdapterOptions({
		baseURL: PUBLIC_BASE_URL,
		maxTokens: model.maxTokens,
		defaultContextWindow: model.contextWindow,
		models: [
			{
				...catalogModel,
				name: model.name,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				systemPromptUpdate:
					compatibility &&
					"supportsMidConvoSystemMessages" in compatibility &&
					compatibility.supportsMidConvoSystemMessages === false
						? undefined
						: catalogModel.systemPromptUpdate,
				toolUpdate:
					compatibility &&
					"supportsMidConvoToolAdditions" in compatibility &&
					compatibility.supportsMidConvoToolAdditions === false
						? undefined
						: catalogModel.toolUpdate,
			},
		],
	});
	return new DeepSeekAdapter({
		providerName: "DeepSeek",
		options: () => options,
		resolveAuth: async (): Promise<DeepSeekRequestAuth> => {
			const resolved = authentication ?? (await resolveAuth(model));
			if (!resolved.apiKey) throw new Error(`LYStar API key is unavailable: ${model.provider}/${model.id}`);
			return {
				headers: {
					"x-api-key": resolved.apiKey,
					...Object.fromEntries(
						Object.entries(resolved.headers ?? {}).filter(
							(entry): entry is [string, string] => entry[1] !== null,
						),
					),
				},
			};
		},
		resolveUserId: () => getOrCreateAnonymousUserId({ env: { DSH_HOME: home } }),
		resolveAttachments: () => context.get("attachments"),
		resolveImageAccess: (attachments, ref) =>
			resolveImageAttachmentAccess(attachments, (path) => context.get("fs")?.processPathFromHostPath(path), ref),
		prepareExtensions: (request) =>
			context.get("deepseekLlmApiExtensions")?.prepare(request) ??
			Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
		onReplayDegrade: ({ reason }) => context.logger.warn("DSH DeepSeek replay: %s", reason),
	});
}
