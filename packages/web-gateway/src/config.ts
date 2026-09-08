import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRuntimeEndpoint } from "@lystar/code-web-runtime";

export const DEFAULT_WEB_GATEWAY_PORT = 1422;
const WEB_PASSWORD_MIN_LENGTH = 8;
const WEB_PASSWORD_MAX_LENGTH = 256;

export interface WebGatewaySettings {
	host: string;
	port: number;
}

export interface WebGatewayConfig {
	host: string;
	port: number;
	agentDir: string;
	runtimeEndpoint: string;
	token: string;
	tokenPath: string;
	allowedHosts: string[];
	staticDir: string;
	manageRuntime: boolean;
}

function webDirectory(agentDir: string): string {
	return join(agentDir, "web");
}

export function webGatewaySettingsPath(agentDir: string): string {
	return join(webDirectory(agentDir), "gateway.json");
}

export function webGatewayTokenPath(agentDir: string): string {
	return join(webDirectory(agentDir), "token");
}

function envString(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

export function parseGatewayPort(value: unknown): number {
	const port = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须在 1 到 65535 之间");
	return port;
}

function parsePort(value: string | undefined): number {
	return parseGatewayPort(value ?? DEFAULT_WEB_GATEWAY_PORT);
}

export function validateGatewayHost(value: unknown): string {
	if (typeof value !== "string") throw new Error("可访问 IP 必须是文本");
	const host = value.trim();
	if (!host || host.length > 255 || (host !== "localhost" && isIP(host) === 0))
		throw new Error("可访问 IP 必须是有效的 IPv4 或 IPv6 地址");
	return host;
}

export function validateWebPassword(value: unknown): string {
	if (typeof value !== "string") throw new Error("访问密码必须是文本");
	const password = value.trim();
	if (password.length < WEB_PASSWORD_MIN_LENGTH || password.length > WEB_PASSWORD_MAX_LENGTH)
		throw new Error(`访问密码长度必须在 ${WEB_PASSWORD_MIN_LENGTH} 到 ${WEB_PASSWORD_MAX_LENGTH} 个字符之间`);
	return password;
}

export async function loadWebGatewaySettings(agentDir: string): Promise<WebGatewaySettings | undefined> {
	let content: string;
	try {
		content = await readFile(webGatewaySettingsPath(agentDir), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error("Web Gateway 配置文件不是有效 JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Web Gateway 配置格式无效");
	const record = value as Record<string, unknown>;
	try {
		return {
			host: validateGatewayHost(record.host),
			port: parseGatewayPort(record.port),
		};
	} catch (error) {
		throw new Error(`Web Gateway 配置无效：${error instanceof Error ? error.message : String(error)}`);
	}
}

async function writeWebFile(agentDir: string, fileName: string, content: string): Promise<string> {
	const directory = webDirectory(agentDir);
	const path = join(directory, fileName);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	await rename(temporaryPath, path);
	if (process.platform !== "win32") await chmod(path, 0o600);
	return path;
}

export async function saveWebGatewaySettings(
	agentDir: string,
	settings: WebGatewaySettings,
): Promise<WebGatewaySettings> {
	const normalized = {
		host: validateGatewayHost(settings.host),
		port: parseGatewayPort(settings.port),
	};
	await writeWebFile(agentDir, "gateway.json", `${JSON.stringify(normalized)}\n`);
	return normalized;
}

export async function saveWebGatewayToken(agentDir: string, password: string): Promise<string> {
	const normalized = validateWebPassword(password);
	await writeWebFile(agentDir, "token", `${normalized}\n`);
	return normalized;
}

function parseAllowedHosts(value: string | undefined, host: string): string[] {
	const configured = value
		?.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
	if (configured && configured.length > 0) return configured;
	return host === "0.0.0.0" || host === "::"
		? ["localhost", "127.0.0.1", "::1", "0.0.0.0"]
		: ["localhost", "127.0.0.1", "::1", host.toLowerCase()];
}

async function loadOrCreateToken(agentDir: string): Promise<{ token: string; tokenPath: string }> {
	const configured = envString("PI_WEB_TOKEN");
	const tokenPath = webGatewayTokenPath(agentDir);
	if (configured) return { token: configured, tokenPath };
	try {
		const stored = (await readFile(tokenPath, "utf8")).trim();
		if (stored) return { token: stored, tokenPath };
	} catch {}
	const token = randomBytes(32).toString("hex");
	await writeWebFile(agentDir, "token", `${token}\n`);
	return { token, tokenPath };
}

export async function loadWebGatewayConfig(): Promise<WebGatewayConfig> {
	const agentDir = envString("PI_CODING_AGENT_DIR") ?? join(homedir(), ".pi", "agent");
	const persisted = await loadWebGatewaySettings(agentDir);
	const host = envString("PI_WEB_HOST") ?? persisted?.host ?? "0.0.0.0";
	const port = parsePort(envString("PI_WEB_PORT") ?? persisted?.port?.toString());
	const token = await loadOrCreateToken(agentDir);
	const staticDir =
		envString("PI_WEB_STATIC_DIR") ?? fileURLToPath(new URL("../../packages/web/dist", import.meta.url));
	return {
		host,
		port,
		agentDir,
		runtimeEndpoint: envString("PI_WEB_RUNTIME_ENDPOINT") ?? defaultRuntimeEndpoint(agentDir),
		token: token.token,
		tokenPath: token.tokenPath,
		allowedHosts: parseAllowedHosts(process.env.PI_WEB_ALLOWED_HOSTS, host),
		staticDir,
		manageRuntime: process.env.PI_WEB_MANAGE_RUNTIME !== "0",
	};
}

export function hostMatches(hostname: string, allowedHosts: readonly string[]): boolean {
	const normalized = hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	return allowedHosts.some((allowed) => {
		if (allowed === "*") return true;
		if (allowed.startsWith("*.")) return normalized.endsWith(allowed.slice(1));
		return normalized === allowed.replace(/^\[|\]$/g, "");
	});
}

export function requestHostname(hostHeader: string | undefined): string | undefined {
	if (!hostHeader) return undefined;
	try {
		return new URL(`http://${hostHeader}`).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

export function originHostname(origin: string | undefined): string | undefined {
	if (!origin) return undefined;
	try {
		const url = new URL(origin);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

export function bearerToken(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const match = /^Bearer\s+(.+)$/iu.exec(value.trim());
	return match?.[1]?.trim() || undefined;
}

export function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=") || undefined;
	}
	return undefined;
}

export function isValidClientId(value: string | undefined): value is string {
	return Boolean(value && /^[A-Za-z0-9._:-]{8,128}$/u.test(value));
}
