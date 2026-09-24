import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type LystarConfig, loadLystarConfig, updateLystarConfig } from "./lystar-config.ts";

const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "low";
const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
];

export interface SessionNameSettings {
	model?: string;
	thinkingLevel: ModelThinkingLevel;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ModelThinkingLevel);
}

function readSessionNameSettings(config: LystarConfig | undefined): SessionNameSettings {
	const sessionName = record(config?.sessionName);
	const model = typeof sessionName?.model === "string" ? sessionName.model.trim() : "";
	const thinkingLevel = isThinkingLevel(sessionName?.thinkingLevel)
		? sessionName.thinkingLevel
		: DEFAULT_THINKING_LEVEL;
	return { ...(model ? { model } : {}), thinkingLevel };
}

export async function loadSessionNameSettings(agentDir: string): Promise<SessionNameSettings> {
	try {
		return readSessionNameSettings(await loadLystarConfig(agentDir));
	} catch {
		return { thinkingLevel: DEFAULT_THINKING_LEVEL };
	}
}

export async function saveSessionNameSettings(
	agentDir: string,
	input: { model?: unknown; thinkingLevel?: unknown },
): Promise<SessionNameSettings> {
	if (input.model !== undefined && typeof input.model !== "string") {
		throw new Error("会话标题模型必须是文本");
	}
	const model = typeof input.model === "string" ? input.model.trim() : "";
	if (model.length > 4096) throw new Error("会话标题模型标识不能超过 4096 个字符");
	if (!isThinkingLevel(input.thinkingLevel)) throw new Error("不支持的会话标题思考强度");

	const config = await updateLystarConfig(agentDir, (current) => {
		const sessionName = { ...(record(current.sessionName) ?? {}) };
		if (model) sessionName.model = model;
		else delete sessionName.model;
		sessionName.thinkingLevel = input.thinkingLevel;
		return { ...current, sessionName };
	});
	return readSessionNameSettings(config);
}
