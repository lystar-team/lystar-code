import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientMessage, RUNTIME_PROTOCOL_VERSION, type ServerMessage } from "@lystar/code-web-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../../coding-agent/src/core/agent-session-runtime.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../coding-agent/src/core/agent-session-services.ts";
import { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.ts";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import { WebRuntimeService } from "../src/service.ts";
import type { RuntimeSession } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function appendCompletedTurn(manager: SessionManager): void {
	const timestamp = Date.now();
	manager.appendMessage({ role: "user", content: "共享会话", timestamp });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "已创建" }],
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

function successfulResponse(
	messages: ServerMessage[],
	id: string,
): Extract<ServerMessage, { type: "response"; ok: true }> | undefined {
	const message = messages.find((candidate) => candidate.type === "response" && candidate.id === id);
	return message?.type === "response" && message.ok ? message : undefined;
}

async function waitForResponse(
	messages: ServerMessage[],
	id: string,
): Promise<Extract<ServerMessage, { type: "response"; ok: true }>> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const response = successfulResponse(messages, id);
		if (response) return response;
		const failure = messages.find(
			(candidate): candidate is Extract<ServerMessage, { type: "response"; ok: false }> =>
				candidate.type === "response" && candidate.id === id && !candidate.ok,
		);
		if (failure) throw new Error(`${failure.error.code}: ${failure.error.message}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`等待 Runtime 响应超时：${id}`);
}

async function waitForRuntimeOwner(service: WebRuntimeService, sessionPath: string): Promise<RuntimeSession> {
	const runtimes = (service as unknown as { runtimes: Map<string, RuntimeSession> }).runtimes;
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const runtime = runtimes.get(sessionPath);
		if (runtime?.ownsSessionWriter?.() === true && runtime.isConnected?.() !== false) return runtime;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`等待 Runtime 取得会话写入权超时：${sessionPath}`);
}

function createSessionWorkspace(): {
	root: string;
	agentDir: string;
	cwd: string;
	sessionPath: string;
	createRuntime: CreateAgentSessionRuntimeFactory;
} {
	const root = mkdtempSync(join(tmpdir(), "web-runtime-multi-client-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
	appendCompletedTurn(manager);
	const sessionPath = manager.getSessionFile()!;
	manager.dispose();
	return { root, agentDir, cwd, sessionPath, createRuntime: runtimeFactory() };
}

async function acquireSession(
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
		id: "acquire",
		request: { command: "acquire_session", sessionPath, clientInstanceId },
	});
	const acquired = await waitForResponse(messages, "acquire");
	const result = acquired.result as { lease: { leaseId: string } };
	return { connection, messages, leaseId: result.lease.leaseId };
}

async function renameThroughService(
	connection: ReturnType<WebRuntimeService["createConnection"]>,
	messages: ServerMessage[],
	sessionPath: string,
	leaseId: string,
	clientInstanceId: string,
	name: string,
	requestId: string,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	let attempt = 0;
	while (Date.now() < deadline) {
		const id = `${requestId}-${attempt++}`;
		await connection.handle({
			type: "request",
			id,
			request: {
				command: "rename_session",
				sessionPath,
				leaseId,
				clientInstanceId,
				clientRequestId: id,
				name,
			},
		} satisfies ClientMessage);
		const response = messages.find(
			(candidate): candidate is Extract<ServerMessage, { type: "response" }> =>
				candidate.type === "response" && candidate.id === id,
		);
		if (response?.ok) return;
		if (response && response.error.code !== "session_handoff_in_progress") {
			throw new Error(`${response.error.code}: ${response.error.message}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`等待会话接管完成超时：${requestId}`);
}

