import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";
import { getRuntimeServiceStatus } from "@lystar/code-web-runtime";
import {
	DEFAULT_ALLOWED_HOSTS,
	DEFAULT_RUNTIME_PORT,
	DEFAULT_WEB_GATEWAY_PORT,
	DEFAULT_WEB_HOST,
	defaultWebStaticDir,
	getWebAgentDir,
	loadWebGatewayConfig,
	parseGatewayPort,
	type RuntimeInvocation,
	validateAllowedHosts,
	validateGatewayHost,
	validateWebPassword,
	type WebConfig,
	WebConfigStore,
} from "./config.ts";
import { hostNetworkAddresses } from "./host-diagnostics.ts";
import { GatewayAlreadyRunningError, GatewayInstanceLock } from "./instance-lock.ts";
import { ensurePersistentRuntime } from "./runtime-client.ts";
import { WebGatewayServer } from "./server.ts";

export interface WebGatewayCliOptions {
	defaultPort?: number;
	defaultRuntimePort?: number;
	staticDir?: string;
	runtimeInvocation?: RuntimeInvocation;
	configFileName?: string;
	backgroundInvocation?: RuntimeInvocation;
	expectedProductVersion?: string;
}

function environmentValue(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

function clearWebEnvironment(): void {
	delete process.env.PI_WEB_HOST;
	delete process.env.PI_WEB_ALLOWED_HOSTS;
	delete process.env.PI_WEB_PORT;
	delete process.env.PI_WEB_RUNTIME_PORT;
	delete process.env.PI_WEB_TOKEN;
}

async function askHidden(readline: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
	readline.close();
	const input = process.stdin;
	input.removeAllListeners("keypress");
	input.removeAllListeners("data");
	const previousRaw = input.isRaw;
	input.setRawMode?.(true);
	input.resume();
	process.stdout.write(prompt);
	const decoder = new StringDecoder("utf8");
	let value = "";
	return new Promise((resolve, reject) => {
		const finish = (callback: () => void) => {
			input.off("data", onData);
			input.setRawMode?.(previousRaw ?? false);
			process.stdout.write("\n");
			callback();
		};
		const onData = (chunk: Buffer | string) => {
			for (const character of decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk)) {
				const code = character.charCodeAt(0);
				if (code === 3) {
					finish(() => reject(new Error("用户取消配置")));
					return;
				}
				if (code === 13 || code === 10) {
					finish(() => resolve(value));
					return;
				}
				if (code === 8 || code === 127) {
					const characters = Array.from(value);
					if (characters.length > 0) {
						characters.pop();
						value = characters.join("");
						process.stdout.write("\\b \\b");
					}
					continue;
				}
				if (code >= 32) value += character;
			}
		};
		input.on("data", onData);
	});
}

