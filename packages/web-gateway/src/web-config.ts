import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";

export const WEB_CONFIG_VERSION = 1 as const;
export const DEFAULT_WEB_HOST = "0.0.0.0";
export const DEFAULT_WEB_PORT = 1420;
export const DEFAULT_RUNTIME_PORT = 1422;
export const DEFAULT_RUNTIME_HOST = "127.0.0.1";
export const DEFAULT_ALLOWED_HOSTS = ["*"] as const;
const WEB_PASSWORD_MIN_LENGTH = 8;
const WEB_PASSWORD_MAX_LENGTH = 256;
const HOSTNAME_PATTERN =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export interface WebConfig {
	version: typeof WEB_CONFIG_VERSION;
	host: string;
	allowedHosts: string[];
	port: number;
	runtimePort: number;
	password: string;
}

export interface WebConfigInput {
	host: string;
	port: number;
	password: string;
	allowedHosts?: readonly string[];
	runtimePort?: number;
}

export interface LegacyWebConfig {
	host?: string;
	allowedHosts?: string[];
	port?: number;
	runtimePort?: number;
	password?: string;
}

function webDirectory(agentDir: string): string {
	return join(agentDir, "web");
}

export function webConfigPath(agentDir: string): string {
	return join(agentDir, "web-config.json");
}

export function webGatewaySettingsPath(agentDir: string): string {
	return join(webDirectory(agentDir), "gateway.json");
}

export function webGatewayTokenPath(agentDir: string): string {
	return join(webDirectory(agentDir), "token");
}

export function parseGatewayPort(value: unknown): number {
	const port = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须在 1 到 65535 之间");
	return port;
}

export function validateGatewayHost(value: unknown): string {
	if (typeof value !== "string") throw new Error("监听 IP 必须是文本");
	const host = value.trim();
	if (!host || host.length > 255 || (host !== "localhost" && isIP(host) === 0))
		throw new Error("监听 IP 必须是有效的 IPv4、IPv6 地址或 localhost");
	return host;
}

export function defaultAllowedHosts(host: string): string[] {
	const normalizedHost = host.trim().toLowerCase();
	if (normalizedHost === "0.0.0.0" || normalizedHost === "::") return [...DEFAULT_ALLOWED_HOSTS];
	return [...new Set(["localhost", "127.0.0.1", "::1", normalizedHost])];
}

function normalizeAllowedHost(value: string): string {
	const host = value
		.trim()
		.replace(/^\[|\]$/gu, "")
		.toLowerCase();
	if (host === "*") return host;
	if (host.startsWith("*.")) {
		const suffix = host.slice(2);
		if (!HOSTNAME_PATTERN.test(suffix)) throw new Error(`白名单地址无效：${value}`);
		return host;
	}
	if (host !== "localhost" && isIP(host) === 0 && !HOSTNAME_PATTERN.test(host))
		throw new Error(`白名单地址无效：${value}`);
	return host;
}

export function validateAllowedHosts(value: unknown): string[] {
	const values =
		typeof value === "string"
			? value.split(",")
			: Array.isArray(value)
				? value.filter((item): item is string => typeof item === "string")
				: [];
	const normalized = [...new Set(values.map(normalizeAllowedHost).filter(Boolean))];
	if (normalized.length === 0) throw new Error("白名单 IP 地址不能为空；填入 * 表示不限制访问来源");
	return normalized;
}

export function validateWebPassword(value: unknown): string {
	if (typeof value !== "string") throw new Error("连接密钥必须是文本");
	const password = value.trim();
	if (password.length < WEB_PASSWORD_MIN_LENGTH || password.length > WEB_PASSWORD_MAX_LENGTH)
		throw new Error(`连接密钥长度必须在 ${WEB_PASSWORD_MIN_LENGTH} 到 ${WEB_PASSWORD_MAX_LENGTH} 个字符之间`);
	return password;
}

function recordValue(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Web 配置格式无效");
	return value as Record<string, unknown>;
}

