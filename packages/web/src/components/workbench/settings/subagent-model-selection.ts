import { ThinkingLevelSchema } from "@lystar/code-web-protocol";
import type { WebThinkingLevel } from "../../../types";

export const AGENT_THINKING_LEVELS = ThinkingLevelSchema.anyOf.map((schema) => schema.const);

export function thinkingLevelAfterModelChange(
	level: WebThinkingLevel | "",
	supportedLevels: readonly string[] | undefined,
): WebThinkingLevel | "" {
	if (!level || !supportedLevels?.length) return level;
	return supportedLevels.includes(level) ? level : "";
}
