import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";

export interface SessionNameConfig {
	model?: string;
	thinkingLevel: ModelThinkingLevel;
}

interface LystarConfigFile {
	sessionName?: {
		model?: unknown;
		thinkingLevel?: unknown;
	};
}

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

/** 读取 LYStar 专用配置；配置无效时保持默认行为。 */
export function loadSessionNameConfig(agentDir = getAgentDir()): SessionNameConfig {
	const configPath = join(agentDir, "lystar.json");
	if (!existsSync(configPath)) return { thinkingLevel: "low" };

	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (!parsed || typeof parsed !== "object") return { thinkingLevel: "low" };
		const sessionName = (parsed as LystarConfigFile).sessionName;
		if (!sessionName || typeof sessionName !== "object") return { thinkingLevel: "low" };

		const model = typeof sessionName.model === "string" ? sessionName.model.trim() : "";
		const thinkingLevel = THINKING_LEVELS.includes(sessionName.thinkingLevel as ModelThinkingLevel)
			? (sessionName.thinkingLevel as ModelThinkingLevel)
			: "low";
		return { ...(model ? { model } : {}), thinkingLevel };
	} catch {
		return { thinkingLevel: "low" };
	}
}
