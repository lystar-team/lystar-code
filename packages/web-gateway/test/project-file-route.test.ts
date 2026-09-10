import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Command, ProjectResource } from "@lystar/code-web-protocol";
import type { ProjectRegistry } from "../src/project-registry.ts";
import { WebGatewayServer } from "../src/server.ts";

interface RouteInternals {
	registry: ProjectRegistry;
	getClient(context: { id: string }): Promise<{ request<T>(command: Command): Promise<T> }>;
	resolveSession(context: { id: string }, id: string): Promise<{ id: string; path: string; projectId: string }>;
	requireLease(context: { id: string }, id: string): Promise<{ leaseId: string }>;
	handleProjects(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		context: { id: string },
		parts: string[],
	): Promise<void>;
}

function responseCapture(): {
	response: ServerResponse;
	result: () => { status: number; body: Record<string, unknown> };
} {
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
		result: () => ({ status, body: JSON.parse(body) as Record<string, unknown> }),
	};
}

function request(method: string, body?: Record<string, unknown>): IncomingMessage {
	const value = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as unknown as IncomingMessage;
	value.method = method;
	value.headers = {};
	return value;
}

test("项目文件路由返回内容版本并使用哈希保护保存", async (t) => {
	const tempDir = await mkdtemp(join(tmpdir(), "web-project-file-route-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "project");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "app.ts"), "one\n");
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
	t.after(async () => {
		await server.close();
		await rm(tempDir, { recursive: true, force: true });
	});
	const routes = server as unknown as RouteInternals;
	await routes.registry.load();
	const project = await routes.registry.add({ id: "project-one", cwd, name: "Project One" });
	const commands: Command[] = [];
	const resource: ProjectResource = {
		path: join(cwd, "app.ts"),
		displayPath: "app.ts",
		kind: "text",
		mimeType: "text/typescript",
		byteLength: 4,
		contentVersion: "4:100:200",
	};
	routes.getClient = async () => ({
		request: async <T>(command: Command): Promise<T> => {
			commands.push(command);
			if (command.command === "resolve_project_resource") return resource as T;
			if (command.command === "read_project_resource") {
				return {
					contentRef: resource.path,
					offset: 0,
					nextOffset: 4,
					byteLength: 4,
					data: Buffer.from("one\n").toString("base64"),
					encoding: "base64",
					done: true,
				} as T;
			}
			if (command.command === "save_project_file") {
				return {
					path: "app.ts",
					mimeType: "text/typescript",
					byteLength: 4,
					contentHash: "saved-hash",
					contentVersion: "4:300:400",
				} as T;
			}
			throw new Error(`Unexpected command: ${command.command}`);
		},
	});
	routes.resolveSession = async (_context, id) => ({ id, path: "/tmp/session.jsonl", projectId: project.id });
	routes.requireLease = async () => ({ leaseId: "lease-one" });
	const parts = ["api", "projects", project.id, "file"];

	const metadata = responseCapture();
	await routes.handleProjects(
		request("GET"),
		metadata.response,
		new URL(`http://localhost/api/projects/${project.id}/file?path=app.ts&metadata=true`),
		{ id: "browser-one" },
		parts,
	);
	assert.deepEqual(metadata.result(), {
		status: 200,
		body: {
			kind: "text",
			path: "app.ts",
			mimeType: "text/typescript",
			byteLength: 4,
			contentVersion: "4:100:200",
		},
	});

	const preview = responseCapture();
	await routes.handleProjects(
		request("GET"),
		preview.response,
		new URL(`http://localhost/api/projects/${project.id}/file?path=app.ts`),
		{ id: "browser-one" },
		parts,
	);
	const previewResult = preview.result();
	assert.equal(previewResult.status, 200);
	assert.equal(previewResult.body.content, "one\n");
	assert.equal(previewResult.body.contentVersion, "4:100:200");
	assert.equal(previewResult.body.contentHash, "2c8b08da5ce60398e1f19af0e5dccc744df274b826abe585eaba68c525434806");

	const saved = responseCapture();
	await routes.handleProjects(
		request("POST", {
			path: "app.ts",
			content: "two\n",
			expectedHash: "original-hash",
			sessionId: "session-one",
			clientRequestId: "save-one",
		}),
		saved.response,
		new URL(`http://localhost/api/projects/${project.id}/file`),
		{ id: "browser-one" },
		parts,
	);
	assert.deepEqual(commands.at(-1), {
		command: "save_project_file",
		sessionPath: "/tmp/session.jsonl",
		leaseId: "lease-one",
		cwd,
		path: "app.ts",
		content: "two\n",
		expectedHash: "original-hash",
		clientInstanceId: "browser-one",
		clientRequestId: "save-one",
	});
	assert.deepEqual(saved.result(), {
		status: 200,
		body: {
			kind: "text",
			path: "app.ts",
			mimeType: "text/typescript",
			byteLength: 4,
			previewByteLength: 4,
			truncated: false,
			content: "two\n",
			contentHash: "saved-hash",
			contentVersion: "4:300:400",
		},
	});
});
