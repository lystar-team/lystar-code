import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRuntimeEndpoint, runtimeTcpEndpoint } from "@lystar/code-web-runtime";
import {
	DEFAULT_RUNTIME_HOST,
	DEFAULT_RUNTIME_PORT,
	DEFAULT_WEB_HOST,
	defaultAllowedHosts,
	loadWebConfig,
	parseGatewayPort,
	validateAllowedHosts,
	validateGatewayHost,
	validateWebPassword,
	WebConfigStore,
} from "./web-config.ts";

export {
	DEFAULT_ALLOWED_HOSTS,
	DEFAULT_RUNTIME_HOST,
	DEFAULT_RUNTIME_PORT,
	DEFAULT_WEB_HOST,
	DEFAULT_WEB_PORT,
	defaultAllowedHosts,
	type LegacyWebConfig,
	loadWebConfig,
	parseGatewayPort,
	saveWebConfig,
	validateAllowedHosts,
	validateGatewayHost,
	validateWebPassword,
	WEB_CONFIG_VERSION,
	type WebConfig,
	type WebConfigInput,
	WebConfigStore,
	webConfigPath,
	webGatewaySettingsPath,
	webGatewayTokenPath,
} from "./web-config.ts";

export const DEFAULT_WEB_GATEWAY_PORT = 2422;

export interface WebGatewaySettings {
	host: string;
	port: number;
}

export interface RuntimeInvocation {
	command: string;
	args: string[];
	cwd: string;
}

export interface WebGatewayConfig {
	host: string;
	port: number;
	agentDir: string;
	runtimeEndpoint: string;
	runtimePort?: number;
	token: string;
	/** 兼容旧调用方，实际配置文件为 configPath。 */
	tokenPath?: string;
	configPath?: string;
	allowedHosts: string[];
	staticDir: string;
	manageRuntime: boolean;
	runtimeInvocation?: RuntimeInvocation;
}

export interface LoadWebGatewayConfigOptions {
	defaultPort?: number;
	defaultRuntimePort?: number;
	staticDir?: string;
	runtimeInvocation?: RuntimeInvocation;
	configFileName?: string;
}

function envString(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

export function getWebAgentDir(): string {
	return envString("PI_CODING_AGENT_DIR") ?? join(homedir(), ".pi", "agent");
}

function parsePort(value: string | undefined, fallback: number): number {
	return parseGatewayPort(value ?? fallback);
}

export function defaultWebStaticDir(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [resolve(moduleDir, "../../web/dist"), resolve(process.cwd(), "packages/web/dist")];
	return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? candidates[0];
}

export async function loadWebGatewaySettings(agentDir: string): Promise<WebGatewaySettings | undefined> {
	const config = await loadWebConfig(agentDir);
	return config ? { host: config.host, port: config.port } : undefined;
}

/** 兼容旧调用方；新写入统一保存完整 web-config.json。 */
export async function saveWebGatewaySettings(
	agentDir: string,
	settings: WebGatewaySettings,
): Promise<WebGatewaySettings> {
	const store = new WebConfigStore(agentDir);
	const current = await store.loadOrMigrate();
	const legacy = current ? undefined : await store.loadLegacy();
	const host = validateGatewayHost(settings.host);
	const port = parseGatewayPort(settings.port);
	await store.save({
		host,
		allowedHosts: current?.allowedHosts ?? legacy?.allowedHosts ?? defaultAllowedHosts(host),
		port,
		runtimePort: current?.runtimePort ?? legacy?.runtimePort ?? DEFAULT_RUNTIME_PORT,
		password: current?.password ?? legacy?.password ?? randomBytes(32).toString("hex"),
	});
	return { host, port };
}

/** 兼容旧调用方；新写入统一保存完整 web-config.json。 */
export async function saveWebGatewayToken(agentDir: string, password: string): Promise<string> {
	const store = new WebConfigStore(agentDir);
	const current = await store.loadOrMigrate();
	const legacy = current ? undefined : await store.loadLegacy();
	return (
		await store.save({
			host: current?.host ?? legacy?.host ?? DEFAULT_WEB_HOST,
			allowedHosts:
				current?.allowedHosts ??
				legacy?.allowedHosts ??
				defaultAllowedHosts(current?.host ?? legacy?.host ?? DEFAULT_WEB_HOST),
			port: current?.port ?? legacy?.port ?? DEFAULT_WEB_GATEWAY_PORT,
			runtimePort: current?.runtimePort ?? legacy?.runtimePort ?? DEFAULT_RUNTIME_PORT,
			password: validateWebPassword(password),
		})
	).password;
}

export async function loadWebGatewayConfig(options: LoadWebGatewayConfigOptions = {}): Promise<WebGatewayConfig> {
	const agentDir = getWebAgentDir();
	const configPath = options.configFileName ? join(agentDir, options.configFileName) : undefined;
	const store = new WebConfigStore(agentDir, configPath);
	let persisted = await store.loadOrMigrate();
	const environmentHost = envString("PI_WEB_HOST");
	const environmentAllowedHosts = envString("PI_WEB_ALLOWED_HOSTS");
	const environmentPort = envString("PI_WEB_PORT");
	const environmentRuntimePort = envString("PI_WEB_RUNTIME_PORT");
	const environmentPassword = envString("PI_WEB_TOKEN");
	if (!persisted) {
		const legacy = await store.loadLegacy();
		const host = environmentHost ?? legacy.host ?? DEFAULT_WEB_HOST;
		persisted = await store.save({
			host,
			allowedHosts:
				environmentAllowedHosts !== undefined
					? validateAllowedHosts(environmentAllowedHosts)
					: (legacy.allowedHosts ?? defaultAllowedHosts(host)),
			port: parsePort(environmentPort ?? legacy.port?.toString(), options.defaultPort ?? DEFAULT_WEB_GATEWAY_PORT),
			runtimePort: parsePort(
				environmentRuntimePort ?? legacy.runtimePort?.toString(),
				options.defaultRuntimePort ?? DEFAULT_RUNTIME_PORT,
			),
			password: environmentPassword ?? legacy.password ?? randomBytes(32).toString("hex"),
		});
	} else if (
		environmentHost ||
		environmentAllowedHosts ||
		environmentPort ||
		environmentRuntimePort ||
		environmentPassword
	) {
		persisted = await store.save({
			host: environmentHost ?? persisted.host,
			allowedHosts:
				environmentAllowedHosts !== undefined
					? validateAllowedHosts(environmentAllowedHosts)
					: persisted.allowedHosts,
			port: parsePort(environmentPort, persisted.port),
			runtimePort: parsePort(environmentRuntimePort, persisted.runtimePort),
			password: environmentPassword ?? persisted.password,
		});
	}
	const staticDir = options.staticDir ?? envString("PI_WEB_STATIC_DIR") ?? defaultWebStaticDir();
	const runtimePort = persisted.runtimePort;
	const runtimeEndpoint = options.runtimeInvocation
		? runtimeTcpEndpoint(DEFAULT_RUNTIME_HOST, runtimePort)
		: (envString("PI_WEB_RUNTIME_ENDPOINT") ?? defaultRuntimeEndpoint(agentDir));
	return {
		host: persisted.host,
		port: persisted.port,
		runtimePort,
		agentDir,
		runtimeEndpoint,
		token: persisted.password,
		tokenPath: store.path,
		configPath: store.path,
		allowedHosts: persisted.allowedHosts,
		staticDir,
		manageRuntime: process.env.PI_WEB_MANAGE_RUNTIME !== "0",
		...(options.runtimeInvocation ? { runtimeInvocation: options.runtimeInvocation } : {}),
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
