import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";

export interface SessionNameConfig {
	model?: string;
}

interface LystarConfigFile {
	sessionName?: {
		model?: unknown;
	};
}

/** 读取 LYStar 专用配置；配置无效时保持默认行为。 */
export function loadSessionNameConfig(agentDir = getAgentDir()): SessionNameConfig {
	const configPath = join(agentDir, "lystar.json");
	if (!existsSync(configPath)) return {};

	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (!parsed || typeof parsed !== "object") return {};
		const sessionName = (parsed as LystarConfigFile).sessionName;
		if (!sessionName || typeof sessionName !== "object" || typeof sessionName.model !== "string") return {};

		const model = sessionName.model.trim();
		return model ? { model } : {};
	} catch {
		return {};
	}
}
