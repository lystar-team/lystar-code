import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultIpcEndpoint } from "@lystar/code-gui-host";

export const DEFAULT_WEB_GATEWAY_PORT = 1422;

export interface WebGatewayConfig {
	host: string;
	port: number;
	agentDir: string;
	hostEndpoint: string;
	token: string;
	tokenPath: string;
	allowedHosts: string[];
	staticDir: string;
	manageHost: boolean;
}

function envString(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

function defaultHostEndpoint(agentDir: string): string {
	return defaultIpcEndpoint(agentDir);
}

function parsePort(value: string | undefined): number {
	const port = Number(value ?? String(DEFAULT_WEB_GATEWAY_PORT));
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须在 1 到 65535 之间");
	return port;
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
	const webDir = join(agentDir, "web");
	const tokenPath = join(webDir, "token");
	if (configured) return { token: configured, tokenPath };
	try {
		const stored = (await readFile(tokenPath, "utf8")).trim();
		if (stored) return { token: stored, tokenPath };
	} catch {}
	const token = randomBytes(32).toString("hex");
	await mkdir(webDir, { recursive: true, mode: 0o700 });
	const temporaryPath = `${tokenPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporaryPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	await rename(temporaryPath, tokenPath);
	if (process.platform !== "win32") await chmod(tokenPath, 0o600);
	return { token, tokenPath };
}

export async function loadWebGatewayConfig(): Promise<WebGatewayConfig> {
	const agentDir = envString("PI_CODING_AGENT_DIR") ?? join(homedir(), ".pi", "agent");
	const host = envString("PI_WEB_HOST") ?? "0.0.0.0";
	const port = parsePort(process.env.PI_WEB_PORT);
	const token = await loadOrCreateToken(agentDir);
	const staticDir =
		envString("PI_WEB_STATIC_DIR") ?? fileURLToPath(new URL("../../packages/web/dist", import.meta.url));
	return {
		host,
		port,
		agentDir,
		hostEndpoint: envString("PI_GUI_HOST_ENDPOINT") ?? defaultHostEndpoint(agentDir),
		token: token.token,
		tokenPath: token.tokenPath,
		allowedHosts: parseAllowedHosts(process.env.PI_WEB_ALLOWED_HOSTS, host),
		staticDir,
		manageHost: process.env.PI_WEB_MANAGE_HOST !== "0",
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
