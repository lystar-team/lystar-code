import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ByteTransport, type OperationSnapshot, RuntimeProtocolClient } from "@lystar/code-web-protocol";
import { connectRuntimeEndpoint, defaultRuntimeEndpoint, probeIpcRuntime } from "./ipc.ts";
import { getRuntimeAgentDir } from "./runtime-adapter.ts";
import {
	currentProcessInvocation,
	ensureWebService,
	getWebServiceStatus,
	installWebService,
	removeWebService,
	stopWebService,
	type WebServiceInvocation,
	type WebServiceSpec,
	type WebServiceStatus,
	webServiceDiagnostic,
} from "./service-manager.ts";

const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "waiting_for_input"]);

export interface RuntimeServiceStatus extends WebServiceStatus {
	endpoint: string;
	reachable: boolean;
}

interface HostSnapshot {
	operations: OperationSnapshot[];
	pendingUiRequests: unknown[];
}

export interface RuntimeServiceOptions {
	profile?: string;
	invocation?: WebServiceInvocation;
	agentDir?: string;
	environment?: Record<string, string | undefined>;
}

function runtimePidPath(endpoint: string, agentDir = getRuntimeAgentDir()): string {
	if (endpoint.startsWith("tcp://")) {
		const suffix = createHash("sha256").update(endpoint).digest("hex").slice(0, 24);
		return join(agentDir, "host", `lystar-web-runtime-${suffix}.pid`);
	}
	return process.platform === "win32" ? join(agentDir, "host", "lystar-web-runtime.pid") : `${endpoint}.pid`;
}

function legacyRuntimePidPath(endpoint: string): string {
	if (endpoint.startsWith("tcp://")) {
		const suffix = createHash("sha256").update(endpoint).digest("hex").slice(0, 24);
		return join(homedir(), ".pi", "agent", "host", `lystar-web-runtime-${suffix}.pid`);
	}
	return process.platform === "win32"
		? join(homedir(), ".pi", "agent", "host", "lystar-web-runtime.pid")
		: `${endpoint}.pid`;
}

function runtimePidPaths(endpoint: string, agentDir: string): string[] {
	const current = runtimePidPath(endpoint, agentDir);
	const legacy = legacyRuntimePidPath(endpoint);
	return current === legacy ? [current] : [current, legacy];
}

export function writeRuntimePid(endpoint: string, pid = process.pid, agentDir = getRuntimeAgentDir()): void {
	const path = runtimePidPath(endpoint, agentDir);
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, `${pid}\n`, { encoding: "utf8", mode: 0o600 });
	} catch (error) {
		throw new Error(`无法写入 Web Runtime PID 文件：${error instanceof Error ? error.message : String(error)}`);
	}
}

export function clearRuntimePid(endpoint: string, pid = process.pid, agentDir = getRuntimeAgentDir()): void {
	for (const path of runtimePidPaths(endpoint, agentDir)) {
		try {
			if (readFileSync(path, "utf8").trim() === String(pid)) unlinkSync(path);
		} catch {}
	}
}

function readRuntimePid(endpoint: string, agentDir = getRuntimeAgentDir()): number | undefined {
	for (const path of runtimePidPaths(endpoint, agentDir)) {
		try {
			const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
			if (!Number.isInteger(pid) || pid <= 0) continue;
			process.kill(pid, 0);
			return pid;
		} catch {}
	}
	return undefined;
}

function withRuntimeEndpoint(args: readonly string[], endpoint: string): string[] {
	const endpointIndex = args.findIndex((argument) => argument === "--endpoint" || argument.startsWith("--endpoint="));
	if (endpointIndex === -1) return [...args, "--endpoint", endpoint];
	if (args[endpointIndex] === "--endpoint") {
		return [...args.slice(0, endpointIndex + 1), endpoint, ...args.slice(endpointIndex + 2)];
	}
	return [...args.slice(0, endpointIndex), `--endpoint=${endpoint}`, ...args.slice(endpointIndex + 1)];
}

