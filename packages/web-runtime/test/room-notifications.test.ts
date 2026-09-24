import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROTOCOL_VERSION, type ServerMessage } from "@lystar/code-web-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import { WebRuntimeService } from "../src/service.ts";
import type { UiRequestHandler } from "../src/types.ts";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

describe("Room startup notifications", () => {
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("suppresses Room startup info while preserving warnings and regular-session info", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-room-notify-"));
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const service = new WebRuntimeService(new CodingAgentRuntimeAdapter(agentDir), { agentDir });
		const messages: ServerMessage[] = [];
		const connection = service.createConnection(async (message) => {
			messages.push(message);
		});
		cleanups.push(async () => {
			await connection.close();
			await service.dispose();
		});
		const clientInstanceId = "room-notify-client";
		await connection.handle({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId });
		const createUiRequestHandler = (
			service as unknown as {
				createUiRequestHandler(
					operationId: string,
					sessionPath?: string,
					clientInstanceId?: string,
					options?: { suppressInfoNotifications?: boolean },
				): UiRequestHandler;
			}
		).createUiRequestHandler;
		const roomHandler = createUiRequestHandler.call(service, "room-create", undefined, clientInstanceId, {
			suppressInfoNotifications: true,
		});
		const regularHandler = createUiRequestHandler.call(service, "regular-create", undefined, clientInstanceId);
		await roomHandler({
			id: "room-info",
			kind: "notify",
			title: "MCP",
			payload: { method: "notify", type: "info", message: "MCP: 1/1 servers" },
		});
		await roomHandler({
			id: "room-warning",
			kind: "notify",
			title: "MCP",
			payload: { method: "notify", type: "warning", message: "MCP server unavailable" },
		});
		await regularHandler({
			id: "regular-info",
			kind: "notify",
			title: "Session",
			payload: { method: "notify", type: "info", message: "Session ready" },
		});

		const notifications = messages.filter(
			(message): message is Extract<ServerMessage, { type: "event" }> =>
				message.type === "event" && message.event.type === "ui_request",
		);
		expect(notifications.map((message) => message.event)).toMatchObject([
			{ operationId: "room-create", payload: { type: "warning", message: "MCP server unavailable" } },
			{ operationId: "regular-create", payload: { type: "info", message: "Session ready" } },
		]);
	});
});
