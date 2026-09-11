import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnProcess, spawnProcessSync } from "./child-process.ts";

async function runCommand(command: string, args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawnProcess(command, args, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) {
				resolve();
			} else if (signal) {
				reject(new Error(`${command} 被信号 ${signal} 终止`));
			} else {
				reject(new Error(`${command} 退出码：${code ?? "unknown"}`));
			}
		});
	});
}

export async function runLystarInstaller(
	repository: string,
	args: string[] = [],
	options: { fetch?: typeof fetch } = {},
): Promise<void> {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
		throw new Error(`无效的 LYStar release repository：${repository}`);
	}

	const isWindows = process.platform === "win32";
	const scriptName = isWindows ? "install.ps1" : "install.sh";
	const installRoot = isWindows
		? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "LYStarAgent")
		: join(homedir(), ".local", "share", "lystar-agent");
	const versionIndex = args.indexOf("--version");
	const expectedVersion = args.includes("--rollback")
		? isWindows
			? readFileSync(join(installRoot, "previous"), "utf8").trim()
			: basename(readlinkSync(join(installRoot, "previous")))
		: versionIndex >= 0
			? args[versionIndex + 1]
			: undefined;
	const installerArgs = isWindows
		? args.map((argument) => ({ "--version": "-Version", "--rollback": "-Rollback" })[argument] ?? argument)
		: args;
	const url = `https://github.com/${repository}/releases/latest/download/${scriptName}`;
	const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new Error(`下载安装器失败：HTTP ${response.status}`);

	const directory = mkdtempSync(join(tmpdir(), "lystar-update-"));
	const scriptPath = join(directory, scriptName);
	try {
		const script = await response.text();
		writeFileSync(scriptPath, isWindows ? `\uFEFF${script.replace(/^\uFEFF/u, "")}` : script, { mode: 0o700 });
		if (isWindows) {
			await runCommand("powershell.exe", [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				scriptPath,
				...installerArgs,
			]);
		} else {
			await runCommand("bash", [scriptPath, ...installerArgs]);
		}
		// 子进程退出成功不能替代安装结果，旧安装器可能在失败后返回零。
		const launcher = isWindows ? join(installRoot, "bin", "lc.cmd") : join(homedir(), ".local", "bin", "lc");
		const environment = { ...process.env };
		delete environment.LYSTAR_WEB_SERVICE_VERSION;
		const result = spawnProcessSync(launcher, ["--version"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: environment,
			timeout: 15_000,
		});
		const actualVersion = result.stdout?.trim();
		if (
			result.error ||
			result.status !== 0 ||
			!actualVersion ||
			(expectedVersion && actualVersion !== expectedVersion)
		) {
			throw new Error(
				`安装结果校验失败：预期 ${expectedVersion ?? "可运行的 lc"}，实际 ${actualVersion || result.error?.message || "无法读取版本"}`,
			);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
