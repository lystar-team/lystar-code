import { createHash } from "node:crypto";
import { access, open, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

export async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	try {
		return await realpath(resolvedPath);
	} catch (error) {
		if (isMissingPathError(error)) {
			return resolvedPath;
		}
		throw error;
	}
}

async function getCrossProcessLockTarget(key: string): Promise<{ path: string; removeAfter: boolean }> {
	try {
		await access(key);
		return { path: key, removeAfter: false };
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
	}

	let directory = dirname(key);
	while (true) {
		try {
			await access(directory);
			const lockTarget = join(
				directory,
				`.pi-file-mutation-${createHash("sha256").update(key).digest("hex")}.lock-target`,
			);
			const handle = await open(lockTarget, "a");
			await handle.close();
			return { path: lockTarget, removeAfter: true };
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			const parent = dirname(directory);
			if (parent === directory) throw error;
			directory = parent;
		}
	}
}

async function acquireCrossProcessLock(key: string): Promise<() => Promise<void>> {
	const target = await getCrossProcessLockTarget(key);
	await lockfile.lock(target.path, {
		realpath: false,
		stale: 60_000,
		update: 15_000,
		retries: { retries: 40, minTimeout: 10, maxTimeout: 100 },
	});
	return async () => {
		try {
			await lockfile.unlock(target.path, { realpath: false });
		} finally {
			if (target.removeAfter) await rm(target.path, { force: true });
		}
	};
}

/**
 * Serialize file mutation operations targeting the same file inside one process and across processes.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	let releaseCrossProcessLock: (() => Promise<void>) | undefined;
	try {
		releaseCrossProcessLock = await acquireCrossProcessLock(key);
		return await fn();
	} finally {
		try {
			if (releaseCrossProcessLock) await releaseCrossProcessLock();
		} finally {
			releaseNext();
			if (fileMutationQueues.get(key) === chainedQueue) {
				fileMutationQueues.delete(key);
			}
		}
	}
}
