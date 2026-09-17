import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, VERSION } from "../config.ts";

const DEFAULT_WEB_PORT = 1420;
const DEFAULT_DEV_WEB_PORT = 2422;
const DEFAULT_DEV_FRONTEND_PORT = 2420;
const DEFAULT_RUNTIME_PORT = 1422;
const DEFAULT_DEV_RUNTIME_PORT = 2423;
const DEVELOPMENT_CLI_MODE = "development";
const DEV_WEB_CONFIG_FILE = "web-dev-config.json";

type RuntimeInvocation = { command: string; args: string[]; cwd: string };
type WebServiceAction = "install" | "start" | "stop" | "restart" | "reconcile" | "status" | "uninstall";
type WebComponentAction = "start" | "stop" | "restart" | "status";
type WebCommandName = "lc" | "lcd";
type WebCommandSettings = {
	commandName: WebCommandName;
	configFileName?: string;
	defaultPort: number;
	defaultRuntimePort: number;
};
interface WebGatewayModule {
	runWebComponentAction(options: {
		component: "gateway" | "runtime";
		action: WebComponentAction;
		force?: boolean;
		agentDir: string;
		configFileName?: string;
		defaultPort?: number;
		defaultRuntimePort?: number;
		staticDir?: string;
		gatewayInvocation: RuntimeInvocation;
		runtimeInvocation?: RuntimeInvocation;
		serviceVersion?: string;
		interactiveAdmin?: boolean;
	}): Promise<unknown>;
	runWebServiceAction(options: {
		action: WebServiceAction;
		agentDir: string;
		configFileName?: string;
		defaultPort?: number;
		defaultRuntimePort?: number;
		staticDir?: string;
		frontendInvocation?: RuntimeInvocation;
		frontendPort?: number;
		gatewayInvocation: RuntimeInvocation;
		runtimeInvocation?: RuntimeInvocation;
		serviceVersion?: string;
		previousServiceVersion?: string;
		interactiveAdmin?: boolean;
	}): Promise<unknown>;
	runMacosPermissionsCommand(options: {
		action: "status" | "setup";
		agentDir: string;
		onlyIfRequired?: boolean;
	}): Promise<unknown>;
	runWebGatewayCli(options: {
		defaultPort: number;
		defaultRuntimePort: number;
		staticDir: string;
		frontendInvocation?: RuntimeInvocation;
		frontendPort?: number;
		expectedProductVersion: string;
		runtimeInvocation: RuntimeInvocation;
		configFileName?: string;
		commandName?: "lc" | "lcd";
		backgroundInvocation?: RuntimeInvocation;
		serviceVersion?: string;
		skipWebAssetVerification?: boolean;
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

function developmentFrontendInvocation(settings: WebCommandSettings): RuntimeInvocation | undefined {
	if (settings.commandName !== "lcd") return undefined;
	return {
		command: join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm"),
		args: ["run", "dev", "--workspace=@lystar/code-web"],
		cwd: resolve(packageRoot(), "../.."),
	};
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

async function runWebComponentCommand(
	component: "gateway" | "runtime",
	action: WebComponentAction,
	force: boolean,
	gatewayModule?: Pick<WebGatewayModule, "runWebComponentAction">,
): Promise<void> {
	const settings = webCommandSettings();
	const module = gatewayModule ?? (await loadGatewayModule());
	const gatewayInvocation = foregroundWebInvocation();
	const runtimeInvocation = sourceRuntimeInvocation();
	const stableLauncher = stableLauncherPath();
	const serviceVersion =
		settings.commandName === "lc" &&
		gatewayInvocation.command === stableLauncher &&
		runtimeInvocation.command === stableLauncher
			? VERSION
			: undefined;
	const result = await module.runWebComponentAction({
		component,
		action,
		...(force ? { force: true } : {}),
		agentDir: getAgentDir(),
		configFileName: settings.configFileName,
		defaultPort: settings.defaultPort,
		defaultRuntimePort: settings.defaultRuntimePort,
		staticDir: staticDir(),
		gatewayInvocation,
		runtimeInvocation,
		...(serviceVersion ? { serviceVersion } : {}),
		interactiveAdmin: Boolean(process.stdin.isTTY && process.stdout.isTTY),
	});
	if (action === "status") {
		console.log(JSON.stringify(result, null, "\t"));
		return;
	}
	const label = component === "gateway" ? "Gateway" : "Runtime";
	console.log(`${label}${action === "stop" ? "已停止" : action === "start" ? "已启动" : "已重启"}。`);
}

interface WebServiceCommandOptions {
	gatewayModule?: Pick<WebGatewayModule, "runWebServiceAction">;
	permissionsGatewayModule?: Pick<WebGatewayModule, "runMacosPermissionsCommand">;
	frontendInvocation?: RuntimeInvocation;
	frontendPort?: number;
	gatewayInvocation?: RuntimeInvocation;
	runtimeInvocation?: RuntimeInvocation;
	serviceVersion?: string;
	previousServiceVersion?: string;
}

type WebServiceCommandDependencies = Omit<WebServiceCommandOptions, "serviceVersion" | "previousServiceVersion">;

async function runPostServiceMacosPermissions(
	gatewayModule?: Pick<WebGatewayModule, "runMacosPermissionsCommand">,
): Promise<void> {
	try {
		await runWebPermissionsCommand(["setup", "--if-required"], gatewayModule);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`Web 服务已经完成安装或升级；macOS 系统授权没有完成，不影响当前版本继续运行。请回到 Mac 本机后执行 lc web permissions setup。原因：${message}`,
		);
	}
}

export async function runWebServiceCommand(
	args: readonly string[],
	options: WebServiceCommandOptions = {},
): Promise<unknown> {
	const settings = webCommandSettings();
	const action = args[0] as WebServiceAction | undefined;
	const flags = new Set(args.slice(1));
	const interactive = !flags.has("--non-interactive") && Boolean(process.stdin.isTTY && process.stdout.isTTY);
	if (!action || !["install", "start", "stop", "restart", "reconcile", "status", "uninstall"].includes(action)) {
		throw new Error(
			`用法：${settings.commandName} web service <install|start|stop|restart|reconcile|status|uninstall>`,
		);
	}
	if ([...flags].some((flag) => !["--upgrade", "--non-interactive"].includes(flag))) {
		throw new Error(`用法：${settings.commandName} web service ${action} [--upgrade] [--non-interactive]`);
	}
	const module = options.gatewayModule ?? (await loadGatewayModule());
	const frontendInvocation = options.frontendInvocation ?? developmentFrontendInvocation(settings);
	const frontendPort = options.frontendPort ?? (frontendInvocation ? DEFAULT_DEV_FRONTEND_PORT : undefined);
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
		...(frontendInvocation ? { frontendInvocation } : {}),
		...(frontendPort !== undefined ? { frontendPort } : {}),
		gatewayInvocation,
		runtimeInvocation,
		...(serviceVersion ? { serviceVersion } : {}),
		...(previousServiceVersion ? { previousServiceVersion } : {}),
		interactiveAdmin: interactive,
	});
	if (action === "status") {
		console.log(JSON.stringify(result, null, "\t"));
	} else if (action === "uninstall") {
		console.log(
			frontendInvocation
				? "开发 Web 前端、Gateway 和 Runtime 服务已卸载。"
				: "Web Gateway 和 Web Runtime 服务已卸载。",
		);
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
			const serviceLabel = frontendInvocation
				? "开发 Web 前端、Gateway 和 Runtime 服务"
				: "Web Gateway 和 Web Runtime 服务";
			console.log(`${serviceLabel}${action === "stop" ? "已停止" : "已启动"}。`);
			if (process.platform === "darwin" && interactive && (action === "install" || action === "reconcile")) {
				await runPostServiceMacosPermissions(options.permissionsGatewayModule);
			}
		}
	}
	return result;
}

