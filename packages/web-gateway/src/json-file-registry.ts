import { randomUUID } from "node:crypto";
import { readFileSync, type Stats, statSync } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

export class JsonFileRegistry<T> {
	private readonly path: string;
	private readonly initialState: () => T;
	private readonly normalize: (raw: Record<string, unknown>) => T;
	private readonly corruptMessage: string;
	private cached?: { stat: Stats; state: T };
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		path: string,
		initialState: () => T,
		normalize: (raw: Record<string, unknown>) => T,
		corruptMessage: string,
	) {
		this.path = path;
		this.initialState = initialState;
		this.normalize = normalize;
		this.corruptMessage = corruptMessage;
	}

	async load(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		this.read();
	}

	read(): T {
		try {
			const stat = statSync(this.path);
			const cached = this.cached;
			if (
				cached &&
				cached.stat.dev === stat.dev &&
				cached.stat.ino === stat.ino &&
				cached.stat.mtimeMs === stat.mtimeMs &&
				cached.stat.ctimeMs === stat.ctimeMs &&
				cached.stat.size === stat.size
			) {
				return cached.state;
			}
			const state = this.normalize(JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>);
			this.cached = { stat, state };
			return state;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(`${this.corruptMessage}：${this.path}`, { cause: error });
			}
			this.cached = undefined;
			return this.initialState();
		}
	}

	async update<R>(mutate: (state: T) => R): Promise<R> {
		const operation = this.writeQueue.then(async () => {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			const release = await lockfile.lock(this.path, {
				realpath: false,
				retries: { retries: 10, minTimeout: 20, maxTimeout: 1000 },
			});
			try {
				// 每次修改都以锁内读到的索引为准，避免不同 Gateway 的旧副本互相覆盖。
				const state = structuredClone(this.read());
				const previous = JSON.stringify(state);
				const result = mutate(state);
				if (JSON.stringify(state) === previous) return result;
				const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
				try {
					await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
						encoding: "utf8",
						mode: 0o600,
						flag: "wx",
					});
					await rename(temporaryPath, this.path);
					if (process.platform !== "win32") await chmod(this.path, 0o600);
					this.cached = { stat: statSync(this.path), state };
				} finally {
					await unlink(temporaryPath).catch(() => {});
				}
				return result;
			} finally {
				await release();
			}
		});
		this.writeQueue = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}
}
