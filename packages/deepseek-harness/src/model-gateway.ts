import type { Context as CordisContext } from "@deepseek-ai/cordis";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import { brandString } from "@deepseek-ai/dsh-brand";
import {
	attributionHeaders,
	type ContentBlock,
	createAssistantMessage,
	createSystemMessage,
	createToolResultMessage,
	createUserMessage,
	type GenerateOptions,
	type Message as HarnessMessage,
	LlmAdapter,
	type LlmResolvedModelInfo,
	type PreparedAdapterCall,
	type ReasoningEffortId,
	type StreamChunk,
	type ToolCallId,
	type ToolSchema,
} from "@deepseek-ai/dsh-llm";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	getSupportedThinkingLevels,
	getSystemMessageText,
	type Message,
	type Model,
	type ModelsSimpleStreamOptions,
	type ProviderHeaders,
	type Tool,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { nativeDeepSeekAdapter } from "./native-deepseek.ts";

/** The host supplies configured models, authentication, and request hooks. */
export interface ModelGateway {
	models(): readonly Model<Api>[];
	auth?(model: Model<Api>): Promise<{ apiKey?: string; headers?: ProviderHeaders; baseUrl?: string }>;
	stream(model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions): AssistantMessageEventStream;
}

export function toHarnessTools(tools: readonly Tool[]): ToolSchema[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>,
	}));
}

function toPiTool(tool: ToolSchema): Tool {
	return { name: tool.name, description: tool.description, parameters: Type.Unsafe(tool.parameters) };
}

export function toHarnessAssistantContent(message: AssistantMessage): ContentBlock[] {
	return message.content.flatMap((block): ContentBlock[] => {
		switch (block.type) {
			case "text":
				return [{ type: "text", text: block.text }];
			case "thinking":
				return [{ type: "reasoning", text: block.thinking }];
			case "toolCall":
				return [
					{
						type: "tool-call",
						id: brandString<ToolCallId>(block.id),
						name: block.name,
						arguments: JSON.stringify(block.arguments),
					},
				];
			case "webSearchCall":
				return [{ type: "text", text: JSON.stringify(block) }];
			default: {
				const unsupported: never = block;
				throw new Error(`Unsupported LYStar assistant block: ${JSON.stringify(unsupported)}`);
			}
		}
	});
}

async function toHarnessContent(
	context: CordisContext,
	content: string | Exclude<Message, { role: "assistant" | "system" }>["content"],
): Promise<ContentBlock[]> {
	if (typeof content === "string") return [{ type: "text", text: content }];
	const blocks: ContentBlock[] = [];
	for (const block of content) {
		if (block.type === "text") blocks.push({ type: "text", text: block.text });
		else {
			const attachments = context.get("attachments");
			if (!attachments) throw new Error("DSH attachment service is required to import image history");
			const mediaType = block.mimeType;
			if (
				mediaType !== "image/png" &&
				mediaType !== "image/jpeg" &&
				mediaType !== "image/webp" &&
				mediaType !== "image/gif"
			)
				throw new Error(`DSH does not support image type ${mediaType}`);
			const attachment = await attachments.saveImage({ data: Buffer.from(block.data, "base64"), mediaType });
			blocks.push({ type: "image", attachment });
		}
	}
	return blocks;
}

/** Provider replay fields stay outside model-visible text. */
export async function toHarnessMessage(context: CordisContext, message: Message): Promise<HarnessMessage> {
	if (message.role === "assistant") {
		return createAssistantMessage({
			content: toHarnessAssistantContent(message),
			source: {
				provider: message.provider,
				model: message.model,
				replayState: { response: { kind: "lystar-pi", message: JSON.parse(JSON.stringify(message)) } },
			},
		});
	}
	if (message.role === "system") return createSystemMessage(getSystemMessageText(message));
	const content = await toHarnessContent(context, message.content);
	if (message.role === "toolResult")
		return createToolResultMessage({
			callId: brandString<ToolCallId>(message.toolCallId),
			content,
			isError: message.isError,
		});
	return createUserMessage({ content, source: { kind: "user" } });
}

function piReplay(message: Extract<HarnessMessage, { role: "assistant" }>): AssistantMessage | undefined {
	const state = message.source.replayState;
	if (!state || typeof state !== "object" || !("response" in state)) return undefined;
	const response = state.response;
	if (
		!response ||
		typeof response !== "object" ||
		!("kind" in response) ||
		response.kind !== "lystar-pi" ||
		!("message" in response)
	)
		return undefined;
	const saved = response.message as AssistantMessage;
	// Projections can edit canonical blocks; stale provider replay must not undo those edits.
	return JSON.stringify(toHarnessAssistantContent(saved)) === JSON.stringify(message.content) ? saved : undefined;
}