function parseWebConfig(value: unknown): WebConfig {
	const record = recordValue(value);
	if (record.version !== WEB_CONFIG_VERSION) throw new Error(`Web 配置版本无效：${String(record.version)}`);
	try {
		const host = validateGatewayHost(record.host);
		return {
			version: WEB_CONFIG_VERSION,
			host,
			allowedHosts:
				record.allowedHosts === undefined ? defaultAllowedHosts(host) : validateAllowedHosts(record.allowedHosts),
			port: parseGatewayPort(record.port),
			runtimePort: parseGatewayPort(record.runtimePort ?? DEFAULT_RUNTIME_PORT),
			password: validateWebPassword(record.password),
		};
	} catch (error) {
		throw new Error(`Web 配置无效：${error instanceof Error ? error.message : String(error)}`);
	}
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
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

export class WebConfigStore {
	readonly agentDir: string;
	readonly path: string;

	constructor(agentDir: string, configPath?: string) {
		this.agentDir = agentDir;
		this.path = configPath ?? webConfigPath(agentDir);
	}

	async load(): Promise<WebConfig | undefined> {
		const content = await readOptional(this.path);
		if (content === undefined) return undefined;
		try {
			return parseWebConfig(JSON.parse(content));
		} catch (error) {
			if (error instanceof SyntaxError) throw new Error("Web 配置文件不是有效 JSON");
			throw error;
		}
	}

	async loadLegacy(): Promise<LegacyWebConfig> {
		const result: LegacyWebConfig = {};
		const settingsContent = await readOptional(webGatewaySettingsPath(this.agentDir));
		if (settingsContent !== undefined) {
			let value: unknown;
			try {
				value = JSON.parse(settingsContent);
			} catch {
				throw new Error("旧 Web Gateway 配置文件不是有效 JSON");
			}
			const record = recordValue(value);
			try {
				result.host = validateGatewayHost(record.host);
				result.allowedHosts =
					record.allowedHosts === undefined ? undefined : validateAllowedHosts(record.allowedHosts);
				result.port = parseGatewayPort(record.port);
				result.runtimePort = record.runtimePort === undefined ? undefined : parseGatewayPort(record.runtimePort);
			} catch (error) {
				throw new Error(`旧 Web Gateway 配置无效：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const tokenContent = await readOptional(webGatewayTokenPath(this.agentDir));
		const password = tokenContent?.trim();
		if (password) result.password = password;
		return result;
	}

	async loadOrMigrate(): Promise<WebConfig | undefined> {
		const current = await this.load();
		if (current) return current;
		const legacy = await this.loadLegacy();
		if (!legacy.host || legacy.port === undefined || !legacy.password) return undefined;
		const migrated = await this.save({
			host: legacy.host,
			allowedHosts: legacy.allowedHosts ?? defaultAllowedHosts(legacy.host),
			port: legacy.port,
			runtimePort: legacy.runtimePort ?? DEFAULT_RUNTIME_PORT,
			password: legacy.password,
		});
		await Promise.all([
			unlink(webGatewaySettingsPath(this.agentDir)).catch(() => {}),
			unlink(webGatewayTokenPath(this.agentDir)).catch(() => {}),
		]);
		return migrated;
	}

	async save(input: WebConfigInput): Promise<WebConfig> {
		const host = validateGatewayHost(input.host);
		const config: WebConfig = {
			version: WEB_CONFIG_VERSION,
			host,
			allowedHosts: validateAllowedHosts(input.allowedHosts ?? defaultAllowedHosts(host)),
			port: parseGatewayPort(input.port),
			runtimePort: parseGatewayPort(input.runtimePort ?? DEFAULT_RUNTIME_PORT),
			password: validateWebPassword(input.password),
		};
		await writeAtomic(this.path, `${JSON.stringify(config, null, "\t")}\n`);
		return config;
	}

	async update(patch: Partial<WebConfigInput>): Promise<WebConfig> {
		const current = await this.loadOrMigrate();
		if (!current) throw new Error(`Web 配置尚未初始化：${this.path}`);
		return this.save({
			host: patch.host ?? current.host,
			allowedHosts: patch.allowedHosts ?? current.allowedHosts,
			port: patch.port ?? current.port,
			runtimePort: patch.runtimePort ?? current.runtimePort,
			password: patch.password ?? current.password,
		});
	}
}

export async function loadWebConfig(agentDir: string): Promise<WebConfig | undefined> {
	return new WebConfigStore(agentDir).loadOrMigrate();
}

export async function saveWebConfig(agentDir: string, input: WebConfigInput): Promise<WebConfig> {
	return new WebConfigStore(agentDir).save(input);
}
