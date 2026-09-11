import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const UPDATE_STATE_VERSION = 1 as const;
const PRODUCT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const UPDATE_STAGES = new Set<ProductUpdateStage>([
	"starting",
	"downloading",
	"verifying",
	"installing",
	"restarting",
	"completed",
	"failed",
]);

export type ProductUpdateStage =
	| "starting"
	| "downloading"
	| "verifying"
	| "installing"
	| "restarting"
	| "completed"
	| "failed";

export interface ProductUpdateJob {
	version: typeof UPDATE_STATE_VERSION;
	id: string;
	status: "running" | "completed" | "failed";
	stage: ProductUpdateStage;
	progress: number;
	currentVersion: string;
	targetVersion: string;
	message: string;
	startedAt: number;
	updatedAt: number;
	pid?: number;
}

interface SpawnedUpdater {
	pid: number;
	completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export type ProductUpdateSpawner = (
	executable: string,
	args: readonly string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; logPath: string },
) => Promise<SpawnedUpdater>;

export interface ProductUpdateControllerOptions {
	installRoot?: string;
	development?: boolean;
	now?: () => number;
	isProcessAlive?: (pid: number) => boolean;
	spawnUpdate?: ProductUpdateSpawner;
}

function updateError(status: number, code: string, message: string): Error {
	return Object.assign(new Error(message), { status, code });
}

function defaultInstallRoot(): string {
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "LYStarAgent");
	}
	return join(homedir(), ".local", "share", "lystar-agent");
}

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function defaultSpawnUpdate(
	executable: string,
	args: readonly string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; logPath: string },
): Promise<SpawnedUpdater> {
	const log = openSync(options.logPath, "a", 0o600);
	try {
		const child = spawn(executable, [...args], {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			stdio: ["ignore", log, log],
			windowsHide: true,
		});
		const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		if (!child.pid) throw new Error("更新进程没有返回 PID");
		child.unref();
		return { pid: child.pid, completion };
	} finally {
		closeSync(log);
	}
}

function decodeJob(value: unknown): ProductUpdateJob | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Partial<ProductUpdateJob>;
	if (
		record.version !== UPDATE_STATE_VERSION ||
		typeof record.id !== "string" ||
		!record.id ||
		!(["running", "completed", "failed"] as const).includes(record.status as ProductUpdateJob["status"]) ||
		typeof record.stage !== "string" ||
		!UPDATE_STAGES.has(record.stage as ProductUpdateStage) ||
		typeof record.progress !== "number" ||
		!Number.isFinite(record.progress) ||
		typeof record.currentVersion !== "string" ||
		typeof record.targetVersion !== "string" ||
		typeof record.message !== "string" ||
		typeof record.startedAt !== "number" ||
		typeof record.updatedAt !== "number"
	)
		return undefined;
	if (record.pid !== undefined && (!Number.isInteger(record.pid) || record.pid <= 0)) return undefined;
	return {
		version: UPDATE_STATE_VERSION,
		id: record.id,
		status: record.status as ProductUpdateJob["status"],
		stage: record.stage as ProductUpdateStage,
		progress: Math.max(0, Math.min(100, record.progress)),
		currentVersion: record.currentVersion,
		targetVersion: record.targetVersion,
		message: record.message,
		startedAt: record.startedAt,
		updatedAt: record.updatedAt,
		...(record.pid ? { pid: record.pid } : {}),
	};
}

function stripTerminalFormatting(value: string): string {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "").replaceAll("\r", "");
}

function latestLogMessage(log: string): string | undefined {
	return stripTerminalFormatting(log)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
}

