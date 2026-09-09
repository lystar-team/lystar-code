import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { WebRuntimeService } from "./service.ts";
import { runRuntimeStream, writeBounded } from "./stream-transport.ts";

export const REMOTE_PREFACE = "LYSTAR-WEB-RUNTIME/1\n";

const socketsByServer = new WeakMap<Server, Set<Socket>>();

export type RuntimeEndpoint = { kind: "socket"; path: string } | { kind: "tcp"; host: string; port: number };

export function defaultRuntimeEndpoint(agentDir: string): string {
	if (process.platform === "win32") {
		const suffix = createHash("sha256").update(agentDir).digest("hex").slice(0, 24);
		return `\\\\.\\pipe\\lystar-web-runtime-${suffix}`;
	}
	return join(agentDir, "host", "lystar-web-runtime.sock");
}

export function runtimeTcpEndpoint(host: string, port: number): string {
	const normalizedHost = host.trim().replace(/^\[|\]$/gu, "");
	if (!normalizedHost) throw new Error("Runtime 监听 IP 不能为空");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Runtime 端口必须在 1 到 65535 之间");
	return `tcp://${normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost}:${port}`;
}

export function parseRuntimeEndpoint(endpoint: string): RuntimeEndpoint {
	const value = endpoint.trim();
	if (!value) throw new Error("Runtime 连接地址不能为空");
	if (!value.startsWith("tcp://")) return { kind: "socket", path: value };
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new Error(`Runtime TCP 地址无效：${error instanceof Error ? error.message : String(error)}`);
	}
	const host = url.hostname.replace(/^\[|\]$/gu, "");
	const port = Number(url.port);
	if (url.protocol !== "tcp:" || !host || !Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("Runtime TCP 地址必须是 tcp://主机:端口");
	if (url.pathname && url.pathname !== "/") throw new Error("Runtime TCP 地址不能包含路径");
	if (url.username || url.password || url.search || url.hash) throw new Error("Runtime TCP 地址不能包含额外参数");
	return { kind: "tcp", host, port };
}

export function isTcpRuntimeEndpoint(endpoint: string): boolean {
	return parseRuntimeEndpoint(endpoint).kind === "tcp";
}

export function connectRuntimeEndpoint(endpoint: string, timeoutMs = 10_000): Promise<Socket> {
	const target = parseRuntimeEndpoint(endpoint);
	return new Promise((resolve, reject) => {
		let settled = false;
		const socket =
			target.kind === "tcp"
				? createConnection({ host: target.host, port: target.port })
				: createConnection(target.path);
		const timer = setTimeout(() => fail(new Error("Web Runtime IPC 连接超时")), timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			socket.off("error", onError);
			socket.off("close", onClose);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.destroy();
			reject(error);
		};
		const onError = (error: Error) => fail(error);
		const onClose = () => fail(new Error("Web Runtime IPC 连接已关闭"));
		socket.once("error", onError);
		socket.once("close", onClose);
		socket.once("connect", () => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.setNoDelay(true);
			socket.setKeepAlive(true, 10_000);
			resolve(socket);
		});
	});
}

async function removeStaleEndpoint(endpoint: string): Promise<void> {
	if (parseRuntimeEndpoint(endpoint).kind === "tcp" || !existsSync(endpoint)) return;
	try {
		const socket = await connectRuntimeEndpoint(endpoint);
		socket.destroy();
		throw Object.assign(new Error(`Web Runtime is already running at ${endpoint}`), { code: "host_already_running" });
	} catch (error) {
		if ((error as { code?: string }).code === "host_already_running") throw error;
		unlinkSync(endpoint);
	}
}

function assertPrivateEndpoint(endpoint: string): void {
	if (parseRuntimeEndpoint(endpoint).kind === "tcp" || process.platform === "win32") return;
	const stat = statSync(endpoint);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`Web Runtime endpoint is owned by another user: ${endpoint}`);
	}
	if ((stat.mode & 0o077) !== 0) throw new Error(`Web Runtime endpoint permissions are not private: ${endpoint}`);
}

export async function serveIpcRuntime(service: WebRuntimeService, endpoint: string): Promise<Server> {
	const target = parseRuntimeEndpoint(endpoint);
	if (target.kind === "socket") {
		mkdirSync(dirname(target.path), { recursive: true, mode: 0o700 });
		await removeStaleEndpoint(target.path);
	}
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		void runRuntimeStream(service, socket, socket).then(
			() => socket.end(),
			() => socket.destroy(),
		);
	});
	socketsByServer.set(server, sockets);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		if (target.kind === "tcp") server.listen({ host: target.host, port: target.port }, resolve);
		else server.listen(target.path, resolve);
	});
	if (target.kind === "socket" && process.platform !== "win32") {
		chmodSync(target.path, 0o600);
		assertPrivateEndpoint(target.path);
	}
	server.once("close", () => {
		socketsByServer.delete(server);
		if (target.kind === "socket" && process.platform !== "win32" && existsSync(target.path)) unlinkSync(target.path);
	});
	return server;
}

export async function closeIpcRuntime(server: Server): Promise<void> {
	for (const socket of socketsByServer.get(server) ?? []) socket.destroy();
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

export async function runIpcRelay(endpoint: string, preface = false): Promise<void> {
	assertPrivateEndpoint(endpoint);
	const socket = await connectRuntimeEndpoint(endpoint);
	if (preface) await writeBounded(process.stdout, Buffer.from(REMOTE_PREFACE));
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
	await new Promise<void>((resolve, reject) => {
		socket.once("close", resolve);
		socket.once("error", reject);
		process.stdin.once("error", reject);
	});
}

export async function probeIpcRuntime(endpoint: string): Promise<{ endpoint: string; reachable: boolean }> {
	try {
		assertPrivateEndpoint(endpoint);
		const socket = await connectRuntimeEndpoint(endpoint);
		socket.destroy();
		return { endpoint, reachable: true };
	} catch {
		return { endpoint, reachable: false };
	}
}