function completedServiceVersion(result: unknown): string | undefined {
	if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
	const value = (result as { serviceVersion?: unknown; recovered?: unknown }).serviceVersion;
	return (result as { recovered?: unknown }).recovered === undefined && typeof value === "string" ? value : undefined;
}

function updateReconcileError(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

async function waitForUpdateReconcileRetry(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 1_000));
}

export async function reconcileWebServicesAfterUpdate(
	targetVersion: string,
	previousServiceVersion = VERSION,
	options: WebServiceCommandDependencies = {},
): Promise<void> {
	const settings = webCommandSettings();
	const agentDir = getAgentDir();
	const candidates = [
		join(agentDir, settings.configFileName ?? "web-config.json"),
		join(agentDir, "web", "gateway.json"),
		join(agentDir, "web", "service-state.json"),
	];
	if (!candidates.some((path) => existsSync(path))) return;
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const args = ["reconcile", "--upgrade", ...(interactive ? [] : ["--non-interactive"])] as const;
	const commandOptions: WebServiceCommandOptions = {
		...options,
		serviceVersion: targetVersion,
		previousServiceVersion,
	};
	let firstFailure: string | undefined;
	try {
		const result = await runWebServiceCommand(args, commandOptions);
		if (completedServiceVersion(result) === targetVersion) return;
		firstFailure = `服务仍为 ${completedServiceVersion(result) ?? "未知版本"}`;
	} catch (error) {
		firstFailure = updateReconcileError(error);
	}
	console.warn(`Web 服务首次切换到 ${targetVersion} 没有完成，1秒后自动重试。原因：${firstFailure}`);
	await waitForUpdateReconcileRetry();
	try {
		const result = await runWebServiceCommand(args, commandOptions);
		const actualVersion = completedServiceVersion(result);
		if (actualVersion === targetVersion) return;
		throw new Error(`重试后服务仍为 ${actualVersion ?? "未知版本"}`);
	} catch (error) {
		throw new Error(
			`应用已经更新到 ${targetVersion}，但 Web Gateway 和 Runtime 自动切换失败。首次结果：${firstFailure}；重试结果：${updateReconcileError(error)}`,
			{ cause: error },
		);
	}
}

