import type { ByteTransport } from "@lystar/code-gui-protocol";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { SshConnectionProfile } from "./desktop-state.ts";

type TransportStatus = { type: "closed" } | { type: "error"; message: string };
export type TransportTarget = { kind: "local" } | { kind: "ssh"; profile: SshConnectionProfile };

class WebSocketByteTransport implements ByteTransport {
	private readonly socket: WebSocket;
	private readonly bytesListeners = new Set<(bytes: Uint8Array) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();
	private readonly opened: Promise<void>;

	constructor(url: string) {
		this.socket = new WebSocket(url);
		this.socket.binaryType = "arraybuffer";
		this.opened = new Promise((resolve, reject) => {
			this.socket.addEventListener("open", () => resolve(), { once: true });
			this.socket.addEventListener("error", () => reject(new Error("无法连接本地 GUI Host")), { once: true });
		});
		this.socket.addEventListener("message", (event) => {
			if (event.data instanceof ArrayBuffer) {
				const bytes = new Uint8Array(event.data);
				for (const listener of this.bytesListeners) listener(bytes);
			}
		});
		this.socket.addEventListener("close", () => {
			for (const listener of this.closeListeners) listener();
		});
	}

	async send(bytes: Uint8Array): Promise<void> {
		await this.opened;
		if (this.socket.readyState !== WebSocket.OPEN) throw new Error("GUI 后台连接已关闭");
		this.socket.send(bytes);
	}

	async close(): Promise<void> {
		if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
	}

	onBytes(listener: (bytes: Uint8Array) => void): () => void {
		this.bytesListeners.add(listener);
		return () => this.bytesListeners.delete(listener);
	}

	onClose(listener: (error?: Error) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}
}

class TauriByteTransport implements ByteTransport {
	private readonly bytesListeners = new Set<(bytes: Uint8Array) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();
	private connectionId?: string;

	static async open(target: TransportTarget): Promise<TauriByteTransport> {
		const transport = new TauriByteTransport();
		const bytes = new Channel<ArrayBuffer>();
		bytes.onmessage = (buffer) => {
			const chunk = new Uint8Array(buffer);
			for (const listener of transport.bytesListeners) listener(chunk);
		};
		const status = new Channel<TransportStatus>();
		status.onmessage = (event) => {
			transport.connectionId = undefined;
			const error = event.type === "error" ? new Error(event.message) : undefined;
			for (const listener of transport.closeListeners) listener(error);
		};
		transport.connectionId =
			target.kind === "ssh"
				? await invoke<string>("open_ssh_host", {
						profile: {
							target: target.profile.target,
							...(target.profile.user ? { user: target.profile.user } : {}),
							...(target.profile.port ? { port: target.profile.port } : {}),
							authMethod: target.profile.authMethod ?? "agent",
							...(target.profile.identityFile ? { identityFile: target.profile.identityFile } : {}),
							...(target.profile.credentialId ? { credentialId: target.profile.credentialId } : {}),
							platform: target.profile.platform ?? "auto",
							...(target.profile.hostCommand ? { hostCommand: target.profile.hostCommand } : {}),
						},
						bytes,
						status,
					})
				: await invoke<string>("open_gui_host", { bytes, status });
		return transport;
	}

	async send(bytes: Uint8Array): Promise<void> {
		if (!this.connectionId) throw new Error("GUI 后台连接已关闭");
		await invoke("write_gui_host", bytes, {
			headers: { "x-lystar-connection-id": this.connectionId },
		});
	}

	async close(): Promise<void> {
		if (!this.connectionId) return;
		const connectionId = this.connectionId;
		this.connectionId = undefined;
		await invoke("close_gui_host", { connectionId });
	}

	onBytes(listener: (bytes: Uint8Array) => void): () => void {
		this.bytesListeners.add(listener);
		return () => this.bytesListeners.delete(listener);
	}

	onClose(listener: (error?: Error) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}
}

export async function createByteTransport(target: TransportTarget = { kind: "local" }): Promise<ByteTransport> {
	if (isTauri()) return TauriByteTransport.open(target);
	if (target.kind === "ssh") throw new Error("SSH 连接只在桌面应用中可用");
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return new WebSocketByteTransport(`${protocol}//${location.hostname}:1421`);
}
