import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const LYSTAR_CONFIG_FILE_NAME = "lystar.json";

export type LystarConfig = Record<string, unknown>;

function record(value: unknown): LystarConfig | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as LystarConfig) : undefined;
}

export function getLystarConfigPath(agentDir: string): string {
	return join(agentDir, LYSTAR_CONFIG_FILE_NAME);
}

export async function loadLystarConfig(agentDir: string): Promise<LystarConfig | undefined> {
	const path = getLystarConfigPath(agentDir);
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error(`无法读取 ${path}：配置文件不是有效 JSON`);
	}
	const config = record(parsed);
	if (!config) throw new Error(`无法读取 ${path}：配置文件必须是 JSON 对象`);
	return config;
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporaryPath, path);
		if (process.platform !== "win32") await chmod(path, 0o600);
	} catch (error) {
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

const writeLocks = new Map<string, Promise<void>>();

async function withWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const previous = writeLocks.get(path);
	const current = previous ? previous.then(operation, operation) : operation();
	const lock = current.then(
		() => undefined,
		() => undefined,
	);
	writeLocks.set(path, lock);
	try {
		return await current;
	} finally {
		if (writeLocks.get(path) === lock) writeLocks.delete(path);
	}
}

export async function updateLystarConfig(
	agentDir: string,
	update: (current: LystarConfig) => LystarConfig,
): Promise<LystarConfig> {
	const path = getLystarConfigPath(agentDir);
	return withWriteLock(path, async () => {
		const current = (await loadLystarConfig(agentDir)) ?? {};
		const next = update(current);
		await writeAtomic(path, `${JSON.stringify(next, null, "\t")}\n`);
		return next;
	});
}
