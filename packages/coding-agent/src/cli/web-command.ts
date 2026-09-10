import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, VERSION } from "../config.ts";

const DEFAULT_WEB_PORT = 1420;
const DEFAULT_DEV_WEB_PORT = 2422;
const DEFAULT_RUNTIME_PORT = 1422;
const DEFAULT_DEV_RUNTIME_PORT = 2423;
const DEVELOPMENT_CLI_MODE = "development";
const DEV_WEB_CONFIG_FILE = "web-dev-config.json";

type RuntimeInvocation = { command: string; args: string[]; cwd: string };
type WebServiceAction = "install" | "start" | "stop" | "restart" | "reconcile" | "status" | "uninstall";
type WebCommandName = "lc" | "lcd";
type WebCommandSettings = {
	commandName: WebCommandName;
	configFileName?: string;
	defaultPort: number;
	defaultRuntimePort: number;
};
type StoredWebConfig = {
	host: string;
	allowedHosts: string[];
	port: number;
	password: string;
};

interface WebGatewayModule {
	loadWebConfig(agentDir: string, configFileName?: string): Promise<StoredWebConfig | undefined>;
	runWebServiceAction(options: {
		action: WebServiceAction;
		agentDir: string;
		configFileName?: string;
		defaultPort?: number;
		defaultRuntimePort?: number;
		staticDir?: string;
		gatewayInvocation: RuntimeInvocation;
		runtimeInvocation?: RuntimeInvocation;
		serviceVersion?: string;
		previousServiceVersion?: string;
		interactiveAdmin?: boolean;
	}): Promise<unknown>;
	runWebGatewayCli(options: {
		defaultPort: number;
		defaultRuntimePort: number;
		staticDir: string;
		expectedProductVersion: string;
		runtimeInvocation: RuntimeInvocation;
		configFileName?: string;
		commandName?: "lc" | "lcd";
		backgroundInvocation?: RuntimeInvocation;
		serviceVersion?: string;
	}): Promise<void>;
}

function webCommandSettings(): WebCommandSettings {
	const development = process.env.LYSTAR_CLI_MODE === DEVELOPMENT_CLI_MODE;
	return {
		commandName: development ? "lcd" : "lc",
		defaultPort: development ? DEFAULT_DEV_WEB_PORT : DEFAULT_WEB_PORT,
		defaultRuntimePort: development ? DEFAULT_DEV_RUNTIME_PORT : DEFAULT_RUNTIME_PORT,
		...(development ? { configFileName: DEV_WEB_CONFIG_FILE } : {}),
	};
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
	if (process.versions.bun) {
		const sourceArgs = entrypoint.endsWith(".mjs") ? [entrypoint] : [];
		return { command: process.execPath, args: [...sourceArgs, ...args], cwd: process.cwd() };
	}
	const sourceArgs = entrypoint.endsWith(".ts") ? ["--import", import.meta.resolve("tsx"), entrypoint] : [entrypoint];
	return { command: process.execPath, args: [...sourceArgs, ...args], cwd: process.cwd() };
}

function stableLauncherPath(): string {
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "LYStarAgent", "bin", "lc.cmd");
	}
	return join(homedir(), ".local", "bin", "lc");
}

function stableLauncherInvocation(args: string[]): RuntimeInvocation | undefined {
	if (process.env.LYSTAR_CLI_MODE === DEVELOPMENT_CLI_MODE) return undefined;
	const launcher = stableLauncherPath();
	return existsSync(launcher) ? { command: launcher, args, cwd: getAgentDir() } : undefined;
}

export function sourceRuntimeInvocation(): RuntimeInvocation {
	return stableLauncherInvocation(["web-runtime", "serve"]) ?? selfInvocation(["web-runtime", "serve"]);
}

