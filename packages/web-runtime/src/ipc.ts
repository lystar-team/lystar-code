import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { WebRuntimeService } from "./service.ts";
import { runRuntimeStream, writeBounded } from "./stream-transport.ts";

export const REMOTE_PREFACE = "LYSTAR-WEB-RUNTIME/1\n";

const socketsByServer = new WeakMap<Server, Set<Socket>>();

export function defaultRuntimeEndpoint(agentDir: string): string {
	if (process.platform === "win32") {
		const suffix = createHash("sha256").update(agentDir).digest("hex").slice(0, 24);
		return `\\\\.\\pipe\\lystar-web-runtime-${suffix}`;
	}
	return join(agentDir, "host", "lystar-web-runtime.sock");
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
		throw Object.assign(new Error(`Web Runtime is already running at ${endpoint}`), { code: "host_already_running" });
	} catch (error) {
		if ((error as { code?: string }).code === "host_already_running") throw error;
		unlinkSync(endpoint);
	}
}

function assertPrivateEndpoint(endpoint: string): void {
	if (process.platform === "win32") return;
	const stat = statSync(endpoint);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`Web Runtime endpoint is owned by another user: ${endpoint}`);
	}
	if ((stat.mode & 0o077) !== 0) throw new Error(`Web Runtime endpoint permissions are not private: ${endpoint}`);
}

export async function serveIpcRuntime(service: WebRuntimeService, endpoint: string): Promise<Server> {
	if (process.platform !== "win32") mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
	await removeStaleEndpoint(endpoint);
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
		server.listen(endpoint, resolve);
	});
	if (process.platform !== "win32") {
		chmodSync(endpoint, 0o600);
		assertPrivateEndpoint(endpoint);
	}
	server.once("close", () => {
		socketsByServer.delete(server);
		if (process.platform !== "win32" && existsSync(endpoint)) unlinkSync(endpoint);
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
	if (process.platform !== "win32") assertPrivateEndpoint(endpoint);
	const socket = await connect(endpoint);
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
		if (process.platform !== "win32") assertPrivateEndpoint(endpoint);
		const socket = await connect(endpoint);
		socket.destroy();
		return { endpoint, reachable: true };
	} catch {
		return { endpoint, reachable: false };
	}
}
