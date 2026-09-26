import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROTOCOL_VERSION, type ServerMessage, type SessionStateSnapshot } from "@lystar/code-web-protocol";
import { expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../../coding-agent/src/core/agent-session-runtime.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../coding-agent/src/core/agent-session-services.ts";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.ts";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import { WebRuntimeService } from "../src/service.ts";
import type { RuntimeSession } from "../src/types.ts";

it("acquire_session does not wait for an active turn in an already activated session", async () => {
	const root = mkdtempSync(join(tmpdir(), "web-acquire-active-turn-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
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
			...(await createAgentSessionFromServices({ services, sessionManager: options.sessionManager })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const adapter = new CodingAgentRuntimeAdapter({ agentDir, createRuntime });
	let runtime: RuntimeSession | undefined;
	let service: WebRuntimeService | undefined;
	let releaseTurn!: () => void;
	const activeTurn = new Promise<undefined>((resolve) => {
		releaseTurn = () => resolve(undefined);
	});
	try {
		runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		(runtime as unknown as { activePromptOperations: Set<Promise<undefined>> }).activePromptOperations.add(
			activeTurn,
		);
		service = new WebRuntimeService(adapter, { agentDir });
		(service as unknown as { attachRuntime(runtime: RuntimeSession): void }).attachRuntime(runtime);
		const messages: ServerMessage[] = [];
		const connection = service.createConnection(async (message) => {
			messages.push(message);
		});
		await connection.handle({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId: "browser" });
		const acquired = connection.handle({
			type: "request",
			id: "acquire",
			request: { command: "acquire_session", sessionPath: runtime.sessionPath, clientInstanceId: "browser" },
		});
		const outcome = await Promise.race([
			acquired.then(() => "acquired"),
			new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
		]);
		expect(outcome).toBe("acquired");
		expect(messages).toContainEqual(expect.objectContaining({ type: "response", id: "acquire", ok: true }));
		await connection.close();
	} finally {
		releaseTurn();
		if (service) await service.dispose();
		else await runtime?.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}, 20_000);

it("acquire_session returns while a Room turn delays extension lifecycle activation", async () => {
	const root = mkdtempSync(join(tmpdir(), "web-acquire-room-turn-"));
	const agentDir = join(root, "agent");
	const sessionPath = join(root, "session.jsonl");
	mkdirSync(agentDir, { recursive: true });
	let finishTurn!: () => void;
	const turn = new Promise<void>((resolve) => {
		finishTurn = resolve;
	});
	const snapshot: SessionStateSnapshot = {
		id: "room-session",
		path: sessionPath,
		cwd: root,
		createdAt: 1,
		updatedAt: 1,
		phase: "turn",
		activity: "running",
		attached: true,
		writeAccess: "owned",
		revision: 1,
		leafId: "leaf",
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		thinkingLevel: "off",
		transcriptGeneration: "generation",
		transcriptRevision: 1,
	};
	const activateExtensionLifecycle = vi.fn(() => turn);
	const runtime = {
		sessionPath,
		isConnected: () => true,
		getSnapshot: (writeAccess: SessionStateSnapshot["writeAccess"]) => ({ ...snapshot, writeAccess }),
		onEvent: () => () => {},
		activateExtensionLifecycle,
		dispose: async () => {},
	} as unknown as RuntimeSession;
	const service = new WebRuntimeService(new CodingAgentRuntimeAdapter(agentDir), { agentDir });
	const messages: ServerMessage[] = [];
	const connection = service.createConnection(async (message) => {
		messages.push(message);
	});
	let acquired: Promise<void> | undefined;
	try {
		(service as unknown as { attachRuntime(value: RuntimeSession): void }).attachRuntime(runtime);
		await connection.handle({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId: "browser" });
		acquired = connection.handle({
			type: "request",
			id: "acquire",
			request: { command: "acquire_session", sessionPath, clientInstanceId: "browser" },
		});
		const outcome = await Promise.race([
			acquired.then(() => "acquired"),
			new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 250)),
		]);
		expect(outcome).toBe("acquired");
		expect(activateExtensionLifecycle).toHaveBeenCalledOnce();
		expect(messages).toContainEqual(expect.objectContaining({ type: "response", id: "acquire", ok: true }));
	} finally {
		finishTurn();
		await acquired;
		await connection.close();
		await service.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
