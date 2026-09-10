import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, VERSION } from "../config.ts";

const DEFAULT_WEB_PORT = 1420;
const DEFAULT_RUNTIME_PORT = 1422;

type RuntimeInvocation = { command: string; args: string[]; cwd: string };
type StoredWebConfig = {
	host: string;
	allowedHosts: string[];
	port: number;
	password: string;
};

interface WebGatewayModule {
	loadWebConfig(agentDir: string): Promise<StoredWebConfig | undefined>;
	runWebGatewayCli(options: {
		defaultPort: number;
		defaultRuntimePort: number;
		staticDir: string;
		expectedProductVersion: string;
		runtimeInvocation: RuntimeInvocation;
		backgroundInvocation?: RuntimeInvocation;
	}): Promise<void>;
}

function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function modulePath(packageName: "web-gateway" | "web-runtime", fileName: string): string {
	return resolve(packageRoot(), "..", packageName, "dist", fileName);
}

function staticDir(): string {
	const root = packageRoot();
	const candidates = [join(root, "web"), resolve(root, "../web/dist")];
	return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? candidates[0];
}

function selfInvocation(args: string[]): RuntimeInvocation {
	const entrypoint = process.argv[1] ? resolve(process.argv[1]) : resolve(packageRoot(), "dist", "cli.js");
	const sourceArgs = entrypoint.endsWith(".ts") ? ["--import", import.meta.resolve("tsx"), entrypoint] : [entrypoint];
	return { command: process.execPath, args: [...sourceArgs, ...args], cwd: process.cwd() };
}

function sourceRuntimeInvocation(): RuntimeInvocation {
	return selfInvocation(["web-runtime", "serve"]);
}

function foregroundWebInvocation(): RuntimeInvocation {
	return selfInvocation(["web", "--foreground"]);
}

async function loadGatewayModule(): Promise<WebGatewayModule> {
	const path = modulePath("web-gateway", "index.js");
	if (!existsSync(path)) throw new Error(`Web Gateway 未构建：${path}`);
	return (await import(pathToFileURL(path).href)) as WebGatewayModule;
}

async function loadGatewayRunnerModule(): Promise<Pick<WebGatewayModule, "runWebGatewayCli">> {
	const path = modulePath("web-gateway", "runner.js");
	if (!existsSync(path)) throw new Error(`Web Gateway 未构建：${path}`);
	return (await import(pathToFileURL(path).href)) as Pick<WebGatewayModule, "runWebGatewayCli">;
}

async function loadRuntimeModule(): Promise<{ runWebRuntimeCli(args: readonly string[]): Promise<void> }> {
	const path = modulePath("web-runtime", "cli-runner.js");
	if (!existsSync(path)) throw new Error(`Web Runtime 未构建：${path}`);
	return (await import(pathToFileURL(path).href)) as { runWebRuntimeCli(args: readonly string[]): Promise<void> };
}

function urlHost(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function controlHosts(config: StoredWebConfig): string[] {
	const configuredHost = config.host === "0.0.0.0" || config.host === "::" ? undefined : config.host;
	const candidates = [
		configuredHost,
		...config.allowedHosts.filter((host) => host !== "*" && !host.startsWith("*.")),
		"127.0.0.1",
		"localhost",
		"::1",
	].filter((host): host is string => Boolean(host));
	return [...new Set(candidates)];
}

async function restartWebService(service: "gateway" | "runtime"): Promise<void> {
	const agentDir = getAgentDir();
	const gatewayModule = await loadGatewayModule();
	const config = await gatewayModule.loadWebConfig(agentDir);
	if (!config) throw new Error(`Web 尚未完成配置，请先运行 lc web。配置文件：${join(agentDir, "web-config.json")}`);
	let lastError: Error | undefined;
	for (const host of controlHosts(config)) {
		try {
			const response = await fetch(`http://${urlHost(host)}:${config.port}/api/diagnostics/actions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.password}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ action: `restart-${service}` }),
			});
			if (response.ok) {
				console.log(`${service === "gateway" ? "Gateway" : "Runtime"} 重启请求已发送。`);
				return;
			}
			const body = (await response.text()).trim();
			throw new Error(`Gateway 返回 HTTP ${response.status}${body ? `：${body}` : ""}`);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}
	throw new Error(
		`无法连接 Web Gateway，${service === "gateway" ? "不能重启 Gateway" : "不能重启 Runtime"}：${lastError?.message ?? "未知错误"}`,
	);
}

export async function runWebControlCommand(args: readonly string[]): Promise<void> {
	if (args.length !== 2 || (args[0] !== "gateway" && args[0] !== "runtime") || args[1] !== "restart") {
		throw new Error("用法：lc web\n      lc web gateway restart\n      lc web runtime restart");
	}
	await restartWebService(args[0]);
}

export async function runWebCommand(args: readonly string[] = []): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(
			"用法：lc web\n\n首次运行会依次配置监听 IP、白名单 IP、Web 端口、Runtime 端口和连接密码。\nWeb 默认端口：1420；Runtime 默认端口：1422。\n默认启动为后台模式；需要前台运行时使用：lc web --foreground。\n\n服务命令：\n  lc web gateway restart\n  lc web runtime restart\n",
		);
		return;
	}
	if (args.length > 0) {
		const foreground = args.includes("--foreground");
		const controlArgs = args.filter((arg) => arg !== "--foreground");
		if (foreground && controlArgs.length > 0) throw new Error("用法：lc web [--foreground]");
		if (!foreground && controlArgs.length > 0) {
			await runWebControlCommand(controlArgs);
			return;
		}
		if (foreground) {
			const { runWebGatewayCli } = await loadGatewayRunnerModule();
			await runWebGatewayCli({
				defaultPort: DEFAULT_WEB_PORT,
				defaultRuntimePort: DEFAULT_RUNTIME_PORT,
				staticDir: staticDir(),
				expectedProductVersion: VERSION,
				runtimeInvocation: sourceRuntimeInvocation(),
			});
			return;
		}
	}
	const { runWebGatewayCli } = await loadGatewayRunnerModule();
	await runWebGatewayCli({
		defaultPort: DEFAULT_WEB_PORT,
		defaultRuntimePort: DEFAULT_RUNTIME_PORT,
		staticDir: staticDir(),
		expectedProductVersion: VERSION,
		runtimeInvocation: sourceRuntimeInvocation(),
		backgroundInvocation: foregroundWebInvocation(),
	});
}

export async function runWebRuntimeCommand(args: readonly string[]): Promise<void> {
	const { runWebRuntimeCli } = await loadRuntimeModule();
	await runWebRuntimeCli(args);
}
