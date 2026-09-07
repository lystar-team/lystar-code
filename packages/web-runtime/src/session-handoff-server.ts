import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
	getWebSessionHandoffEndpoint,
	WEB_SESSION_HANDOFF_PROTOCOL_VERSION,
	type WebSessionHandoffCommand,
	type WebSessionHandoffServerMessage,
} from "@earendil-works/pi-coding-agent/core";

const MAX_HANDOFF_BYTES = 64 * 1024;
const HANDOFF_REQUEST_TIMEOUT_MS = 10_000;

function send(socket: Socket, message: WebSessionHandoffServerMessage): void {
	if (!socket.destroyed && socket.writable) socket.end(`${JSON.stringify(message)}\n`);
}

function errorResponse(error: unknown): Extract<WebSessionHandoffServerMessage, { ok: false }> {
	const value = error as { message?: unknown; code?: unknown; retryable?: unknown };
	return {
		type: "handoff_result",
		ok: false,
		error: typeof value?.message === "string" ? value.message : String(error),
		...(typeof value?.code === "string" ? { code: value.code } : {}),
		...(typeof value?.retryable === "boolean" ? { retryable: value.retryable } : {}),
	};
}

function connect(endpoint: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(endpoint);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

async function removeStaleEndpoint(endpoint: string): Promise<void> {
	if (process.platform === "win32" || !existsSync(endpoint)) return;
	try {
		const socket = await connect(endpoint);
		socket.destroy();
		throw Object.assign(new Error(`Web 会话交接通道已存在：${endpoint}`), { code: "handoff_already_running" });
	} catch (error) {
		if ((error as { code?: string }).code === "handoff_already_running") throw error;
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ECONNREFUSED" && code !== "ENOENT") throw error;
		if (existsSync(endpoint)) unlinkSync(endpoint);
	}
}

function assertPrivateEndpoint(endpoint: string): void {
	if (process.platform === "win32") return;
	const stat = statSync(endpoint);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`Web 会话交接通道属于其他用户：${endpoint}`);
	}
	if ((stat.mode & 0o077) !== 0) throw new Error(`Web 会话交接通道权限不安全：${endpoint}`);
}

export class WebSessionHandoffServer {
	private readonly sockets = new Set<Socket>();
	private server?: Server;
	private handoff?: Promise<void>;
	private closed = false;
	private readonly endpoint: string;
	private readonly sessionPath: string;
	private readonly onHandoff: () => Promise<void>;
	private readonly onClosed?: () => void;

	constructor(agentDir: string, sessionPath: string, onHandoff: () => Promise<void>, onClosed?: () => void) {
		this.endpoint = getWebSessionHandoffEndpoint(agentDir, sessionPath);
		this.sessionPath = sessionPath;
		this.onHandoff = onHandoff;
		this.onClosed = onClosed;
	}

	async start(): Promise<void> {
		if (this.server || this.closed) return;
		if (process.platform !== "win32") mkdirSync(dirname(this.endpoint), { recursive: true, mode: 0o700 });
		await removeStaleEndpoint(this.endpoint);
		const server = createServer((socket) => this.accept(socket));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.endpoint, resolve);
		});
		this.server = server;
		if (process.platform !== "win32") {
			chmodSync(this.endpoint, 0o600);
			assertPrivateEndpoint(this.endpoint);
		}
		server.once("close", () => {
			if (process.platform !== "win32" && existsSync(this.endpoint)) unlinkSync(this.endpoint);
			this.onClosed?.();
		});
	}

	async dispose(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		const server = this.server;
		this.server = undefined;
		if (server?.listening) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		let handled = false;
		const timer = setTimeout(() => socket.destroy(), HANDOFF_REQUEST_TIMEOUT_MS);
		timer.unref?.();
		socket.on("data", (chunk: string) => {
			if (handled) return;
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) {
				if (Buffer.byteLength(buffer) > MAX_HANDOFF_BYTES) socket.destroy();
				return;
			}
			handled = true;
			clearTimeout(timer);
			void this.handle(socket, buffer.slice(0, newline));
		});
		const cleanup = () => {
			clearTimeout(timer);
			this.sockets.delete(socket);
		};
		socket.once("close", cleanup);
		socket.once("error", cleanup);
	}

	private async handle(socket: Socket, line: string): Promise<void> {
		let command: WebSessionHandoffCommand;
		try {
			command = JSON.parse(line) as WebSessionHandoffCommand;
		} catch {
			socket.destroy();
			return;
		}
		if (
			command.type !== "handoff" ||
			command.protocolVersion !== WEB_SESSION_HANDOFF_PROTOCOL_VERSION ||
			command.sessionPath !== this.sessionPath
		) {
			socket.destroy();
			return;
		}
		try {
			this.handoff ??= this.onHandoff().catch((error) => {
				this.handoff = undefined;
				throw error;
			});
			await this.handoff;
			this.closeListener();
			send(socket, { type: "handoff_result", ok: true });
		} catch (error) {
			send(socket, errorResponse(error));
		}
	}

	private closeListener(): void {
		if (this.closed) return;
		this.closed = true;
		const server = this.server;
		this.server = undefined;
		if (server?.listening) server.close();
	}
}
