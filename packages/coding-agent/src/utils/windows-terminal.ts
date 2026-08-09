import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isBunBinary } from "../config.ts";

const CURRENT_TERMINAL_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "auth"]);

export function shouldLaunchWindowsTerminalHost(
	args: readonly string[],
	stdio: { stdinIsTTY: boolean; stdoutIsTTY: boolean },
	env: NodeJS.ProcessEnv = process.env,
	standalone = isBunBinary,
): boolean {
	if (process.platform !== "win32" || !standalone || env.LYSTAR_TERMINAL_HOST === "1") return false;
	if (!stdio.stdinIsTTY || !stdio.stdoutIsTTY || args.includes("--attached")) return false;
	if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v")) return false;
	if (args.some((arg) => arg === "--print" || arg === "-p" || arg === "--export" || arg === "--list-models")) {
		return false;
	}
	const modeIndex = args.indexOf("--mode");
	if (modeIndex >= 0 && (args[modeIndex + 1] === "json" || args[modeIndex + 1] === "rpc")) return false;
	if (args.includes("--ensure-windows-bash") || CURRENT_TERMINAL_COMMANDS.has(args[0] ?? "")) return false;
	return true;
}

export function getWindowsTerminalHostPath(executablePath = process.execPath): string {
	return join(dirname(executablePath), "lystar-terminal.exe");
}

export function launchWindowsTerminalHost(args: readonly string[], executablePath = process.execPath): void {
	const hostPath = getWindowsTerminalHostPath(executablePath);
	if (!existsSync(hostPath)) {
		throw new Error(`Windows 终端宿主不存在：${hostPath}。可使用 ${basename(executablePath)} --attached 临时启动。`);
	}
	const child = spawn(hostPath, [...args], {
		cwd: process.cwd(),
		detached: true,
		env: { ...process.env, LYSTAR_TERMINAL_LA_PATH: executablePath },
		stdio: "ignore",
		windowsHide: false,
	});
	child.unref();
}
