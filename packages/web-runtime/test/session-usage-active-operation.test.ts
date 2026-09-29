import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROTOCOL_VERSION, type ServerMessage } from "@lystar/code-web-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import { WebRuntimeService } from "../src/service.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("WebRuntimeService session usage", () => {
	it("allows token reads while the session has an active operation", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-runtime-session-usage-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const service = new WebRuntimeService(adapter, { agentDir });
		const messages: ServerMessage[] = [];
		const connection = service.createConnection(async (message) => {
			messages.push(message);
		});
		cleanups.push(async () => {
			await connection.close();
			await service.dispose();
			rmSync(root, { recursive: true, force: true });
		});

		await connection.handle({
			type: "hello",
			version: RUNTIME_PROTOCOL_VERSION,
			clientInstanceId: "session-usage-client",
		});
		await connection.handle({
			type: "request",
			id: "create",
			request: {
				command: "create_session",
				cwd,
				clientInstanceId: "session-usage-client",
				clientRequestId: "create-session",
			},
		});
		const createResponse = messages.find(
			(message): message is Extract<ServerMessage, { type: "response" }> =>
				message.type === "response" && message.id === "create" && message.ok,
		);
		if (!createResponse || !createResponse.ok) throw new Error("Missing session creation response");
		const created = createResponse.result as unknown as {
			lease: { leaseId: string };
			snapshot: { path: string };
		};

		const internal = service as unknown as { activeOperationBySession: Map<string, string> };
		internal.activeOperationBySession.set(created.snapshot.path, "operation-1");
		await connection.handle({
			type: "request",
			id: "usage",
			request: {
				command: "get_session_info",
				sessionPath: created.snapshot.path,
				leaseId: created.lease.leaseId,
			},
		});

		const usageResponse = messages.find(
			(message): message is Extract<ServerMessage, { type: "response" }> =>
				message.type === "response" && message.id === "usage",
		);
		expect(usageResponse).toMatchObject({ type: "response", ok: true });
	});
});
