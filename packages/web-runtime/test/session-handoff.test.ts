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
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	openSessionWithWebHandoff,
} from "../../coding-agent/src/core/agent-session-runtime.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../coding-agent/src/core/agent-session-services.ts";
import { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.ts";
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

function runtimeFactory(): CreateAgentSessionRuntimeFactory {
	return async (options) => {
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager: SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
}

function localRuntime(
	sessionPath: string,
	manager: SessionManager,
	activity: SessionStateSnapshot["activity"] = "idle",
): {
	runtime: RuntimeSession;
	dispose: ReturnType<typeof vi.fn>;
	setActivity: (activity: SessionStateSnapshot["activity"]) => void;
	setQueuedFollowUpCount: (count: number) => void;
} {
	let connected = true;
	let currentActivity = activity;
	let queuedFollowUpCount = 0;
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
			phase: currentActivity === "idle" ? "idle" : "turn",
			activity: currentActivity,
			attached: true,
			writeAccess,
			revision: 0,
			leafId: manager.getLeafId(),
			queuedSteerCount: 0,
			queuedFollowUpCount,
			thinkingLevel: "off",
			transcriptGeneration: manager.getSessionId(),
			transcriptRevision: 1,
		}),
		onEvent: () => () => {},
		dispose,
	} as unknown as RuntimeSession;
	return {
		runtime,
		dispose,
		setActivity: (nextActivity) => {
			currentActivity = nextActivity;
		},
		setQueuedFollowUpCount: (count) => {
			queuedFollowUpCount = count;
		},
	};
}

function response(messages: ServerMessage[], id: string): Extract<ServerMessage, { type: "response"; ok: true }> {
	const message = messages.find((candidate) => candidate.type === "response" && candidate.id === id && candidate.ok);
	if (!message || message.type !== "response" || !message.ok) throw new Error(`Missing response: ${id}`);
	return message;
}

async function acquireWebSession(
	service: WebRuntimeService,
	sessionPath: string,
	clientInstanceId: string,
): Promise<{
	connection: ReturnType<WebRuntimeService["createConnection"]>;
	messages: ServerMessage[];
	leaseId: string;
}> {
	const messages: ServerMessage[] = [];
	const connection = service.createConnection(async (message) => {
		messages.push(message);
	});
	await connection.handle({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId });
	await connection.handle({
		type: "request",
		id: `acquire-${clientInstanceId}`,
		request: { command: "acquire_session", sessionPath, clientInstanceId },
	});
	const acquired = response(messages, `acquire-${clientInstanceId}`).result as { lease: { leaseId: string } };
	return { connection, messages, leaseId: acquired.lease.leaseId };
}

async function promptThroughWeb(
	connection: ReturnType<WebRuntimeService["createConnection"]>,
	messages: ServerMessage[],
	sessionPath: string,
	leaseId: string,
	clientInstanceId: string,
	text: string,
): Promise<void> {
	const id = `prompt-${clientInstanceId}`;
	await connection.handle({
		type: "request",
		id,
		request: {
			command: "prompt",
			sessionPath,
			leaseId,
			clientInstanceId,
			clientRequestId: id,
			text,
		},
	} satisfies ClientMessage);
	response(messages, id);
}

