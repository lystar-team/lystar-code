import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ByteTransport, ServerEvent, SessionSummary } from "@lystar/code-web-protocol";
import { RuntimeProtocolClient } from "@lystar/code-web-protocol";
import { WebSocket } from "ws";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const hostCli = join(repositoryRoot, "packages/web-runtime/dist/cli.js");
const gatewayCli = join(repositoryRoot, "packages/web-gateway/dist/cli.js");
const staticDir = join(repositoryRoot, "packages/web/dist");
const token = "resilience-loop-token";
const projectCwd = repositoryRoot;

interface FakeProviderRequest {
	body: string;
}

interface JsonResponse {
	status: number;
	data: Record<string, unknown>;
}

interface Credentials {
	clientId: string;
}

interface GatewayStack {
	agentDir: string;
	endpoint: string;
	baseUrl: string;
	requests: FakeProviderRequest[];
	host?: ChildProcess;
	gateway: ChildProcess;
	fakeProvider: Server;
	close(): Promise<void>;
}

class SocketByteTransport implements ByteTransport {
	private readonly bytesListeners = new Set<(bytes: Uint8Array) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();
	private closed = false;
	private closeNotified = false;
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
			const fail = (error: Error) => {
				socket.destroy();
				reject(error);
			};
			socket.once("error", fail);
			socket.once("connect", () => {
				socket.off("error", fail);
				socket.setNoDelay(true);
				resolve(new SocketByteTransport(socket));
			});
		});
	}

	send(bytes: Uint8Array): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Host transport is closed"));
		return new Promise((resolve, reject) => {
			try {
				this.socket.write(Buffer.from(bytes), () => resolve());
			} catch (error) {
				reject(error);
			}
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.notifyClose(new Error("Host transport is closed"));
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
		if (this.closeNotified) return;
		this.closed = true;
		this.closeNotified = true;
		for (const listener of this.closeListeners) listener(error);
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
	return value;
}

function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = 15_000): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function listenOnFreePort(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port");
	return address.port;
}

async function closeServer(server: Server | ReturnType<typeof createNetServer>): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function childEnvironment(values: Record<string, string>): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of [
		"PI_SESSION_FILE",
		"PI_SESSION_ID",
		"PI_PROVIDER",
		"PI_MODEL",
		"PI_REASONING_LEVEL",
		"PI_OFFLINE",
		"PI_CODING_AGENT_DIR",
		"PI_WEB_RUNTIME_ENDPOINT",
		"PI_WEB_HOST",
		"PI_WEB_PORT",
		"PI_WEB_TOKEN",
		"PI_WEB_STATIC_DIR",
		"PI_WEB_ALLOWED_HOSTS",
		"PI_WEB_MANAGE_RUNTIME",
		"OPENAI_API_KEY",
		"OPENAI_BASE_URL",
	])
		delete environment[key];
	return { ...environment, ...values };
}

