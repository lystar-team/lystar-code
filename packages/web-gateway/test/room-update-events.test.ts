import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ServerEvent } from "@lystar/code-web-protocol";
import { WebSocket } from "ws";
import type { WebGatewayConfig } from "../src/config.ts";
import { WebGatewayServer } from "../src/server.ts";

test("Room 变更只推送轻量通知，不把消息和任务改动变成工作台重建", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-room-gateway-"));
	const server = new WebGatewayServer({
		host: "127.0.0.1",
		port: 0,
		agentDir,
		runtimeEndpoint: join(agentDir, "host.sock"),
		token: "room-update-test-token",
		tokenPath: join(agentDir, "web", "token"),
		allowedHosts: ["127.0.0.1"],
		staticDir: agentDir,
		manageRuntime: false,
	} satisfies WebGatewayConfig);
	t.after(async () => {
		await server.close();
		await rm(agentDir, { recursive: true, force: true });
	});
	await server.registry.load();
	await server.registry.add({ id: "project", name: "协作项目", cwd: agentDir });
	const internal = server as unknown as {
		createContext(id: string): { sockets: Set<WebSocket>; bootstrapGeneration: number };
		handleHostEvent(context: { sockets: Set<WebSocket>; bootstrapGeneration: number }, event: ServerEvent): void;
	};
	const context = internal.createContext("room-client");
	const sent: unknown[] = [];
	context.sockets.add({
		readyState: WebSocket.OPEN,
		bufferedAmount: 0,
		send(value: string, callback: (error?: Error) => void) {
			sent.push(JSON.parse(value));
			callback();
		},
		close() {},
	} as unknown as WebSocket);
	const event: ServerEvent = {
		type: "room_updated",
		cwd: agentDir,
		roomId: "00000000-0000-4000-8000-000000000001",
		latestSeq: 4,
		messagesChanged: true,
		tasksChanged: false,
		membersChanged: false,
	};
	internal.handleHostEvent(context, event);
	assert.deepEqual(sent, [
		{
			type: "room_updated",
			projectId: "project",
			roomId: event.roomId,
			latestSeq: 4,
			messagesChanged: true,
			tasksChanged: false,
			membersChanged: false,
		},
	]);
	assert.equal(context.bootstrapGeneration, 0);
	internal.handleHostEvent(context, { ...event, messagesChanged: false, membersChanged: true });
	assert.equal(context.bootstrapGeneration, 1);
});