describe("Web Runtime 到 TUI 的会话交接", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("Release Web 发起后由 TUI Resume，再由 development Web 接力", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-tui-handoff-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));

		const webManager = SessionManager.create(cwd, join(agentDir, "sessions"));
		appendCompletedTurn(webManager, "来自 Release Web");
		const sessionPath = webManager.getSessionFile()!;
		const local = localRuntime(sessionPath, webManager);
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const openLocalSession = adapter.openSession.bind(adapter);
		const openSession = vi
			.spyOn(adapter, "openSession")
			.mockImplementationOnce(async () => local.runtime)
			.mockImplementation((path, onUiRequest) => openLocalSession(path, onUiRequest));
		const releaseService = new WebRuntimeService(adapter, { agentDir });
		cleanups.push(() => releaseService.dispose());
		const release = await acquireWebSession(releaseService, sessionPath, "release-client");
		cleanups.push(() => release.connection.close());

		const initialTuiManager = SessionManager.create(cwd, join(agentDir, "sessions"));
		appendCompletedTurn(initialTuiManager, "TUI 当前会话");
		const tuiRuntime = await createAgentSessionRuntime(runtimeFactory(), {
			cwd,
			agentDir,
			sessionManager: initialTuiManager,
			writerHandoff: true,
		});
		cleanups.push(() => tuiRuntime.dispose());
		const resumeResult = await tuiRuntime.switchSession(sessionPath);
		expect(resumeResult.cancelled).toBe(false);
		expect(tuiRuntime.session.sessionFile).toBe(sessionPath);

		const prompt = vi.spyOn(tuiRuntime.session, "prompt").mockResolvedValue(undefined);
		await tuiRuntime.session.prompt("TUI 接力");
		const companion = new WebCompanionServer(tuiRuntime.session, agentDir);
		await companion.start();
		cleanups.push(() => companion.dispose());
		await waitFor(() => openSession.mock.calls.length >= 2);

		const developmentService = new WebRuntimeService(
			new CodingAgentRuntimeAdapter({ agentDir, preferSessionOwnership: true }),
			{ agentDir },
		);
		cleanups.push(() => developmentService.dispose());
		const development = await acquireWebSession(developmentService, sessionPath, "development-client");
		cleanups.push(() => development.connection.close());
		await promptThroughWeb(
			development.connection,
			development.messages,
			sessionPath,
			development.leaseId,
			"development-client",
			"development Web 接力",
		);
		await promptThroughWeb(
			release.connection,
			release.messages,
			sessionPath,
			release.leaseId,
			"release-client",
			"Release Web 再次接力",
		);

		expect(local.dispose).toHaveBeenCalledOnce();
		await waitFor(() => prompt.mock.calls.length === 3);
		expect(prompt.mock.calls.map(([text]) => text)).toEqual([
			"TUI 接力",
			"development Web 接力",
			"Release Web 再次接力",
		]);
	});

	it("TUI 发起后由 Release Web 和 development Web 依次接力", async () => {
		const root = mkdtempSync(join(tmpdir(), "tui-release-development-handoff-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));

		const tuiManager = SessionManager.create(cwd, join(agentDir, "sessions"));
		appendCompletedTurn(tuiManager, "来自 TUI");
		const sessionPath = tuiManager.getSessionFile()!;
		const tuiRuntime = await createAgentSessionRuntime(runtimeFactory(), {
			cwd,
			agentDir,
			sessionManager: tuiManager,
			writerHandoff: true,
		});
		cleanups.push(() => tuiRuntime.dispose());
		const prompt = vi.spyOn(tuiRuntime.session, "prompt").mockResolvedValue(undefined);
		const companion = new WebCompanionServer(tuiRuntime.session, agentDir);
		await companion.start();
		cleanups.push(() => companion.dispose());

		const releaseService = new WebRuntimeService(new CodingAgentRuntimeAdapter(agentDir), { agentDir });
		cleanups.push(() => releaseService.dispose());
		const release = await acquireWebSession(releaseService, sessionPath, "release-client");
		cleanups.push(() => release.connection.close());
		await promptThroughWeb(
			release.connection,
			release.messages,
			sessionPath,
			release.leaseId,
			"release-client",
			"Release Web 接力",
		);

		const developmentService = new WebRuntimeService(
			new CodingAgentRuntimeAdapter({ agentDir, preferSessionOwnership: true }),
			{ agentDir },
		);
		cleanups.push(() => developmentService.dispose());
		const development = await acquireWebSession(developmentService, sessionPath, "development-client");
		cleanups.push(() => development.connection.close());
		await promptThroughWeb(
			development.connection,
			development.messages,
			sessionPath,
			development.leaseId,
			"development-client",
			"development Web 接力",
		);

		await waitFor(() => prompt.mock.calls.length === 2);
		expect(prompt.mock.calls.map(([text]) => text)).toEqual(["Release Web 接力", "development Web 接力"]);
		expect(SessionManager.isWriterLocked(sessionPath)).toBe(true);
	});

	it("TUI owner serializes simultaneous Release and development Web prompts", async () => {
		const root = mkdtempSync(join(tmpdir(), "tui-web-concurrent-prompts-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));

		const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
		appendCompletedTurn(manager, "来自 TUI");
		const sessionPath = manager.getSessionFile()!;
		const tuiRuntime = await createAgentSessionRuntime(runtimeFactory(), {
			cwd,
			agentDir,
			sessionManager: manager,
			writerHandoff: true,
		});
		cleanups.push(() => tuiRuntime.dispose());
		let streaming = false;
		let releasePrompt: (() => void) | undefined;
		cleanups.push(() => releasePrompt?.());
		vi.spyOn(tuiRuntime.session, "isStreaming", "get").mockImplementation(() => streaming);
		const prompt = vi.spyOn(tuiRuntime.session, "prompt").mockImplementation(async (text, options) => {
			if (streaming) {
				await tuiRuntime.session.followUp(text, options?.images, options?.queueId);
				options?.preflightResult?.(true);
				return;
			}
			options?.preflightResult?.(true);
			streaming = true;
			await new Promise<void>((resolve) => {
				releasePrompt = resolve;
			});
			streaming = false;
		});
		const followUp = vi.spyOn(tuiRuntime.session, "followUp").mockResolvedValue(undefined);
		const companion = new WebCompanionServer(tuiRuntime.session, agentDir);
		await companion.start();
		cleanups.push(() => companion.dispose());

		const releaseService = new WebRuntimeService(new CodingAgentRuntimeAdapter(agentDir), { agentDir });
		cleanups.push(() => releaseService.dispose());
		const release = await acquireWebSession(releaseService, sessionPath, "release-client");
		cleanups.push(() => release.connection.close());
		const developmentService = new WebRuntimeService(
			new CodingAgentRuntimeAdapter({ agentDir, preferSessionOwnership: true }),
			{ agentDir },
		);
		cleanups.push(() => developmentService.dispose());
		const development = await acquireWebSession(developmentService, sessionPath, "development-client");
		cleanups.push(() => development.connection.close());

		await Promise.all([
			promptThroughWeb(
				release.connection,
				release.messages,
				sessionPath,
				release.leaseId,
				"release-client",
				"Release Web 同时提交",
			),
			promptThroughWeb(
				development.connection,
				development.messages,
				sessionPath,
				development.leaseId,
				"development-client",
				"development Web 同时提交",
			),
		]);
		await waitFor(() => prompt.mock.calls.length === 2 && followUp.mock.calls.length === 1);

		const [, , queueId] = followUp.mock.calls[0] ?? [];
		expect(new Set(prompt.mock.calls.map(([text]) => text))).toEqual(
			new Set(["Release Web 同时提交", "development Web 同时提交"]),
		);
		expect(["prompt-release-client", "prompt-development-client"]).toContain(queueId);
		releasePrompt?.();
		await waitFor(() => !streaming);
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

	it("TUI Resume waits for Web work and queued prompts before taking the writer", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-tui-handoff-wait-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
		appendCompletedTurn(manager, "等待接管");
		const sessionPath = manager.getSessionFile()!;
		const local = localRuntime(sessionPath, manager, "running");
		local.setQueuedFollowUpCount(1);
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		vi.spyOn(adapter, "openSession").mockResolvedValue(local.runtime);
		const service = new WebRuntimeService(adapter, { agentDir });
		const web = await acquireWebSession(service, sessionPath, "web-client");
		cleanups.push(async () => {
			await web.connection.close();
			await service.dispose();
			manager.dispose();
			rmSync(root, { recursive: true, force: true });
		});

		const opening = openSessionWithWebHandoff(sessionPath, agentDir);
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(local.dispose).not.toHaveBeenCalled();
		local.setActivity("idle");
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(local.dispose).not.toHaveBeenCalled();
		local.setQueuedFollowUpCount(0);

		const opened = await opening;
		expect(opened.getSessionFile()).toBe(sessionPath);
		expect(local.dispose).toHaveBeenCalledOnce();
		opened.dispose();
	});
});