function runtimeEnvironment(agentDir: string, endpoint: string): Record<string, string | undefined> {
	return {
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_RUNTIME_ENDPOINT: endpoint,
		HOME: process.env.HOME ?? homedir(),
		USERPROFILE: process.env.USERPROFILE ?? homedir(),
		APPDATA: process.env.APPDATA,
		LOCALAPPDATA: process.env.LOCALAPPDATA,
	};
}

export function createRuntimeServiceSpec(endpoint: string, options: RuntimeServiceOptions = {}): WebServiceSpec {
	const agentDir = options.agentDir ?? getRuntimeAgentDir();
	const base = options.invocation ?? currentProcessInvocation();
	const invocation = options.invocation
		? { ...base, args: withRuntimeEndpoint(base.args, endpoint), cwd: agentDir }
		: { ...base, args: [...base.args, "serve", "--endpoint", endpoint], cwd: agentDir };
	return {
		kind: "runtime",
		...(options.profile ? { profile: options.profile } : {}),
		agentDir,
		invocation,
		environment: { ...runtimeEnvironment(agentDir, endpoint), ...options.environment },
		logPath: join(agentDir, "web", "runtime.log"),
	};
}

function mergeRuntimeStatus(
	base: WebServiceStatus,
	endpoint: string,
	reachable: boolean,
	pid: number | undefined,
): RuntimeServiceStatus {
	const effectivePid = pid ?? base.pid;
	return {
		...base,
		endpoint,
		reachable,
		running: base.running || reachable,
		...(effectivePid !== undefined ? { pid: effectivePid } : {}),
	};
}

export async function getRuntimeServiceStatus(
	endpoint: string,
	profile?: string,
	invocation?: WebServiceInvocation,
	agentDir?: string,
): Promise<RuntimeServiceStatus> {
	const spec = createRuntimeServiceSpec(endpoint, {
		...(profile ? { profile } : {}),
		...(invocation ? { invocation } : {}),
		...(agentDir ? { agentDir } : {}),
	});
	const base = getWebServiceStatus(spec);
	const reachable = (await probeIpcRuntime(endpoint)).reachable;
	return mergeRuntimeStatus(base, endpoint, reachable, readRuntimePid(endpoint, spec.agentDir));
}

function runtimeSpecOptions(options: RuntimeServiceOptions | undefined): RuntimeServiceOptions {
	return options ?? {};
}

export async function installRuntimeService(
	endpoint: string,
	interactiveAdmin = false,
	options?: RuntimeServiceOptions,
): Promise<RuntimeServiceStatus> {
	const spec = createRuntimeServiceSpec(endpoint, runtimeSpecOptions(options));
	// 重装同样经过忙碌检查，不能由系统服务重启绕过运行任务保护。
	await stopRuntimeService(
		endpoint,
		false,
		options?.profile,
		options?.invocation,
		interactiveAdmin,
		options?.agentDir,
	);
	installWebService(spec, { interactiveAdmin });
	await waitUntilReachable(endpoint);
	return getRuntimeServiceStatus(endpoint, options?.profile, options?.invocation, options?.agentDir);
}

