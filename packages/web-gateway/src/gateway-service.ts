import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	assertRuntimeIdle,
	captureUserCommandEnvironment,
	createRuntimeServiceSpec,
	defaultRuntimeEndpoint,
	ensureRuntimeService,
	ensureWebService,
	getRuntimeServiceStatus,
	getWebServiceStatus,
	installRuntimeService,
	installWebService,
	type RuntimeServiceStatus,
	removeWebService,
	restartRuntimeService,
	runtimeTcpEndpoint,
	stopRuntimeService,
	stopWebService,
	type WebServiceInvocation,
	type WebServiceSpec,
	type WebServiceStatus,
} from "@lystar/code-web-runtime";
import {
	DEFAULT_RUNTIME_HOST,
	DEFAULT_RUNTIME_PORT,
	DEFAULT_WEB_GATEWAY_PORT,
	DEFAULT_WEB_HOST,
	defaultAllowedHosts,
	defaultWebStaticDir,
	loadWebConfig,
	loadWebGatewayConfig,
	type RuntimeInvocation,
	type WebGatewayConfig,
} from "./config.ts";
import { readGatewayPid } from "./instance-lock.ts";
import {
	getMacosPermissionsStatus,
	type MacosPermissionsStatus,
	removeMacosWebAdminAuthorization,
	runMacosPermissionsSetup,
} from "./macos-permissions.ts";
import { requiresServiceVersionReconcile, runServiceVersionTransaction } from "./service-version-transaction.ts";

const SERVICE_STATE_VERSION = 1 as const;
const DEFAULT_PROFILE = "default";

interface WebServiceState {
	version: typeof SERVICE_STATE_VERSION;
	enabled: true;
	profile: string;
	configFileName?: string;
	serviceVersion?: string;
	host: string;
	port: number;
	runtimePort: number;
	runtimeEndpoint: string;
	updatedAt: number;
}

export interface WebServiceLaunchOptions {
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
}

export interface WebServicesStatus {
	enabled: boolean;
	profile: string;
	serviceVersion?: string;
	recovered?: {
		targetVersion: string;
		serviceVersion: string;
		reason: string;
	};
	gateway: WebServiceStatus;
	runtime: RuntimeServiceStatus;
}

export type WebServiceAction = "install" | "start" | "stop" | "restart" | "reconcile" | "status" | "uninstall";
export type WebComponent = "gateway" | "runtime";
export type WebComponentAction = "start" | "stop" | "restart" | "status";

export interface WebServiceActionOptions extends WebServiceLaunchOptions {
	action: WebServiceAction;
}

export interface WebComponentActionOptions extends WebServiceLaunchOptions {
	component: WebComponent;
	action: WebComponentAction;
	force?: boolean;
}

export async function runMacosPermissionsCommand(options: {
	action: "status" | "setup";
	agentDir: string;
}): Promise<MacosPermissionsStatus> {
	return options.action === "setup"
		? runMacosPermissionsSetup(options.agentDir)
		: getMacosPermissionsStatus(options.agentDir);
}

function profileFor(configFileName: string | undefined): string {
	return configFileName ? "development" : DEFAULT_PROFILE;
}

function runtimeProfileFor(config: WebGatewayConfig): string | undefined {
	return config.serviceProfile;
}

function serviceEnvironment(
	config: WebGatewayConfig,
	configFileName: string | undefined,
	serviceVersion: string | undefined,
): Record<string, string | undefined> {
	return {
		...captureUserCommandEnvironment(),
		PI_CODING_AGENT_DIR: config.agentDir,
		PI_WEB_SERVICE_PROFILE: profileFor(configFileName),
		...(configFileName ? { LYSTAR_CLI_MODE: "development" } : {}),
		...(serviceVersion ? { LYSTAR_WEB_SERVICE_VERSION: serviceVersion } : {}),
		PI_WEB_RUNTIME_ENDPOINT: config.runtimeEndpoint,
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		APPDATA: process.env.APPDATA,
		LOCALAPPDATA: process.env.LOCALAPPDATA,
	};
}

