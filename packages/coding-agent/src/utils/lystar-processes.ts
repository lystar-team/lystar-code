import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnProcessSync } from "./child-process.ts";

export interface SystemProcessRecord {
	pid: number;
	commandLine: string;
	executablePath?: string;
	arguments?: readonly string[];
}

export interface OldLystarProcess {
	pid: number;
	versionDirectory: string;
}

interface LystarExecutable {
	rawPath: string;
	realPath: string;
	versionDirectory: string;
}

function normalizeProcessValue(value: string): string {
	return value
		.trim()
		.replace(/^['"]|['"]$/gu, "")
		.replace(/\s+\(deleted\)$/u, "")
		.replaceAll("\\", "/")
		.toLowerCase();
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOf(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isInteger(number) && number > 0 ? number : undefined;
}

function pathEquals(left: string, right: string): boolean {
	return normalizeProcessValue(left) === normalizeProcessValue(right);
}

function commandLineContainsPath(commandLine: string, path: string): boolean {
	const value = normalizeProcessValue(commandLine);
	const candidate = normalizeProcessValue(path);
	let offset = value.indexOf(candidate);
	while (offset >= 0) {
		const before = value[offset - 1];
		const after = value[offset + candidate.length];
		if ((!before || /[\s"'=]/u.test(before)) && (!after || /[\s"'()]/u.test(after))) return true;
		offset = value.indexOf(candidate, offset + 1);
	}
	return false;
}

function tokenizeCommandLine(commandLine: string): string[] {
	const tokens: string[] = [];
	const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/gu;
	for (const match of commandLine.matchAll(pattern)) {
		const token = match[1] ?? match[2] ?? match[3];
		if (token) tokens.push(token);
	}
	return tokens;
}

function processArguments(record: SystemProcessRecord): readonly string[] {
	return record.arguments ?? tokenizeCommandLine(record.commandLine);
}

function isServiceProcess(record: SystemProcessRecord, executable: LystarExecutable): boolean {
	const argumentsList = processArguments(record);
	const candidateIndex = argumentsList.findIndex((argument) =>
		[executable.rawPath, executable.realPath].some((path) => pathEquals(argument, path)),
	);
	const subcommand = candidateIndex >= 0 ? argumentsList[candidateIndex + 1] : argumentsList[1];
	return subcommand === "web" || subcommand === "web-runtime";
}

function listInstalledExecutables(installRoot: string): LystarExecutable[] {
	const versionsDirectory = join(installRoot, "versions");
	const result: LystarExecutable[] = [];
	const seen = new Set<string>();
	let entries: Dirent[];
	try {
		entries = readdirSync(versionsDirectory, { withFileTypes: true });
	} catch {
		return result;
	}
	for (const entry of entries) {
		const rawVersionDirectory = join(versionsDirectory, entry.name);
		let versionDirectory: string;
		try {
			const versionStat = lstatSync(rawVersionDirectory);
			if (!versionStat.isDirectory() && !versionStat.isSymbolicLink()) continue;
			versionDirectory = realpathSync(rawVersionDirectory);
			if (!lstatSync(versionDirectory).isDirectory()) continue;
		} catch {
			continue;
		}
		for (const fileName of ["lc", "lystar", "lc.exe", "lystar.exe"]) {
			const rawPath = join(rawVersionDirectory, fileName);
			try {
				const stat = lstatSync(rawPath);
				if (!stat.isFile() && !stat.isSymbolicLink()) continue;
				const realPath = realpathSync(rawPath);
				const key = `${normalizeProcessValue(rawPath)}\0${normalizeProcessValue(realPath)}`;
				if (seen.has(key)) continue;
				seen.add(key);
				result.push({ rawPath, realPath, versionDirectory });
			} catch {
				// 版本目录可能正在被安装器替换，跳过当前不完整条目。
			}
		}
	}
	return result;
}

export function defaultLystarInstallRoot(): string {
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "LYStarAgent");
	}
	return join(homedir(), ".local", "share", "lystar-agent");
}

export function resolveCurrentLystarVersionDirectory(installRoot: string): string | undefined {
	const currentPath = join(installRoot, "current");
	try {
		const stat = lstatSync(currentPath);
		if (stat.isDirectory() || stat.isSymbolicLink()) return realpathSync(currentPath);
		const version = readFileSync(currentPath, "utf8").trim();
		if (!version) return undefined;
		return realpathSync(join(installRoot, "versions", version));
	} catch {
		return undefined;
	}
}

export function findOldLystarProcesses(
	processes: readonly SystemProcessRecord[],
	options: { installRoot: string; currentVersionDirectory: string; excludePid?: number },
): OldLystarProcess[] {
	const executables = listInstalledExecutables(options.installRoot);
	const currentVersionDirectory = normalizeProcessValue(options.currentVersionDirectory);
	const found = new Map<number, OldLystarProcess>();
	for (const processRecord of processes) {
		if (processRecord.pid === (options.excludePid ?? globalThis.process.pid)) continue;
		const executable = processRecord.executablePath
			? (() => {
					const executablePath = processRecord.executablePath!;
					return executables.find(
						(candidate) =>
							pathEquals(executablePath, candidate.rawPath) || pathEquals(executablePath, candidate.realPath),
					);
				})()
			: executables.find((candidate) =>
					[candidate.rawPath, candidate.realPath].some((path) =>
						commandLineContainsPath(processRecord.commandLine, path),
					),
				);
		if (!executable) continue;
		if (normalizeProcessValue(executable.versionDirectory) === currentVersionDirectory) continue;
		if (isServiceProcess(processRecord, executable)) continue;
		found.set(processRecord.pid, { pid: processRecord.pid, versionDirectory: executable.versionDirectory });
	}
	return [...found.values()].sort((left, right) => left.pid - right.pid);
}

function listLinuxProcesses(): SystemProcessRecord[] {
	const result: SystemProcessRecord[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync("/proc", { withFileTypes: true });
	} catch {
		return result;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
		const pid = Number(entry.name);
		try {
			const argumentsList = readFileSync(`/proc/${entry.name}/cmdline`, "utf8").split("\0").filter(Boolean);
			const executablePath = realpathSync(`/proc/${entry.name}/exe`);
			result.push({ pid, commandLine: argumentsList.join(" "), executablePath, arguments: argumentsList });
		} catch {
			// 进程可能在读取期间退出。
		}
	}
	return result;
}

function listMacProcesses(): SystemProcessRecord[] {
	const result = spawnProcessSync("ps", ["-ww", "-axo", "pid=,command="], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) throw new Error(`无法读取 macOS 进程列表：${result.stderr.trim() || result.status}`);
	return result.stdout.split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
		if (!match) return [];
		const pid = Number(match[1]);
		return Number.isInteger(pid) && pid > 0
			? [{ pid, commandLine: match[2]!, arguments: tokenizeCommandLine(match[2]!) }]
			: [];
	});
}

function listWindowsProcesses(): SystemProcessRecord[] {
	const script =
		"$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress";
	const result = spawnProcessSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) throw new Error(`无法读取 Windows 进程列表：${result.stderr.trim() || result.status}`);
	const text = result.stdout.trim();
	if (!text) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`Windows 进程列表格式无效：${error instanceof Error ? error.message : String(error)}`);
	}
	const records = Array.isArray(parsed) ? parsed : [parsed];
	return records.flatMap((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		const item = value as Record<string, unknown>;
		const pid = numberOf(item.ProcessId);
		const executablePath = stringOf(item.ExecutablePath);
		const commandLine = stringOf(item.CommandLine) ?? executablePath ?? "";
		return pid && (executablePath || commandLine)
			? [
					{
						pid,
						commandLine,
						...(executablePath ? { executablePath } : {}),
						arguments: tokenizeCommandLine(commandLine),
					},
				]
			: [];
	});
}

export function listSystemProcesses(): SystemProcessRecord[] {
	if (process.platform === "linux") return listLinuxProcesses();
	if (process.platform === "darwin") return listMacProcesses();
	if (process.platform === "win32") return listWindowsProcesses();
	throw new Error(`当前平台不支持关闭旧版 LYStar Code 进程：${process.platform}`);
}
