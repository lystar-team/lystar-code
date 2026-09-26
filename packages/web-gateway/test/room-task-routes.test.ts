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

function request(method: string, body: Record<string, unknown>): IncomingMessage {
	const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
	stream.method = method;
	stream.headers = {};
	return stream;
}

function capture(): { response: ServerResponse; result: () => { status: number; body: unknown } } {
	let status = 0;
	let body = "";
	return {
		response: {
			writeHead(code: number) {
				status = code;
			},
			end(text: string) {
				body = text;
			},
		} as unknown as ServerResponse,
		result: () => ({ status, body: JSON.parse(body) as unknown }),
	};
}

test("Room 任务编辑和评论路由校验归属并转发结构化命令", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "lystar-room-task-routes-"));
	const cwd = join(root, "project");
	await mkdir(cwd, { recursive: true });
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir: join(root, "agent"),
		runtimeEndpoint: join(root, "host.sock"),
		token: "test-token",
		tokenPath: join(root, "token"),
		allowedHosts: ["127.0.0.1"],
		staticDir: root,
		manageRuntime: false,
	});
	t.after(async () => {
		await server.close();
		await rm(root, { recursive: true, force: true });
	});
	const routes = server as unknown as {
		registry: ProjectRegistry;
		getClient(context: { id: string }): Promise<{ request<T>(command: Command): Promise<T> }>;
		resolveSession(
			context: { id: string },
			sessionId: string,
		): Promise<{ id: string; path: string; projectId: string }>;
		handleProjects(
			request: IncomingMessage,
			response: ServerResponse,
			url: URL,
			context: { id: string },
			parts: string[],
		): Promise<void>;
	};
	await routes.registry.load();
	const project = await routes.registry.add({ id: "project-one", cwd, name: "Project One" });
	const commands: Command[] = [];
	routes.getClient = async () => ({
		request: async <T>(command: Command): Promise<T> => {
			commands.push(command);
			return { id: "task-one" } as T;
		},
	});
	routes.resolveSession = async (_context, sessionId) => ({
		id: sessionId,
		path: join(root, sessionId),
		projectId: sessionId === "outsider" ? "other" : project.id,
	});
	const parts = ["api", "projects", project.id, "rooms", "room-one", "tasks", "task-one"];
	const context = { id: "browser" };
	const taskUrl = new URL(`http://localhost/${parts.join("/")}`);

	const edited = capture();
	await routes.handleProjects(
		request("PATCH", { sessionId: "owner", title: "新标题", assigneeSessionId: "worker" }),
		edited.response,
		taskUrl,
		context,
		parts,
	);
	assert.deepEqual(edited.result(), { status: 200, body: { id: "task-one" } });
	assert.deepEqual(commands.at(-1), {
		command: "room_task_edit",
		cwd,
		roomId: "room-one",
		taskId: "task-one",
		sessionId: "owner",
		title: "新标题",
		assigneeSessionId: "worker",
	});

	const commentParts = [...parts, "comments"];
	const commented = capture();
	await routes.handleProjects(
		request("POST", { sessionId: "owner", body: "@worker 请核对" }),
		commented.response,
		new URL(`${taskUrl}/comments`),
		context,
		commentParts,
	);
	assert.deepEqual(commented.result(), { status: 200, body: { id: "task-one" } });
	assert.deepEqual(commands.at(-1), {
		command: "room_task_comment",
		cwd,
		roomId: "room-one",
		taskId: "task-one",
		sessionId: "owner",
		body: "@worker 请核对",
	});

	const before = commands.length;
	await assert.rejects(
		routes.handleProjects(
			request("PATCH", { sessionId: "owner", assigneeSessionId: "outsider" }),
			capture().response,
			taskUrl,
			context,
			parts,
		),
		/负责人不属于当前项目/u,
	);
	await assert.rejects(
		routes.handleProjects(
			request("POST", { sessionId: "owner", body: "   " }),
			capture().response,
			new URL(`${taskUrl}/comments`),
			context,
			commentParts,
		),
		/评论内容长度无效/u,
	);
	assert.equal(commands.length, before);
});