export async function runWebPermissionsCommand(
	args: readonly string[],
	gatewayModule?: Pick<WebGatewayModule, "runMacosPermissionsCommand">,
): Promise<void> {
	const action = args[0] as "status" | "setup" | undefined;
	const onlyIfRequired = action === "setup" && args[1] === "--if-required" && args.length === 2;
	if (!action || !["status", "setup"].includes(action) || (!onlyIfRequired && args.length !== 1)) {
		throw new Error("用法：lc web permissions <status|setup [--if-required]>");
	}
	const module = gatewayModule ?? (await loadGatewayModule());
	const result = await module.runMacosPermissionsCommand({
		action,
		agentDir: getAgentDir(),
		...(onlyIfRequired ? { onlyIfRequired: true } : {}),
	});
	console.log(JSON.stringify(result, null, "\t"));
}

export async function runWebControlCommand(
	args: readonly string[],
	options: { gatewayModule?: Pick<WebGatewayModule, "runWebComponentAction"> } = {},
): Promise<void> {
	const settings = webCommandSettings();
	const component = args[0];
	const action = args[1] as WebComponentAction | undefined;
	const force = args[2] === "--force";
	if (
		(component !== "gateway" && component !== "runtime") ||
		!action ||
		!["status", "stop", "start", "restart"].includes(action) ||
		args.length > (force ? 3 : 2) ||
		(args.length === 3 && !force) ||
		(force && action !== "stop" && action !== "restart")
	) {
		throw new Error(`用法：${settings.commandName} web <gateway|runtime> <status|stop|start|restart> [--force]`);
	}
	await runWebComponentCommand(component, action, force, options.gatewayModule);
}

export async function runWebCommand(args: readonly string[] = []): Promise<void> {
	const settings = webCommandSettings();
	if (args.includes("--help") || args.includes("-h")) {
		const development = settings.commandName === "lcd";
		const developmentFrontend = development
			? `\n开发前端（Vite HMR）：http://127.0.0.1:${DEFAULT_DEV_FRONTEND_PORT}。Gateway 端口：${settings.defaultPort}。`
			: "";
		const launchMode = development
			? `${settings.commandName} web 会启动并托管 Vite HMR 前端、Gateway 和 Runtime。`
			: `默认启动为后台模式；需要前台运行时使用：${settings.commandName} web --foreground。`;
		console.log(
			`用法：${settings.commandName} web\n\n首次运行会依次配置监听 IP、白名单 IP、Web 端口、Runtime 端口和连接密码。\nWeb 默认端口：${settings.defaultPort}；Runtime 默认端口：${settings.defaultRuntimePort}。${developmentFrontend}\n配置文件：${settings.configFileName ?? "web-config.json"}。\n${launchMode}\n\n组件命令：\n  ${settings.commandName} web gateway status|stop|start|restart\n  ${settings.commandName} web runtime status|stop|start|restart\n\n服务命令：\n  ${settings.commandName} web service install\n  ${settings.commandName} web service status\n  ${settings.commandName} web service restart\n  ${settings.commandName} web service uninstall\n\nmacOS 授权：\n  ${settings.commandName} web permissions status\n  ${settings.commandName} web permissions setup\n`,
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
			} else if (controlArgs[0] === "permissions") {
				await runWebPermissionsCommand(controlArgs.slice(1));
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
				skipWebAssetVerification: settings.commandName === "lcd",
			});
			return;
		}
	}
	const { runWebGatewayCli } = await loadGatewayRunnerModule();
	const frontendInvocation = developmentFrontendInvocation(settings);
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
		...(frontendInvocation ? { frontendInvocation, frontendPort: DEFAULT_DEV_FRONTEND_PORT } : {}),
		expectedProductVersion: VERSION,
		runtimeInvocation,
		configFileName: settings.configFileName,
		commandName: settings.commandName,
		skipWebAssetVerification: settings.commandName === "lcd",
		backgroundInvocation: gatewayInvocation,
		...(serviceVersion ? { serviceVersion } : {}),
	});
	if (process.platform === "darwin" && process.stdin.isTTY && process.stdout.isTTY) {
		await runPostServiceMacosPermissions();
	}
}

export async function runWebRuntimeCommand(args: readonly string[]): Promise<void> {
	const { runWebRuntimeCli } = await loadRuntimeModule();
	await runWebRuntimeCli(args);
}
