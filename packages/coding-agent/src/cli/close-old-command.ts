import { basename } from "node:path";
import { spawnProcessSync } from "../utils/child-process.ts";
import {
	defaultLystarInstallRoot,
	findOldLystarProcesses,
	listSystemProcesses,
	resolveCurrentLystarVersionDirectory,
} from "../utils/lystar-processes.ts";

const CLOSE_WAIT_MS = 3_000;
const CLOSE_POLL_MS = 50;

function usage(): string {
	return "用法：lc close-old [--dry-run] [--force]\n关闭更新前启动的旧版 lc 会话；默认发送正常退出请求。";
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function requestClose(pid: number, force: boolean): void {
	if (process.platform === "win32") {
		const result = spawnProcessSync("taskkill.exe", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status !== 0 && isAlive(pid)) {
			throw new Error(result.stderr.trim() || `taskkill.exe 退出码：${result.status}`);
		}
		return;
	}
	try {
		process.kill(pid, force ? "SIGKILL" : "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function waitForExit(pid: number): Promise<boolean> {
	const deadline = Date.now() + CLOSE_WAIT_MS;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, CLOSE_POLL_MS));
	}
	return !isAlive(pid);
}

export async function runCloseOldCommand(args: readonly string[] = []): Promise<void> {
	let dryRun = false;
	let force = false;
	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			console.log(usage());
			return;
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--force") {
			force = true;
			continue;
		}
		throw new Error(`${usage()}\n不支持参数：${arg}`);
	}

	const installRoot = defaultLystarInstallRoot();
	const currentVersionDirectory = resolveCurrentLystarVersionDirectory(installRoot);
	if (!currentVersionDirectory) throw new Error(`未找到当前 LYStar Code 安装目录：${installRoot}`);
	const oldProcesses = findOldLystarProcesses(listSystemProcesses(), {
		installRoot,
		currentVersionDirectory,
		excludePid: process.pid,
	});
	if (oldProcesses.length === 0) {
		console.log("没有发现更新前启动的旧版 lc 会话。");
		return;
	}

	console.log(`发现 ${oldProcesses.length} 个旧版 lc 会话：`);
	for (const oldProcess of oldProcesses) {
		console.log(`  PID ${oldProcess.pid}（${basename(oldProcess.versionDirectory)}）`);
	}
	if (dryRun) {
		console.log("仅查看，没有关闭进程。");
		return;
	}

	let closed = 0;
	const remaining: number[] = [];
	for (const oldProcess of oldProcesses) {
		try {
			requestClose(oldProcess.pid, force);
			if (await waitForExit(oldProcess.pid)) closed++;
			else remaining.push(oldProcess.pid);
		} catch (error) {
			remaining.push(oldProcess.pid);
			console.error(`PID ${oldProcess.pid} 关闭失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (remaining.length > 0) {
		process.exitCode = 1;
		console.error(`已关闭 ${closed} 个，仍有 ${remaining.length} 个旧版 lc 会话运行。需要时加 --force 重试。`);
		return;
	}
	console.log(`已关闭 ${closed} 个旧版 lc 会话。Session 文件没有删除。`);
}