function startChild(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
	return spawn(process.execPath, args, {
		cwd: repositoryRoot,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await withTimeout(
		"child shutdown",
		new Promise<void>((resolve) => child.once("exit", () => resolve())),
		5_000,
	).catch(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
}

async function waitForHttp(url: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for HTTP endpoint: ${url}`);
}

async function waitForSocket(endpoint: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await new Promise<void>((resolve, reject) => {
				const socket = createConnection(endpoint);
				socket.once("connect", () => {
					socket.destroy();
					resolve();
				});
				socket.once("error", reject);
			});
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error(`Timed out waiting for Host socket: ${endpoint}`);
}

async function waitUntil(label: string, predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out: ${label}`);
}

function requestJson(
	baseUrl: string,
	path: string,
	credentials: Credentials,
	init: RequestInit = {},
): Promise<JsonResponse> {
	return fetch(`${baseUrl}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"X-LYStar-Client-Id": credentials.clientId,
			...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
			...init.headers,
		},
	}).then(async (response) => {
		const data = record(await response.json());
		if (!data) throw new Error("JSON response must be an object");
		return { status: response.status, data };
	});
}

function createFakeProvider(requests: FakeProviderRequest[]): Server {
	return createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			response.writeHead(404, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: { message: "not found" } }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		requests.push({ body: Buffer.concat(chunks).toString("utf8") });
		const requestNumber = requests.length;
		const responseId = `resp_resilience_${requestNumber}`;
		const messageId = `msg_resilience_${requestNumber}`;
		const item = {
			type: "message",
			id: messageId,
			role: "assistant",
			content: [{ type: "output_text", text: "OK", annotations: [] }],
			status: "completed",
			phase: "final_answer",
		};
		const usage = {
			input_tokens: 5,
			output_tokens: 1,
			total_tokens: 6,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens_details: { reasoning_tokens: 0 },
		};
		const events = [
			{
				type: "response.created",
				response: {
					id: responseId,
					object: "response",
					created_at: Math.floor(Date.now() / 1000),
					status: "in_progress",
					model: "gpt-5.5",
					output: [],
				},
			},
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: messageId, role: "assistant", content: [], status: "in_progress" },
			},
			{ type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: "O" },
			{ type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: "K" },
			{ type: "response.output_item.done", output_index: 0, item },
			{
				type: "response.completed",
				response: {
					id: responseId,
					object: "response",
					created_at: Math.floor(Date.now() / 1000),
					status: "completed",
					model: "gpt-5.5",
					output: [item],
					usage,
				},
			},
		];
		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		for (const event of events) {
			response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		response.end();
	});
}

async function findManagedHostPids(endpoint: string): Promise<number[]> {
	if (process.platform !== "linux") return [];
	const entries = await readdir("/proc", { withFileTypes: true });
	const pids: number[] = [];
	for (const entry of entries) {
		if (!/^\d+$/u.test(entry.name)) continue;
		try {
			const [commandLine, environment] = await Promise.all([
				readFile(`/proc/${entry.name}/cmdline`, "utf8"),
				readFile(`/proc/${entry.name}/environ`, "utf8"),
			]);
			if (
				commandLine.includes("packages/web-runtime/dist/cli.js") &&
				environment.includes(`PI_WEB_RUNTIME_ENDPOINT=${endpoint}`)
			) {
				pids.push(Number(entry.name));
			}
		} catch {}
	}
	return pids;
}

async function createStack(manageRuntime: boolean): Promise<GatewayStack> {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-gateway-resilience-loop-"));
	const endpoint = join(agentDir, "host.sock");
	const requests: FakeProviderRequest[] = [];
	const fakeProvider = createFakeProvider(requests);
	const fakePort = await listenOnFreePort(fakeProvider);
	const fakeBaseUrl = `http://127.0.0.1:${fakePort}/v1`;
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { openai: { baseUrl: fakeBaseUrl, apiKey: "fake-test-key" } } }),
	);
	const gatewayPortServer = createNetServer();
	const gatewayPort = await listenOnFreePort(gatewayPortServer);
	await closeServer(gatewayPortServer);
	const baseUrl = `http://127.0.0.1:${gatewayPort}`;
	const host = manageRuntime
		? undefined
		: startChild(
				[hostCli, "serve"],
				childEnvironment({
					PI_CODING_AGENT_DIR: agentDir,
					PI_WEB_RUNTIME_ENDPOINT: endpoint,
					PI_WEB_RUNTIME_PERSISTENT: "1",
					OPENAI_API_KEY: "fake-test-key",
					OPENAI_BASE_URL: fakeBaseUrl,
					PI_PROVIDER: "openai",
					PI_MODEL: "gpt-5.5",
					PI_REASONING_LEVEL: "off",
				}),
			);
	let gateway: ChildProcess | undefined;
	try {
		if (host) await waitForSocket(endpoint);
		gateway = startChild(
			[gatewayCli],
			childEnvironment({
				PI_CODING_AGENT_DIR: agentDir,
				PI_WEB_RUNTIME_ENDPOINT: endpoint,
				PI_WEB_HOST: "127.0.0.1",
				PI_WEB_PORT: String(gatewayPort),
				PI_WEB_TOKEN: token,
				PI_WEB_MANAGE_RUNTIME: manageRuntime ? "1" : "0",
				PI_WEB_STATIC_DIR: staticDir,
				PI_WEB_ALLOWED_HOSTS: "127.0.0.1,localhost",
				OPENAI_API_KEY: "fake-test-key",
				OPENAI_BASE_URL: fakeBaseUrl,
				PI_PROVIDER: "openai",
				PI_MODEL: "gpt-5.5",
				PI_REASONING_LEVEL: "off",
			}),
		);
		await waitForHttp(`${baseUrl}/healthz`);
		return {
			agentDir,
			endpoint,
			baseUrl,
			requests,
			host,
			gateway,
			fakeProvider,
			close: async () => {
				await stopChild(gateway!);
				if (host) await stopChild(host);
				for (const pid of await findManagedHostPids(endpoint)) {
					try {
						process.kill(pid, "SIGTERM");
					} catch {}
				}
				await closeServer(fakeProvider);
				await rm(agentDir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		if (gateway) await stopChild(gateway).catch(() => {});
		if (host) await stopChild(host).catch(() => {});
		for (const pid of await findManagedHostPids(endpoint)) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}
		await closeServer(fakeProvider);
		await rm(agentDir, { recursive: true, force: true });
		throw error;
	}
}

function attachTrustResponder(
	stack: GatewayStack,
	connection: { socket: WebSocket; messages: Record<string, unknown>[] },
	credentials: Credentials,
): void {
	const handled = new Set<string>();
	connection.socket.on("message", (raw) => {
		const message = record(JSON.parse(String(raw)));
		if (!message || message.type !== "ui_request" || message.kind !== "select") return;
		const requestId = typeof message.id === "string" ? message.id : undefined;
		if (!requestId || handled.has(requestId)) return;
		const payload = record(message.payload);
		const options = Array.isArray(payload?.options) ? payload.options : [];
		if (!options.includes("信任此项目")) return;
		handled.add(requestId);
		void requestJson(stack.baseUrl, `/api/ui-requests/${encodeURIComponent(requestId)}`, credentials, {
			method: "POST",
			body: JSON.stringify({ value: "信任此项目" }),
		});
	});
}

function openWebSocket(
	baseUrl: string,
	credentials: Credentials,
): Promise<{ socket: WebSocket; messages: Record<string, unknown>[] }> {
	return new Promise((resolve, reject) => {
		const messages: Record<string, unknown>[] = [];
		const socket = new WebSocket(
			`${baseUrl.replace(/^http/u, "ws")}/ws?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(credentials.clientId)}`,
			{ headers: { Origin: baseUrl } },
		);
		socket.on("message", (raw) => {
			const message = record(JSON.parse(String(raw)));
			if (message) messages.push(message);
		});
		socket.once("open", () => resolve({ socket, messages }));
		socket.once("error", reject);
	});
}

async function waitForMessage(
	messages: Array<Record<string, unknown>>,
	predicate: (message: Record<string, unknown>) => boolean,
	label: string,
	timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const interval = setInterval(() => {
			const message = messages.find(predicate);
			if (!message) return;
			clearInterval(interval);
			clearTimeout(timeout);
			resolve(message);
		}, 20);
		const timeout = setTimeout(() => {
			clearInterval(interval);
			reject(new Error(`Timed out: ${label}`));
		}, timeoutMs);
		const message = messages.find(predicate);
		if (message) {
			clearInterval(interval);
			clearTimeout(timeout);
			resolve(message);
		}
	});
}

