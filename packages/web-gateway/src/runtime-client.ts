import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ByteTransport, RuntimeProtocolClient, ServerEvent } from "@lystar/code-web-protocol";
import {
	type OperationSnapshot,
	RuntimeProtocolClient as ProtocolClient,
	RUNTIME_PROTOCOL_VERSION,
	RuntimeProtocolError,
	type SessionStateSnapshot,
} from "@lystar/code-web-protocol";
import {
	connectRuntimeEndpoint,
	createBoundedWriter,
	defaultRuntimeEndpoint,
	ensureRuntimeService,
	getRuntimeServiceStatus,
	probeIpcRuntime,
	stopRuntimeService,
	type WebServiceInvocation,
} from "@lystar/code-web-runtime";
import type { WebGatewayConfig } from "./config.ts";

class SocketByteTransport implements ByteTransport {
	private readonly bytesListeners = new Set<(bytes: Uint8Array) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();
	private closed = false;
	private notifiedClose = false;
	private readonly write: (bytes: Uint8Array) => Promise<void>;
	private sendFailure?: Error;

	private readonly socket: Socket;

	private constructor(socket: Socket) {
		this.socket = socket;
		this.write = createBoundedWriter(socket);
		socket.on("data", (chunk: Buffer) => {
			for (const listener of this.bytesListeners) listener(new Uint8Array(chunk));
		});
		socket.on("error", (error) => this.notifyClose(error));
		socket.on("close", () => this.notifyClose());
	}

	static connect(endpoint: string): Promise<SocketByteTransport> {
		return connectRuntimeEndpoint(endpoint).then((socket) => new SocketByteTransport(socket));
	}

	async send(bytes: Uint8Array): Promise<void> {
		if (this.closed) throw this.sendFailure ?? new Error("Web Runtime IPC 连接已关闭");
		return this.write(bytes);
	}

	async close(): Promise<void> {
		if (this.notifiedClose) return;
		this.notifyClose(new Error("Web Runtime IPC 连接已关闭"));
		this.socket.end();
		this.socket.destroy();
	}

	onBytes(listener: (bytes: Uint8Array) => void): () => void {
		this.bytesListeners.add(listener);
		return () => this.bytesListeners.delete(listener);
	}

	onClose(listener: (error?: Error) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	private notifyClose(error?: Error): void {
		if (this.notifiedClose) return;
		this.closed = true;
		this.notifiedClose = true;
		this.sendFailure = error ?? new Error("Web Runtime IPC 连接已关闭");
		for (const listener of this.closeListeners) listener(error);
	}
}

export interface RuntimeInitialSnapshot {
	sessions: SessionStateSnapshot[];
	operations: OperationSnapshot[];
	pendingUiRequests: Extract<ServerEvent, { type: "ui_request" }>[];
	startupSessionPath?: string;
	startupCwd?: string;
}

async function waitForHello(client: RuntimeProtocolClient, timeoutMs = 10_000): Promise<void> {
	if (client.getSnapshot().connected) return;
	await new Promise<void>((resolvePromise, reject) => {
		let unsubscribe = () => {};
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(client.getSnapshot().lastError ?? "Web Runtime 连接超时"));
		}, timeoutMs);
		unsubscribe = client.subscribe(() => {
			const snapshot = client.getSnapshot();
			if (!snapshot.connected && !snapshot.lastError) return;
			clearTimeout(timer);
			unsubscribe();
			if (snapshot.connected) resolvePromise();
			else reject(new Error(snapshot.lastError ?? "Web Runtime 连接失败"));
		});
	});
}

function repositoryRoot(): string {
	const currentDirectory = resolve(dirname(fileURLToPath(import.meta.url)));
	for (const candidate of [resolve(currentDirectory, "../.."), resolve(currentDirectory, "../../..")]) {
		if (existsSync(resolve(candidate, "packages/web-runtime/dist/cli.js"))) return candidate;
	}
	return resolve(currentDirectory, "../..");
}