export function foregroundWebInvocation(): RuntimeInvocation {
	return stableLauncherInvocation(["web", "--foreground"]) ?? selfInvocation(["web", "--foreground"]);
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

async function restartWebService(
	service: "gateway" | "runtime",
	gatewayModule?: Pick<WebGatewayModule, "loadWebConfig">,
): Promise<void> {
	const settings = webCommandSettings();
	const agentDir = getAgentDir();
	const module = gatewayModule ?? (await loadGatewayModule());
	const config = await module.loadWebConfig(agentDir, settings.configFileName);
	if (!config)
		throw new Error(
			`Web 尚未完成配置，请先运行 ${settings.commandName} web。配置文件：${join(agentDir, settings.configFileName ?? "web-config.json")}`,
		);
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

export async function runWebServiceCommand(
	args: readonly string[],
	options: {
		gatewayModule?: Pick<WebGatewayModule, "runWebServiceAction">;
		gatewayInvocation?: RuntimeInvocation;
		runtimeInvocation?: RuntimeInvocation;
		serviceVersion?: string;
		previousServiceVersion?: string;
	} = {},
): Promise<void> {
	const settings = webCommandSettings();
	const action = args[0] as WebServiceAction | undefined;
	const flags = new Set(args.slice(1));
	if (!action || !["install", "start", "stop", "restart", "reconcile", "status", "uninstall"].includes(action)) {
		throw new Error(
			`用法：${settings.commandName} web service <install|start|stop|restart|reconcile|status|uninstall>`,
		);
	}
	if ([...flags].some((flag) => !["--upgrade", "--non-interactive"].includes(flag))) {
		throw new Error(`用法：${settings.commandName} web service ${action} [--upgrade] [--non-interactive]`);
	}
	const module = options.gatewayModule ?? (await loadGatewayModule());
	const gatewayInvocation = options.gatewayInvocation ?? foregroundWebInvocation();
	const runtimeInvocation = options.runtimeInvocation ?? sourceRuntimeInvocation();
	const stableLauncher = stableLauncherPath();
	const usesVersionedLauncher =
		settings.commandName === "lc" &&
		gatewayInvocation.command === stableLauncher &&
		runtimeInvocation.command === stableLauncher;
	const serviceVersion = usesVersionedLauncher
		? (options.serviceVersion ?? process.env.LYSTAR_WEB_SERVICE_TARGET_VERSION?.trim() ?? VERSION)
		: undefined;
	const previousServiceVersion = usesVersionedLauncher
		? (options.previousServiceVersion ?? process.env.LYSTAR_WEB_PREVIOUS_SERVICE_VERSION?.trim())
		: undefined;
	const result = await module.runWebServiceAction({
		action,
		agentDir: getAgentDir(),
		configFileName: settings.configFileName,
		defaultPort: settings.defaultPort,
		defaultRuntimePort: settings.defaultRuntimePort,
		staticDir: staticDir(),
		gatewayInvocation,
		runtimeInvocation,
		...(serviceVersion ? { serviceVersion } : {}),
		...(previousServiceVersion ? { previousServiceVersion } : {}),
		interactiveAdmin: !flags.has("--non-interactive") && Boolean(process.stdin.isTTY && process.stdout.isTTY),
	});
	if (action === "status") {
		console.log(JSON.stringify(result, null, "\t"));
	} else if (action === "uninstall") {
		console.log("Web Gateway 和 Web Runtime 服务已卸载。");
	} else {
		const recovered = (
			result as {
				recovered?: { targetVersion: string; serviceVersion: string; reason: string };
			}
		).recovered;
		if (recovered) {
			console.warn(
				`Web 服务版本 ${recovered.targetVersion} 启动失败，已恢复服务版本 ${recovered.serviceVersion}。LYStar Code 应用版本保持不变。原因：${recovered.reason}`,
			);
		} else {
			console.log(`Web Gateway 和 Web Runtime 服务${action === "stop" ? "已停止" : "已启动"}。`);
		}
	}
}

export async function reconcileWebServicesAfterUpdate(): Promise<void> {
	const settings = webCommandSettings();
	const agentDir = getAgentDir();
	const candidates = [
		join(agentDir, settings.configFileName ?? "web-config.json"),
		join(agentDir, "web", "gateway.json"),
		join(agentDir, "web", "service-state.json"),
	];
	if (!candidates.some((path) => existsSync(path))) return;
	await runWebServiceCommand(["reconcile", "--upgrade", "--non-interactive"]);
}

export async function runWebControlCommand(
	args: readonly string[],
	options: { gatewayModule?: Pick<WebGatewayModule, "loadWebConfig"> } = {},
): Promise<void> {
	const settings = webCommandSettings();
	if (args.length !== 2 || (args[0] !== "gateway" && args[0] !== "runtime") || args[1] !== "restart") {
		throw new Error(
			`用法：${settings.commandName} web\n      ${settings.commandName} web gateway restart\n      ${settings.commandName} web runtime restart`,
		);
	}
	await restartWebService(args[0], options.gatewayModule);
}

export async function runWebCommand(args: readonly string[] = []): Promise<void> {
	const settings = webCommandSettings();
	if (args.includes("--help") || args.includes("-h")) {
		console.log(
			`用法：${settings.commandName} web\n\n首次运行会依次配置监听 IP、白名单 IP、Web 端口、Runtime 端口和连接密码。\nWeb 默认端口：${settings.defaultPort}；Runtime 默认端口：${settings.defaultRuntimePort}。\n配置文件：${settings.configFileName ?? "web-config.json"}。\n默认启动为后台模式；需要前台运行时使用：${settings.commandName} web --foreground。\n\n服务命令：\n  ${settings.commandName} web gateway restart\n  ${settings.commandName} web runtime restart\n  ${settings.commandName} web service install\n  ${settings.commandName} web service status\n  ${settings.commandName} web service restart\n  ${settings.commandName} web service uninstall\n`,
		);
		return;
	}
	if (args.length > 0) {
		const foreground = args.includes("--foreground");
		const controlArgs = args.filter((arg) => arg !== "--foreground");
		if (foreground && controlArgs.length > 0) throw new Error(`用法：${settings.commandName} web [--foreground]`);
		if (!foreground && controlArgs.length > 0) {
			if (controlArgs[0] === "service") {
				await runWebServiceCommand(controlArgs.slice(1));
			} else {
				await runWebControlCommand(controlArgs);
			}
			return;
		}
		if (foreground) {
			const { runWebGatewayCli } = await loadGatewayRunnerModule();
			await runWebGatewayCli({
				defaultPort: settings.defaultPort,
				defaultRuntimePort: settings.defaultRuntimePort,
				staticDir: staticDir(),
				expectedProductVersion: VERSION,
				runtimeInvocation: sourceRuntimeInvocation(),
				configFileName: settings.configFileName,
				commandName: settings.commandName,
			});
			return;
		}
	}
	const { runWebGatewayCli } = await loadGatewayRunnerModule();
	const gatewayInvocation = foregroundWebInvocation();
	const runtimeInvocation = sourceRuntimeInvocation();
	const stableLauncher = stableLauncherPath();
	const serviceVersion =
		gatewayInvocation.command === stableLauncher && runtimeInvocation.command === stableLauncher
			? VERSION
			: undefined;
	await runWebGatewayCli({
		defaultPort: settings.defaultPort,
		defaultRuntimePort: settings.defaultRuntimePort,
		staticDir: staticDir(),
		expectedProductVersion: VERSION,
		runtimeInvocation,
		configFileName: settings.configFileName,
		commandName: settings.commandName,
		backgroundInvocation: gatewayInvocation,
		...(serviceVersion ? { serviceVersion } : {}),
	});
}

export async function runWebRuntimeCommand(args: readonly string[]): Promise<void> {
	const { runWebRuntimeCli } = await loadRuntimeModule();
	await runWebRuntimeCli(args);
}