class GatewayAdapter extends LlmAdapter {
	private gateway: ModelGateway;
	private host: CordisContext;
	private home: string;

	constructor(host: CordisContext, gateway: ModelGateway, home: string) {
		super();
		this.host = host;
		this.gateway = gateway;
		this.home = home;
	}

	private find(provider: string, modelId: string): Model<Api> {
		const model = this.gateway.models().find((entry) => entry.provider === provider && entry.id === modelId);
		if (!model) throw new Error(`LYStar model is unavailable: ${provider}/${modelId}`);
		return model;
	}

	override async listModels(provider: string) {
		return this.gateway
			.models()
			.filter((model) => model.provider === provider)
			.map((model) => ({ provider, id: model.id, name: model.name }));
	}

	private async native(model: Model<Api>) {
		const resolveAuth = this.gateway.auth;
		if (model.provider !== "deepseek" || !resolveAuth) return undefined;
		const authentication = await resolveAuth(model);
		return nativeDeepSeekAdapter(this.host, this.gateway, model, this.home, authentication);
	}

	private piModelInfo(model: Model<Api>): LlmResolvedModelInfo {
		return {
			provider: model.provider,
			id: model.id,
			name: model.name,
			inputModalities: model.input,
			context: { contextWindow: model.contextWindow },
			defaultMaxTokens: model.maxTokens,
			reasoning: {
				efforts: getSupportedThinkingLevels(model).map((id) => ({
					id: brandString<ReasoningEffortId>(id),
					name: id,
				})),
			},
			systemPromptUpdate:
				model.compat &&
				"supportsMidConvoSystemMessages" in model.compat &&
				model.compat.supportsMidConvoSystemMessages
					? "in-history"
					: undefined,
		};
	}

	override async resolveModel(provider: string, modelId: string): Promise<LlmResolvedModelInfo> {
		const model = this.find(provider, modelId);
		const native = await this.native(model);
		return native ? native.resolveModel(provider, modelId) : this.piModelInfo(model);
	}

	override async prepareCall(provider: string, modelId: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
		const model = this.find(provider, modelId);
		const native = await this.native(model);
		return native
			? native.prepareCall(provider, modelId, signal)
			: { model: this.piModelInfo(model), stream: (options) => this.piStream(model, options) };
	}

	override imageRequestPricing(provider: string, modelId: string) {
		return nativeDeepSeekAdapter(
			this.host,
			this.gateway,
			this.find(provider, modelId),
			this.home,
		)?.imageRequestPricing(provider, modelId);
	}

	override imageRequestTarget(provider: string, modelId: string, image: ImageAttachmentRef) {
		const native = nativeDeepSeekAdapter(this.host, this.gateway, this.find(provider, modelId), this.home);
		return native
			? native.imageRequestTarget(provider, modelId, image)
			: super.imageRequestTarget(provider, modelId, image);
	}

	private async content(blocks: readonly ContentBlock[], signal?: AbortSignal) {
		const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
		for (const block of blocks) {
			if (block.type === "text") content.push({ type: "text", text: block.text });
			else if (block.type === "image") {
				const attachments = this.host.get("attachments");
				if (!attachments) throw new Error("DSH attachment service is unavailable");
				const image = await attachments.readImage(block.attachment, signal);
				content.push({
					type: "image",
					mimeType: image.ref.mediaType,
					data: Buffer.from(image.data).toString("base64"),
				});
			} else if (block.type === "file") {
				throw new Error("DSH file references must be projected to request text before model dispatch");
			}
		}
		return content;
	}

