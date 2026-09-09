import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClientMessage,
	RUNTIME_PROTOCOL_VERSION,
	type ServerMessage,
	type SessionStateSnapshot,
} from "@lystar/code-web-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEventListener } from "../../coding-agent/src/core/agent-session.ts";
import { openSessionWithWebHandoff } from "../../coding-agent/src/core/agent-session-runtime.ts";
import { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { requestWebSessionHandoff, WebCompanionServer } from "../../coding-agent/src/core/web-companion.ts";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import { WebRuntimeService } from "../src/service.ts";
import type { RuntimeSession } from "../src/types.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Session handoff");
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
}

function appendCompletedTurn(manager: SessionManager, text: string): void {
	const timestamp = Date.now();
	manager.appendMessage({ role: "user", content: text, timestamp });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "完成" }],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	});
}

function localRuntime(
	sessionPath: string,
	manager: SessionManager,
	activity: SessionStateSnapshot["activity"] = "idle",
): { runtime: RuntimeSession; dispose: ReturnType<typeof vi.fn> } {
	let connected = true;
	const dispose = vi.fn(async () => {
		connected = false;
		manager.dispose();
	});
	const runtime = {
		sessionPath,
		isConnected: () => connected,
		ownsSessionWriter: () => true,
		getSnapshot: (writeAccess: SessionStateSnapshot["writeAccess"]): SessionStateSnapshot => ({
			id: manager.getSessionId(),
			path: sessionPath,
			cwd: manager.getCwd(),
			createdAt: 1,
			updatedAt: 1,
			phase: activity === "idle" ? "idle" : "turn",
			activity,
			attached: true,
			writeAccess,
			revision: 0,
			leafId: manager.getLeafId(),
			queuedSteerCount: 0,
			queuedFollowUpCount: 0,
			thinkingLevel: "off",
			transcriptGeneration: manager.getSessionId(),
			transcriptRevision: 1,
		}),
		onEvent: () => () => {},
		dispose,
	} as unknown as RuntimeSession;
	return { runtime, dispose };
}

function response(messages: ServerMessage[], id: string): Extract<ServerMessage, { type: "response"; ok: true }> {
	const message = messages.find((candidate) => candidate.type === "response" && candidate.id === id && candidate.ok);
	if (!message || message.type !== "response" || !message.ok) throw new Error(`Missing response: ${id}`);
	return message;
}

describe("Web Runtime 到 TUI 的会话交接", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("交给 TUI 后保留 Web 租约并通过 Companion 继续操作", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-tui-handoff-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const webManager = SessionManager.create(cwd, join(agentDir, "sessions"));
		appendCompletedTurn(webManager, "来自 Web");
		const sessionPath = webManager.getSessionFile()!;
		const local = localRuntime(sessionPath, webManager);
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const openLocalSession = adapter.openSession.bind(adapter);
		const openSession = vi
			.spyOn(adapter, "openSession")
			.mockImplementationOnce(async () => local.runtime)
			.mockImplementation((path, onUiRequest) => openLocalSession(path, onUiRequest));
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
			clientInstanceId: "web-client",
		});
		await connection.handle({
			type: "request",
			id: "acquire",
			request: { command: "acquire_session", sessionPath, clientInstanceId: "web-client" },
		});
		const leaseId = (response(messages, "acquire").result as { lease: { leaseId: string } }).lease.leaseId;

		const tuiManager = await openSessionWithWebHandoff(sessionPath, agentDir);
		cleanups.push(() => tuiManager.dispose());
		let listener: AgentSessionEventListener | undefined;
		const prompt = vi.fn(async () => {});
		const tuiSession = {
			agent: { state: { streamingMessage: undefined } },
			sessionFile: sessionPath,
			sessionManager: tuiManager,
			sessionName: undefined,
			model: undefined,
			thinkingLevel: "off",
			isCompacting: false,
			retryAttempt: 0,
			isStreaming: false,
			getContextUsage: () => undefined,
			getSteeringMessages: () => [],
			getFollowUpMessages: () => [],
			getToolActivityEpoch: () => "epoch",
			getToolActivityRevision: () => 0,
			getToolActivitySnapshot: () => [],
			subscribe: (next: AgentSessionEventListener) => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			prompt,
			waitForIdle: async () => {},
		} as unknown as AgentSession;
		const companion = new WebCompanionServer(tuiSession, agentDir);
		await companion.start();
		cleanups.push(() => companion.dispose());

		await waitFor(() => openSession.mock.calls.length >= 2);
		await connection.handle({
			type: "request",
			id: "prompt",
			request: {
				command: "prompt",
				sessionPath,
				leaseId,
				clientInstanceId: "web-client",
				clientRequestId: "web-after-handoff",
				text: "Web 继续发送",
			},
		} satisfies ClientMessage);
		await waitFor(() => prompt.mock.calls.length === 1);

		expect(local.dispose).toHaveBeenCalledOnce();
		expect(prompt).toHaveBeenCalledWith("Web 继续发送", expect.objectContaining({ source: "rpc" }));
		expect(listener).toBeTypeOf("function");
	});

	it("会话运行时拒绝交接并继续持有写锁", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-tui-handoff-active-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
		appendCompletedTurn(manager, "运行中");
		const sessionPath = manager.getSessionFile()!;
		const local = localRuntime(sessionPath, manager, "running");
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		vi.spyOn(adapter, "openSession").mockResolvedValue(local.runtime);
		const service = new WebRuntimeService(adapter, { agentDir });
		const messages: ServerMessage[] = [];
		const connection = service.createConnection(async (message) => {
			messages.push(message);
		});
		cleanups.push(async () => {
			await connection.close();
			await service.dispose();
			manager.dispose();
			rmSync(root, { recursive: true, force: true });
		});

		await connection.handle({
			type: "hello",
			version: RUNTIME_PROTOCOL_VERSION,
			clientInstanceId: "web-client",
		});
		await connection.handle({
			type: "request",
			id: "acquire",
			request: { command: "acquire_session", sessionPath, clientInstanceId: "web-client" },
		});
		response(messages, "acquire");

		await expect(requestWebSessionHandoff(agentDir, sessionPath)).rejects.toMatchObject({
			code: "session_operation_active",
			retryable: true,
		});
		expect(local.dispose).not.toHaveBeenCalled();
		expect(SessionManager.isWriterLocked(sessionPath)).toBe(true);
	});
});