export function productUpdateProgressFromLog(log: string): Pick<ProductUpdateJob, "stage" | "progress" | "message"> {
	const text = stripTerminalFormatting(log);
	if (text.includes("正在把 Web Gateway 和 Web Runtime 服务切换") || text.includes("Web 服务切换")) {
		return { stage: "restarting", progress: 94, message: "正在重启 Web 服务" };
	}
	let step = 0;
	for (const match of text.matchAll(/\[(\d+)\/6\]/gu)) step = Math.max(step, Number(match[1]));
	switch (step) {
		case 6:
			return { stage: "restarting", progress: 90, message: "正在检查安装结果" };
		case 5:
			return { stage: "installing", progress: 78, message: "正在切换到新版本" };
		case 4:
			return { stage: "installing", progress: 68, message: "正在写入新版本" };
		case 3:
			return { stage: "verifying", progress: 54, message: "正在检查更新包" };
		case 2:
			return { stage: "downloading", progress: 34, message: "正在下载更新" };
		case 1:
			return { stage: "starting", progress: 16, message: "正在获取更新信息" };
		default:
			return { stage: "starting", progress: 8, message: "正在启动更新" };
	}
}

export class ProductUpdateController {
	private readonly agentDir: string;
	private readonly installRoot: string;
	private readonly development: boolean;
	private readonly now: () => number;
	private readonly isProcessAlive: (pid: number) => boolean;
	private readonly spawnUpdate: ProductUpdateSpawner;
	private startPromise?: Promise<ProductUpdateJob>;

	constructor(agentDir: string, options: ProductUpdateControllerOptions = {}) {
		this.agentDir = agentDir;
		this.installRoot = options.installRoot ?? defaultInstallRoot();
		this.development = options.development ?? process.env.LYSTAR_CLI_MODE === "development";
		this.now = options.now ?? Date.now;
		this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
		this.spawnUpdate = options.spawnUpdate ?? defaultSpawnUpdate;
	}

	private get statePath(): string {
		return join(this.agentDir, "web", "product-update.json");
	}

	private get logPath(): string {
		return join(this.agentDir, "web", "product-update.log");
	}

	private async readJob(): Promise<ProductUpdateJob | undefined> {
		try {
			return decodeJob(JSON.parse(await readFile(this.statePath, "utf8")));
		} catch {
			return undefined;
		}
	}