function serviceInvocation(invocation: RuntimeInvocation | undefined): WebServiceInvocation | undefined {
	return invocation ? { program: invocation.command, args: invocation.args, cwd: invocation.cwd } : undefined;
}

function fallbackGatewayConfig(options: WebServiceLaunchOptions): WebGatewayConfig {
	const development = Boolean(options.configFileName);
	const runtimePort = options.defaultRuntimePort ?? DEFAULT_RUNTIME_PORT;
	return {
		host: DEFAULT_WEB_HOST,
		port: options.defaultPort ?? DEFAULT_WEB_GATEWAY_PORT,
		agentDir: options.agentDir,
		...(development ? { serviceProfile: "development" } : {}),
		runtimeEndpoint: options.runtimeInvocation
			? runtimeTcpEndpoint(DEFAULT_RUNTIME_HOST, runtimePort)
			: defaultRuntimeEndpoint(options.agentDir),
		runtimePort,
		token: "",
		allowedHosts: defaultAllowedHosts(DEFAULT_WEB_HOST),
		staticDir: options.staticDir ?? defaultWebStaticDir(),
		manageRuntime: true,
	};
}

function serviceLogPath(agentDir: string, kind: "gateway" | "runtime", profile: string): string {
	return join(agentDir, "web", `${kind}${profile === DEFAULT_PROFILE ? "" : `-${profile}`}.log`);
}

function gatewaySpec(config: WebGatewayConfig, options: WebServiceLaunchOptions): WebServiceSpec {
	const profile = profileFor(options.configFileName);
	return {
		kind: "gateway",
		profile,
		agentDir: config.agentDir,
		invocation: { ...serviceInvocation(options.gatewayInvocation)!, cwd: config.agentDir },
		environment: serviceEnvironment(config, options.configFileName, options.serviceVersion),
		logPath: serviceLogPath(config.agentDir, "gateway", profile),
	};
}

function runtimeSpec(config: WebGatewayConfig, options: WebServiceLaunchOptions): WebServiceSpec {
	return createRuntimeServiceSpec(config.runtimeEndpoint, {
		profile: runtimeProfileFor(config),
		agentDir: config.agentDir,
		environment: serviceEnvironment(config, options.configFileName, options.serviceVersion),
		...(options.runtimeInvocation ? { invocation: serviceInvocation(options.runtimeInvocation) } : {}),
	});
}

function statePath(agentDir: string, configFileName?: string): string {
	const profile = profileFor(configFileName);
	return join(agentDir, "web", `service-state${profile === DEFAULT_PROFILE ? "" : `-${profile}`}.json`);
}

function readState(agentDir: string, configFileName: string | undefined): WebServiceState | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(statePath(agentDir, configFileName), "utf8"));
		if (!value || typeof value !== "object") return undefined;
		const state = value as Partial<WebServiceState>;
		const port = typeof state.port === "number" ? state.port : undefined;
		const runtimePort = typeof state.runtimePort === "number" ? state.runtimePort : undefined;
		if (
			state.version !== SERVICE_STATE_VERSION ||
			state.enabled !== true ||
			typeof state.profile !== "string" ||
			typeof state.host !== "string" ||
			port === undefined ||
			!Number.isInteger(port) ||
			runtimePort === undefined ||
			!Number.isInteger(runtimePort) ||
			typeof state.runtimeEndpoint !== "string"
		)
			return undefined;
		if (state.configFileName !== configFileName) return undefined;
		return {
			version: SERVICE_STATE_VERSION,
			enabled: true,
			profile: state.profile,
			...(state.configFileName ? { configFileName: state.configFileName } : {}),
			...(typeof state.serviceVersion === "string" ? { serviceVersion: state.serviceVersion } : {}),
			host: state.host,
			port,
			runtimePort,
			runtimeEndpoint: state.runtimeEndpoint,
			updatedAt: typeof state.updatedAt === "number" ? state.updatedAt : 0,
		};
	} catch {
		return undefined;
	}
}

