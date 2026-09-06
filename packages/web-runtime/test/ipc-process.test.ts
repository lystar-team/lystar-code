import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { encodeClientMessage, type ServerMessage, ServerMessageDecoder } from "@lystar/code-web-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { REMOTE_PREFACE } from "../src/ipc.ts";

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const PROCESS_START_TIMEOUT_MS = 15_000;
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const hostFixture = fileURLToPath(new URL("./fixtures/ipc-runtime-worker.mjs", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

afterEach(async () => {
	const exits = [...children].map((child) => waitForExit(child));
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await withTimeout(
		"child process cleanup",
		Promise.all(exits).then(() => undefined),
		2_000,
	);
	children.clear();
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.clear();
});

function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs)),
	]);
}

function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

function waitForLine(
	child: ChildProcess & { stdout: Readable; stderr: Readable },
	stream: "stdout" | "stderr",
	text: string,
	timeoutMs = 5_000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${text}: ${output}`)), timeoutMs);
		child[stream].setEncoding("utf8");
		child[stream].on("data", (chunk: string) => {
			output += chunk;
			if (output.includes(text)) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Process exited ${code}: ${output}`));
		});
	});
}

function startRelay(agentDir: string, endpoint: string): ChildProcessWithoutNullStreams {
	const child = spawn(process.execPath, ["--import", tsxImport, cliPath, "connect", "--stdio"], {
		cwd: repositoryRoot,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_RUNTIME_ENDPOINT: endpoint },
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	return child;
}

function readRelayMessages(child: ChildProcessWithoutNullStreams): {
	ready: Promise<void>;
	messages: ServerMessage[];
	waitFor(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage>;
} {
	const decoder = new ServerMessageDecoder();
	const messages: ServerMessage[] = [];
	let buffer = Buffer.alloc(0);
	let prefaceRead = false;
	let markReady: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => {
		markReady = resolve;
	});
	child.stdout.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		if (!prefaceRead) {
			const index = buffer.indexOf(REMOTE_PREFACE);
			if (index === -1) return;
			buffer = buffer.subarray(index + Buffer.byteLength(REMOTE_PREFACE));
			prefaceRead = true;
			markReady?.();
		}
		if (buffer.length > 0) {
			messages.push(...decoder.push(buffer));
			buffer = Buffer.alloc(0);
		}
	});
	return {
		ready,
		messages,
		waitFor: async (predicate) => {
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				const message = messages.find(predicate);
				if (message) return message;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`Timed out waiting for relay message: ${JSON.stringify(messages)}`);
		},
	};
}

function connectSocket(endpoint: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(endpoint);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

function readSocketMessages(socket: Socket): {
	messages: ServerMessage[];
	waitFor(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage>;
} {
	const decoder = new ServerMessageDecoder();
	const messages: ServerMessage[] = [];
	socket.on("data", (chunk) => messages.push(...decoder.push(chunk)));
	return {
		messages,
		waitFor: async (predicate) => {
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				const message = messages.find(predicate);
				if (message) return message;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`Timed out waiting for socket message: ${JSON.stringify(messages)}`);
		},
	};
}

function response(id: string) {
	return (message: ServerMessage): boolean => message.type === "response" && message.id === id;
}

describe("Web Runtime persistent IPC", () => {
	if (process.platform !== "win32") {
		it("keeps an accepted operation alive after the SSH-style relay is killed", async () => {
			const agentDir = mkdtempSync(join(tmpdir(), "web-runtime-ipc-"));
			tempDirs.add(agentDir);
			const endpoint = join(agentDir, "host.sock");
			const host = spawn(process.execPath, ["--import", tsxImport, hostFixture, agentDir, endpoint], {
				cwd: repositoryRoot,
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.add(host);
			await withTimeout(
				"Host ready",
				waitForLine(host, "stderr", "ready", PROCESS_START_TIMEOUT_MS),
				PROCESS_START_TIMEOUT_MS,
			);

			const firstRelay = startRelay(agentDir, endpoint);
			const first = readRelayMessages(firstRelay);
			await withTimeout("first relay ready", first.ready, PROCESS_START_TIMEOUT_MS);
			firstRelay.stdin.write(encodeClientMessage({ type: "hello", version: 2, clientInstanceId: "client" }));
			const firstHello = await withTimeout(
				"first relay hello",
				first.waitFor((message) => message.type === "hello"),
			);
			if (firstHello.type !== "hello") throw new Error("Missing first Host hello");
			expect(firstHello.capabilities).toContain("remote-detach");
			firstRelay.stdin.write(
				encodeClientMessage({
					type: "request",
					id: "create",
					request: {
						command: "create_session",
						cwd: agentDir,
						clientInstanceId: "client",
						clientRequestId: "create-session",
					},
				}),
			);
			const create = await withTimeout("create Session", first.waitFor(response("create")));
			if (create.type !== "response" || !create.ok) throw new Error("Session creation failed");
			const result = create.result as { lease: { leaseId: string }; snapshot: { path: string } };
			firstRelay.stdin.write(
				encodeClientMessage({
					type: "request",
					id: "prompt",
					request: {
						command: "prompt",
						sessionPath: result.snapshot.path,
						leaseId: result.lease.leaseId,
						clientInstanceId: "client",
						clientRequestId: "persistent-request",
						text: "continue remotely",
					},
				}),
			);
			const accepted = await withTimeout("prompt accepted", first.waitFor(response("prompt")));
			if (accepted.type !== "response" || !accepted.ok) throw new Error("Prompt was not accepted");
			const operationId = (accepted.result as { operation: { operationId: string } }).operation.operationId;
			const exited = waitForExit(firstRelay);
			if (firstRelay.exitCode === null && firstRelay.signalCode === null) firstRelay.kill("SIGKILL");
			await withTimeout("first relay exit", exited, 2_000);
			children.delete(firstRelay);
			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(host.exitCode).toBeNull();

			const secondSocket = await withTimeout("second socket connect", connectSocket(endpoint));
			const second = readSocketMessages(secondSocket);
			secondSocket.write(encodeClientMessage({ type: "hello", version: 2, clientInstanceId: "client" }));
			const secondHello = await withTimeout(
				"second socket hello",
				second.waitFor((message) => message.type === "hello"),
			);
			if (secondHello.type !== "hello") throw new Error("Missing resumed Host hello");
			expect(secondHello.hostInstanceId).toBe(firstHello.hostInstanceId);
			secondSocket.write(encodeClientMessage({ type: "request", id: "about", request: { command: "get_about" } }));
			await second.waitFor(response("about"));
			secondSocket.write(
				encodeClientMessage({
					type: "request",
					id: "operation",
					request: { command: "get_operation", operationId },
				}),
			);
			const completed = await second.waitFor(response("operation"));
			expect(completed).toMatchObject({
				type: "response",
				id: "operation",
				ok: true,
				result: { operationId, status: "completed" },
			});

			secondSocket.end();
			host.kill("SIGTERM");
			await withTimeout("Host shutdown", waitForExit(host), 2_000);
			children.delete(host);
		}, 30_000);
	}
});
