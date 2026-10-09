import { randomUUID } from "node:crypto";
import fs, { type Stats } from "node:fs";
import { hostname } from "node:os";
import lockfile from "proper-lockfile";

const SESSION_LOCK_STALE_MS = 120_000;
const SESSION_LOCK_UPDATE_MS = 10_000;

interface WriterOwner {
	pid: number;
	host: string;
	token: string;
	processStart?: string;
	dev: number;
	ino: number;
	birthtimeMs: number;
}

function processStart(pid: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const value = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return value
			.slice(value.lastIndexOf(") ") + 2)
			.trim()
			.split(/\s+/u)[19];
	} catch {
		return undefined;
	}
}

function readOwner(path: string): WriterOwner | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(path, "utf8")) as Partial<WriterOwner> | null;
		if (
			!value ||
			!Number.isSafeInteger(value.pid) ||
			(value.pid ?? 0) <= 0 ||
			typeof value.host !== "string" ||
			typeof value.token !== "string" ||
			typeof value.dev !== "number" ||
			typeof value.ino !== "number" ||
			typeof value.birthtimeMs !== "number" ||
			(value.processStart !== undefined && typeof value.processStart !== "string")
		)
			return undefined;
		return value as WriterOwner;
	} catch {
		return undefined;
	}
}

function sameLock(left: Pick<WriterOwner, "dev" | "ino" | "birthtimeMs">, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function ownerAlive(owner: WriterOwner): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		// 只有明确不存在的进程才能立即回收；其他错误沿用锁的保留期。
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
	const currentStart = owner.processStart ? processStart(owner.pid) : undefined;
	return !currentStart || currentStart === owner.processStart;
}

function ownerLockStat(lockPath: string, ownerPath: string): Stats {
	const stat = fs.statSync(lockPath);
	const owner = readOwner(ownerPath);
	if (owner?.host === hostname() && sameLock(owner, stat)) {
		// 不修改磁盘心跳。只向锁库提供持有进程的存活结果。
		stat.mtime = new Date(ownerAlive(owner) ? Date.now() : 0);
	}
	return stat;
}

export function lockSessionWriter(sessionPath: string, onCompromised: (error: Error) => void): () => void {
	const lockPath = `${sessionPath}.lock`;
	const ownerPath = `${lockPath}.owner.json`;
	let acquired = false;
	let observed: Stats | undefined;
	const release = lockfile.lockSync(sessionPath, {
		stale: SESSION_LOCK_STALE_MS,
		update: SESSION_LOCK_UPDATE_MS,
		realpath: false,
		retries: 0,
		lockfilePath: lockPath,
		onCompromised,
		fs: {
			...fs,
			statSync(path: fs.PathLike): Stats {
				if (acquired) return fs.statSync(path);
				observed = ownerLockStat(lockPath, ownerPath);
				return observed;
			},
			rmdirSync(path: fs.PathLike): void {
				// 并发恢复时，不移除另一进程刚取得的新锁。
				if (!acquired && observed && !sameLock(observed, fs.statSync(path))) {
					throw Object.assign(new Error(`Session writer changed during recovery: ${sessionPath}`), {
						code: "ELOCKED",
					});
				}
				fs.rmdirSync(path);
			},
		},
	});
	acquired = true;
	const stat = fs.statSync(lockPath);
	const owner: WriterOwner = {
		pid: process.pid,
		host: hostname(),
		token: randomUUID(),
		processStart: processStart(process.pid),
		dev: stat.dev,
		ino: stat.ino,
		birthtimeMs: stat.birthtimeMs,
	};
	const tempPath = `${ownerPath}.${owner.token}.tmp`;
	try {
		fs.writeFileSync(tempPath, JSON.stringify(owner), { flag: "wx" });
		fs.renameSync(tempPath, ownerPath);
	} catch (error) {
		release();
		throw error;
	} finally {
		if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
	}
	return () => {
		try {
			if (readOwner(ownerPath)?.token === owner.token) fs.unlinkSync(ownerPath);
		} finally {
			release();
		}
	};
}

export function isSessionWriterLocked(sessionPath: string): boolean {
	const lockPath = `${sessionPath}.lock`;
	try {
		return ownerLockStat(lockPath, `${lockPath}.owner.json`).mtime.getTime() >= Date.now() - SESSION_LOCK_STALE_MS;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
