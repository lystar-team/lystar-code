import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_FILE_NAME = "gateway.lock";
const MAX_ACQUIRE_ATTEMPTS = 3;

interface GatewayLockRecord {
	pid: number;
	startedAt: number;
	processStartToken?: string;
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

function readProcessStartToken(pid: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(") ");
		if (commandEnd < 0) return undefined;
		return stat
			.slice(commandEnd + 2)
			.trim()
			.split(/\s+/u)[19];
	} catch {
		return undefined;
	}
}

function isProcessAlive(record: GatewayLockRecord): boolean {
	try {
		process.kill(record.pid, 0);
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
	if (!record.processStartToken) return true;
	const currentStartToken = readProcessStartToken(record.pid);
	return !currentStartToken || currentStartToken === record.processStartToken;
}

function readLockRecord(path: string): GatewayLockRecord | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8").trim());
		if (!value || typeof value !== "object") return undefined;
		const record = value as Partial<GatewayLockRecord>;
		return typeof record.pid === "number" && typeof record.startedAt === "number"
			? {
					pid: record.pid,
					startedAt: record.startedAt,
					...(typeof record.processStartToken === "string" ? { processStartToken: record.processStartToken } : {}),
				}
			: undefined;
	} catch {
		return undefined;
	}
}

export class GatewayAlreadyRunningError extends Error {
	readonly code = "gateway_already_running" as const;
	readonly pid: number;

	constructor(pid: number) {
		super(`LYStar Web Gateway 已在运行（PID ${pid}）。请使用现有实例，不要重复启动。`);
		this.name = "GatewayAlreadyRunningError";
		this.pid = pid;
	}
}

export class GatewayInstanceLock {
	private released = false;
	private readonly path: string;
	private readonly fd: number;
	private readonly record: GatewayLockRecord;

	private constructor(path: string, fd: number, record: GatewayLockRecord) {
		this.path = path;
		this.fd = fd;
		this.record = record;
	}

	static async acquire(agentDir: string): Promise<GatewayInstanceLock> {
		const directory = join(agentDir, "web");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, LOCK_FILE_NAME);
		for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
			try {
				const fd = openSync(path, "wx", 0o600);
				const processStartToken = readProcessStartToken(process.pid);
				const record: GatewayLockRecord = {
					pid: process.pid,
					startedAt: Date.now(),
					...(processStartToken ? { processStartToken } : {}),
				};
				try {
					writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
				} catch (error) {
					closeSync(fd);
					unlinkSync(path);
					throw error;
				}
				return new GatewayInstanceLock(path, fd, record);
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
				const existing = readLockRecord(path);
				if (existing && isProcessAlive(existing)) throw new GatewayAlreadyRunningError(existing.pid);
				try {
					unlinkSync(path);
				} catch (unlinkError) {
					if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
				}
			}
		}
		throw new Error(`无法获取 Web Gateway 单实例锁：${path}`);
	}

	async release(): Promise<void> {
		if (this.released) return;
		this.released = true;
		try {
			const current = readLockRecord(this.path);
			if (
				current?.pid === this.record.pid &&
				current.startedAt === this.record.startedAt &&
				current.processStartToken === this.record.processStartToken
			) {
				try {
					unlinkSync(this.path);
				} catch (error) {
					if (errorCode(error) !== "ENOENT") throw error;
				}
			}
		} finally {
			closeSync(this.fd);
		}
	}
}
