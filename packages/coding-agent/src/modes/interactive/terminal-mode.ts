import { spawnSync } from "node:child_process";

export type AltScreenMode = "auto" | "always" | "never";

export interface TerminalModeContext {
	isTTY: boolean;
	term?: string;
	tmux?: string;
	zellij?: string;
	zellijSessionName?: string;
	tmuxControlMode: boolean;
}

export function detectTmuxControlMode(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!env.TMUX) return false;
	const result = spawnSync("tmux", ["display-message", "-p", "#{client_flags}"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 300,
	});
	return result.status === 0 && result.stdout.includes("control-mode");
}

export function createTerminalModeContext(
	env: NodeJS.ProcessEnv = process.env,
	isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true,
): TerminalModeContext {
	return {
		isTTY,
		term: env.TERM,
		tmux: env.TMUX,
		zellij: env.ZELLIJ,
		zellijSessionName: env.ZELLIJ_SESSION_NAME,
		tmuxControlMode: detectTmuxControlMode(env),
	};
}

export function shouldUseAlternateScreen(mode: AltScreenMode, context: TerminalModeContext): boolean {
	if (!context.isTTY || context.term === "dumb") return false;
	if (mode === "always") return true;
	if (mode === "never") return false;
	if (context.zellij || context.zellijSessionName) return false;
	if (context.tmux && context.tmuxControlMode) return false;
	return true;
}
