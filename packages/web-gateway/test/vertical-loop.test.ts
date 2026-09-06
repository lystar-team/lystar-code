import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const hostCli = join(repositoryRoot, "packages/gui-host/dist/cli.js");
const gatewayCli = join(repositoryRoot, "packages/web-gateway/dist/cli.js");
const staticDir = join(repositoryRoot, "packages/web/dist");
const token = "vertical-test-token";
const clientId = "vertical-test-client";
const projectCwd = repositoryRoot;

interface FakeProviderRequest {
	body: string;
}

interface JsonResponse {
	status: number;
	data: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
	return value;
}

function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = 10_000): Promise<T> {
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
		"PI_GUI_HOST_ENDPOINT",
		"PI_WEB_HOST",
		"PI_WEB_PORT",
		"PI_WEB_TOKEN",
		"PI_WEB_STATIC_DIR",
		"PI_WEB_ALLOWED_HOSTS",
		"PI_WEB_MANAGE_HOST",
		"OPENAI_API_KEY",
		"OPENAI_BASE_URL",
	])
		delete environment[key];
	return { ...environment, ...values };
}

async function waitForHttp(url: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for HTTP endpoint: ${url}`);
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
		3_000,
	).catch(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
}

async function waitForSocket(endpoint: string): Promise<void> {
	const deadline = Date.now() + 10_000;
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

function requestJson(baseUrl: string, path: string, init: RequestInit = {}): Promise<JsonResponse> {
	return fetch(`${baseUrl}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"X-LYStar-Client-Id": clientId,
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
		const responseId = `resp_vertical_${requestNumber}`;
		const messageId = `msg_vertical_${requestNumber}`;
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

function waitForWebSocketMessage(
	messages: Array<Record<string, unknown>>,
	predicate: (message: Record<string, unknown>) => boolean,
	label: string,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const poll = () => {
			const message = messages.find(predicate);
			if (!message) return;
			clearInterval(interval);
			clearTimeout(timeout);
			resolve(message);
		};
		const interval = setInterval(poll, 10);
		const timeout = setTimeout(() => {
			clearInterval(interval);
			reject(new Error(`Timed out: ${label}`));
		}, 10_000);
		poll();
	});
}