async function createProjectAndSession(
	stack: GatewayStack,
	credentials: Credentials,
): Promise<{ projectId: string; sessionId: string }> {
	const projectResponse = await requestJson(stack.baseUrl, "/api/projects", credentials, {
		method: "POST",
		body: JSON.stringify({ cwd: projectCwd, name: "resilience-loop-project" }),
	});
	assert.equal(projectResponse.status, 201);
	const project = record(projectResponse.data.project);
	if (!project) throw new Error("Project response is missing project data");
	const projectId = requiredString(project.id, "project id");
	const sessionResponse = await requestJson(stack.baseUrl, "/api/sessions", credentials, {
		method: "POST",
		body: JSON.stringify({ projectId, clientRequestId: "resilience-create-session" }),
	});
	assert.equal(sessionResponse.status, 201);
	const session = record(sessionResponse.data.session);
	if (!session) throw new Error("Session response is missing session data");
	const sessionId = requiredString(session.id, "session id");
	return { projectId, sessionId };
}

test("Web 与直接 Web Client 可同时观察同一运行时，并由租约串行保护写入", async (t) => {
	const stack = await createStack(false);
	t.after(() => stack.close());
	const webA: Credentials = { clientId: "resilience-web-a" };
	const webB: Credentials = { clientId: "resilience-web-b" };
	const first = await openWebSocket(stack.baseUrl, webA);
	const second = await openWebSocket(stack.baseUrl, webB);
	attachTrustResponder(stack, first, webA);
	t.after(() => {
		first.socket.close();
		second.socket.close();
	});
	await waitForMessage(first.messages, (message) => message.type === "bootstrap", "Web A bootstrap");
	await waitForMessage(second.messages, (message) => message.type === "bootstrap", "Web B bootstrap");

	const project = await createProjectAndSession(stack, webA);
	const projectsForB = await requestJson(stack.baseUrl, "/api/projects", webB);
	assert.equal(projectsForB.status, 200);
	const controlByB = await requestJson(stack.baseUrl, `/api/sessions/${project.sessionId}/control`, webB, {
		method: "POST",
	});
	assert.equal(controlByB.status, 200);

	const transport = await SocketByteTransport.connect(stack.endpoint);
	const tui = new RuntimeProtocolClient(transport, "resilience-tui-observer");
	const tuiEvents: ServerEvent[] = [];
	tui.onEvent((event) => tuiEvents.push(event));
	t.after(() => tui.close());
	await tui.connect();
	const tuiSessions = await tui.request<SessionSummary[]>({ command: "list_sessions", cwd: projectCwd });
	const tuiSession = tuiSessions.find((session) => session.id === project.sessionId);
	if (!tuiSession) throw new Error("TUI observer could not resolve the session path");
	const sessionPath = tuiSession.path;
	const operationByA = await requestJson(stack.baseUrl, `/api/sessions/${project.sessionId}/prompt`, webA, {
		method: "POST",
		body: JSON.stringify({ text: "Web 发送的消息", clientRequestId: "resilience-web-prompt" }),
	});
	assert.equal(operationByA.status, 202, JSON.stringify(operationByA.data));
	const operation = record(operationByA.data.operation);
	if (!operation) throw new Error("Prompt response is missing operation data");
	const operationId = requiredString(operation.operationId, "Web operation id");

	await waitForMessage(
		first.messages,
		(message) => {
			const candidate = record(message.operation);
			return (
				message.type === "operation_updated" &&
				candidate?.operationId === operationId &&
				candidate.status === "completed"
			);
		},
		"Web A completion",
	);

	const tuiControl = await tui.request<{ lease: { leaseId: string } }>({
		command: "acquire_session",
		sessionPath,
		clientInstanceId: tui.clientInstanceId,
	});
	const tuiSnapshot = await tui.request<{ sessions: unknown[] }>({ command: "get_snapshot" });
	assert.equal(tuiSnapshot.sessions.length, 1);
	const tuiOperationResult = await tui.request<{ operation?: { operationId: string } }>({
		command: "prompt",
		sessionPath,
		leaseId: tuiControl.lease.leaseId,
		clientInstanceId: tui.clientInstanceId,
		clientRequestId: "resilience-tui-prompt",
		text: "TUI 发送的消息",
	});
	const tuiOperation = record(tuiOperationResult.operation);
	if (!tuiOperation) throw new Error("TUI prompt response is missing operation data");
	const tuiOperationId = requiredString(tuiOperation.operationId, "TUI operation id");

	await waitForMessage(
		first.messages,
		(message) => {
			const candidate = record(message.operation);
			return (
				message.type === "operation_updated" &&
				candidate?.operationId === tuiOperationId &&
				candidate.status === "completed"
			);
		},
		"TUI completion",
	);
	await waitForMessage(
		second.messages,
		(message) => message.type === "session_progress" && message.sessionId === project.sessionId,
		"Web B observation",
	);
	assert.ok(
		tuiEvents.filter((event) => event.type === "session_progress" && event.sessionPath === sessionPath).length >= 2,
		"TUI observer did not receive both concurrent progress streams",
	);
	const tuiTranscript = await tui.request<{ items: unknown[] }>({
		command: "read_transcript",
		sessionPath,
		limit: 40,
	});
	assert.match(JSON.stringify(tuiTranscript.items), /OK/u);
	assert.equal(stack.requests.length, 2);

	const transcriptForB = await requestJson(
		stack.baseUrl,
		`/api/sessions/${project.sessionId}/transcript?limit=40`,
		webB,
	);
	assert.equal(transcriptForB.status, 200);
	assert.match(JSON.stringify(transcriptForB.data.items), /OK/u);
	const firstTranscriptItem = record((transcriptForB.data.items as unknown[])[0]);
	assert.ok(firstTranscriptItem);
	assert.equal("payload" in firstTranscriptItem, false);
});

