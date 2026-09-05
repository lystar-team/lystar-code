import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import type {
	AgentSettledEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../core/extensions/index.ts";
import type { SessionEntry, SessionMessageEntry } from "../../core/session-manager.ts";
import { loadSessionNameConfig } from "./config.ts";

type UserMessageEntry = SessionMessageEntry & {
	message: Extract<SessionMessageEntry["message"], { role: "user" }>;
};

const SESSION_NAME_SYSTEM_PROMPT = [
	"你是会话命名助手。",
	"根据用户的第一条消息生成一个简短、准确的会话标题。",
	"只输出标题本身，不要引号、Markdown、前缀或解释。",
	"使用与用户消息相同的语言，标题不超过 30 个字。",
].join("\n");

const SESSION_NAME_MAX_TOKENS = 64;
const SESSION_NAME_THINKING_LEVEL = "low" as const;
const SESSION_NAME_MAX_LENGTH = 30;

interface PendingNameRequest {
	controller: AbortController;
	token: number;
}

function isUserMessageEntry(entry: SessionEntry): entry is UserMessageEntry {
	return entry.type === "message" && entry.message.role === "user";
}

function getFirstUserMessage(sessionEntries: SessionEntry[]): string | undefined {
	const entry = sessionEntries.find(isUserMessageEntry);
	if (!entry) return undefined;

	const text = contentText(entry.message.content, "").trim();
	return text || undefined;
}

function resolveConfiguredModel(reference: string, ctx: ExtensionContext): Model<Api> | undefined {
	const separator = reference.indexOf("/");
	if (separator <= 0) {
		return ctx.model ? ctx.modelRegistry.find(ctx.model.provider, reference) : undefined;
	}

	return ctx.modelRegistry.find(reference.slice(0, separator), reference.slice(separator + 1));
}

function normalizeSessionName(content: string): string | undefined {
	const firstLine = content
		.replace(/```(?:text|markdown)?/gi, "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstLine) return undefined;

	const name = firstLine
		.replace(/^[-*#]+\s*/, "")
		.replace(/^(?:title|标题)\s*[:：]\s*/i, "")
		.replace(/^[`"“”'‘’]+|[`"“”'‘’]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!name) return undefined;

	return Array.from(name).slice(0, SESSION_NAME_MAX_LENGTH).join("");
}

async function generateSessionName(
	ctx: ExtensionContext,
	userMessage: string,
	sessionId: string,
	agentDir: string | undefined,
	signal: AbortSignal,
): Promise<string | undefined> {
	const configuredModel = loadSessionNameConfig(agentDir);
	const model = configuredModel.model ? resolveConfiguredModel(configuredModel.model, ctx) : ctx.model;
	if (!model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;

	const context: Context = {
		systemPrompt: SESSION_NAME_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: userMessage }],
				timestamp: Date.now(),
			},
		],
	};
	const options = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		signal,
		maxTokens: SESSION_NAME_MAX_TOKENS,
		cacheRetention: "none" as const,
		sessionId,
		reasoning: model.reasoning ? SESSION_NAME_THINKING_LEVEL : undefined,
	};

	const response: AssistantMessage = await ctx.modelRegistry.complete(model, context, options);
	if (response.stopReason !== "stop" && response.stopReason !== "length") return undefined;

	return normalizeSessionName(contentText(response.content, ""));
}

function isEligibleNewSession(event: SessionStartEvent, ctx: ExtensionContext): boolean {
	if (event.reason !== "startup" && event.reason !== "new") return false;
	if (!ctx.sessionManager.getSessionFile()) return false;
	if (ctx.sessionManager.getSessionName()) return false;
	return !ctx.sessionManager.getEntries().some(isUserMessageEntry);
}

export function createSessionNameExtension(agentDir?: string): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let sessionToken = 0;
		let eligible = false;
		let manualNameChanged = false;
		let attempted = false;
		let automaticNameWrite = false;
		let pending: PendingNameRequest | undefined;

		const cancelPending = () => {
			pending?.controller.abort();
			pending = undefined;
		};

		pi.on("session_start", (event: SessionStartEvent, ctx) => {
			cancelPending();
			sessionToken++;
			eligible = isEligibleNewSession(event, ctx);
			manualNameChanged = false;
			attempted = false;
		});

		pi.on("session_info_changed", (_event: SessionInfoChangedEvent) => {
			if (!eligible || automaticNameWrite) return;
			manualNameChanged = true;
			cancelPending();
		});

		pi.on("session_shutdown", (_event: SessionShutdownEvent) => {
			cancelPending();
			sessionToken++;
			eligible = false;
		});

		pi.on("agent_settled", (_event: AgentSettledEvent, ctx) => {
			if (!eligible || attempted || manualNameChanged || pending) return;

			const userMessage = getFirstUserMessage(ctx.sessionManager.getBranch());
			if (!userMessage) {
				attempted = true;
				return;
			}

			attempted = true;
			const token = sessionToken;
			const sessionId = ctx.sessionManager.getSessionId();
			const controller = new AbortController();
			pending = { controller, token };

			void generateSessionName(ctx, userMessage, sessionId, agentDir, controller.signal)
				.then((name) => {
					if (!name || controller.signal.aborted || token !== sessionToken || manualNameChanged) return;

					try {
						if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getSessionName()) return;
						eligible = false;
						automaticNameWrite = true;
						pi.setSessionName(name);
					} catch {
						// 会话切换或退出时，旧上下文可能已经失效；自动命名直接放弃。
					} finally {
						automaticNameWrite = false;
					}
				})
				.catch(() => {
					// 自动命名失败不影响主会话。
				})
				.finally(() => {
					if (pending?.token === token) pending = undefined;
				});
		});
	};
}

const sessionNameExtension = createSessionNameExtension();

export default sessionNameExtension;
