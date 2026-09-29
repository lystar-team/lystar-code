import type { WebThinkingLevel } from "../../../types";

export function thinkingLevelAfterModelChange(
	level: WebThinkingLevel | "",
	supportedLevels: readonly string[] | undefined,
): WebThinkingLevel | "" {
	if (!level || !supportedLevels?.length) return level;
	return supportedLevels.includes(level) ? level : "";
}
