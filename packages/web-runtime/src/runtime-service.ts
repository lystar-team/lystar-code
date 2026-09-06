import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type ByteTransport, type OperationSnapshot, RuntimeProtocolClient } from "@lystar/code-web-protocol";
import { probeIpcRuntime } from "./ipc.ts";

const SERVICE_NAME = "lystar-web-runtime";
const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "waiting_for_input"]);

export interface RuntimeServiceStatus {
	platform: NodeJS.Platform;
	arch: string;
	endpoint: string;
	reachable: boolean;
	installed: boolean;
	running: boolean;
	persistent: boolean;
	manager: "systemd-user" | "launch-daemon" | "scheduled-task" | "detached";
	servicePath?: string;
	lingerEnabled?: boolean;
	message?: string;
	remedy?: string;
}

interface HostSnapshot {
	operations: OperationSnapshot[];
	pendingUiRequests: unknown[];
}

interface ServiceInvocation {
	program: string;
	args: string[];
}

function executableInvocation(): ServiceInvocation {
	const entry = process.argv[1];
	if (entry && existsSync(entry) && basename(process.execPath).startsWith("node")) {
		return { program: realpathSync(process.execPath), args: [realpathSync(entry)] };
	}
	return { program: realpathSync(process.execPath), args: [] };
}

function run(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	return {
		ok: !result.error && result.status === 0,
		stdout: result.stdout?.trim() ?? "",
		stderr: result.error?.message ?? result.stderr?.trim() ?? "",
	};
}

function runInteractive(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync(command, args, { stdio: "inherit" });
	return {
		ok: !result.error && result.status === 0,
		stdout: "",
		stderr: result.error?.message ?? "",
	};
}

function writeAtomic(path: string, content: string, mode: number): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, content, { encoding: "utf8", mode });
	renameSync(temporaryPath, path);
}

