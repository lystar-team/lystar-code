import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { APP_NAME, detectInstallMethod, getAgentDir, type InstallMethod, PACKAGE_NAME } from "../config.ts";
import { spawnProcess, spawnProcessSync } from "../utils/child-process.ts";
import { defaultLystarInstallRoot } from "../utils/lystar-processes.ts";
import { runWebServiceCommand, type WebGatewayModule } from "./web-command.ts";

export interface UninstallCommandOptions {
	gatewayModule?: Pick<WebGatewayModule, "runWebServiceAction">;
}

// `uninstall` is also a Package command (`lc uninstall <source>`). Only these
// flags select the product uninstall; anything else stays with the Package
// manager so existing scripts keep working.
const PRODUCT_UNINSTALL_FLAGS = new Set(["--yes", "--help", "-h", "--non-interactive"]);

function printUninstallHelp(): void {
	console.log(`${chalk.bold("用法：")}
  ${APP_NAME} uninstall [--yes] [--non-interactive]

移除官方安装器安装的 LYStar Code。命令会先停止并移除 Web 后台服务，再删除
版本目录、命令入口和开始菜单快捷方式。用户数据保留在：
  ${getAgentDir()}

选项：
  --yes             跳过交互确认，直接卸载
  --non-interactive 非交互模式，等同 --yes，供安装器和脚本使用

卸载已安装的 Package 使用：${APP_NAME} uninstall <source> [-l]
`);
}

function isInstallerManagedInstall(installRoot: string): boolean {
	return existsSync(join(installRoot, "current")) || existsSync(join(installRoot, "versions"));
}

function hasWebServiceUsage(agentDir: string): boolean {
	return (
		existsSync(join(agentDir, "web-config.json")) ||
		existsSync(join(agentDir, "web", "service-state.json")) ||
		existsSync(join(agentDir, "web", "gateway.json"))
	);
}

function packageManagerUninstallCommand(method: InstallMethod): string | undefined {
	switch (method) {
		case "npm":
			return `npm uninstall -g ${PACKAGE_NAME}`;
		case "pnpm":
			return `pnpm remove -g ${PACKAGE_NAME}`;
		case "yarn":
			return `yarn global remove ${PACKAGE_NAME}`;
		case "bun":
			return `bun uninstall -g ${PACKAGE_NAME}`;
		default:
			return undefined;
	}
}

function printNotInstallerManaged(installRoot: string): void {
	const agentDir = getAgentDir();
	const method = detectInstallMethod();
	const command = packageManagerUninstallCommand(method);
	console.log(chalk.yellow(`没有找到官方安装器管理的 LYStar Code 安装目录：${installRoot}`));
	if (command) {
		console.log(`当前安装由 ${method} 管理，请运行：${command}`);
	} else if (method === "bun-binary") {
		console.log(`当前 ${APP_NAME} 是独立可执行文件，删除它所在的目录即可完成卸载。`);
	} else {
		console.log("请使用提供当前安装的程序包管理器、wrapper 或源码目录移除。");
	}
	console.log(`用户数据保留在 ${agentDir}。`);
}

async function confirmUninstall(installRoot: string): Promise<boolean> {
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await readline.question(
			`将删除 LYStar Code 程序文件：${installRoot}\n用户数据 ${getAgentDir()} 会保留。继续？[y/N] `,
		);
		return ["y", "yes", "是"].includes(answer.trim().toLowerCase());
	} finally {
		readline.close();
	}
}

function powerShellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function writeWindowsHelperScript(name: string, lines: string[]): string {
	const scriptPath = join(tmpdir(), `lystar-${name}-${process.pid}-${randomUUID()}.ps1`);
	writeFileSync(scriptPath, `\uFEFF${lines.join("\n")}`, { encoding: "utf8", mode: 0o600 });
	return scriptPath;
}

function removeWindowsUserPathEntry(binDir: string): void {
	const scriptPath = writeWindowsHelperScript("uninstall-path", [
		"$ErrorActionPreference = 'Stop'",
		`$bin = ${powerShellLiteral(binDir)}`,
		"$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
		"$normalized = $bin.TrimEnd('\\').ToLowerInvariant()",
		"$parts = @($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\\').ToLowerInvariant() -ne $normalized })",
		"[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')",
		"Add-Type @'",
		"using System;",
		"using System.Runtime.InteropServices;",
		"public static class LYStarUninstallEnvironment {",
		'    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
		"    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);",
		"}",
		"'@",
		"$result = [UIntPtr]::Zero",
		"[void][LYStarUninstallEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)",
		"Remove-Item -Force -LiteralPath $PSCommandPath -ErrorAction SilentlyContinue",
	]);
	try {
		const result = spawnProcessSync(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		);
		if (!result.error && result.status === 0) return;
		const reason = result.error?.message || result.stderr?.trim();
		console.warn(
			chalk.yellow(`未能自动从用户 PATH 移除 ${binDir}，请手动删除该条目。${reason ? `（${reason}）` : ""}`),
		);
	} finally {
		rmSync(scriptPath, { force: true });
	}
}