export async function ensureRuntimeService(
	endpoint: string,
	profile?: string,
	invocation?: WebServiceInvocation,
	interactiveAdmin = false,
	agentDir?: string,
): Promise<RuntimeServiceStatus> {
	const status = await getRuntimeServiceStatus(endpoint, profile, invocation, agentDir);
	if (status.reachable) return status;
	if (!status.installed) {
		throw Object.assign(new Error("Web Runtime服务尚未安装"), {
			code: "host_service_not_installed",
			status,
		});
	}
	const spec = createRuntimeServiceSpec(endpoint, {
		...(profile ? { profile } : {}),
		...(invocation ? { invocation } : {}),
		...(agentDir ? { agentDir } : {}),
	});
	ensureWebService(spec, { interactiveAdmin });
	await waitUntilReachable(endpoint);
	return getRuntimeServiceStatus(endpoint, profile, invocation, agentDir);
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

async function readHostSnapshot(endpoint: string): Promise<HostSnapshot | undefined> {
	if (!(await probeIpcRuntime(endpoint)).reachable) return undefined;
	const client = new RuntimeProtocolClient(
		new SocketTransport(await connectRuntimeEndpoint(endpoint)),
		`host-control-${process.pid}`,
	);
	try {
		await client.connect();
		const deadline = Date.now() + 5_000;
		while (!client.getSnapshot().connected && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		if (!client.getSnapshot().connected) throw new Error("Web Runtime握手超时");
		return await client.request<HostSnapshot>({ command: "get_snapshot" }, { timeoutMs: 5_000 });
	} finally {
		await client.close();
	}
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

export async function assertRuntimeIdle(endpoint: string): Promise<void> {
	const snapshot = await readHostSnapshot(endpoint);
	if (snapshot) {
		const active = snapshot.operations.filter((operation) => ACTIVE_OPERATION_STATUSES.has(operation.status));
		if (active.length > 0 || snapshot.pendingUiRequests.length > 0) {
			throw Object.assign(new Error("Web Runtime仍有运行任务或待处理交互"), {
				code: "host_busy",
				activeOperations: active.map((operation) => operation.operationId),
				pendingUiRequests: snapshot.pendingUiRequests.length,
			});
		}
	}
}

export async function restartRuntimeService(
	endpoint: string,
	profile?: string,
	invocation?: WebServiceInvocation,
	agentDir = getRuntimeAgentDir(),
): Promise<RuntimeServiceStatus> {
	const status = await getRuntimeServiceStatus(endpoint, profile, invocation, agentDir);
	if (status.manager === "launch-daemon" && status.pid && status.reachable) {
		await assertRuntimeIdle(endpoint);
		// 同用户的 Runtime 接收重启信号，由 launchd 拉起，无需后台 sudo 授权。
		process.kill(status.pid, "SIGUSR2");
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const pid = readRuntimePid(endpoint, agentDir);
			if (pid && pid !== status.pid && (await probeIpcRuntime(endpoint)).reachable) {
				return getRuntimeServiceStatus(endpoint, profile, invocation, agentDir);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("Web Runtime 重启超时，请运行 lc web service status 查看服务状态");
	}
	await stopRuntimeService(endpoint, false, profile, invocation, false, agentDir);
	return ensureRuntimeService(endpoint, profile, invocation, false, agentDir);
}

export async function stopRuntimeService(
	endpoint: string,
	force: boolean,
	profile?: string,
	invocation?: WebServiceInvocation,
	interactiveAdmin = false,
	agentDir?: string,
): Promise<RuntimeServiceStatus> {
	const status = await getRuntimeServiceStatus(endpoint, profile, invocation, agentDir);
	if (!force) await assertRuntimeIdle(endpoint);
	const spec = createRuntimeServiceSpec(endpoint, {
		...(profile ? { profile } : {}),
		...(invocation ? { invocation } : {}),
		...(agentDir ? { agentDir } : {}),
	});
	stopWebService(spec, force, { detachedPid: status.pid, interactiveAdmin });
	await waitUntilUnreachable(endpoint);
	return getRuntimeServiceStatus(endpoint, profile, invocation, agentDir);
}

export function startDetachedRuntime(endpoint: string): void {
	const invocation = createRuntimeServiceSpec(endpoint).invocation;
	const child = spawn(invocation.program, invocation.args, {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, PI_CODING_AGENT_DIR: getRuntimeAgentDir(), PI_WEB_RUNTIME_ENDPOINT: endpoint },
	});
	child.unref();
}

export function removeRuntimeService(
	endpoint = defaultRuntimeEndpoint(getRuntimeAgentDir()),
	profile?: string,
	invocation?: WebServiceInvocation,
	interactiveAdmin = false,
	agentDir?: string,
): void {
	removeWebService(
		createRuntimeServiceSpec(endpoint, {
			...(profile ? { profile } : {}),
			...(invocation ? { invocation } : {}),
			...(agentDir ? { agentDir } : {}),
		}),
		{ interactiveAdmin },
	);
}

export function hostServiceDiagnostic(endpoint: string, profile?: string, agentDir?: string): string {
	return webServiceDiagnostic(
		createRuntimeServiceSpec(endpoint, {
			...(profile ? { profile } : {}),
			...(agentDir ? { agentDir } : {}),
		}),
	);
}

export { defaultRuntimeEndpoint } from "./ipc.ts";
