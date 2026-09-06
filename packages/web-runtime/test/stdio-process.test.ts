import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeCbor, encodeFrame } from "@earendil-works/pi-protocol";
import { encodeClientMessage, type ServerMessage, ServerMessageDecoder } from "@lystar/code-web-protocol";
import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcessWithoutNullStreams>();
const tempDirs = new Set<string>();
const PROCESS_START_TIMEOUT_MS = 15_000;

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.all(
		[...children].map(
			(child) =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) return resolve();
					child.once("exit", () => resolve());
				}),
		),
	);
	children.clear();
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.clear();
});

function startHost(): ChildProcessWithoutNullStreams {
	const agentDir = mkdtempSync(join(tmpdir(), "web-runtime-stdio-"));
	tempDirs.add(agentDir);
	const fixturePath = fileURLToPath(new URL("./fixtures/stdio-runtime-worker.mjs", import.meta.url));
	const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
	const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fixturePath, agentDir], {
		cwd: repositoryRoot,
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	return child;
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
	return new Promise((resolve, reject) => {
		let stderr = "";
		const timer = setTimeout(() => reject(new Error(`Timed out starting Host: ${stderr}`)), PROCESS_START_TIMEOUT_MS);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			if (stderr.includes("ready\n")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Host exited ${code}: ${stderr}`));
		});
	});
}

function readMessages(child: ChildProcessWithoutNullStreams, count: number): Promise<ServerMessage[]> {
	return new Promise((resolve, reject) => {
		const decoder = new ServerMessageDecoder();
		const messages: ServerMessage[] = [];
		let stderr = "";
		const timer = setTimeout(() => reject(new Error(`Timed out reading Host messages: ${stderr}`)), 2_000);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.stdout.on("data", (chunk: Buffer) => {
			try {
				messages.push(...decoder.push(chunk));
				if (messages.length >= count) {
					clearTimeout(timer);
					resolve(messages);
				}
			} catch (error) {
				clearTimeout(timer);
				reject(error);
			}
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (messages.length < count) {
				clearTimeout(timer);
				reject(new Error(`Host exited ${code}: ${stderr}`));
			}
		});
	});
}

function coalesce(...frames: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
	let offset = 0;
	for (const frame of frames) {
		result.set(frame, offset);
		offset += frame.length;
	}
	return result;
}

function waitForMessage(
	messages: ServerMessage[],
	predicate: (message: ServerMessage) => boolean,
	timeoutMs = 2_000,
): Promise<ServerMessage> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const poll = () => {
			const message = messages.find(predicate);
			if (message) return resolve(message);
			if (Date.now() - started >= timeoutMs) return reject(new Error("Timed out waiting for Host message"));
			setTimeout(poll, 5);
		};
		poll();
	});
}

describe("Web Runtime stdio process", () => {
	it("processes coalesced hello and request frames in order", async () => {
		const child = startHost();
		await waitForReady(child);
		const reading = readMessages(child, 2);
		child.stdin.write(
			coalesce(
				encodeClientMessage({ type: "hello", version: 2, clientInstanceId: "client" }),
				encodeClientMessage({ type: "request", id: "about", request: { command: "get_about" } }),
			),
		);
		const messages = await reading;

		expect(messages[0]).toMatchObject({ type: "hello", productVersion: "test-process" });
		expect(messages[1]).toEqual({
			type: "response",
			id: "about",
			ok: true,
			result: expect.objectContaining({ productVersion: "test-process" }),
		});
		child.stdin.end();
	}, 20_000);

	it.each([0, 3])(
		"returns a readable version error over the framed process transport for v%i",
		async (version) => {
			const child = startHost();
			await waitForReady(child);
			const reading = readMessages(child, 1);
			child.stdin.write(encodeFrame(encodeCbor({ type: "hello", version, clientInstanceId: "client" })));
			const [message] = await reading;

			expect(message).toEqual({
				type: "hello_error",
				error: {
					code: "version",
					message: `Web Runtime Protocol ${version} is unsupported; Host requires 2`,
					retryable: false,
				},
			});
			child.stdin.end();
		},
		20_000,
	);

	it("processes UI responses while a request waits for consecutive authentication prompts", async () => {
		const child = startHost();
		await waitForReady(child);
		const decoder = new ServerMessageDecoder();
		const messages: ServerMessage[] = [];
		child.stdout.on("data", (chunk: Buffer) => messages.push(...decoder.push(chunk)));
		child.stdin.write(
			coalesce(
				encodeClientMessage({ type: "hello", version: 2, clientInstanceId: "client" }),
				encodeClientMessage({
					type: "request",
					id: "login",
					request: {
						command: "login_model_provider",
						provider: "test",
						authType: "api_key",
						clientInstanceId: "client",
						clientRequestId: "login",
					},
				}),
			),
		);

		const select = await waitForMessage(
			messages,
			(message) =>
				message.type === "event" && message.event.type === "ui_request" && message.event.kind === "select",
		);
		if (select.type !== "event" || select.event.type !== "ui_request") throw new Error("Missing select request");
		child.stdin.write(encodeClientMessage({ type: "ui_response", id: select.event.id, value: "bearer-token" }));

		const secret = await waitForMessage(
			messages,
			(message) =>
				message.type === "event" && message.event.type === "ui_request" && message.event.kind === "secret",
		);
		if (secret.type !== "event" || secret.event.type !== "ui_request") throw new Error("Missing secret request");
		child.stdin.write(encodeClientMessage({ type: "ui_response", id: secret.event.id, value: "secret-value" }));

		const login = await waitForMessage(messages, (message) => message.type === "response" && message.id === "login");
		expect(login).toEqual({
			type: "response",
			id: "login",
			ok: true,
			result: [
				{
					provider: "test",
					id: "test-model",
					name: "Test Model",
					api: "openai-completions",
					reasoning: false,
					input: ["text"],
					contextWindow: 128000,
					maxTokens: 4096,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					supportedThinkingLevels: ["off"],
					authenticated: true,
					authMethods: ["api_key", "oauth"],
					authSource: "test",
				},
			],
		});
		expect(JSON.stringify(login)).not.toContain("secret-value");
		child.stdin.end();
	}, 20_000);

	it("returns the same model projection after an OAuth login", async () => {
		const child = startHost();
		await waitForReady(child);
		const reading = readMessages(child, 5);
		child.stdin.write(
			coalesce(
				encodeClientMessage({ type: "hello", version: 2, clientInstanceId: "client" }),
				encodeClientMessage({
					type: "request",
					id: "oauth-login",
					request: {
						command: "login_model_provider",
						provider: "test",
						authType: "oauth",
						clientInstanceId: "client",
						clientRequestId: "oauth-login",
					},
				}),
			),
		);
		const messages = await reading;
		expect(messages.find((message) => message.type === "event" && message.event.type === "ui_request")).toMatchObject(
			{
				type: "event",
				event: { type: "ui_request", kind: "notify", id: "stdio-oauth-notify" },
			},
		);
		expect(messages.find((message) => message.type === "response" && message.id === "oauth-login")).toMatchObject({
			type: "response",
			id: "oauth-login",
			ok: true,
			result: [
				expect.objectContaining({ provider: "test", authenticated: true, authMethods: ["api_key", "oauth"] }),
			],
		});
		child.stdin.end();
	}, 20_000);
});