describe("Web Runtime 多端会话协作", () => {
	it("按准确 ID 停止其他客户端持有的运行中会话，不删除会话", async () => {
		const workspace = createSessionWorkspace();
		const service = new WebRuntimeService(
			new CodingAgentRuntimeAdapter({ agentDir: workspace.agentDir, createRuntime: workspace.createRuntime }),
			{ agentDir: workspace.agentDir },
		);
		const owner = await acquireSession(service, workspace.sessionPath, "owner-client");
		const runtime = await waitForRuntimeOwner(service, workspace.sessionPath);
		const snapshot = runtime.getSnapshot.bind(runtime);
		const sessionId = snapshot("available").id;
		const snapshotMock = vi.spyOn(runtime, "getSnapshot").mockImplementation((access) => ({
			...snapshot(access),
			activity: "running",
			phase: "turn",
		}));
		const abort = vi.spyOn(runtime, "abort").mockResolvedValue();
		const clearQueue = vi.spyOn(runtime, "clearQueue");
		const messages: ServerMessage[] = [];
		const controller = service.createConnection(async (message) => {
			messages.push(message);
		});
		cleanups.push(async () => {
			await controller.close();
			await owner.connection.close();
			await service.dispose();
			rmSync(workspace.root, { recursive: true, force: true });
		});
		await controller.handle({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId: "stop-client" });
		await controller.handle({
			type: "request",
			id: "wrong",
			request: { command: "stop_session", sessionId: "other" },
		});
		const wrong = messages.find((item) => item.type === "response" && item.id === "wrong");
		expect(wrong).toMatchObject({ ok: false, error: { code: "session_not_running" } });
		expect(abort).not.toHaveBeenCalled();

		await controller.handle({ type: "request", id: "stop", request: { command: "stop_session", sessionId } });
		expect((await waitForResponse(messages, "stop")).result).toEqual({ stopped: true });
		expect(abort).toHaveBeenCalledOnce();
		expect(clearQueue).toHaveBeenCalledOnce();
		snapshotMock.mockRestore();
		await controller.handle({ type: "request", id: "idle", request: { command: "stop_session", sessionId } });
		expect((await waitForResponse(messages, "idle")).result).toEqual({ stopped: false });
		expect(abort).toHaveBeenCalledOnce();
		expect(snapshot("available").id).toBe(sessionId);
	});

	it("本地控制端退出后仍为其他 Runtime 客户端保留会话", async () => {
		const workspace = createSessionWorkspace();
		const ownerAdapter = new CodingAgentRuntimeAdapter({
			agentDir: workspace.agentDir,
			createRuntime: workspace.createRuntime,
		});
		const ownerService = new WebRuntimeService(ownerAdapter, { agentDir: workspace.agentDir });
		const owner = await acquireSession(ownerService, workspace.sessionPath, "release-client");
		const follower = await new CodingAgentRuntimeAdapter({
			agentDir: workspace.agentDir,
			createRuntime: workspace.createRuntime,
		}).openSession(workspace.sessionPath, async () => ({ cancelled: true }));
		cleanups.push(async () => {
			await follower.dispose();
			await ownerService.dispose();
			rmSync(workspace.root, { recursive: true, force: true });
		});

		expect(follower.ownsSessionWriter?.()).toBe(false);
		await owner.connection.close();
		await follower.rename("跟随端继续使用");
		expect(follower.getSnapshot("owned").name).toBe("跟随端继续使用");
	});

	it("development Runtime 接管后 Release Runtime 自动跟随", async () => {
		const workspace = createSessionWorkspace();
		const releaseService = new WebRuntimeService(
			new CodingAgentRuntimeAdapter({
				agentDir: workspace.agentDir,
				createRuntime: workspace.createRuntime,
			}),
			{ agentDir: workspace.agentDir },
		);
		const release = await acquireSession(releaseService, workspace.sessionPath, "release-client");
		let developmentRuntime: RuntimeSession | undefined;
		cleanups.push(async () => {
			await release.connection.close();
			await releaseService.dispose();
			await developmentRuntime?.dispose();
			rmSync(workspace.root, { recursive: true, force: true });
		});

		developmentRuntime = await new CodingAgentRuntimeAdapter({
			agentDir: workspace.agentDir,
			createRuntime: workspace.createRuntime,
			preferSessionOwnership: true,
		}).openSession(workspace.sessionPath, async () => ({ cancelled: true }));
		expect(developmentRuntime.ownsSessionWriter?.()).toBe(true);

		await renameThroughService(
			release.connection,
			release.messages,
			workspace.sessionPath,
			release.leaseId,
			"release-client",
			"Release 通过 development Runtime 写入",
			"rename-after-takeover",
		);
		expect(developmentRuntime.getSnapshot("owned").name).toBe("Release 通过 development Runtime 写入");

		await developmentRuntime.dispose();
		developmentRuntime = undefined;
		const recoveredReleaseRuntime = await waitForRuntimeOwner(releaseService, workspace.sessionPath);
		await renameThroughService(
			release.connection,
			release.messages,
			workspace.sessionPath,
			release.leaseId,
			"release-client",
			"development 退出后由 Release 接管",
			"rename-after-owner-exit",
		);
		expect(recoveredReleaseRuntime.getSnapshot("owned").name).toBe("development 退出后由 Release 接管");
	});

	it("不同会话可分别由 Release 与 development Runtime 持有", async () => {
		const workspace = createSessionWorkspace();
		const secondManager = SessionManager.create(workspace.cwd, join(workspace.agentDir, "sessions"));
		appendCompletedTurn(secondManager);
		const secondSessionPath = secondManager.getSessionFile()!;
		secondManager.dispose();
		const releaseRuntime = await new CodingAgentRuntimeAdapter({
			agentDir: workspace.agentDir,
			createRuntime: workspace.createRuntime,
		}).openSession(workspace.sessionPath, async () => ({ cancelled: true }));
		const developmentRuntime = await new CodingAgentRuntimeAdapter({
			agentDir: workspace.agentDir,
			createRuntime: workspace.createRuntime,
			preferSessionOwnership: true,
		}).openSession(secondSessionPath, async () => ({ cancelled: true }));
		cleanups.push(async () => {
			await releaseRuntime.dispose();
			await developmentRuntime.dispose();
			rmSync(workspace.root, { recursive: true, force: true });
		});

		expect(releaseRuntime.ownsSessionWriter?.()).toBe(true);
		expect(developmentRuntime.ownsSessionWriter?.()).toBe(true);
		await releaseRuntime.rename("Release 会话");
		await developmentRuntime.rename("development 会话");
		expect(releaseRuntime.getSnapshot("owned").name).toBe("Release 会话");
		expect(developmentRuntime.getSnapshot("owned").name).toBe("development 会话");
	});
});
