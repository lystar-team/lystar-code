import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { loadLystarConfig, updateLystarConfig } from "./lystar-config.ts";

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

export interface ToolRecoverySettings {
	model?: string;
	thinkingLevel: ModelThinkingLevel;
}

function readSettings(config: Record<string, unknown> | undefined): ToolRecoverySettings {
	const recovery = config?.toolRecovery;
	if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) return { thinkingLevel: "low" };
	const settings = recovery as Record<string, unknown>;
	const model = settings.model;
	const thinkingLevel = THINKING_LEVELS.includes(settings.thinkingLevel as ModelThinkingLevel)
		? (settings.thinkingLevel as ModelThinkingLevel)
		: "low";
	return { ...(typeof model === "string" && model.trim() ? { model: model.trim() } : {}), thinkingLevel };
}

export async function loadToolRecoverySettings(agentDir: string): Promise<ToolRecoverySettings> {
	return readSettings(await loadLystarConfig(agentDir));
}

export async function saveToolRecoverySettings(
	agentDir: string,
	input: { model?: unknown; thinkingLevel?: unknown },
): Promise<ToolRecoverySettings> {
	if (input.model !== undefined && typeof input.model !== "string") throw new Error("错题本模型必须是文本");
	const model = typeof input.model === "string" ? input.model.trim() : "";
	if (model.length > 4096 || (model && !/^[^/\s]+\/.+$/u.test(model))) {
		throw new Error("错题本模型标识无效");
	}
	if (!THINKING_LEVELS.includes(input.thinkingLevel as ModelThinkingLevel)) throw new Error("不支持的错题本思考强度");
	const config = await updateLystarConfig(agentDir, (current) => {
		const existing = current.toolRecovery;
		const recovery =
			existing && typeof existing === "object" && !Array.isArray(existing)
				? { ...(existing as Record<string, unknown>) }
				: {};
		if (model) recovery.model = model;
		else delete recovery.model;
		recovery.thinkingLevel = input.thinkingLevel;
		return { ...current, toolRecovery: recovery };
	});
	return readSettings(config);
}