function systemdUnitPath(): string {
	return join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

function launchDaemonLabel(): string {
	return `com.lystar.web-runtime.${process.getuid?.() ?? 0}`;
}

function launchDaemonPath(): string {
	return join("/Library", "LaunchDaemons", `${launchDaemonLabel()}.plist`);
}

function launchDaemonStagingPath(): string {
	return join(homedir(), ".pi", "agent", "host", `${launchDaemonLabel()}.plist`);
}

function windowsTaskName(): string {
	return "LYStar Web Runtime";
}

function linuxStatus(endpoint: string): RuntimeServiceStatus {
	const servicePath = systemdUnitPath();
	const active = run("systemctl", ["--user", "is-active", "--quiet", SERVICE_NAME]).ok;
	const user = process.env.USER ?? process.env.LOGNAME ?? "";
	const lingerEnabled = user !== "" && existsSync(join("/var/lib/systemd/linger", user));
	return {
		platform: process.platform,
		arch: process.arch,
		endpoint,
		reachable: false,
		installed: existsSync(servicePath),
		running: active,
		persistent: active && lingerEnabled,
		manager: "systemd-user",
		servicePath,
		lingerEnabled,
		...(!lingerEnabled && user
			? {
					message: "用户 lingering 尚未启用，SSH 退出后用户服务可能停止",
					remedy: `sudo loginctl enable-linger ${user}`,
				}
			: {}),
	};
}

function macStatus(endpoint: string): RuntimeServiceStatus {
	const servicePath = launchDaemonPath();
	const listed = run("launchctl", ["print", `system/${launchDaemonLabel()}`]).ok;
	return {
		platform: process.platform,
		arch: process.arch,
		endpoint,
		reachable: false,
		installed: existsSync(servicePath),
		running: listed,
		persistent: listed,
		manager: "launch-daemon",
		servicePath,
		...(!existsSync(servicePath)
			? {
					message: "macOS 远端后台需要一次管理员批准",
					remedy: "在远端终端运行 ~/.local/bin/lystar-web-runtime install --interactive-admin。",
				}
			: {}),
	};
}

function windowsStatus(endpoint: string): RuntimeServiceStatus {
	const task = run("schtasks.exe", ["/Query", "/TN", windowsTaskName(), "/FO", "LIST"]);
	const running = task.ok && /Running|正在运行/iu.test(task.stdout);
	return {
		platform: process.platform,
		arch: process.arch,
		endpoint,
		reachable: false,
		installed: task.ok,
		running,
		persistent: task.ok,
		manager: "scheduled-task",
		servicePath: windowsTaskName(),
	};
}

export async function getRuntimeServiceStatus(endpoint: string): Promise<RuntimeServiceStatus> {
	const base =
		process.platform === "linux"
			? linuxStatus(endpoint)
			: process.platform === "darwin"
				? macStatus(endpoint)
				: windowsStatus(endpoint);
	const reachable = (await probeIpcRuntime(endpoint)).reachable;
	return { ...base, reachable, running: base.running || reachable };
}

function installLinux(endpoint: string): void {
	const invocation = executableInvocation();
	const command = [...invocation.args, "serve"].reduce(
		(value, argument) => `${value} ${JSON.stringify(argument)}`,
		JSON.stringify(invocation.program),
	);
	const unit = `[Unit]\nDescription=LYStar Code Web Runtime\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${command}\nEnvironment=${JSON.stringify(`PI_WEB_RUNTIME_ENDPOINT=${endpoint}`)}\nRestart=on-failure\nRestartSec=2\nKillMode=mixed\n\n[Install]\nWantedBy=default.target\n`;
	writeAtomic(systemdUnitPath(), unit, 0o600);
	const reload = run("systemctl", ["--user", "daemon-reload"]);
	if (!reload.ok) throw new Error(`无法刷新 systemd 用户服务：${reload.stderr || reload.stdout}`);
	const enable = run("systemctl", ["--user", "enable", SERVICE_NAME]);
	if (!enable.ok) throw new Error(`无法启用 systemd 用户服务：${enable.stderr || enable.stdout}`);
	const restart = run("systemctl", ["--user", "restart", SERVICE_NAME]);
	if (!restart.ok) throw new Error(`无法启动 systemd 用户服务：${restart.stderr || restart.stdout}`);
}

function xml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function sudo(interactiveAdmin: boolean, args: string[]): { ok: boolean; stdout: string; stderr: string } {
	return interactiveAdmin ? runInteractive("sudo", args) : run("sudo", ["-n", ...args]);
}

function installMac(endpoint: string, interactiveAdmin: boolean): void {
	const user = process.env.USER ?? process.env.LOGNAME;
	if (!user) throw new Error("无法确定 macOS 后台运行用户");
	const invocation = executableInvocation();
	const programArguments = [invocation.program, ...invocation.args, "serve"]
		.map((argument) => `<string>${xml(argument)}</string>`)
		.join("");
	const escapedEndpoint = xml(endpoint);
	const logs = xml(join(homedir(), "Library", "Logs"));
	const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${launchDaemonLabel()}</string>\n<key>UserName</key><string>${xml(user)}</string>\n<key>ProgramArguments</key><array>${programArguments}</array>\n<key>EnvironmentVariables</key><dict><key>PI_WEB_RUNTIME_ENDPOINT</key><string>${escapedEndpoint}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string>\n<key>StandardOutPath</key><string>${logs}/lystar-web-runtime.log</string>\n<key>StandardErrorPath</key><string>${logs}/lystar-web-runtime.error.log</string>\n</dict></plist>\n`;
	const stagingPath = launchDaemonStagingPath();
	writeAtomic(stagingPath, plist, 0o600);
	const install = sudo(interactiveAdmin, [
		"install",
		"-o",
		"root",
		"-g",
		"wheel",
		"-m",
		"0644",
		stagingPath,
		launchDaemonPath(),
	]);
	if (!install.ok) {
		throw new Error(
			`macOS 远端后台需要管理员批准：请在远端终端运行 ~/.local/bin/lystar-web-runtime install --interactive-admin。${install.stderr || install.stdout}`,
		);
	}
	sudo(interactiveAdmin, ["launchctl", "bootout", `system/${launchDaemonLabel()}`]);
	const bootstrap = sudo(interactiveAdmin, ["launchctl", "bootstrap", "system", launchDaemonPath()]);
	if (!bootstrap.ok) throw new Error(`无法启动 macOS LaunchDaemon：${bootstrap.stderr || bootstrap.stdout}`);
}

function installWindows(): void {
	const invocation = executableInvocation();
	const taskCommand = [invocation.program, ...invocation.args, "serve"]
		.map((argument) => `"${argument.replaceAll('"', '\\"')}"`)
		.join(" ");
	const username = process.env.USERNAME;
	const runAs = username
		? ["/RU", process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username, "/NP"]
		: [];
	const create = run("schtasks.exe", [
		"/Create",
		"/TN",
		windowsTaskName(),
		"/TR",
		taskCommand,
		"/SC",
		"ONLOGON",
		...runAs,
		"/RL",
		"LIMITED",
		"/F",
	]);
	if (!create.ok) throw new Error(`无法创建 Windows 计划任务：${create.stderr || create.stdout}`);
	const start = run("schtasks.exe", ["/Run", "/TN", windowsTaskName()]);
	if (!start.ok) throw new Error(`无法启动 Windows 计划任务：${start.stderr || start.stdout}`);
}

async function waitUntilReachable(endpoint: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await probeIpcRuntime(endpoint)).reachable) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Web Runtime服务启动超时");
}

async function waitUntilUnreachable(endpoint: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await probeIpcRuntime(endpoint)).reachable) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Web Runtime服务停止超时");
}

export async function installRuntimeService(endpoint: string, interactiveAdmin = false): Promise<RuntimeServiceStatus> {
	if (process.platform === "linux") installLinux(endpoint);
	else if (process.platform === "darwin") installMac(endpoint, interactiveAdmin);
	else if (process.platform === "win32") installWindows();
	else throw new Error(`不支持的后台托管平台：${process.platform}`);
	await waitUntilReachable(endpoint);
	return getRuntimeServiceStatus(endpoint);
}

export async function ensureRuntimeService(endpoint: string): Promise<RuntimeServiceStatus> {
	const status = await getRuntimeServiceStatus(endpoint);
	if (status.reachable) return status;
	if (!status.installed) {
		throw Object.assign(new Error("Web Runtime服务尚未安装"), {
			code: "host_service_not_installed",
			status,
		});
	}
	const start =
		process.platform === "linux"
			? run("systemctl", ["--user", "start", SERVICE_NAME])
			: process.platform === "darwin"
				? status.running
					? run("sudo", ["-n", "launchctl", "kickstart", "-k", `system/${launchDaemonLabel()}`])
					: run("sudo", ["-n", "launchctl", "bootstrap", "system", launchDaemonPath()])
				: run("schtasks.exe", ["/Run", "/TN", windowsTaskName()]);
	if (!start.ok) throw new Error(`无法启动 Web Runtime服务：${start.stderr || start.stdout}`);
	await waitUntilReachable(endpoint);
	return getRuntimeServiceStatus(endpoint);
}

class SocketTransport implements ByteTransport {
	private readonly listeners = new Set<(bytes: Uint8Array) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();
	private readonly socket: Socket;
	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (bytes) => {
			for (const listener of this.listeners) listener(bytes);
		});
		socket.once("close", () => {
			for (const listener of this.closeListeners) listener();
		});
		socket.once("error", (error) => {
			for (const listener of this.closeListeners) listener(error);
		});
	}
	async send(bytes: Uint8Array): Promise<void> {
		await new Promise<void>((resolve, reject) =>
			this.socket.write(bytes, (error) => (error ? reject(error) : resolve())),
		);
	}
	async close(): Promise<void> {
		this.socket.end();
	}
	onBytes(listener: (bytes: Uint8Array) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	onClose(listener: (error?: Error) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}
}

async function connectSocket(endpoint: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(endpoint);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

async function readHostSnapshot(endpoint: string): Promise<HostSnapshot | undefined> {
	if (!(await probeIpcRuntime(endpoint)).reachable) return undefined;
	const client = new RuntimeProtocolClient(
		new SocketTransport(await connectSocket(endpoint)),
		`host-control-${process.pid}`,
	);
	try {
		await client.connect();
		const deadline = Date.now() + 5_000;
		while (!client.getSnapshot().connected && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		if (!client.getSnapshot().connected) throw new Error("Web Runtime握手超时");
		return await client.request<HostSnapshot>({ command: "get_snapshot" });
	} finally {
		await client.close();
	}
}

export async function stopRuntimeService(endpoint: string, force: boolean): Promise<RuntimeServiceStatus> {
	const snapshot = await readHostSnapshot(endpoint);
	if (!force && snapshot) {
		const active = snapshot.operations.filter((operation) => ACTIVE_OPERATION_STATUSES.has(operation.status));
		if (active.length > 0 || snapshot.pendingUiRequests.length > 0) {
			throw Object.assign(new Error("Web Runtime仍有运行任务或待处理交互"), {
				code: "host_busy",
				activeOperations: active.map((operation) => operation.operationId),
				pendingUiRequests: snapshot.pendingUiRequests.length,
			});
		}
	}
	const stop =
		process.platform === "linux"
			? run("systemctl", ["--user", "stop", SERVICE_NAME])
			: process.platform === "darwin"
				? run("sudo", ["-n", "launchctl", "bootout", `system/${launchDaemonLabel()}`])
				: run("schtasks.exe", ["/End", "/TN", windowsTaskName()]);
	if (!stop.ok && (await probeIpcRuntime(endpoint)).reachable) {
		throw new Error(`无法停止 Web Runtime服务：${stop.stderr || stop.stdout}`);
	}
	await waitUntilUnreachable(endpoint);
	return getRuntimeServiceStatus(endpoint);
}

export function startDetachedRuntime(endpoint: string): void {
	const invocation = executableInvocation();
	const child = spawn(invocation.program, [...invocation.args, "serve"], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, PI_WEB_RUNTIME_ENDPOINT: endpoint },
	});
	child.unref();
}

export function removeRuntimeService(): void {
	if (process.platform === "linux") {
		run("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
		rmSync(systemdUnitPath(), { force: true });
		run("systemctl", ["--user", "daemon-reload"]);
	} else if (process.platform === "darwin") {
		run("sudo", ["-n", "launchctl", "bootout", `system/${launchDaemonLabel()}`]);
		run("sudo", ["-n", "rm", "-f", launchDaemonPath()]);
		rmSync(launchDaemonStagingPath(), { force: true });
	} else if (process.platform === "win32") {
		run("schtasks.exe", ["/Delete", "/TN", windowsTaskName(), "/F"]);
	}
}

export function hostServiceDiagnostic(_endpoint: string): string {
	if (process.platform === "win32") {
		const task = run("schtasks.exe", ["/Query", "/TN", windowsTaskName(), "/FO", "LIST", "/V"]);
		return task.ok ? task.stdout : task.stderr || "Windows 计划任务尚未安装";
	}
	const path = process.platform === "linux" ? systemdUnitPath() : launchDaemonPath();
	return existsSync(path) ? readFileSync(path, "utf8") : `后台服务尚未安装：${path}`;
}
