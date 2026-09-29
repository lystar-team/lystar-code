import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

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

/** 未指定模型时沿用当前会话模型。 */
export function loadToolRecoveryConfig(agentDir: string): { model?: string; thinkingLevel: ModelThinkingLevel } {
	const path = join(agentDir, "lystar.json");
	if (!existsSync(path)) return { thinkingLevel: "low" };
	const config: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!config || typeof config !== "object" || !("toolRecovery" in config)) return { thinkingLevel: "low" };
	const recovery = config.toolRecovery;
	if (!recovery || typeof recovery !== "object") return { thinkingLevel: "low" };
	const model = "model" in recovery && typeof recovery.model === "string" ? recovery.model.trim() : "";
	const level = "thinkingLevel" in recovery ? recovery.thinkingLevel : undefined;
	const thinkingLevel = THINKING_LEVELS.includes(level as ModelThinkingLevel) ? (level as ModelThinkingLevel) : "low";
	return { ...(model ? { model } : {}), thinkingLevel };
}
