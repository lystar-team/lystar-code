import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	TextContent,
	Tool,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { getSystemMessageText } from "./text.ts";

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
const REQUEST_BYTES_PER_TOKEN = 3;
const textEncoder = new TextEncoder();

function estimateEncodedTokens(value: string | undefined): number {
	return value ? Math.ceil(textEncoder.encode(value).length / REQUEST_BYTES_PER_TOKEN) : 0;
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

	if (message.role === "system") {
		return (
			estimateTextTokens(getSystemMessageText(message)) +
			estimateToolsTokens(message.toolsAdded) +
			estimateToolsTokens(message.toolsRemoved)
		);
	}
	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);

	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else if (block.type === "webSearchCall") {
			chars += block.id.length + safeJsonStringify(block.action).length;
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

export function estimateContextTokens(context: TranscriptContext | readonly Message[]): ContextUsageEstimate {
	const messages = "messages" in context ? context.messages : context;
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

function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}
function estimateToolsTokenUpperBound(tools: readonly Tool[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateEncodedTokens(safeJsonStringify(tools));
}

function estimateMessageTokenUpperBound(message: Message): number {
	let tokens = 0;
	const addContent = (content: string | Array<TextContent | ImageContent>) => {
		if (typeof content === "string") {
			tokens += estimateEncodedTokens(content);
			return;
		}
		for (const block of content) {
			tokens +=
				block.type === "text"
					? estimateEncodedTokens(block.text) + estimateEncodedTokens(block.textSignature)
					: Math.ceil(ESTIMATED_IMAGE_CHARS / REQUEST_BYTES_PER_TOKEN);
		}
	};

	if (message.role === "user" || message.role === "toolResult") {
		addContent(message.content);
		if (message.role === "toolResult") {
			tokens += estimateEncodedTokens(message.toolCallId) + estimateEncodedTokens(message.toolName);
		}
		return tokens;
	}
	if (typeof message.content === "string") return tokens + estimateEncodedTokens(message.content);

	for (const block of message.content) {
		if (block.type === "text") {
			tokens += estimateEncodedTokens(block.text) + estimateEncodedTokens(block.textSignature);
		} else if (block.type === "thinking") {
			tokens += estimateEncodedTokens(block.thinking) + estimateEncodedTokens(block.thinkingSignature);
		} else if (block.type === "webSearchCall") {
			tokens += estimateEncodedTokens(block.id) + estimateEncodedTokens(safeJsonStringify(block.action));
		} else {
			tokens +=
				estimateEncodedTokens(block.id) +
				estimateEncodedTokens(block.name) +
				estimateEncodedTokens(safeJsonStringify(block.arguments)) +
				estimateEncodedTokens(block.thoughtSignature);
		}
	}
	return tokens;
}

/**
 * 请求前轻量估算。已有历史以 Provider usage 为锚点，只估算其后新增内容；
 * 没有 usage 时按 UTF-8 体量近似，结果用于提前压缩，不能替代 Provider 的真实溢出判断。
 */
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
				.flatMap((message) => (message as Message & { addedToolNames?: string[] }).addedToolNames ?? []),
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

	let trailingTokens = estimateEncodedTokens(context.systemPrompt);
	trailingTokens += estimateToolsTokenUpperBound(context.tools);
	for (const message of context.messages) trailingTokens += estimateMessageTokenUpperBound(message);
	return { tokens: trailingTokens, usageTokens: 0, trailingTokens, lastUsageIndex: null };
}
