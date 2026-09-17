import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
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

function rawResponseCapture(): {
	response: ServerResponse;
	result: () => { status: number; headers: Record<string, string>; body: Buffer };
} {
	let status = 0;
	let headers: Record<string, string> = {};
	let body = Buffer.alloc(0);
	return {
		response: {
			writeHead(code: number, values?: Record<string, string>) {
				status = code;
				headers = values ?? {};
			},
			end(value?: string | Uint8Array) {
				body = value === undefined ? Buffer.alloc(0) : Buffer.from(value);
			},
		} as unknown as ServerResponse,
		result: () => ({ status, headers, body }),
	};
}

function request(method: string, body?: Record<string, unknown>): IncomingMessage {
	const value = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as unknown as IncomingMessage;
	value.method = method;
	value.headers = {};
	return value;
}

function binaryRequest(body: Uint8Array): IncomingMessage {
	const value = Readable.from([body]) as unknown as IncomingMessage;
	value.method = "POST";
	value.headers = { "content-type": "application/octet-stream" };
	return value;
}

function unzipEntries(archive: Buffer): Map<string, Buffer> {
	const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
	const endOffset = archive.lastIndexOf(endSignature);
	assert.notEqual(endOffset, -1);
	const entryCount = archive.readUInt16LE(endOffset + 10);
	let offset = archive.readUInt32LE(endOffset + 16);
	const entries = new Map<string, Buffer>();
	for (let index = 0; index < entryCount; index++) {
		assert.equal(archive.readUInt32LE(offset), 0x02014b50);
		const method = archive.readUInt16LE(offset + 10);
		const compressedSize = archive.readUInt32LE(offset + 20);
		const uncompressedSize = archive.readUInt32LE(offset + 24);
		const nameLength = archive.readUInt16LE(offset + 28);
		const extraLength = archive.readUInt16LE(offset + 30);
		const commentLength = archive.readUInt16LE(offset + 32);
		const localOffset = archive.readUInt32LE(offset + 42);
		const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		assert.equal(archive.readUInt32LE(localOffset), 0x04034b50);
		const localNameLength = archive.readUInt16LE(localOffset + 26);
		const localExtraLength = archive.readUInt16LE(localOffset + 28);
		const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
		const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
		const content = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
		assert.equal(content.length, uncompressedSize);
		entries.set(name, content);
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
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

	const downloaded = rawResponseCapture();
	await routes.handleProjects(
		request("GET"),
		downloaded.response,
		new URL(`http://localhost/api/projects/${project.id}/file?path=app.ts&download=true`),
		{ id: "browser-one" },
		parts,
	);
	assert.equal(downloaded.result().status, 200);
	assert.equal(downloaded.result().headers["Content-Type"], "application/octet-stream");
	assert.match(downloaded.result().headers["Content-Disposition"], /app\.ts/u);
	assert.equal(downloaded.result().body.toString("utf8"), "one\n");

	const renamed = responseCapture();
	await routes.handleProjects(
		request("PATCH", { path: "app.ts", name: "renamed.ts" }),
		renamed.response,
		new URL(`http://localhost/api/projects/${project.id}/file`),
		{ id: "browser-one" },
		parts,
	);
	assert.deepEqual(renamed.result(), { status: 200, body: { path: "renamed.ts" } });
	assert.equal(await readFile(join(cwd, "renamed.ts"), "utf8"), "one\n");

	await writeFile(join(cwd, "taken.ts"), "taken\n");
	await assert.rejects(
		routes.handleProjects(
			request("PATCH", { path: "renamed.ts", name: "taken.ts" }),
			responseCapture().response,
			new URL(`http://localhost/api/projects/${project.id}/file`),
			{ id: "browser-one" },
			parts,
		),
		/同一目录下已有同名文件/u,
	);

	await mkdir(join(cwd, "folder"));
	await writeFile(join(cwd, "folder", "nested.txt"), "nested\n");
	const renamedDirectory = responseCapture();
	await routes.handleProjects(
		request("PATCH", { path: "folder", name: "renamed-folder" }),
		renamedDirectory.response,
		new URL(`http://localhost/api/projects/${project.id}/file`),
		{ id: "browser-one" },
		parts,
	);
	assert.deepEqual(renamedDirectory.result(), { status: 200, body: { path: "renamed-folder" } });
	assert.equal(await readFile(join(cwd, "renamed-folder", "nested.txt"), "utf8"), "nested\n");

	const archived = responseCapture();
	await routes.handleProjects(
		request("POST", { paths: ["renamed.ts", "renamed-folder"], name: "bundle.zip" }),
		archived.response,
		new URL(`http://localhost/api/projects/${project.id}/archive`),
		{ id: "browser-one" },
		["api", "projects", project.id, "archive"],
	);
	assert.deepEqual(archived.result(), { status: 200, body: { path: "bundle.zip", entryCount: 3 } });
	const zipEntries = unzipEntries(await readFile(join(cwd, "bundle.zip")));
	assert.equal(zipEntries.get("renamed.ts")?.toString("utf8"), "one\n");
	assert.equal(zipEntries.get("renamed-folder/")?.byteLength, 0);
	assert.equal(zipEntries.get("renamed-folder/nested.txt")?.toString("utf8"), "nested\n");
	await assert.rejects(
		routes.handleProjects(
			request("POST", { paths: ["renamed.ts"], name: "bundle.zip" }),
			responseCapture().response,
			new URL(`http://localhost/api/projects/${project.id}/archive`),
			{ id: "browser-one" },
			["api", "projects", project.id, "archive"],
		),
		/已有同名 ZIP 文件/u,
	);

	const uploadedRoot = responseCapture();
	await routes.handleProjects(
		binaryRequest(Buffer.from("root upload\n")),
		uploadedRoot.response,
		new URL(`http://localhost/api/projects/${project.id}/upload?path=&name=uploaded.txt`),
		{ id: "browser-one" },
		["api", "projects", project.id, "upload"],
	);
	assert.deepEqual(uploadedRoot.result(), {
		status: 200,
		body: { path: "uploaded.txt", byteLength: 12 },
	});
	assert.equal(await readFile(join(cwd, "uploaded.txt"), "utf8"), "root upload\n");

	const uploadedNested = responseCapture();
	await routes.handleProjects(
		binaryRequest(Buffer.from([0, 1, 2, 3])),
		uploadedNested.response,
		new URL(`http://localhost/api/projects/${project.id}/upload?path=renamed-folder&name=data.bin`),
		{ id: "browser-one" },
		["api", "projects", project.id, "upload"],
	);
	assert.deepEqual(uploadedNested.result(), {
		status: 200,
		body: { path: "renamed-folder/data.bin", byteLength: 4 },
	});
	assert.deepEqual(await readFile(join(cwd, "renamed-folder", "data.bin")), Buffer.from([0, 1, 2, 3]));
	await assert.rejects(
		routes.handleProjects(
			binaryRequest(Buffer.from("conflict")),
			responseCapture().response,
			new URL(`http://localhost/api/projects/${project.id}/upload?path=&name=uploaded.txt`),
			{ id: "browser-one" },
			["api", "projects", project.id, "upload"],
		),
		/已有同名文件或目录/u,
	);

	const deleted = responseCapture();
	await routes.handleProjects(
		request("DELETE", { paths: ["renamed.ts", "renamed-folder", "renamed-folder/nested.txt"] }),
		deleted.response,
		new URL(`http://localhost/api/projects/${project.id}/file`),
		{ id: "browser-one" },
		parts,
	);
	assert.deepEqual(deleted.result(), {
		status: 200,
		body: { paths: ["renamed.ts", "renamed-folder"] },
	});
	await assert.rejects(readFile(join(cwd, "renamed.ts")), /ENOENT/u);
	await assert.rejects(readFile(join(cwd, "renamed-folder", "nested.txt")), /ENOENT/u);
});
