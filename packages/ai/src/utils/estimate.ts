import type { AssistantMessage, Context, ImageContent, Message, TextContent, Tool, Usage } from "../types.ts";

export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent applicable assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent applicable assistant usage block. */
	trailingTokens: number;
	/** Index of the applicable message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;
const textEncoder = new TextEncoder();

function encodedLength(value: string | undefined): number {
	return value ? textEncoder.encode(value).length : 0;
}

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function estimateTextAndImageContentChars(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return content.length;

	let chars = 0;
	for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	return chars;
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
	let chars = 0;

	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);

	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else {
			chars += block.name.length + safeJsonStringify(block.arguments).length;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

function getLastAssistantUsageInfo(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			// A newer prefix message was inserted after this response (for example, a
			// compaction summary), so its usage cannot describe the current prefix.
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			if (
				usageAppliesToPrefix &&
				assistant.stopReason !== "aborted" &&
				assistant.stopReason !== "error" &&
				calculateContextTokens(assistant.usage) > 0
			) {
				usageInfo = { usage: assistant.usage, index: i };
			}
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

function estimateMessages(messages: readonly Message[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}

	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

function estimateToolsTokens(tools: readonly Tool[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}

function estimateToolsTokenUpperBound(tools: readonly Tool[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return encodedLength(safeJsonStringify(tools));
}

function estimateMessageTokenUpperBound(message: Message): number {
	let tokens = 0;
	const addContent = (content: string | Array<TextContent | ImageContent>) => {
		if (typeof content === "string") {
			tokens += encodedLength(content);
			return;
		}
		for (const block of content) {
			tokens +=
				block.type === "text"
					? encodedLength(block.text) + encodedLength(block.textSignature)
					: ESTIMATED_IMAGE_CHARS;
		}
	};

	if (message.role === "user" || message.role === "toolResult") {
		addContent(message.content);
		if (message.role === "toolResult") {
			tokens += encodedLength(message.toolCallId) + encodedLength(message.toolName);
		}
		return tokens;
	}

	for (const block of message.content) {
		if (block.type === "text") {
			tokens += encodedLength(block.text) + encodedLength(block.textSignature);
		} else if (block.type === "thinking") {
			tokens += encodedLength(block.thinking) + encodedLength(block.thinkingSignature);
		} else {
			tokens +=
				encodedLength(block.id) +
				encodedLength(block.name) +
				encodedLength(safeJsonStringify(block.arguments)) +
				encodedLength(block.thoughtSignature);
		}
	}
	return tokens;
}

/** 保守估算请求上界，用于执行模型配置中的上下文窗口硬限制。 */
export function estimateContextTokensUpperBound(context: Context): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(context.messages);
	if (usageInfo) {
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < context.messages.length; i++) {
			trailingTokens += estimateMessageTokenUpperBound(context.messages[i]);
		}
		const addedNames = new Set(
			context.messages
				.slice(usageInfo.index + 1)
				.filter((message) => message.role === "toolResult")
				.flatMap((message) => message.addedToolNames ?? []),
		);
		trailingTokens += estimateToolsTokenUpperBound(context.tools?.filter((tool) => addedNames.has(tool.name)));
		const usageTokens = calculateContextTokens(usageInfo.usage);
		return {
			tokens: usageTokens + trailingTokens,
			usageTokens,
			trailingTokens,
			lastUsageIndex: usageInfo.index,
		};
	}

	let trailingTokens = context.systemPrompt ? encodedLength(context.systemPrompt) : 0;
	trailingTokens += estimateToolsTokenUpperBound(context.tools);
	for (const message of context.messages) trailingTokens += estimateMessageTokenUpperBound(message);
	return { tokens: trailingTokens, usageTokens: 0, trailingTokens, lastUsageIndex: null };
}

function isMessageArray(value: Context | readonly Message[]): value is readonly Message[] {
	return Array.isArray(value);
}

export function estimateContextTokens(context: Context | readonly Message[]): ContextUsageEstimate {
	if (isMessageArray(context)) return estimateMessages(context);

	const estimate = estimateMessages(context.messages);
	if (estimate.lastUsageIndex !== null) {
		const addedNames = new Set(
			context.messages
				.slice(estimate.lastUsageIndex + 1)
				.filter((message) => message.role === "toolResult")
				.flatMap((message) => message.addedToolNames ?? []),
		);
		const addedToolTokens = estimateToolsTokens(context.tools?.filter((tool) => addedNames.has(tool.name)));
		return {
			tokens: estimate.tokens + addedToolTokens,
			usageTokens: estimate.usageTokens,
			trailingTokens: estimate.trailingTokens + addedToolTokens,
			lastUsageIndex: estimate.lastUsageIndex,
		};
	}

	const prefixTokens =
		(context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0) + estimateToolsTokens(context.tools);

	return {
		tokens: estimate.tokens + prefixTokens,
		usageTokens: estimate.usageTokens,
		trailingTokens: estimate.trailingTokens + prefixTokens,
		lastUsageIndex: estimate.lastUsageIndex,
	};
}
