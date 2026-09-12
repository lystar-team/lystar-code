import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Command, ModelOptions } from "@lystar/code-web-protocol";
import { WebGatewayServer } from "../src/server.ts";

interface RouteInternals {
	getClient(context: { id: string }): Promise<{ request(command: Command): Promise<unknown> }>;
	handleApi(request: IncomingMessage, response: ServerResponse, url: URL, context: { id: string }): Promise<void>;
	handleHostEvent(context: { id: string }, event: { type: "model_catalog_changed"; revision: number }): void;
}

function responseCapture(): { response: ServerResponse; status: () => number; body: () => string } {
	let status = 0;
	let body = "";
	return {
		response: {
			writeHead(code: number) {
				status = code;
			},
			end(value: string) {
				body = value;
			},
		} as unknown as ServerResponse,
		status: () => status,
		body: () => body,
	};
}

function request(method: string, body?: unknown): IncomingMessage {
	const value = Readable.from(
		body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
	) as unknown as IncomingMessage;
	value.method = method;
	value.headers = {};
	return value;
}

test("Prompt 模型接口缓存轻量结果并在目录变更后刷新", async (t) => {
	const agentDir = join(tmpdir(), "web-model-options-route-test");
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "host.sock"),
		token: "test-token",
		tokenPath: join(agentDir, "token"),
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	});
	t.after(() => server.close());
	const routes = server as unknown as RouteInternals;
	const commands: Command[] = [];
	const options: ModelOptions = {
		models: Array.from({ length: 14 }, (_, index) => ({
			provider: "ready",
			id: `model-${index}`,
			name: `Model ${index}`,
			reasoning: index % 2 === 0,
			contextWindow: 64_000,
			supportedThinkingLevels: index % 2 === 0 ? ["off", "low", "high"] : ["off"],
		})),
		providers: [{ id: "ready", name: "Ready Provider", builtIn: false }],
	};
	routes.getClient = async () => ({
		request: async (command) => {
			commands.push(command);
			if (command.command === "list_model_options") return options;
			if (command.command === "add_model_provider") return [];
			throw new Error(`unexpected command: ${command.command}`);
		},
	});
	const context = { id: "browser-one" };

	for (let index = 0; index < 2; index++) {
		const capture = responseCapture();
		await routes.handleApi(request("GET"), capture.response, new URL("http://localhost/api/model-options"), context);
		assert.equal(capture.status(), 200);
		assert.equal(Buffer.byteLength(capture.body()), Buffer.byteLength(JSON.stringify({ revision: 1, ...options })));
		assert.ok(Buffer.byteLength(capture.body()) < 10 * 1024);
	}
	assert.equal(commands.filter((command) => command.command === "list_model_options").length, 1);

	const included = responseCapture();
	await routes.handleApi(
		request("GET"),
		included.response,
		new URL("http://localhost/api/model-options?includeProvider=locked"),
		context,
	);
	assert.equal(included.status(), 200);
	assert.deepEqual(
		commands.find(
			(command) => command.command === "list_model_options" && command.includeProviders?.includes("locked"),
		),
		{ command: "list_model_options", includeProviders: ["locked"] },
	);

	const saveCapture = responseCapture();
	await routes.handleApi(
		request("POST", {
			provider: "ready",
			baseUrl: "https://ready.test/v1",
			api: "openai-completions",
		}),
		saveCapture.response,
		new URL("http://localhost/api/model-providers"),
		context,
	);
	assert.equal(saveCapture.status(), 200);
	routes.handleHostEvent(context, { type: "model_catalog_changed", revision: 2 });

	const refreshed = responseCapture();
	await routes.handleApi(request("GET"), refreshed.response, new URL("http://localhost/api/model-options"), context);
	assert.equal(refreshed.status(), 200);
	assert.equal(JSON.parse(refreshed.body()).revision, 2);
	assert.equal(commands.filter((command) => command.command === "list_model_options").length, 3);
});