function runtimeCommand(endpoint: string): { command: string; args: string[]; cwd: string } {
	const root = repositoryRoot();
	const builtCli = resolve(root, "packages/web-runtime/dist/cli.js");
	if (existsSync(builtCli))
		return { command: process.execPath, args: [builtCli, "serve", "--endpoint", endpoint], cwd: root };
	const sourceCli = resolve(root, "packages/web-runtime/src/cli.ts");
	if (existsSync(sourceCli)) {
		return {
			command: process.execPath,
			args: ["--import", import.meta.resolve("tsx"), sourceCli, "serve", "--endpoint", endpoint],
			cwd: root,
		};
	}
	return { command: "lystar-web-runtime", args: ["serve", "--endpoint", endpoint], cwd: process.cwd() };
}

function withRuntimeEndpoint(args: readonly string[], endpoint: string): string[] {
	const endpointIndex = args.findIndex((argument) => argument === "--endpoint" || argument.startsWith("--endpoint="));
	if (endpointIndex === -1) return [...args, "--endpoint", endpoint];
	if (args[endpointIndex] === "--endpoint") {
		return [...args.slice(0, endpointIndex + 1), endpoint, ...args.slice(endpointIndex + 2)];
	}
	return [...args.slice(0, endpointIndex), `--endpoint=${endpoint}`, ...args.slice(endpointIndex + 1)];
}

const runtimeStartupPromises = new Map<string, Promise<void>>();
const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "waiting_for_input"]);

function incompatibleRuntimeVersion(error: unknown): number | undefined {
	if (error instanceof RuntimeProtocolError && error.code !== "version") return undefined;
	const message = error instanceof Error ? error.message : String(error);
	if (!message.startsWith("Web Runtime Protocol ") || !message.includes(" is unsupported; Host requires "))
		return undefined;
	const match = /Host requires (\d+)/u.exec(message);
	if (!match) return undefined;
	const version = Number.parseInt(match[1]!, 10);
	return Number.isInteger(version) && version >= 0 && version !== RUNTIME_PROTOCOL_VERSION ? version : undefined;
}

async function readLegacyRuntimeSnapshot(endpoint: string, protocolVersion: number): Promise<RuntimeInitialSnapshot> {
	const transport = await SocketByteTransport.connect(endpoint);
	const client = new ProtocolClient(transport, `gateway-compat-${process.pid}`, {
		trustedServerMessages: true,
		protocolVersion,
	});
	try {
		await client.connect();
		await waitForHello(client);
		return await client.request<RuntimeInitialSnapshot>({ command: "get_snapshot" }, { timeoutMs: 5_000 });
	} finally {
		await client.close().catch(() => {});
	}
}

function runtimeIsBusy(snapshot: RuntimeInitialSnapshot): boolean {
	return (
		snapshot.pendingUiRequests.length > 0 ||
		snapshot.operations.some((operation) => ACTIVE_OPERATION_STATUSES.has(operation.status)) ||
		snapshot.sessions.some(
			(session) =>
				session.activity === "running" ||
				session.activity === "waiting_for_input" ||
				["turn", "compaction", "retry", "waiting_for_input"].includes(session.phase),
		)
	);
}

function runtimeServiceInvocation(config: WebGatewayConfig): WebServiceInvocation | undefined {
	return config.runtimeInvocation
		? {
				program: config.runtimeInvocation.command,
				args: config.runtimeInvocation.args,
				cwd: config.runtimeInvocation.cwd,
			}
		: undefined;
}

async function hasIncompatibleRuntimeVersion(endpoint: string): Promise<boolean> {
	const transport = await SocketByteTransport.connect(endpoint).catch(() => undefined);
	if (!transport) return false;
	const client = new ProtocolClient(transport, `gateway-version-probe-${process.pid}`, {
		trustedServerMessages: true,
	});
	try {
		await client.connect();
		await waitForHello(client, 1_000);
		return false;
	} catch (error) {
		return incompatibleRuntimeVersion(error) !== undefined;
	} finally {
		await client.close().catch(() => {});
	}
}

