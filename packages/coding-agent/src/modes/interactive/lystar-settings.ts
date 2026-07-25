import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AltScreenMode } from "./terminal-mode.ts";

export interface LystarSettings {
	altScreen: AltScreenMode;
	mouse: boolean;
	reduceMotion: boolean;
}

const DEFAULT_SETTINGS: LystarSettings = {
	altScreen: "auto",
	mouse: true,
	reduceMotion: false,
};

export function getLystarSettingsPath(agentDir: string): string {
	return join(agentDir, "lystar.json");
}

export function loadLystarSettings(agentDir: string): { settings: LystarSettings; warning?: string } {
	const settingsPath = getLystarSettingsPath(agentDir);
	if (!existsSync(settingsPath)) return { settings: { ...DEFAULT_SETTINGS } };

	try {
		const value = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		const altScreen = value.altScreen ?? DEFAULT_SETTINGS.altScreen;
		const mouse = value.mouse ?? DEFAULT_SETTINGS.mouse;
		const reduceMotion = value.reduceMotion ?? DEFAULT_SETTINGS.reduceMotion;
		if (altScreen !== "auto" && altScreen !== "always" && altScreen !== "never") {
			throw new Error('altScreen 必须是 "auto"、"always" 或 "never"');
		}
		if (typeof mouse !== "boolean") throw new Error("mouse 必须是布尔值");
		if (typeof reduceMotion !== "boolean") throw new Error("reduceMotion 必须是布尔值");
		return { settings: { altScreen, mouse, reduceMotion } };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			settings: { ...DEFAULT_SETTINGS },
			warning: `无法读取 ${settingsPath}：${message}。已使用默认终端设置。`,
		};
	}
}
