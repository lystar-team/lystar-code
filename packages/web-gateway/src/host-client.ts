import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultIpcEndpoint, probeIpcHost } from "@lystar/code-gui-host";
import type { ByteTransport, GuiProtocolClient, ServerEvent } from "@lystar/code-gui-protocol";
import {
	type OperationSnapshot,
	GuiProtocolClient as ProtocolClient,
	type SessionStateSnapshot,
} from "@lystar/code-gui-protocol";
import type { WebGatewayConfig } from "./config.ts";

class SocketByteTransport implements ByteTransport {
	private readonly bytesListeners = new Set<(bytes: Uint8Array) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();
	private closed = false;

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
			const onError = (error: Error) => {
				socket.destroy();
				reject(error);
			};
			socket.once("error", onError);
			socket.once("connect", () => {
				socket.off("error", onError);
				socket.setNoDelay(true);
				resolve(new SocketByteTransport(socket));
			});
		});
	}

	async send(bytes: Uint8Array): Promise<void> {
		if (this.closed) throw new Error("Web Host IPC 连接已关闭");
		await new Promise<void>((resolvePromise, reject) => {
			const onError = (error: Error) => {
				this.socket.off("drain", onDrain);
				reject(error);
			};
			const onDrain = () => {
				this.socket.off("error", onError);
				resolvePromise();
			};
			this.socket.once("error", onError);
			if (this.socket.write(bytes)) {
				this.socket.off("error", onError);
				resolvePromise();
			} else {
				this.socket.once("drain", onDrain);
			}
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
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
		if (this.closed && !error) return;
		this.closed = true;
		for (const listener of this.closeListeners) listener(error);
	}
}

export interface HostInitialSnapshot {
	sessions: SessionStateSnapshot[];
	operations: OperationSnapshot[];
	pendingUiRequests: Extract<ServerEvent, { type: "ui_request" }>[];
	startupSessionPath?: string;
	startupCwd?: string;
}

async function waitForHello(client: GuiProtocolClient): Promise<void> {
	if (client.getSnapshot().connected) return;
	await new Promise<void>((resolvePromise, reject) => {
		let unsubscribe = () => {};
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(client.getSnapshot().lastError ?? "Web Host 连接超时"));
		}, 10_000);
		unsubscribe = client.subscribe(() => {
			const snapshot = client.getSnapshot();
			if (!snapshot.connected && !snapshot.lastError) return;
			clearTimeout(timer);
			unsubscribe();
			if (snapshot.connected) resolvePromise();
			else reject(new Error(snapshot.lastError ?? "Web Host 连接失败"));
		});
	});
}

function repositoryRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function hostCommand(): { command: string; args: string[]; cwd: string } {
	const root = repositoryRoot();
	const builtCli = resolve(root, "packages/gui-host/dist/cli.js");
	if (existsSync(builtCli)) return { command: process.execPath, args: [builtCli, "serve"], cwd: root };
	const sourceCli = resolve(root, "packages/gui-host/src/cli.ts");
	if (existsSync(sourceCli)) {
		return {
			command: process.execPath,
			args: ["--import", import.meta.resolve("tsx"), sourceCli, "serve"],
			cwd: root,
		};
	}
	return { command: "lystar-gui-host", args: ["serve"], cwd: process.cwd() };
}

export async function ensurePersistentHost(config: WebGatewayConfig): Promise<void> {
	if ((await probeIpcHost(config.hostEndpoint)).reachable) return;
	if (!config.manageHost) throw new Error(`Web Host 未运行：${config.hostEndpoint}`);
	const command = hostCommand();
	const child = spawn(command.command, command.args, {
		cwd: command.cwd,
		env: { ...process.env, PI_GUI_HOST_ENDPOINT: config.hostEndpoint },
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if ((await probeIpcHost(config.hostEndpoint)).reachable) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	throw new Error("Web Host 启动超时，请检查 Web Host 进程和日志");
}

export async function connectHostClient(
	config: WebGatewayConfig,
	clientInstanceId: string,
	onEvent: (event: ServerEvent) => void,
	onClose: (error?: Error) => void,
): Promise<{ client: GuiProtocolClient; initial: HostInitialSnapshot }> {
	await ensurePersistentHost(config);
	const transport = await SocketByteTransport.connect(config.hostEndpoint);
	transport.onClose(onClose);
	const client = new ProtocolClient(transport, clientInstanceId);
	client.onEvent(onEvent);
	await client.connect();
	await waitForHello(client);
	const initial = await client.request<HostInitialSnapshot>({ command: "get_snapshot" }, { timeoutMs: 10_000 });
	return { client, initial };
}

export function endpointForAgentDir(agentDir: string): string {
	return defaultIpcEndpoint(agentDir);
}
