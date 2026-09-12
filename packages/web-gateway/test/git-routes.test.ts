import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Command } from "@lystar/code-web-protocol";
import type { ProjectRegistry } from "../src/project-registry.ts";
import { WebGatewayServer } from "../src/server.ts";

interface RouteInternals {
	registry: ProjectRegistry;
	getClient(context: { id: string }): Promise<{ request<T>(command: Command): Promise<T> }>;
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

test("Git 路由转发受限读取和幂等写操作", async (t) => {
	const tempDir = await mkdtemp(join(tmpdir(), "web-git-routes-"));
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "project");
	await mkdir(join(cwd, "packages", "app", "src"), { recursive: true });
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
	const status = { root: join(cwd, "packages", "app"), branch: "main", ahead: 0, behind: 0, files: [] };
	routes.getClient = async () => ({
		request: async <T>(command: Command): Promise<T> => {
			commands.push(command);
			switch (command.command) {
				case "get_git_stats":
					return { repositoryPath: "packages/app", files: [] } as T;
				case "get_git_history":
					return { repositoryPath: "packages/app", offset: command.offset, commits: [], hasMore: false } as T;
				case "get_git_commit":
					return {
						repositoryPath: "packages/app",
						hash: command.revision,
						shortHash: command.revision.slice(0, 7),
						subject: "提交",
						authorName: "LYStar",
						authorEmail: "lystar@example.invalid",
						authoredAt: "2026-09-12T00:00:00Z",
						parents: [],
						body: "提交\n",
						committerName: "LYStar",
						committerEmail: "lystar@example.invalid",
						committedAt: "2026-09-12T00:00:00Z",
						files: [],
					} as T;
				case "mutate_git":
					return {
						repositoryPath: "packages/app",
						action: command.mutation.type,
						message: "ok",
						status,
					} as T;
				default:
					throw new Error(`Unexpected command: ${command.command}`);
			}
		},
	});
	const context = { id: "browser-one" };

	const stats = responseCapture();
	await routes.handleProjects(
		request("GET"),
		stats.response,
		new URL(`http://localhost/api/projects/${project.id}/git/stats?repositoryPath=packages/app`),
		context,
		["api", "projects", project.id, "git", "stats"],
	);
	assert.deepEqual(stats.result(), { status: 200, body: { repositoryPath: "packages/app", files: [] } });
	assert.deepEqual(commands.at(-1), { command: "get_git_stats", cwd, repositoryPath: "packages/app" });

	const history = responseCapture();
	await routes.handleProjects(
		request("GET"),
		history.response,
		new URL(`http://localhost/api/projects/${project.id}/git/history?repositoryPath=packages/app&offset=50&limit=25`),
		context,
		["api", "projects", project.id, "git", "history"],
	);
	assert.deepEqual(commands.at(-1), {
		command: "get_git_history",
		cwd,
		repositoryPath: "packages/app",
		offset: 50,
		limit: 25,
	});

	const revision = "a".repeat(40);
	const commit = responseCapture();
	await routes.handleProjects(
		request("GET"),
		commit.response,
		new URL(
			`http://localhost/api/projects/${project.id}/git/commit?repositoryPath=packages/app&revision=${revision}&path=src/app.ts`,
		),
		context,
		["api", "projects", project.id, "git", "commit"],
	);
	assert.deepEqual(commands.at(-1), {
		command: "get_git_commit",
		cwd,
		repositoryPath: "packages/app",
		revision,
		path: "src/app.ts",
	});

	const mutation = responseCapture();
	await routes.handleProjects(
		request("POST", {
			repositoryPath: "packages/app",
			mutation: { type: "stage", paths: ["src/app.ts"] },
			clientRequestId: "git-stage-one",
		}),
		mutation.response,
		new URL(`http://localhost/api/projects/${project.id}/git/mutate`),
		context,
		["api", "projects", project.id, "git", "mutate"],
	);
	assert.deepEqual(commands.at(-1), {
		command: "mutate_git",
		cwd,
		repositoryPath: "packages/app",
		mutation: { type: "stage", paths: ["src/app.ts"] },
		clientInstanceId: "browser-one",
		clientRequestId: "git-stage-one",
	});
	assert.deepEqual(mutation.result(), {
		status: 200,
		body: { repositoryPath: "packages/app", action: "stage", message: "ok", status },
	});

	await assert.rejects(
		routes.handleProjects(
			request("POST", { mutation: { type: "rebase", branch: "main" } }),
			responseCapture().response,
			new URL(`http://localhost/api/projects/${project.id}/git/mutate`),
			context,
			["api", "projects", project.id, "git", "mutate"],
		),
		/Git 操作参数无效/u,
	);
	await assert.rejects(
		routes.handleProjects(
			request("GET"),
			responseCapture().response,
			new URL(`http://localhost/api/projects/${project.id}/git/history?limit=101`),
			context,
			["api", "projects", project.id, "git", "history"],
		),
		/Git 历史分页参数无效/u,
	);
});