export function ensurePersistentRuntime(config: WebGatewayConfig): Promise<void> {
	const startupKey = [config.agentDir, config.serviceProfile ?? "default", config.runtimeEndpoint].join("\0");
	const existing = runtimeStartupPromises.get(startupKey);
	if (existing) return existing;
	const promise = (async () => {
		const serviceProfile = config.serviceProfile;
		const serviceInvocation = runtimeServiceInvocation(config);
		const status = await getRuntimeServiceStatus(
			config.runtimeEndpoint,
			serviceProfile,
			serviceInvocation,
			config.agentDir,
		);
		if (status.responsive) return;
		if (!config.manageRuntime) throw new Error(`Web Runtime 未运行或无响应：${config.runtimeEndpoint}`);
		if (status.installed) {
			if (status.reachable && (await hasIncompatibleRuntimeVersion(config.runtimeEndpoint))) return;
			await ensureRuntimeService(config.runtimeEndpoint, serviceProfile, serviceInvocation, false, config.agentDir);
			return;
		}
		if (status.reachable) return;
		const command = config.runtimeInvocation ?? runtimeCommand(config.runtimeEndpoint);
		const child = spawn(command.command, withRuntimeEndpoint(command.args, config.runtimeEndpoint), {
			cwd: command.cwd,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: config.agentDir,
				PI_WEB_RUNTIME_ENDPOINT: config.runtimeEndpoint,
				PI_WEB_SERVICE_PROFILE: config.serviceProfile ?? "default",
			},
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if ((await probeIpcRuntime(config.runtimeEndpoint)).reachable) return;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
		}
		throw new Error("Web Runtime 启动超时，请检查 Web Runtime 进程和日志");
	})();
	runtimeStartupPromises.set(startupKey, promise);
	return promise.finally(() => {
		if (runtimeStartupPromises.get(startupKey) === promise) runtimeStartupPromises.delete(startupKey);
	});
}

async function openRuntimeClient(
	config: WebGatewayConfig,
	clientInstanceId: string,
	onEvent: (event: ServerEvent) => void,
	onClose: (error?: Error) => void,
): Promise<{ client: RuntimeProtocolClient; initial: RuntimeInitialSnapshot }> {
	const transport = await SocketByteTransport.connect(config.runtimeEndpoint);
	const client = new ProtocolClient(transport, clientInstanceId, { trustedServerMessages: true });
	client.onEvent(onEvent);
	try {
		await client.connect();
		await waitForHello(client);
		const initial = await client.request<RuntimeInitialSnapshot>({ command: "get_snapshot" }, { timeoutMs: 10_000 });
		transport.onClose(onClose);
		return { client, initial };
	} catch (error) {
		await client.close().catch(() => {});
		throw error;
	}
}

export async function connectRuntimeClient(
	config: WebGatewayConfig,
	clientInstanceId: string,
	onEvent: (event: ServerEvent) => void,
	onClose: (error?: Error) => void,
): Promise<{ client: RuntimeProtocolClient; initial: RuntimeInitialSnapshot }> {
	await ensurePersistentRuntime(config);
	const serviceInvocation = runtimeServiceInvocation(config);
	try {
		return await openRuntimeClient(config, clientInstanceId, onEvent, onClose);
	} catch (error) {
		const legacyVersion = incompatibleRuntimeVersion(error);
		if (!config.manageRuntime || legacyVersion === undefined) throw error;
		const legacy = await readLegacyRuntimeSnapshot(config.runtimeEndpoint, legacyVersion).catch(() => undefined);
		if (!legacy) {
			throw new RuntimeProtocolError(
				"version",
				`${error instanceof Error ? error.message : String(error)}；无法读取旧 Runtime 状态，请运行 lc web runtime restart`,
				false,
			);
		}
		if (runtimeIsBusy(legacy)) {
			throw new RuntimeProtocolError(
				"version",
				`${error instanceof Error ? error.message : String(error)}；旧 Runtime 仍有运行任务，任务结束后将自动切换`,
				true,
			);
		}
		const status = await getRuntimeServiceStatus(
			config.runtimeEndpoint,
			config.serviceProfile,
			serviceInvocation,
			config.agentDir,
		);
		if (!status.pid && !status.installed) {
			throw new RuntimeProtocolError(
				"version",
				`${error instanceof Error ? error.message : String(error)}；无法定位旧 Runtime 进程，请运行 lc web runtime restart`,
				false,
			);
		}
		await stopRuntimeService(
			config.runtimeEndpoint,
			true,
			config.serviceProfile,
			serviceInvocation,
			false,
			config.agentDir,
		);
		await ensurePersistentRuntime(config);
		return openRuntimeClient(config, clientInstanceId, onEvent, onClose);
	}
}

export function endpointForAgentDir(agentDir: string): string {
	return defaultRuntimeEndpoint(agentDir);
}