	override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
		const model = this.find(options.provider, options.model);
		const native = await this.native(model);
		if (native) yield* native.stream(options);
		else yield* this.piStream(model, options);
	}

	private async *piStream(model: Model<Api>, options: GenerateOptions): AsyncGenerator<StreamChunk> {
		const messages: Message[] = [];
		const toolNames = new Map<string, string>();
		if (options.system !== undefined) messages.push({ role: "system", content: options.system, timestamp: 0 });
		for (const message of options.messages) {
			if (message.role === "system" || message.role === "developer") {
				messages.push({
					role: "system",
					content: message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n"),
					timestamp: 0,
				});
			} else if (message.role === "assistant") {
				for (const block of message.content) if (block.type === "tool-call") toolNames.set(block.id, block.name);
				const replay = piReplay(message);
				if (replay) messages.push(replay);
				else {
					const content: AssistantMessage["content"] = [];
					for (const block of message.content) {
						if (block.type === "text") content.push({ type: "text", text: block.text });
						else if (block.type === "reasoning") content.push({ type: "thinking", thinking: block.text });
						else if (block.type === "tool-call")
							content.push({
								type: "toolCall",
								id: block.id,
								name: block.name,
								arguments: JSON.parse(block.arguments),
							});
						else throw new Error(`Unsupported assistant block in LYStar bridge: ${block.type}`);
					}
					messages.push({
						role: "assistant",
						api: model.api,
						provider: message.source.provider,
						model: message.source.model,
						content,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
						timestamp: 0,
					});
				}
			} else if (message.role === "user") {
				messages.push({ role: "user", content: await this.content(message.content, options.signal), timestamp: 0 });
			} else {
				messages.push({
					role: "toolResult",
					toolCallId: message.toolCallId,
					toolName: toolNames.get(message.toolCallId) ?? "",
					content: await this.content(message.content, options.signal),
					isError: message.isError ?? false,
					timestamp: 0,
				});
			}
		}
		const reasoning = options.reasoningEffort === "off" ? undefined : options.reasoningEffort;
		if (reasoning && !["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(reasoning))
			throw new Error(`Unsupported LYStar reasoning effort: ${reasoning}`);
		const cancellation = new AbortController();
		const streamOptions: ModelsSimpleStreamOptions = {
			signal: options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal,
			maxTokens: options.maxTokens,
			temperature: options.temperature,
			sessionId: options.sessionId,
			reasoning: reasoning as ModelsSimpleStreamOptions["reasoning"],
			headers: attributionHeaders(),
		};
		if (options.stop?.length) {
			if (!["openai-completions", "openai-responses", "azure-openai-responses"].includes(model.api))
				throw new Error(`LYStar ${model.api} does not expose stop sequences`);
			streamOptions.samplingParams = { stop: options.stop };
		}
		const response = this.gateway.stream(model, { messages, tools: options.tools?.map(toPiTool) }, streamOptions);
		try {
			for await (const event of response) {
				if (event.type === "text_delta") yield { type: "text-delta", index: event.contentIndex, text: event.delta };
				else if (event.type === "thinking_delta")
					yield { type: "reasoning-delta", index: event.contentIndex, text: event.delta };
				else if (
					event.type === "text_start" ||
					event.type === "thinking_start" ||
					event.type === "toolcall_start"
				) {
					yield {
						type: "block-start",
						index: event.contentIndex,
						blockType:
							event.type === "text_start" ? "text" : event.type === "thinking_start" ? "reasoning" : "tool-call",
					};
				} else if (event.type === "toolcall_delta") {
					const block = event.partial.content[event.contentIndex];
					if (block.type !== "toolCall") throw new Error("Expected a LYStar tool-call block");
					yield {
						type: "tool-call-delta",
						index: event.contentIndex,
						id: brandString<ToolCallId>(block.id),
						name: block.name,
						argumentsDelta: event.delta,
					};
				} else if (event.type === "text_end")
					yield { type: "block-end", index: event.contentIndex, block: { type: "text", text: event.content } };
				else if (event.type === "thinking_end")
					yield {
						type: "block-end",
						index: event.contentIndex,
						block: { type: "reasoning", text: event.content },
					};
				else if (event.type === "toolcall_end")
					yield {
						type: "block-end",
						index: event.contentIndex,
						block: {
							type: "tool-call",
							id: brandString<ToolCallId>(event.toolCall.id),
							name: event.toolCall.name,
							arguments: JSON.stringify(event.toolCall.arguments),
						},
					};
			}
			const result = await response.result();
			if (result.stopReason === "error" || result.stopReason === "aborted")
				throw new Error(result.errorMessage ?? result.stopReason);
			yield {
				type: "usage",
				usage: {
					inputTokens: result.usage.input,
					outputTokens: result.usage.output,
					totalTokens: result.usage.totalTokens,
					cacheReadTokens: result.usage.cacheRead,
					cacheWriteTokens: result.usage.cacheWrite,
				},
			};
			yield {
				type: "finish",
				reason: {
					kind:
						result.stopReason === "toolUse"
							? "tool-calls"
							: result.stopReason === "length"
								? "max-tokens"
								: "stop",
				},
				replayState: { response: { kind: "lystar-pi", message: JSON.parse(JSON.stringify(result)) } },
			};
		} finally {
			cancellation.abort();
		}
	}
}

/** Existing native adapters keep ownership of their routes. */
export function registerModelGateway(context: CordisContext, gateway: ModelGateway, home: string): void {
	const existing = new Set(context.llm.listProviders().map((provider) => provider.id));
	const providers = [...new Set(gateway.models().map((model) => model.provider))].filter(
		(provider) => !existing.has(provider),
	);
	if (providers.length) context.llm.registerAdapter(providers, new GatewayAdapter(context, gateway, home));
}
