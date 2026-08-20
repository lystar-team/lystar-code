import type { SettingsManager } from "./core/settings-manager.ts";

export type RustTuiLaunchMode = "auto" | "fullscreen" | "regular";

export interface RustTuiLaunchOptions {
	sessionPath: string;
	mode: RustTuiLaunchMode;
	exitOutput: "transcript" | "resume-hint";
	reduceMotion: boolean;
}

/**
 * Rust TUI 仍是可选路径。此处只形成启动参数，默认 InteractiveMode 不读取它。
 */
export function createRustTuiLaunchOptions(
	sessionPath: string,
	settingsManager: SettingsManager,
	env: NodeJS.ProcessEnv = process.env,
	reduceMotion = false,
): RustTuiLaunchOptions {
	const envMode = env.PI_TUI_MODE;
	const mode: RustTuiLaunchMode =
		envMode === "auto" || envMode === "fullscreen" || envMode === "regular"
			? "auto"
			: (settingsManager.getConfiguredTuiMode() ?? "auto");
	return {
		sessionPath,
		mode,
		exitOutput: settingsManager.getFullscreenExitOutput(),
		reduceMotion,
	};
}

export function rustTuiLaunchArgv(options: RustTuiLaunchOptions): string[] {
	return [
		"--run",
		options.sessionPath,
		"--mode",
		options.mode,
		"--exit-output",
		options.exitOutput,
		"--reduce-motion",
		String(options.reduceMotion),
	];
}
