import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClientMessage,
	encodeServerMessage,
	type ServerMessage,
	type SessionSummary,
} from "@lystar/code-gui-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import { GuiHostService } from "../src/service.ts";
import type { RuntimeEvent, RuntimeSession } from "../src/types.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for GUI Host observation event");
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
}

describe("GuiHostService Session observation", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("observes external writer locks and committed JSONL changes without acquiring the Session", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "gui-host-observe-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const service = new GuiHostService(adapter, { agentDir });
		const messages: ServerMessage[] = [];
		const connection = service.createConnection(async (message) => {
			expect(() => encodeServerMessage(message)).not.toThrow();
			messages.push(message);
		});
		cleanups.push(async () => {
			await connection.close();
			await service.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});
		const handle = (message: ClientMessage) => connection.handle(message);
		await handle({ type: "hello", version: 2, clientInstanceId: "desktop-client" });
		await handle({ type: "request", id: "initial", request: { command: "list_sessions", cwd } });

		const external = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		cleanups.push(() => external.dispose());
		await external.runBash("printf first", false, () => {});
		const sessionPath = external.sessionPath;
		await waitFor(() =>
			messages.some(
				(message) =>
					message.type === "event" && message.event.type === "sessions_changed" && message.event.cwd === cwd,
			),
		);

		await handle({ type: "request", id: "locked", request: { command: "list_sessions", cwd } });
		const lockedResponse = messages.find(
			(message) => message.type === "response" && message.id === "locked" && message.ok,
		);
		if (!lockedResponse || lockedResponse.type !== "response" || !lockedResponse.ok) {
			throw new Error("Missing locked Session response");
		}
		const summaries = lockedResponse.result as unknown as SessionSummary[];
		expect(summaries).toEqual([
			expect.objectContaining({ path: sessionPath, writeAccess: "locked_externally", activity: "completed" }),
		]);

		messages.length = 0;
		await handle({
			type: "request",
			id: "metadata",
			request: { command: "list_sessions", cwd, metadataOnly: true },
		});
		const metadataResponse = messages.find(
			(message) => message.type === "response" && message.id === "metadata" && message.ok,
		);
		if (!metadataResponse || metadataResponse.type !== "response" || !metadataResponse.ok) {
			throw new Error("Missing metadata-only Session response");
		}
		const metadataSummaries = metadataResponse.result as unknown as SessionSummary[];
		expect(metadataSummaries).toEqual([
			expect.objectContaining({ path: sessionPath, messageCount: 0, firstMessage: "未命名会话" }),
		]);
		expect(metadataSummaries[0]).not.toHaveProperty("allMessagesText");

		messages.length = 0;
		await external.runBash("printf second", false, () => {});
		await waitFor(() =>
			messages.some(
				(message) =>
					message.type === "event" &&
					message.event.type === "transcript_changed" &&
					message.event.sessionPath === sessionPath,
			),
		);

		messages.length = 0;
		await external.dispose();
		await waitFor(() =>
			messages.some(
				(message) =>
					message.type === "event" && message.event.type === "sessions_changed" && message.event.cwd === cwd,
			),
		);
		await handle({ type: "request", id: "available", request: { command: "list_sessions", cwd } });
		const availableResponse = messages.find(
			(message) => message.type === "response" && message.id === "available" && message.ok,
		);
		if (!availableResponse || availableResponse.type !== "response" || !availableResponse.ok) {
			throw new Error("Missing available Session response");
		}
		expect(availableResponse.result).toEqual([
			expect.objectContaining({ path: sessionPath, writeAccess: "available", activity: "completed" }),
		]);

		messages.length = 0;
		await adapter.deleteSession(sessionPath);
		await waitFor(() =>
			messages.some(
				(message) =>
					message.type === "event" &&
					message.event.type === "session_removed" &&
					message.event.sessionPath === sessionPath,
			),
		);
	});

	it("projects observed external activity into the session summary", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "gui-host-activity-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const inspectActivity = vi.spyOn(adapter, "inspectSessionActivity").mockResolvedValue("running");
		const service = new GuiHostService(adapter, { agentDir });
		const messages: ServerMessage[] = [];
		const connection = service.createConnection(async (message) => {
			messages.push(message);
		});
		cleanups.push(async () => {
			await connection.close();
			await service.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});
		const handle = (message: ClientMessage) => connection.handle(message);
		await handle({ type: "hello", version: 2, clientInstanceId: "activity-client" });
		const external = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		cleanups.push(() => external.dispose());
		await external.runBash("printf activity", false, () => {});

		await handle({ type: "request", id: "activity", request: { command: "list_sessions", cwd } });
		const response = messages.find(
			(message) => message.type === "response" && message.id === "activity" && message.ok,
		);
		if (!response || response.type !== "response" || !response.ok)
			throw new Error("Missing activity Session response");
		const summaries = response.result as unknown as SessionSummary[];
		expect(summaries).toEqual([expect.objectContaining({ activity: "running", writeAccess: "locked_externally" })]);
		expect(inspectActivity).toHaveBeenCalledWith(external.sessionPath);
	});

	it("coalesces adjacent high-frequency progress before sending it over the Host protocol", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "gui-host-progress-"));
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const sessionPath = join(tempDir, "session.jsonl");
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const service = new GuiHostService(adapter, { agentDir });
		const messages: ServerMessage[] = [];
		let emit: ((event: RuntimeEvent) => void) | undefined;
		const runtime = {
			sessionPath,
			onEvent: (listener: (event: RuntimeEvent) => void) => {
				emit = listener;
				return () => {
					emit = undefined;
				};
			},
			dispose: async () => {},
		} as unknown as RuntimeSession;
		const connection = service.createConnection(async (message) => {
			messages.push(message);
		});
		cleanups.push(async () => {
			await connection.close();
			await service.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});
		await connection.handle({ type: "hello", version: 2, clientInstanceId: "progress-client" });
		(service as unknown as { attachRuntime(runtime: RuntimeSession): void }).attachRuntime(runtime);

		emit?.({ type: "progress", payload: { type: "assistant_delta", text: "O" } });
		emit?.({ type: "progress", payload: { type: "assistant_delta", text: "K" } });
		await waitFor(() =>
			messages.some((message) => message.type === "event" && message.event.type === "session_progress"),
		);

		const progress = messages.filter(
			(message): message is Extract<ServerMessage, { type: "event" }> =>
				message.type === "event" && message.event.type === "session_progress",
		);
		expect(progress).toHaveLength(1);
		expect(progress[0]?.event).toEqual({
			type: "session_progress",
			sessionPath,
			progress: { type: "assistant_delta", text: "OK" },
		});
	});
	it("returns active runtime recovery diagnostics through get_diagnostics", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "gui-host-diagnostics-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const service = new GuiHostService(adapter, { agentDir });
		const messages: ServerMessage[] = [];
		const connection = service.createConnection(async (message) => {
			messages.push(message);
		});
		cleanups.push(async () => {
			await connection.close();
			await service.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});
		const handle = (message: ClientMessage) => connection.handle(message);
		await handle({ type: "hello", version: 2, clientInstanceId: "diagnostics-client" });
		await handle({
			type: "request",
			id: "create",
			request: {
				command: "create_session",
				cwd,
				clientInstanceId: "diagnostics-client",
				clientRequestId: "create",
			},
		});
		const created = messages.find((message) => message.type === "response" && message.id === "create" && message.ok);
		if (!created || created.type !== "response" || !created.ok) throw new Error("Missing create response");
		const createdResult = created.result as { lease: { leaseId: string }; snapshot: { path: string } };
		const sessionPath = createdResult.snapshot.path;
		await handle({ type: "request", id: "sessions", request: { command: "list_sessions", cwd } });
		const emptySessions = messages.find(
			(message) => message.type === "response" && message.id === "sessions" && message.ok,
		);
		if (!emptySessions || emptySessions.type !== "response" || !emptySessions.ok)
			throw new Error("Missing empty sessions response");
		expect(emptySessions.result).toEqual([
			expect.objectContaining({
				path: sessionPath,
				messageCount: 0,
				firstMessage: "未命名会话",
				writeAccess: "owned",
			}),
		]);
		messages.length = 0;
		await handle({
			type: "request",
			id: "bash",
			request: {
				command: "run_bash",
				sessionPath,
				leaseId: createdResult.lease.leaseId,
				clientInstanceId: "diagnostics-client",
				clientRequestId: "bash",
				commandText: "printf attached-runtime",
				excludeFromContext: false,
			},
		});
		await waitFor(() =>
			messages.some(
				(message) =>
					message.type === "event" &&
					message.event.type === "operation_updated" &&
					message.event.operation.status === "completed",
			),
		);
		expect(
			messages.some(
				(message) =>
					message.type === "event" &&
					message.event.type === "transcript_committed" &&
					message.event.sessionPath === sessionPath,
			),
		).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 650));
		expect(
			messages.some(
				(message) =>
					message.type === "event" &&
					message.event.type === "transcript_changed" &&
					message.event.sessionPath === sessionPath,
			),
		).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 650));
		expect(
			messages.some(
				(message) =>
					message.type === "event" &&
					message.event.type === "session_removed" &&
					message.event.sessionPath === sessionPath,
			),
		).toBe(false);
		await handle({ type: "request", id: "diagnostics", request: { command: "get_diagnostics", cwd } });
		await handle({
			type: "request",
			id: "changelog",
			request: { command: "get_changelog", sessionPath, width: 80 },
		});

		const changelog = messages.find(
			(message) => message.type === "response" && message.id === "changelog" && message.ok,
		);
		if (!changelog || changelog.type !== "response" || !changelog.ok) throw new Error("Missing changelog response");
		expect(changelog.result).toMatchObject({ contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
		expect((changelog.result as { lines: string[] }).lines.length).toBeGreaterThan(0);

		const response = messages.find(
			(message) => message.type === "response" && message.id === "diagnostics" && message.ok,
		);
		if (!response || response.type !== "response" || !response.ok) throw new Error("Missing diagnostics response");
		const result = response.result as unknown as {
			recovery: {
				mode: string;
				sessionActive: boolean;
				activeCircuits: number;
				metrics: { toolRecoveryAttemptTotal: unknown[] };
			};
			lessons: { available: boolean; counts: Record<string, number> };
		};
		expect(result.recovery.mode).toBe("assist");
		expect(result.recovery.sessionActive).toBe(true);
		expect(result.recovery.activeCircuits).toBe(0);
		expect(result.recovery.metrics.toolRecoveryAttemptTotal).toEqual([]);
		expect(result.lessons).toEqual({
			available: true,
			counts: { candidate: 0, verified: 0, active: 0, disabled: 0, expired: 0 },
		});
	});
});