	private async writeJob(job: ProductUpdateJob): Promise<void> {
		await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.statePath}.${process.pid}.${this.now()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(job, null, "\t")}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			await rename(temporaryPath, this.statePath);
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => {});
		}
	}

	private async readLog(): Promise<string> {
		try {
			return (await readFile(this.logPath, "utf8")).slice(-64 * 1024);
		} catch {
			return "";
		}
	}

	private async executablePath(): Promise<string | undefined> {
		let executable: string;
		if (process.platform === "win32") {
			let version: string;
			try {
				version = (await readFile(join(this.installRoot, "current"), "utf8")).trim();
			} catch {
				return undefined;
			}
			if (!PRODUCT_VERSION_PATTERN.test(version)) return undefined;
			executable = join(this.installRoot, "versions", version, "lc.exe");
		} else {
			executable = join(this.installRoot, "current", "lc");
		}
		try {
			return (await stat(executable)).isFile() ? executable : undefined;
		} catch {
			return undefined;
		}
	}

	async availability(repository: string | undefined): Promise<{ enabled: boolean; reason: string }> {
		if (this.development) return { enabled: false, reason: "开发模式不执行应用更新" };
		if (!repository) return { enabled: false, reason: "当前构建没有配置发布仓库" };
		if (!(await this.executablePath())) return { enabled: false, reason: "当前环境不是 LYStar Code 正式安装目录" };
		return { enabled: true, reason: "可以安装新版本" };
	}

	async status(currentVersion: string): Promise<ProductUpdateJob | undefined> {
		const job = await this.readJob();
		if (!job || job.status !== "running") return job;
		const installedVersion =
			currentVersion === job.targetVersion ||
			(PRODUCT_VERSION_PATTERN.test(currentVersion) && currentVersion !== job.currentVersion)
				? currentVersion
				: undefined;
		if (installedVersion) {
			const completed: ProductUpdateJob = {
				...job,
				status: "completed",
				stage: "completed",
				progress: 100,
				targetVersion: installedVersion,
				message: `已更新到 v${installedVersion}`,
				updatedAt: this.now(),
			};
			await this.writeJob(completed);
			return completed;
		}

		const log = await this.readLog();
		if (job.pid && !this.isProcessAlive(job.pid)) {
			const failed: ProductUpdateJob = {
				...job,
				status: "failed",
				stage: "failed",
				message: latestLogMessage(log) ?? "更新进程已结束，版本没有切换",
				updatedAt: this.now(),
			};
			await this.writeJob(failed);
			return failed;
		}

		const progress = productUpdateProgressFromLog(log);
		if (progress.stage === job.stage && progress.progress === job.progress && progress.message === job.message)
			return job;
		const updated = { ...job, ...progress, updatedAt: this.now() };
		await this.writeJob(updated);
		return updated;
	}

	async start(currentVersion: string, targetVersion: string): Promise<ProductUpdateJob> {
		if (this.startPromise) return this.startPromise;
		const operation = this.startInternal(currentVersion, targetVersion);
		this.startPromise = operation;
		try {
			return await operation;
		} finally {
			if (this.startPromise === operation) this.startPromise = undefined;
		}
	}

	private async startInternal(currentVersion: string, targetVersion: string): Promise<ProductUpdateJob> {
		if (!PRODUCT_VERSION_PATTERN.test(targetVersion)) {
			throw updateError(400, "product_update_version_invalid", "目标版本格式无效");
		}
		const existing = await this.status(currentVersion);
		if (existing?.status === "running") {
			throw updateError(409, "product_update_running", "应用更新正在进行中");
		}
		const executable = await this.executablePath();
		if (!executable) {
			throw updateError(409, "product_update_unavailable", "当前环境不是 LYStar Code 正式安装目录");
		}
		await mkdir(dirname(this.logPath), { recursive: true, mode: 0o700 });
		await writeFile(this.logPath, "", { encoding: "utf8", mode: 0o600 });
		const startedAt = this.now();
		const initial: ProductUpdateJob = {
			version: UPDATE_STATE_VERSION,
			id: `${startedAt}-${process.pid}`,
			status: "running",
			stage: "starting",
			progress: 6,
			currentVersion,
			targetVersion,
			message: "正在启动更新",
			startedAt,
			updatedAt: startedAt,
		};
		await this.writeJob(initial);

		const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: this.agentDir };
		delete env.LYSTAR_WEB_SERVICE_VERSION;
		delete env.LYSTAR_WEB_SERVICE_TARGET_VERSION;
		delete env.LYSTAR_WEB_PREVIOUS_SERVICE_VERSION;
		let updater: SpawnedUpdater;
		try {
			updater = await this.spawnUpdate(executable, ["update", "--self"], {
				cwd: this.agentDir,
				env,
				logPath: this.logPath,
			});
		} catch (error) {
			const failed: ProductUpdateJob = {
				...initial,
				status: "failed",
				stage: "failed",
				message: error instanceof Error ? error.message : String(error),
				updatedAt: this.now(),
			};
			await this.writeJob(failed);
			throw updateError(500, "product_update_start_failed", failed.message);
		}
		const running = { ...initial, pid: updater.pid, updatedAt: this.now() };
		await this.writeJob(running);
		void updater.completion.then(async ({ code, signal }) => {
			if (code === 0) return;
			const current = await this.readJob();
			if (!current || current.id !== running.id || current.status !== "running") return;
			const log = await this.readLog();
			await this.writeJob({
				...current,
				status: "failed",
				stage: "failed",
				message:
					latestLogMessage(log) ??
					(signal ? `更新进程被信号 ${signal} 终止` : `更新进程退出码：${code ?? "unknown"}`),
				updatedAt: this.now(),
			});
		});
		return running;
	}
}