test("Gateway 在 manageRuntime=1 时可自动重启断开的 Host 并恢复 Bootstrap", async (t) => {
	if (process.platform !== "linux") {
		t.skip("该测试需要 Linux /proc 读取托管 Host PID");
		return;
	}
	const stack = await createStack(true);
	t.after(() => stack.close());
	const credentials: Credentials = { clientId: "resilience-restart-client" };
	const connection = await openWebSocket(stack.baseUrl, credentials);
	t.after(() => connection.socket.close());
	await waitForMessage(connection.messages, (message) => message.type === "bootstrap", "initial bootstrap");
	await waitUntil("managed Host PID", async () => (await findManagedHostPids(stack.endpoint)).length > 0);
	const hostPid = (await findManagedHostPids(stack.endpoint))[0];
	if (!hostPid) throw new Error("Managed Host PID is missing");
	process.kill(hostPid, "SIGTERM");

	await waitForMessage(
		connection.messages,
		(message) => message.type === "connection_state" && message.connected === false,
		"Host disconnected event",
		20_000,
	);
	await waitForMessage(
		connection.messages,
		(message) => message.type === "connection_state" && message.connected === true,
		"Host recovered event",
		20_000,
	);
	await waitForMessage(connection.messages, (message) => message.type === "bootstrap", "recovery bootstrap", 20_000);
	const health = await fetch(`${stack.baseUrl}/healthz`);
	assert.equal(health.status, 200);
	assert.deepEqual(await health.json(), { ok: true, gateway: "ok", host: "connected" });
});