function removeWindowsStartMenuShortcuts(): void {
	if (!process.env.APPDATA) return;
	const programsDir = join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs");
	rmSync(join(programsDir, "LYStar Code.lnk"), { force: true });
	rmSync(join(programsDir, "LYStar Agent.lnk"), { force: true });
}

function scheduleWindowsInstallRootRemoval(installRoot: string): void {
	// lc.exe runs from the install root, so Windows keeps the files locked until
	// this process exits. A detached helper waits for the exit and retries the
	// removal while the already running cmd.exe wrapper finishes its batch file.
	const scriptPath = writeWindowsHelperScript("uninstall", [
		"$ErrorActionPreference = 'SilentlyContinue'",
		`$root = ${powerShellLiteral(installRoot)}`,
		`Wait-Process -Id ${process.pid} -Timeout 120 -ErrorAction SilentlyContinue`,
		"for ($attempt = 0; $attempt -lt 120; $attempt++) {",
		"\tRemove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue",
		"\tif (!(Test-Path -LiteralPath $root)) { break }",
		"\tStart-Sleep -Milliseconds 500",
		"}",
		"Remove-Item -Force -LiteralPath $PSCommandPath -ErrorAction SilentlyContinue",
	]);
	try {
		const child = spawnProcess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.once("error", (error) => {
			rmSync(scriptPath, { force: true });
			console.warn(chalk.yellow(`无法启动卸载清理进程：${error.message}。请手动删除 ${installRoot}。`));
		});
		child.unref();
	} catch (error) {
		rmSync(scriptPath, { force: true });
		throw error;
	}
}

function removeUnixLaunchers(): void {
	for (const name of ["lc", "lystar", "la"]) {
		rmSync(join(homedir(), ".local", "bin", name), { force: true });
	}
}

/**
 * Handle `lc uninstall`. Returns false when the arguments belong to the Package
 * command (`lc uninstall <source>`), so the caller can keep its behavior.
 */
export async function runUninstallCommand(
	args: readonly string[],
	options: UninstallCommandOptions = {},
): Promise<boolean> {
	if (args[0] !== "uninstall") return false;
	const flags = args.slice(1);
	if (flags.some((flag) => !PRODUCT_UNINSTALL_FLAGS.has(flag))) return false;
	if (flags.includes("--help") || flags.includes("-h")) {
		printUninstallHelp();
		return true;
	}

	const installRoot = defaultLystarInstallRoot();
	if (!isInstallerManagedInstall(installRoot)) {
		printNotInstallerManaged(installRoot);
		return true;
	}
	console.log(`安装目录：${installRoot}`);

	const nonInteractive = flags.includes("--non-interactive");
	if (!flags.includes("--yes") && !nonInteractive) {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error(`当前终端不能交互确认。确认卸载请重新运行：${APP_NAME} uninstall --yes`);
		}
		if (!(await confirmUninstall(installRoot))) {
			console.log("已取消，未做修改。");
			return true;
		}
	}

	const agentDir = getAgentDir();
	if (hasWebServiceUsage(agentDir)) {
		try {
			await runWebServiceCommand(["uninstall", "--non-interactive"], options);
		} catch (error) {
			throw new Error(
				`Web 服务卸载失败，未删除程序文件：${error instanceof Error ? error.message : String(error)}。` +
					`可运行 ${APP_NAME} web service status 查看状态后重试。`,
			);
		}
	}

	if (process.platform === "win32") {
		removeWindowsUserPathEntry(join(installRoot, "bin"));
		removeWindowsStartMenuShortcuts();
		scheduleWindowsInstallRootRemoval(installRoot);
		console.log("LYStar Code 正在卸载：程序文件将在本命令退出后删除。");
		console.log(`用户数据仍保留在 ${agentDir}。`);
		return true;
	}

	removeUnixLaunchers();
	rmSync(installRoot, { recursive: true, force: true });
	console.log(`LYStar Code 已卸载。用户数据仍保留在 ${agentDir}。`);
	return true;
}
