import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ByteTransport, RuntimeProtocolClient, ServerEvent } from "@lystar/code-web-protocol";
import {
	type OperationSnapshot,
	RuntimeProtocolClient as ProtocolClient,
	type SessionStateSnapshot,
} from "@lystar/code-web-protocol";
import { defaultRuntimeEndpoint, probeIpcRuntime } from "@lystar/code-web-runtime";
import type { WebGatewayConfig } from "./config.ts";

class SocketByteTransport implements ByteTransport {
	private readonly bytesListeners = new Set<(bytes: Uint8Array) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();
	private closed = false;
	private notifiedClose = false;
	private sendQueue = Promise.resolve();
	private sendFailure?: Error;

	private readonly socket: Socket;

	private constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer) => {
			for (const listener of this.bytesListeners) listener(new Uint8Array(chunk));
		});
		socket.on("error", (error) => this.notifyClose(error));
		socket.on("close", () => this.notifyClose());
	}

	static connect(endpoint: string): Promise<SocketByteTransport> {
		return new Promise((resolve, reject) => {
			const socket = createConnection(endpoint);
			let settled = false;
			const timer = setTimeout(() => {
				fail(new Error("Web Host IPC 连接超时"));
			}, 10_000);
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.off("error", onError);
				socket.off("close", onClose);
				socket.destroy();
				reject(error);
			};
			const onError = (error: Error) => fail(error);
			const onClose = () => fail(new Error("Web Host IPC 连接已关闭"));
			socket.once("error", onError);
			socket.once("close", onClose);
			socket.once("connect", () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.off("error", onError);
				socket.off("close", onClose);
				socket.setNoDelay(true);
				socket.setKeepAlive(true, 10_000);
				resolve(new SocketByteTransport(socket));
			});
		});
	}

	async send(bytes: Uint8Array): Promise<void> {
		if (this.closed) throw this.sendFailure ?? new Error("Web Runtime IPC 连接已关闭");
		const send = this.sendQueue.then(() => {
			if (this.closed) throw this.sendFailure ?? new Error("Web Runtime IPC 连接已关闭");
			return new Promise<void>((resolvePromise, reject) => {
				let settled = false;
				const cleanup = () => {
					this.socket.off("drain", onDrain);
					this.socket.off("error", onError);
					this.socket.off("close", onClose);
				};
				const resolveOnce = () => {
					if (settled) return;
					settled = true;
					cleanup();
					resolvePromise();
				};
				const rejectOnce = (error: Error) => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(error);
				};
				const onDrain = () => resolveOnce();
				const onError = (error: Error) => rejectOnce(error);
				const onClose = () => rejectOnce(this.sendFailure ?? new Error("Web Runtime IPC 连接已关闭"));
				this.socket.once("error", onError);
				this.socket.once("close", onClose);
				try {
					if (this.socket.write(bytes)) resolveOnce();
					else this.socket.once("drain", onDrain);
				} catch (error) {
					rejectOnce(error instanceof Error ? error : new Error(String(error)));
				}
			});
		});
		this.sendQueue = send.catch((error) => {
			this.sendFailure = error instanceof Error ? error : new Error(String(error));
		});
		return send;
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

async function waitForHello(client: RuntimeProtocolClient): Promise<void> {
	if (client.getSnapshot().connected) return;
	await new Promise<void>((resolvePromise, reject) => {
		let unsubscribe = () => {};
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(client.getSnapshot().lastError ?? "Web Runtime 连接超时"));
		}, 10_000);
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

function runtimeCommand(): { command: string; args: string[]; cwd: string } {
	const root = repositoryRoot();
	const builtCli = resolve(root, "packages/web-runtime/dist/cli.js");
	if (existsSync(builtCli)) return { command: process.execPath, args: [builtCli, "serve"], cwd: root };
	const sourceCli = resolve(root, "packages/web-runtime/src/cli.ts");
	if (existsSync(sourceCli)) {
		return {
			command: process.execPath,
			args: ["--import", import.meta.resolve("tsx"), sourceCli, "serve"],
			cwd: root,
		};
	}
	return { command: "lystar-web-runtime", args: ["serve"], cwd: process.cwd() };
}

const runtimeStartupPromises = new Map<string, Promise<void>>();

export function ensurePersistentRuntime(config: WebGatewayConfig): Promise<void> {
	const existing = runtimeStartupPromises.get(config.runtimeEndpoint);
	if (existing) return existing;
	const promise = (async () => {
		if ((await probeIpcRuntime(config.runtimeEndpoint)).reachable) return;
		if (!config.manageRuntime) throw new Error(`Web Runtime 未运行：${config.runtimeEndpoint}`);
		const command = runtimeCommand();
		const child = spawn(command.command, command.args, {
			cwd: command.cwd,
			env: { ...process.env, PI_WEB_RUNTIME_ENDPOINT: config.runtimeEndpoint },
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
	runtimeStartupPromises.set(config.runtimeEndpoint, promise);
	return promise.finally(() => {
		if (runtimeStartupPromises.get(config.runtimeEndpoint) === promise)
			runtimeStartupPromises.delete(config.runtimeEndpoint);
	});
}

export async function connectRuntimeClient(
	config: WebGatewayConfig,
	clientInstanceId: string,
	onEvent: (event: ServerEvent) => void,
	onClose: (error?: Error) => void,
): Promise<{ client: RuntimeProtocolClient; initial: RuntimeInitialSnapshot }> {
	await ensurePersistentRuntime(config);
	const transport = await SocketByteTransport.connect(config.runtimeEndpoint);
	transport.onClose(onClose);
	const client = new ProtocolClient(transport, clientInstanceId, { trustedServerMessages: true });
	client.onEvent(onEvent);
	await client.connect();
	await waitForHello(client);
	const initial = await client.request<RuntimeInitialSnapshot>({ command: "get_snapshot" }, { timeoutMs: 10_000 });
	return { client, initial };
}

export function endpointForAgentDir(agentDir: string): string {
	return defaultRuntimeEndpoint(agentDir);
}