async function askValidated<T>(
	readline: ReturnType<typeof createInterface>,
	step: string,
	label: string,
	hint: string,
	defaultValue: string,
	parse: (value: string) => T,
): Promise<T> {
	while (true) {
		console.log(`\n${step} ${label}`);
		console.log(`  ${hint}`);
		const answer = await readline.question(`请输入${label}${defaultValue ? `（默认：${defaultValue}）` : ""}：`);
		try {
			return parse(answer.trim() || defaultValue);
		} catch (error) {
			console.error(`输入无效：${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

async function promptForWebConfig(
	store: WebConfigStore,
	initial: { host: string; allowedHosts: string[]; port: number; runtimePort: number; password?: string },
): Promise<WebConfig> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(`首次运行需要在终端完成 Web 配置，请运行 lc web。配置文件：${store.path}`);
	}
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		console.log("\n欢迎使用 LYStar Code Web 工作台。请完成以下配置，按回车使用默认值。\n");
		const host = await askValidated(
			readline,
			"[1/5]",
			"监听 IP 地址",
			"填入 0.0.0.0 表示监听本机所有网络接口。",
			initial.host,
			validateGatewayHost,
		);
		const allowedHosts = await askValidated(
			readline,
			"[2/5]",
			"白名单 IP 地址",
			"填入 * 表示不限制访问来源；多个地址使用英文逗号分隔。",
			initial.allowedHosts.join(","),
			validateAllowedHosts,
		);
		const port = await askValidated(
			readline,
			"[3/5]",
			"Web 监听端口",
			"浏览器访问 Web UI 使用此端口。",
			String(initial.port),
			parseGatewayPort,
		);
		const runtimePort = await askValidated(
			readline,
			"[4/5]",
			"Runtime 监听端口",
			"Runtime 默认只监听本机，用于 Gateway 连接和会话运行。",
			String(initial.runtimePort),
			parseGatewayPort,
		);
		let password = initial.password;
		while (!password) {
			console.log("\n[5/5] 连接密码");
			console.log("  用于进入 Web 工作台，长度需要在 8 到 256 个字符之间。");
			const answer = await askHidden(readline, "请输入连接密码：");
			try {
				password = validateWebPassword(answer);
			} catch (error) {
				console.error(`输入无效：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		console.log("\n配置已完成，正在保存……");
		return store.save({ host, allowedHosts, port, runtimePort, password });
	} finally {
		readline.close();
	}
}

async function ensureWebConfig(
	agentDir: string,
	defaultPort: number,
	defaultRuntimePort: number,
	configFileName?: string,
): Promise<WebConfig> {
	const configPath = configFileName ? join(agentDir, configFileName) : undefined;
	const store = new WebConfigStore(agentDir, configPath);
	let current = await store.loadOrMigrate();
	let legacy = current ? {} : await store.loadLegacy();
	if (!current && configFileName) {
		const production = await new WebConfigStore(agentDir).load();
		if (production) {
			current = await store.save({
				host: production.host,
				allowedHosts: production.allowedHosts,
				port: defaultPort,
				runtimePort: defaultRuntimePort,
				password: production.password,
			});
			legacy = {};
		}
	}
	const environmentHost = environmentValue("PI_WEB_HOST");
	const environmentAllowedHosts = environmentValue("PI_WEB_ALLOWED_HOSTS");
	const environmentPort = environmentValue("PI_WEB_PORT");
	const environmentRuntimePort = environmentValue("PI_WEB_RUNTIME_PORT");
	const environmentPassword = environmentValue("PI_WEB_TOKEN");
	const host = environmentHost ?? current?.host ?? legacy.host ?? DEFAULT_WEB_HOST;
	const allowedHosts =
		environmentAllowedHosts !== undefined
			? validateAllowedHosts(environmentAllowedHosts)
			: (current?.allowedHosts ?? legacy.allowedHosts ?? [...DEFAULT_ALLOWED_HOSTS]);
	const port = environmentPort ? parseGatewayPort(environmentPort) : (current?.port ?? legacy.port ?? defaultPort);
	const runtimePort = environmentRuntimePort
		? parseGatewayPort(environmentRuntimePort)
		: (current?.runtimePort ?? legacy.runtimePort ?? defaultRuntimePort);
	const password = environmentPassword ?? current?.password ?? legacy.password;
	try {
		if (password) {
			return await store.save({ host, allowedHosts, port, runtimePort, password });
		}
		return await promptForWebConfig(store, {
			host,
			allowedHosts: current?.allowedHosts ?? legacy.allowedHosts ?? [...DEFAULT_ALLOWED_HOSTS],
			port,
			runtimePort,
		});
	} finally {
		clearWebEnvironment();
	}
}

async function verifyWebAssets(staticDir: string, expectedProductVersion?: string): Promise<void> {
	try {
		const index = await stat(join(staticDir, "index.html"));
		if (!index.isFile()) throw new Error("index.html 不是文件");
	} catch (error) {
		throw new Error(`发行包缺少 Web 资源：${staticDir}（${error instanceof Error ? error.message : String(error)}）`);
	}
	if (!expectedProductVersion) return;
	let value: unknown;
	try {
		value = JSON.parse(await readFile(join(staticDir, "version.json"), "utf8"));
	} catch (error) {
		throw new Error(`Web 版本信息读取失败：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Web 版本信息格式无效");
	const version = (value as { productVersion?: unknown }).productVersion;
	if (version !== expectedProductVersion)
		throw new Error(`Web 与 LYStar Code 版本不一致：${String(version)} != ${expectedProductVersion}`);
}

function urlHost(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function webAccessUrls(host: string, port: number): string[] {
	const candidates =
		host === "0.0.0.0"
			? ["127.0.0.1", ...hostNetworkAddresses()]
			: host === "::"
				? ["::1", ...hostNetworkAddresses()]
				: [host];
	return [...new Set(candidates)].map((candidate) => `http://${urlHost(candidate)}:${port}`);
}

async function startDetachedGateway(
	invocation: RuntimeInvocation,
	agentDir: string,
): Promise<{ pid: number; logPath: string }> {
	const logDirectory = join(agentDir, "web");
	const logPath = join(logDirectory, "gateway.log");
	await mkdir(logDirectory, { recursive: true, mode: 0o700 });
	const logFd = openSync(logPath, "a");
	try {
		const child = spawn(invocation.command, invocation.args, {
			cwd: invocation.cwd,
			env: { ...process.env },
			detached: true,
			stdio: ["ignore", logFd, logFd],
			windowsHide: true,
		});
		await new Promise<void>((resolvePromise, reject) => {
			child.once("spawn", resolvePromise);
			child.once("error", reject);
		});
		if (child.pid === undefined) throw new Error("后台 Gateway 进程未返回 PID");
		child.unref();
		return { pid: child.pid, logPath };
	} finally {
		closeSync(logFd);
	}
}

function printBackgroundStartup(config: WebGatewayServer["config"], pid: number, logPath: string): void {
	console.log("\nLYStar Code Web 工作台已在后台启动");
	console.log(`Gateway：后台运行（监听 ${urlHost(config.host)}:${config.port}，PID ${pid}）`);
	if (config.runtimeInvocation) {
		console.log(`Runtime：随 Gateway 启动（127.0.0.1:${config.runtimePort ?? DEFAULT_RUNTIME_PORT}）`);
	}
	console.log("\nWeb UI 访问地址：");
	for (const url of webAccessUrls(config.host, config.port)) console.log(`  ${url}`);
	console.log(`\n日志文件：${logPath}`);
}

function printStartupSummary(
	config: WebGatewayServer["config"],
	runtimeStatus?: { reachable: boolean; pid?: number },
): void {
	console.log("\nLYStar Code Web 工作台已启动");
	console.log(`Gateway：已启动（监听 ${urlHost(config.host)}:${config.port}）`);
	if (runtimeStatus) {
		const runtimeAddress = `127.0.0.1:${config.runtimePort ?? DEFAULT_RUNTIME_PORT}`;
		console.log(
			`Runtime：${runtimeStatus.reachable ? "已启动并连接" : "未连接"}（${runtimeAddress}${runtimeStatus.pid ? `，PID ${runtimeStatus.pid}` : ""}）`,
		);
	}
	console.log("\nWeb UI 访问地址：");
	for (const url of webAccessUrls(config.host, config.port)) console.log(`  ${url}`);
	console.log(`\n配置文件：${config.configPath ?? new WebConfigStore(config.agentDir).path}`);
	console.log("\n服务重启命令：");
	console.log("  lc web gateway restart");
	console.log("  lc web runtime restart");
}

export async function runWebGatewayCli(options: WebGatewayCliOptions = {}): Promise<void> {
	const staticDir = options.staticDir ?? defaultWebStaticDir();
	const defaultPort = options.defaultPort ?? DEFAULT_WEB_GATEWAY_PORT;
	const defaultRuntimePort = options.defaultRuntimePort ?? DEFAULT_RUNTIME_PORT;
	await verifyWebAssets(staticDir, options.expectedProductVersion);
	const agentDir = getWebAgentDir();
	await ensureWebConfig(agentDir, defaultPort, defaultRuntimePort, options.configFileName);
	if (options.backgroundInvocation) {
		const config = await loadWebGatewayConfig({
			defaultPort,
			defaultRuntimePort,
			staticDir,
			runtimeInvocation: options.runtimeInvocation,
			configFileName: options.configFileName,
		});
		if (options.runtimeInvocation && config.port === config.runtimePort) {
			throw new Error(`Web 端口和 Runtime 端口不能相同（当前都是 ${config.port}），请修改 ${config.configPath}`);
		}
		const { pid, logPath } = await startDetachedGateway(options.backgroundInvocation, agentDir);
		printBackgroundStartup(config, pid, logPath);
		return;
	}
	const instanceLock = await (async () => {
		try {
			return await GatewayInstanceLock.acquire(agentDir);
		} catch (error) {
			if (error instanceof GatewayAlreadyRunningError) throw new Error(error.message);
			throw error;
		}
	})();

	let activeGateway: WebGatewayServer | undefined;
	let activeClose: ((reason: "restart" | "shutdown") => void) | undefined;
	let shuttingDown = false;
	const onSignal = () => {
		shuttingDown = true;
		activeClose?.("shutdown");
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	try {
		while (!shuttingDown) {
			const config = await loadWebGatewayConfig({
				defaultPort,
				defaultRuntimePort,
				staticDir,
				runtimeInvocation: options.runtimeInvocation,
				configFileName: options.configFileName,
			});
			if (options.runtimeInvocation && config.port === config.runtimePort) {
				throw new Error(`Web 端口和 Runtime 端口不能相同（当前都是 ${config.port}），请修改 ${config.configPath}`);
			}
			if (options.runtimeInvocation) await ensurePersistentRuntime(config);
			const gateway = new WebGatewayServer(config);
			activeGateway = gateway;
			let restartRequested = false;
			let resolveClosed!: () => void;
			const closed = new Promise<void>((resolve) => {
				resolveClosed = resolve;
			});
			activeClose = (reason) => {
				if (restartRequested || (shuttingDown && reason !== "shutdown")) return;
				if (reason === "restart") restartRequested = true;
				void gateway.close().finally(resolveClosed);
			};
			gateway.setRestartHandler(() => activeClose?.("restart"));
			try {
				await gateway.listen();
				const runtimeStatus = options.runtimeInvocation
					? await getRuntimeServiceStatus(config.runtimeEndpoint)
					: undefined;
				printStartupSummary(config, runtimeStatus);
			} catch (error) {
				await gateway.close().catch(() => {});
				throw error;
			}
			if (shuttingDown) activeClose("shutdown");
			await closed;
			activeClose = undefined;
			activeGateway = undefined;
			if (restartRequested && !shuttingDown) continue;
			break;
		}
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		if (activeGateway) await activeGateway.close().catch(() => {});
		await instanceLock.release();
	}
}
