import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const BRANDING_FILE_NAME = "lystar.json";
const DEFAULT_PRODUCT_NAME = "LYStar Code";
const MAX_PRODUCT_NAME_LENGTH = 64;
const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/u;

export interface ProductBranding {
	name: string;
	logo?: string;
}

function defaultProductBranding(): ProductBranding {
	return { name: DEFAULT_PRODUCT_NAME };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function getProductBrandingPath(agentDir: string): string {
	return join(agentDir, BRANDING_FILE_NAME);
}

async function readConfig(agentDir: string): Promise<Record<string, unknown> | undefined> {
	const path = getProductBrandingPath(agentDir);
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
	const value = record(parsed);
	if (!value) throw new Error(`无法读取 ${path}：配置文件必须是 JSON 对象`);
	return value;
}

function validName(value: unknown): string {
	if (typeof value !== "string") throw new Error("系统名称必须是文本");
	const name = value.trim();
	if (!name) throw new Error("系统名称不能为空");
	if (name.length > MAX_PRODUCT_NAME_LENGTH) throw new Error(`系统名称不能超过 ${MAX_PRODUCT_NAME_LENGTH} 个字符`);
	return name;
}

function validLogo(value: unknown): string {
	if (typeof value !== "string") throw new Error("Logo 必须是图片数据");
	const match = LOGO_DATA_URL_PATTERN.exec(value);
	if (!match || match[2].length % 4 === 1) throw new Error("Logo 只支持 PNG、JPEG、GIF 或 WebP 图片");
	const bytes = Buffer.from(match[2], "base64");
	if (bytes.length === 0) throw new Error("Logo 图片不能为空");
	if (bytes.length > MAX_LOGO_BYTES) throw new Error("Logo 图片不能超过 1 MB");
	return value;
}

function readBranding(config: Record<string, unknown> | undefined): ProductBranding {
	const value = record(config?.branding);
	if (!value) return defaultProductBranding();
	const name = typeof value.name === "string" ? value.name.trim() : "";
	const logo = typeof value.logo === "string" ? value.logo : undefined;
	const result: ProductBranding = {
		name: name && name.length <= MAX_PRODUCT_NAME_LENGTH ? name : DEFAULT_PRODUCT_NAME,
	};
	if (logo) {
		try {
			result.logo = validLogo(logo);
		} catch {
			// 无效的自定义 Logo 不影响 Web 启动，回退到内置 Logo。
		}
	}
	return result;
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

export async function loadProductBranding(agentDir: string): Promise<ProductBranding> {
	try {
		return readBranding(await readConfig(agentDir));
	} catch {
		return defaultProductBranding();
	}
}

export async function saveProductBranding(
	agentDir: string,
	input: { name: unknown; logo?: unknown },
): Promise<ProductBranding> {
	const path = getProductBrandingPath(agentDir);
	return withWriteLock(path, async () => {
		const config = (await readConfig(agentDir)) ?? {};
		const current = readBranding(config);
		const name = validName(input.name);
		const logo =
			input.logo === undefined
				? current.logo
				: input.logo === null || input.logo === ""
					? undefined
					: validLogo(input.logo);
		const branding: ProductBranding = { name, ...(logo ? { logo } : {}) };
		await writeAtomic(path, `${JSON.stringify({ ...config, branding }, null, "\t")}\n`);
		return branding;
	});
}
