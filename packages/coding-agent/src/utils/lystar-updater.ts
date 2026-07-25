import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnProcess } from "./child-process.ts";

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
	const url = `https://github.com/${repository}/releases/latest/download/${scriptName}`;
	const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new Error(`下载安装器失败：HTTP ${response.status}`);

	const directory = mkdtempSync(join(tmpdir(), "lystar-update-"));
	const scriptPath = join(directory, scriptName);
	try {
		writeFileSync(scriptPath, await response.text(), { mode: 0o700 });
		if (isWindows) {
			await runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args]);
		} else {
			await runCommand("bash", [scriptPath, ...args]);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
