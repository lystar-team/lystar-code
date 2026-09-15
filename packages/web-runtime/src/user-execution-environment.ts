import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";

const USER_ENVIRONMENT_SOURCE = "LYSTAR_USER_ENV_SOURCE";
const COMMAND_ENVIRONMENT_KEYS = ["PATH", "PATHEXT", "SHELL", "COMSPEC"] as const;

type CommandEnvironment = Record<string, string | undefined>;

export interface UserNodeToolchain {
	node?: { version: string; executable: string };
	npmVersion?: string;
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	return key ? env[key] : undefined;
}

export function captureUserCommandEnvironment(env: NodeJS.ProcessEnv = process.env): CommandEnvironment {
	const source = env[USER_ENVIRONMENT_SOURCE] ?? (env.LYSTAR_WEB_SERVICE_CHILD === "1" ? undefined : "process");
	const captured: CommandEnvironment = source ? { [USER_ENVIRONMENT_SOURCE]: source } : {};
	for (const key of COMMAND_ENVIRONMENT_KEYS) {
		const value = environmentValue(env, key);
		if (value !== undefined) captured[key] = value;
	}
	return captured;
}

function shellArguments(shell: string, command: string): string[] | undefined {
	const name = basename(shell).toLowerCase();
	if (["bash", "zsh", "ksh", "dash", "sh"].some((candidate) => name === candidate || name.endsWith(`-${candidate}`))) {
		return [name.includes("bash") || name.includes("zsh") || name.includes("ksh") ? "-ic" : "-lc", command];
	}
	return undefined;
}

export function discoverUserShellCommandEnvironment(
	options: { env?: NodeJS.ProcessEnv; shellPath?: string; timeoutMs?: number } = {},
): CommandEnvironment | undefined {
	if (process.platform === "win32") return undefined;
	const env = options.env ?? process.env;
	const shell = options.shellPath ?? environmentValue(env, "SHELL");
	if (!shell) return undefined;
	const marker = `__LYSTAR_USER_ENV_${randomUUID().replaceAll("-", "")}__`;
	const command = `printf '%s\\n' '${marker}' "$PATH" "${marker}"`;
	const args = shellArguments(shell, command);
	if (!args) return undefined;
	const result = spawnSync(shell, args, {
		cwd: environmentValue(env, "HOME") ?? homedir(),
		env,
		encoding: "utf8",
		timeout: options.timeoutMs ?? 3_000,
		maxBuffer: 256 * 1024,
		windowsHide: true,
	});
	if (result.error || result.status !== 0) return undefined;
	const lines = result.stdout.split(/\r?\n/u);
	const start = lines.indexOf(marker);
	const end = lines.indexOf(marker, start + 1);
	const path = start >= 0 && end === start + 2 ? lines[start + 1] : undefined;
	if (!path) return undefined;
	return { PATH: path, SHELL: shell, [USER_ENVIRONMENT_SOURCE]: "shell" };
}

export function restoreUserCommandEnvironment(
	options: { env?: NodeJS.ProcessEnv; shellPath?: string; timeoutMs?: number } = {},
): boolean {
	const env = options.env ?? process.env;
	if (process.platform === "win32" || env.LYSTAR_WEB_SERVICE_CHILD !== "1") return false;
	if (env[USER_ENVIRONMENT_SOURCE] && probeUserNodeToolchain(env).node) return false;
	const discovered = discoverUserShellCommandEnvironment({
		env,
		...(options.shellPath ? { shellPath: options.shellPath } : {}),
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
	});
	if (!discovered) return false;
	for (const [key, value] of Object.entries(discovered)) {
		if (value !== undefined) env[key] = value;
	}
	const webCommandBin = env.LYSTAR_WEB_COMMAND_BIN?.trim();
	if (process.platform === "darwin" && webCommandBin) {
		const path = environmentValue(env, "PATH") ?? "";
		env.PATH = path.split(":").includes(webCommandBin) ? path : `${webCommandBin}:${path}`;
	}
	return true;
}

export function probeUserNodeToolchain(env: NodeJS.ProcessEnv = process.env): UserNodeToolchain {
	const node = spawnSync("node", ["-p", "JSON.stringify({version:process.version,executable:process.execPath})"], {
		env,
		encoding: "utf8",
		timeout: 3_000,
		windowsHide: true,
	});
	if (node.error || node.status !== 0) return {};
	let parsed: { version?: unknown; executable?: unknown };
	try {
		parsed = JSON.parse(node.stdout.trim()) as { version?: unknown; executable?: unknown };
	} catch {
		return {};
	}
	if (typeof parsed.version !== "string" || typeof parsed.executable !== "string") return {};
	const npm = spawnSync("npm", ["--version"], {
		env,
		encoding: "utf8",
		timeout: 3_000,
		windowsHide: true,
		shell: process.platform === "win32",
	});
	return {
		node: { version: parsed.version, executable: parsed.executable },
		...(!npm.error && npm.status === 0 && npm.stdout.trim() ? { npmVersion: npm.stdout.trim() } : {}),
	};
}