test("Web Gateway fake Provider 完成 Prompt、事件和 Transcript 闭环", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-gateway-test-"));
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
	const host = startChild(
		[hostCli, "serve"],
		childEnvironment({
			PI_CODING_AGENT_DIR: agentDir,
			PI_GUI_HOST_ENDPOINT: endpoint,
			PI_GUI_HOST_PERSISTENT: "1",
			OPENAI_API_KEY: "fake-test-key",
			OPENAI_BASE_URL: fakeBaseUrl,
			PI_PROVIDER: "openai",
			PI_MODEL: "gpt-5.5",
			PI_REASONING_LEVEL: "off",
		}),
	);
	const gateway = startChild(
		[gatewayCli],
		childEnvironment({
			PI_CODING_AGENT_DIR: agentDir,
			PI_GUI_HOST_ENDPOINT: endpoint,
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_PORT: String(gatewayPort),
			PI_WEB_TOKEN: token,
			PI_WEB_MANAGE_HOST: "0",
			PI_WEB_STATIC_DIR: staticDir,
			PI_WEB_ALLOWED_HOSTS: "127.0.0.1,localhost",
			OPENAI_API_KEY: "fake-test-key",
			OPENAI_BASE_URL: fakeBaseUrl,
			PI_PROVIDER: "openai",
			PI_MODEL: "gpt-5.5",
			PI_REASONING_LEVEL: "off",
		}),
	);
	const messages: Array<Record<string, unknown>> = [];
	const handledUiRequests = new Set<string>();
	let ws: WebSocket | undefined;
	t.after(async () => {
		ws?.close();
		await stopChild(gateway);
		await stopChild(host);
		await closeServer(fakeProvider);
		await rm(agentDir, { recursive: true, force: true });
	});

	await waitForSocket(endpoint);
	await waitForHttp(`${baseUrl}/healthz`);
	ws = new WebSocket(`${baseUrl.replace(/^http/u, "ws")}/ws?token=${token}&clientId=${clientId}`, {
		headers: { Origin: baseUrl },
	});
	ws.on("message", (raw) => {
		const message = record(JSON.parse(String(raw)));
		if (!message) return;
		messages.push(message);
		if (message.type !== "ui_request" || message.kind !== "select") return;
		const requestId = typeof message.id === "string" ? message.id : undefined;
		if (!requestId || handledUiRequests.has(requestId)) return;
		const payload = record(message.payload);
		const options = Array.isArray(payload?.options) ? payload.options : [];
		if (!options.some((option) => option === "信任此项目")) return;
		handledUiRequests.add(requestId);
		void requestJson(baseUrl, `/api/ui-requests/${encodeURIComponent(requestId)}`, {
			method: "POST",
			body: JSON.stringify({ value: "信任此项目" }),
		});
	});
	await withTimeout(
		"WebSocket open",
		new Promise<void>((resolve, reject) => {
			ws?.once("open", () => resolve());
			ws?.once("error", reject);
		}),
	);
	await waitForWebSocketMessage(messages, (message) => message.type === "bootstrap", "WebSocket bootstrap");

	const projectResponse = await requestJson(baseUrl, "/api/projects", {
		method: "POST",
		body: JSON.stringify({ cwd: projectCwd, name: "vertical-test-project" }),
	});
	assert.equal(projectResponse.status, 201);
	const project = record(projectResponse.data.project);
	if (!project) throw new Error("Project response is missing project data");
	const projectId = requiredString(project.id, "project id");
	assert.equal("cwd" in project, false);

	const createResponse = await requestJson(baseUrl, "/api/sessions", {
		method: "POST",
		body: JSON.stringify({ projectId, clientRequestId: "create-vertical-session" }),
	});
	assert.equal(createResponse.status, 201);
	const session = record(createResponse.data.session);
	const lease = record(createResponse.data.lease);
	if (!session || !lease) throw new Error("Session response is missing session or lease data");
	const sessionId = requiredString(session.id, "session id");
	assert.equal("path" in session, false);
	assert.equal("cwd" in session, false);
	assert.equal(lease.leaseGeneration, 1);

	const promptResponse = await requestJson(baseUrl, `/api/sessions/${sessionId}/prompt`, {
		method: "POST",
		body: JSON.stringify({ text: "请只回复 OK，不要调用工具。", clientRequestId: "prompt-vertical-loop" }),
	});
	assert.equal(promptResponse.status, 202);
	const promptOperation = record(promptResponse.data.operation);
	if (!promptOperation) throw new Error("Prompt response is missing operation data");
	const operationId = requiredString(promptOperation.operationId, "operation id");
	assert.equal(promptOperation.status, "accepted");

	const completedEvent = await waitForWebSocketMessage(
		messages,
		(message) => {
			const operation = record(message.operation);
			return (
				message.type === "operation_updated" &&
				operation?.operationId === operationId &&
				operation.status === "completed"
			);
		},
		"Prompt operation completion event",
	);
	assert.equal(record(completedEvent.operation)?.sessionId, sessionId);
	const transcriptCommittedEvent = await waitForWebSocketMessage(
		messages,
		(message) =>
			message.type === "transcript_committed" &&
			message.sessionId === sessionId &&
			Array.isArray(message.items) &&
			message.items.length >= 2,
		"Transcript committed event",
	);
	const committedItems = transcriptCommittedEvent.items as unknown[];
	const firstCommittedItem = record(committedItems[0]);
	assert.equal(firstCommittedItem ? "payload" in firstCommittedItem : false, false);
	const resolvedProjectCwd = resolve(projectCwd);
	const sessionDirectory = join(
		agentDir,
		"sessions",
		`--${resolvedProjectCwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`,
	);
	const sessionFiles = (await readdir(sessionDirectory)).filter((file) => file.endsWith(".jsonl"));
	assert.equal(sessionFiles.length, 1);
	const originalSessionPath = join(sessionDirectory, sessionFiles[0]!);
	const duplicateSessionPath = join(sessionDirectory, "duplicate-session.jsonl");
	const duplicateUpdatedAt = Date.now() + 10_000;
	const duplicateContents = (await readFile(originalSessionPath, "utf8"))
		.trimEnd()
		.split("\n")
		.map((line) => {
			const entry = JSON.parse(line) as Record<string, unknown>;
			const message = record(entry.message);
			if (entry.type === "message" && message && (message.role === "user" || message.role === "assistant")) {
				entry.message = { ...message, timestamp: duplicateUpdatedAt };
			}
			return JSON.stringify(entry);
		})
		.join("\n");
	await writeFile(duplicateSessionPath, `${duplicateContents}\n`);

	const projectsAfterDuplicate = await requestJson(baseUrl, "/api/projects");
	assert.equal(projectsAfterDuplicate.status, 200);
	const listedProjects = Array.isArray(projectsAfterDuplicate.data.projects)
		? projectsAfterDuplicate.data.projects
				.map(record)
				.filter((project): project is Record<string, unknown> => Boolean(project))
		: [];
	const listedProject = listedProjects.find((candidate) => candidate.id === projectId);
	const listedSessions = Array.isArray(listedProject?.sessions)
		? listedProject.sessions.map(record).filter((session): session is Record<string, unknown> => Boolean(session))
		: [];
	const matchingSessions = listedSessions.filter((candidate) => candidate.id === sessionId);
	assert.equal(matchingSessions.length, 1);
	assert.ok(Number(matchingSessions[0]?.updatedAt) >= duplicateUpdatedAt - 1_000);

	const progressTypes = messages
		.filter((message) => message.type === "session_progress" && message.sessionId === sessionId)
		.map((message) => record(message.progress)?.type);
	assert.ok(progressTypes.includes("assistant_delta"), `Missing assistant_delta: ${JSON.stringify(progressTypes)}`);

	const transcriptResponse = await requestJson(baseUrl, `/api/sessions/${sessionId}/transcript?limit=120`);
	assert.equal(transcriptResponse.status, 200);
	assert.ok(Array.isArray(transcriptResponse.data.items));
	const firstTranscriptItem = record((transcriptResponse.data.items as unknown[])[0]);
	assert.equal(firstTranscriptItem ? "payload" in firstTranscriptItem : false, false);
	assert.match(JSON.stringify(transcriptResponse.data.items), /OK/u);
	assert.match(JSON.stringify(transcriptResponse.data.items), /请只回复 OK/u);
	assert.equal("path" in transcriptResponse.data, false);
	assert.equal("cwd" in transcriptResponse.data, false);

	const operationResponse = await requestJson(baseUrl, `/api/operations/${operationId}`);
	assert.equal(operationResponse.status, 200);
	const operationResult = record(operationResponse.data.operation);
	if (!operationResult) throw new Error("Operation response is missing operation data");
	assert.equal(operationResult.status, "completed");
	assert.equal("sessionPath" in operationResult, false);
	assert.equal("clientInstanceId" in operationResult, false);
	assert.equal("clientRequestId" in operationResult, false);
	assert.equal(requests.length, 1);
	assert.match(requests[0]?.body ?? "", /请只回复 OK/u);
});