function writeState(config: WebGatewayConfig, options: WebServiceLaunchOptions): void {
	const path = statePath(config.agentDir, options.configFileName);
	mkdirSync(join(config.agentDir, "web"), { recursive: true, mode: 0o700 });
	const state: WebServiceState = {
		version: SERVICE_STATE_VERSION,
		enabled: true,
		profile: profileFor(options.configFileName),
		...(options.configFileName ? { configFileName: options.configFileName } : {}),
		...(options.serviceVersion ? { serviceVersion: options.serviceVersion } : {}),
		host: config.host,
		port: config.port,
		runtimePort: config.runtimePort ?? DEFAULT_RUNTIME_PORT,
		runtimeEndpoint: config.runtimeEndpoint,
		updatedAt: Date.now(),
	};
	const temporaryPath = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(state, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function stateConfig(state: WebServiceState, options: WebServiceLaunchOptions): WebGatewayConfig {
	return {
		host: state.host,
		port: state.port,
		agentDir: options.agentDir,
		serviceProfile: profileFor(options.configFileName),
		runtimeEndpoint: state.runtimeEndpoint,
		runtimePort: state.runtimePort,
		token: "",
		configPath: join(options.agentDir, options.configFileName ?? "web-config.json"),
		allowedHosts: defaultAllowedHosts(state.host),
		staticDir: options.staticDir ?? defaultWebStaticDir(),
		manageRuntime: true,
	};
}

async function loadConfiguredGateway(options: WebServiceLaunchOptions): Promise<WebGatewayConfig | undefined> {
	const stored = await loadWebConfig(options.agentDir, options.configFileName);
	if (!stored) return undefined;
	return loadWebGatewayConfig({
		agentDir: options.agentDir,
		defaultPort: options.defaultPort ?? DEFAULT_WEB_GATEWAY_PORT,
		defaultRuntimePort: options.defaultRuntimePort ?? DEFAULT_RUNTIME_PORT,
		staticDir: options.staticDir,
		runtimeInvocation: options.runtimeInvocation,
		configFileName: options.configFileName,
	});
}

async function waitForGatewayExit(agentDir: string, profile: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!readGatewayPid(agentDir, profile)) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Web Gateway服务停止超时");
}

async function waitForGatewayReady(config: WebGatewayConfig, timeoutMs = 10_000): Promise<void> {
	const address = config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "::1" : config.host;
	const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
	const deadline = Date.now() + timeoutMs;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://${host}:${config.port}/healthz`, {
				signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
			});
			if (response.ok) {
				const health = (await response.json()) as { ok?: boolean; host?: string };
				if (health.ok === true && health.host === "connected") return;
				lastError = "Gateway 尚未连接 Runtime";
			} else {
				lastError = `HTTP ${response.status}`;
			}
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Web Gateway服务启动超时${lastError ? `：${lastError}` : ""}`);
}

async function stopDetachedGateway(agentDir: string, profile: string): Promise<void> {
	const pid = readGatewayPid(agentDir, profile);
	if (!pid) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await waitForGatewayExit(agentDir, profile);
}

export async function getWebServicesStatus(options: WebServiceLaunchOptions): Promise<WebServicesStatus> {
	const configured = await loadConfiguredGateway(options);
	const state = readState(options.agentDir, options.configFileName);
	const fallbackConfig = configured ?? (state ? stateConfig(state, options) : fallbackGatewayConfig(options));
	const gateway = gatewaySpec(fallbackConfig, options);
	const runtimeInvocation = serviceInvocation(options.runtimeInvocation);
	const [gatewayStatus, runtimeStatus] = await Promise.all([
		getWebServiceStatus(gateway),
		getRuntimeServiceStatus(
			fallbackConfig.runtimeEndpoint,
			runtimeProfileFor(fallbackConfig),
			runtimeInvocation,
			fallbackConfig.agentDir,
		),
	]);
	const profile = profileFor(options.configFileName);
	const gatewayPid = readGatewayPid(options.agentDir, profile);
	return {
		enabled: Boolean(
			configured ||
				state ||
				gatewayStatus.installed ||
				gatewayPid ||
				(fallbackConfig.manageRuntime && runtimeStatus.installed),
		),
		profile,
		...(state?.serviceVersion ? { serviceVersion: state.serviceVersion } : {}),
		gateway: {
			...gatewayStatus,
			...(gatewayPid ? { pid: gatewayPid } : {}),
		},
		runtime: runtimeStatus,
	};
}

async function applyWebServices(
	config: WebGatewayConfig,
	options: WebServiceLaunchOptions,
	reinstall: boolean,
): Promise<void> {
	const gateway = gatewaySpec(config, options);
	const gatewayStatus = getWebServiceStatus(gateway);
	const runtimeInvocation = serviceInvocation(options.runtimeInvocation);
	const runtimeStatus = await getRuntimeServiceStatus(
		config.runtimeEndpoint,
		runtimeProfileFor(config),
		runtimeInvocation,
		config.agentDir,
	);
	const profile = profileFor(options.configFileName);
	if (reinstall) {
		if (config.manageRuntime) await assertRuntimeIdle(config.runtimeEndpoint);
		// 先停止接收新请求，避免旧 Gateway 在版本切换期间拉起旧 Runtime。
		stopWebService(gateway, false, {
			detachedPid: readGatewayPid(config.agentDir, profile),
			interactiveAdmin: options.interactiveAdmin ?? false,
		});
		try {
			await waitForGatewayExit(config.agentDir, profile);
		} catch {
			stopWebService(gateway, true, {
				detachedPid: readGatewayPid(config.agentDir, profile),
				interactiveAdmin: options.interactiveAdmin ?? false,
			});
			await waitForGatewayExit(config.agentDir, profile);
		}
	}
	if (config.manageRuntime) {
		if (!runtimeStatus.installed && (runtimeStatus.manager === "detached" || runtimeStatus.reachable)) {
			await stopRuntimeService(
				config.runtimeEndpoint,
				false,
				runtimeProfileFor(config),
				runtimeInvocation,
				options.interactiveAdmin ?? false,
				config.agentDir,
			);
		}
		if (reinstall || !runtimeStatus.installed) {
			await installRuntimeService(config.runtimeEndpoint, options.interactiveAdmin ?? false, {
				profile: runtimeProfileFor(config),
				invocation: runtimeInvocation,
				agentDir: config.agentDir,
				environment: serviceEnvironment(config, options.configFileName, options.serviceVersion),
			});
		} else {
			await ensureRuntimeService(
				config.runtimeEndpoint,
				runtimeProfileFor(config),
				runtimeInvocation,
				options.interactiveAdmin ?? false,
				config.agentDir,
			);
		}
	} else if (!runtimeStatus.responsive) {
		throw new Error(`Web Runtime 未运行或无响应：${config.runtimeEndpoint}`);
	}
	if (!gatewayStatus.installed && gatewayStatus.manager === "detached")
		await stopDetachedGateway(config.agentDir, profile);
	if (reinstall || !gatewayStatus.installed) {
		installWebService(gateway, { interactiveAdmin: options.interactiveAdmin ?? false });
	} else {
		ensureWebService(gateway, { interactiveAdmin: options.interactiveAdmin ?? false });
	}
	await waitForGatewayReady(config);
}

export async function ensureWebServices(options: WebServiceLaunchOptions): Promise<WebServicesStatus> {
	const config = await loadConfiguredGateway(options);
	if (!config)
		throw new Error(
			`Web 尚未完成配置，请先运行 lc web。配置文件：${join(options.agentDir, options.configFileName ?? "web-config.json")}`,
		);
	const state = readState(options.agentDir, options.configFileName);
	if (requiresServiceVersionReconcile(options.serviceVersion, state?.serviceVersion)) {
		return reconcileWebServices(options);
	}
	const launchOptions = state?.serviceVersion ? { ...options, serviceVersion: state.serviceVersion } : options;
	await applyWebServices(config, launchOptions, false);
	writeState(config, launchOptions);
	return getWebServicesStatus(launchOptions);
}

async function reconcileWebServices(options: WebServiceLaunchOptions): Promise<WebServicesStatus> {
	const config = await loadConfiguredGateway(options);
	if (!config)
		throw new Error(
			`Web 尚未完成配置，请先运行 lc web。配置文件：${join(options.agentDir, options.configFileName ?? "web-config.json")}`,
		);
	const state = readState(options.agentDir, options.configFileName);
	const previousServiceVersion = state?.serviceVersion ?? options.previousServiceVersion;
	const transaction = await runServiceVersionTransaction({
		targetVersion: options.serviceVersion,
		previousVersion: previousServiceVersion,
		apply: async (serviceVersion) => {
			await applyWebServices(config, { ...options, serviceVersion }, true);
		},
		commit: (serviceVersion) => {
			writeState(config, { ...options, serviceVersion });
		},
	});
	const status = await getWebServicesStatus(options);
	return transaction.recovered ? { ...status, recovered: transaction.recovered } : status;
}

export async function runWebComponentAction(
	options: WebComponentActionOptions,
): Promise<WebServiceStatus | RuntimeServiceStatus> {
	const configured = await loadConfiguredGateway(options);
	const state = readState(options.agentDir, options.configFileName);
	if (
		(options.action === "start" || options.action === "restart") &&
		requiresServiceVersionReconcile(options.serviceVersion, state?.serviceVersion)
	) {
		const services = await reconcileWebServices(options);
		return options.component === "runtime" ? services.runtime : services.gateway;
	}
	const config = configured ?? (state ? stateConfig(state, options) : fallbackGatewayConfig(options));
	const profile = profileFor(options.configFileName);
	const interactiveAdmin = options.interactiveAdmin ?? false;
	const runtimeInvocation = serviceInvocation(options.runtimeInvocation);

	if (options.component === "runtime") {
		const runtimeProfile = runtimeProfileFor(config);
		const status = await getRuntimeServiceStatus(
			config.runtimeEndpoint,
			runtimeProfile,
			runtimeInvocation,
			config.agentDir,
		);
		if (options.action === "status") return status;
		if (!configured && !state) {
			throw new Error(
				`Web 尚未完成配置，请先运行 lc web。配置文件：${join(options.agentDir, options.configFileName ?? "web-config.json")}`,
			);
		}
		if (options.action === "stop") {
			return stopRuntimeService(
				config.runtimeEndpoint,
				options.force ?? false,
				runtimeProfile,
				runtimeInvocation,
				interactiveAdmin,
				config.agentDir,
			);
		}
		if (options.action === "restart") {
			if (options.force) {
				await stopRuntimeService(
					config.runtimeEndpoint,
					true,
					runtimeProfile,
					runtimeInvocation,
					interactiveAdmin,
					config.agentDir,
				);
				return ensureRuntimeService(
					config.runtimeEndpoint,
					runtimeProfile,
					runtimeInvocation,
					interactiveAdmin,
					config.agentDir,
				);
			}
			return restartRuntimeService(config.runtimeEndpoint, runtimeProfile, runtimeInvocation, config.agentDir);
		}
		if (status.installed) {
			return ensureRuntimeService(
				config.runtimeEndpoint,
				runtimeProfile,
				runtimeInvocation,
				interactiveAdmin,
				config.agentDir,
			);
		}
		return installRuntimeService(config.runtimeEndpoint, interactiveAdmin, {
			profile: runtimeProfile,
			invocation: runtimeInvocation,
			agentDir: config.agentDir,
			environment: serviceEnvironment(config, options.configFileName, options.serviceVersion),
		});
	}

	const gateway = gatewaySpec(config, options);
	const status = getWebServiceStatus(gateway);
	const gatewayStatus = (): WebServiceStatus => {
		const current = getWebServiceStatus(gateway);
		const pid = readGatewayPid(config.agentDir, profile);
		return { ...current, ...(pid ? { pid } : {}) };
	};
	if (options.action === "status") return gatewayStatus();
	if (!configured && !state) {
		throw new Error(
			`Web 尚未完成配置，请先运行 lc web。配置文件：${join(options.agentDir, options.configFileName ?? "web-config.json")}`,
		);
	}
	if (options.action === "stop" || options.action === "restart") {
		const stop = (force: boolean) =>
			stopWebService(gateway, force, {
				detachedPid: readGatewayPid(config.agentDir, profile),
				interactiveAdmin,
			});
		stop(options.force ?? false);
		try {
			await waitForGatewayExit(config.agentDir, profile);
		} catch (error) {
			if (options.force) throw error;
			stop(true);
			await waitForGatewayExit(config.agentDir, profile);
		}
		if (options.action === "stop") return gatewayStatus();
	}
	if (status.installed) ensureWebService(gateway, { interactiveAdmin });
	else installWebService(gateway, { interactiveAdmin });
	await waitForGatewayReady(config);
	return gatewayStatus();
}

export async function runWebServiceAction(options: WebServiceActionOptions): Promise<WebServicesStatus> {
	if (options.action === "uninstall") {
		const status = await getWebServicesStatus(options);
		const config = await loadConfiguredGateway(options);
		const state = readState(options.agentDir, options.configFileName);
		const base = config ?? (state ? stateConfig(state, options) : fallbackGatewayConfig(options));
		if (base) {
			const gateway = gatewaySpec(base, options);
			stopWebService(gateway, true, {
				detachedPid: status.gateway.pid,
				interactiveAdmin: options.interactiveAdmin ?? false,
			});
			removeWebService(gateway, { interactiveAdmin: options.interactiveAdmin ?? false });
			if (base.manageRuntime) {
				const runtime = runtimeSpec(base, options);
				stopWebService(runtime, true, {
					detachedPid: status.runtime.pid,
					interactiveAdmin: options.interactiveAdmin ?? false,
				});
				removeWebService(runtime, { interactiveAdmin: options.interactiveAdmin ?? false });
			}
		}
		rmSync(statePath(options.agentDir, options.configFileName), { force: true });
		removeMacosWebAdminAuthorization(options.agentDir, options.interactiveAdmin ?? false);
		return { ...status, enabled: false };
	}
	if (options.action === "status") return getWebServicesStatus(options);
	if (options.action === "stop") {
		const config = await loadConfiguredGateway(options);
		if (!config) return getWebServicesStatus(options);
		const gateway = gatewaySpec(config, options);
		const runtimeInvocation = serviceInvocation(options.runtimeInvocation);
		if (config.manageRuntime) {
			await stopRuntimeService(
				config.runtimeEndpoint,
				false,
				runtimeProfileFor(config),
				runtimeInvocation,
				options.interactiveAdmin ?? false,
				config.agentDir,
			);
		}
		stopWebService(gateway, false, {
			detachedPid: readGatewayPid(config.agentDir, profileFor(options.configFileName)),
			interactiveAdmin: options.interactiveAdmin ?? false,
		});
		const profile = profileFor(options.configFileName);
		try {
			await waitForGatewayExit(config.agentDir, profile);
		} catch {
			stopWebService(gateway, true, {
				detachedPid: readGatewayPid(config.agentDir, profile),
				interactiveAdmin: options.interactiveAdmin ?? false,
			});
			await waitForGatewayExit(config.agentDir, profile);
		}
		return getWebServicesStatus(options);
	}
	if (options.action === "start") return ensureWebServices(options);
	if (options.action === "restart") {
		await runWebServiceAction({ ...options, action: "stop" });
		return ensureWebServices(options);
	}
	return reconcileWebServices(options);
}
