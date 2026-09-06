import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { GuiCompanionCommand } from "../src/core/gui-companion.ts";
import { GuiCompanionServer, getGuiCompanionEndpoint } from "../src/core/gui-companion.ts";

const tempDirs = new Set<string>();
type SpawnedChild = ChildProcessByStdio<null, Readable, null>;
const children = new Set<SpawnedChild>();

function createSession(sessionPath: string): AgentSession {
	return {
		sessionFile: sessionPath,
		sessionManager: {
			getEntries: () => [],
		},
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

function createModelSwitchSession(sessionPath: string): {
	session: AgentSession;
	model: { provider: string; id: string };
	thinkingLevel: string;
	setModel: ReturnType<typeof vi.fn>;
	setThinkingLevel: ReturnType<typeof vi.fn>;
} {
	const model = { provider: "test-provider", id: "test-model" };
	const state = { model: undefined as typeof model | undefined, thinkingLevel: "medium" };
	const setModel = vi.fn(async (nextModel: typeof model) => {
		state.model = nextModel;
	});
	const setThinkingLevel = vi.fn((level: string) => {
		state.thinkingLevel = level;
	});
	const session = {
		sessionFile: sessionPath,
		sessionName: undefined,
		isCompacting: false,
		retryAttempt: 0,
		isStreaming: false,
		modelRuntime: { getModel: vi.fn(() => model) },
		getContextUsage: () => undefined,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		setModel,
		setThinkingLevel,
		thinkingLevel: state.thinkingLevel,
		model: state.model,
		sessionManager: {
			getEntries: () => [],
			getHeader: () => ({ timestamp: new Date(0).toISOString() }),
			getSessionId: () => "test-session",
			getCwd: () => "/tmp",
			getLeafId: () => null,
		},
		subscribe: () => () => {},
	} as unknown as AgentSession;
	Object.defineProperties(session, {
		model: { get: () => state.model },
		thinkingLevel: { get: () => state.thinkingLevel },
	});
	return { session, model, thinkingLevel: state.thinkingLevel, setModel, setThinkingLevel };
}

function createControlSession(sessionPath: string): {
	session: AgentSession;
	setSessionName: ReturnType<typeof vi.fn>;
	getSessionInfo: ReturnType<typeof vi.fn>;
} {
	const state = { name: undefined as string | undefined };
	const setSessionName = vi.fn((name: string) => {
		state.name = name;
	});
	const getSessionInfo = vi.fn(() => ({
		name: state.name ?? null,
		sessionFile: sessionPath,
		sessionId: "test-session",
		messages: { total: 1, user: 1, agent: 0, toolCalls: 0, toolResults: 0 },
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
		usageBreakdown: [],
		cacheWaste: { missedTokens: 0, missedCost: 0, missCount: 0 },
	}));
	const session = {
		sessionFile: sessionPath,
		isCompacting: false,
		retryAttempt: 0,
		isStreaming: false,
		getContextUsage: () => undefined,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		getToolActivityEpoch: () => "test-epoch",
		getToolActivityRevision: () => 0,
		getToolActivitySnapshot: () => [],
		getLastAssistantText: () => "最后回复",
		getSessionInfo,
		setSessionName,
		sessionManager: {
			getEntries: () => [],
			getHeader: () => ({ timestamp: new Date(0).toISOString() }),
			getSessionId: () => "test-session",
			getCwd: () => "/tmp",
			getLeafId: () => null,
		},
		subscribe: () => () => {},
	} as unknown as AgentSession;
	Object.defineProperty(session, "sessionName", { get: () => state.name });
	return { session, setSessionName, getSessionInfo };
}
function waitForExit(child: SpawnedChild): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function startStaleListener(endpoint: string): Promise<void> {
	const child = spawn(
		process.execPath,
		[
			"-e",
			"const net = require('node:net'); const server = net.createServer(); server.listen(process.argv[1], () => process.stdout.write('ready\\n')); setInterval(() => {}, 1000);",
			endpoint,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	children.add(child);
	await new Promise<void>((resolve, reject) => {
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
			if (output.includes("ready")) resolve();
		});
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`stale listener exited early: ${code}`)));
	});
	child.kill("SIGKILL");
	await waitForExit(child);
}

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.all([...children].map(waitForExit));
	children.clear();
	for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
	tempDirs.clear();
});

describe("GuiCompanionServer", () => {
	it("handles model and thinking changes through the companion", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "lystar-gui-companion-"));
		tempDirs.add(agentDir);
		const sessionPath = join(agentDir, "session.jsonl");
		writeFileSync(sessionPath, "{}\n");
		const { session, model, setModel, setThinkingLevel } = createModelSwitchSession(sessionPath);
		const onSessionChanged = vi.fn();
		const server = new GuiCompanionServer(session, agentDir, onSessionChanged);
		const execute = (
			server as unknown as {
				execute(command: {
					type: "request";
					requestId: string;
					command: "set_model" | "set_thinking_level";
					model?: { provider: string; id: string };
					level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
				}): Promise<unknown>;
			}
		).execute.bind(server);

		const modelResult = await execute({
			type: "request",
			requestId: "model",
			command: "set_model",
			model,
		});
		const thinkingResult = await execute({
			type: "request",
			requestId: "thinking",
			command: "set_thinking_level",
			level: "high",
		});

		expect(setModel).toHaveBeenCalledWith(model);
		expect(setThinkingLevel).toHaveBeenCalledWith("high");
		expect(onSessionChanged).toHaveBeenCalledTimes(2);
		expect((modelResult as { model?: typeof model }).model).toEqual(model);
		expect((thinkingResult as { thinkingLevel?: string }).thinkingLevel).toBe("high");
	});

	it("forwards shared session controls and advertises capabilities", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "lystar-gui-companion-"));
		tempDirs.add(agentDir);
		const sessionPath = join(agentDir, "session.jsonl");
		writeFileSync(sessionPath, "{}\n");
		const { session, setSessionName, getSessionInfo } = createControlSession(sessionPath);
		const server = new GuiCompanionServer(session, agentDir);
		const execute = (
			server as unknown as {
				execute(command: Extract<GuiCompanionCommand, { type: "request" }>): Promise<unknown>;
			}
		).execute.bind(server);

		const renameResult = await execute({ type: "request", requestId: "rename", command: "rename", name: "共享会话" });
		expect(setSessionName).toHaveBeenCalledWith("共享会话");
		expect(renameResult).toMatchObject({
			name: "共享会话",
			capabilities: expect.arrayContaining([
				"session_rename",
				"session_info",
				"session_settings",
				"session_fork",
				"session_import",
				"session_share",
			]),
		});
		await expect(execute({ type: "request", requestId: "info", command: "get_session_info" })).resolves.toMatchObject(
			{
				sessionId: "test-session",
			},
		);
		expect(getSessionInfo).toHaveBeenCalled();
		await expect(execute({ type: "request", requestId: "tree", command: "get_session_tree" })).resolves.toEqual([]);
		await expect(
			execute({ type: "request", requestId: "last", command: "get_last_assistant_text" }),
		).resolves.toEqual({ text: "最后回复" });
	});

	it("creates detached fork and import files through the companion", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "lystar-gui-companion-"));
		const sourceDir = mkdtempSync(join(tmpdir(), "lystar-gui-import-"));
		tempDirs.add(agentDir);
		tempDirs.add(sourceDir);
		const sessionPath = join(agentDir, "session.jsonl");
		writeFileSync(sessionPath, "{}\n");
		const entry = {
			id: "entry-1",
			parentId: null,
			type: "message",
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: "hello" },
		} as never;
		const header = {
			type: "session",
			version: 3,
			id: "source-session",
			timestamp: new Date(0).toISOString(),
			cwd: agentDir,
		};
		const forkPath = join(agentDir, "forked.jsonl");
		const forkManager = {
			getSessionFile: () => forkPath,
			getHeader: () => ({ ...header, id: "forked-session" }),
			getEntries: () => [entry],
			dispose: vi.fn(),
		};
		const session = {
			...createSession(sessionPath),
			sessionManager: {
				getEntries: () => [entry],
				getEntry: () => entry,
				getLeafId: () => "entry-1",
				getCwd: () => agentDir,
				getSessionDir: () => agentDir,
				createBranchedSessionManager: () => forkManager,
			},
		} as unknown as AgentSession;
		const sourcePath = join(sourceDir, "import.jsonl");
		writeFileSync(sourcePath, `${JSON.stringify(header)}\n`);
		const server = new GuiCompanionServer(session, agentDir);
		const execute = (
			server as unknown as {
				execute(command: Extract<GuiCompanionCommand, { type: "request" }>): Promise<unknown>;
			}
		).execute.bind(server);

		const forkResult = await execute({
			type: "request",
			requestId: "fork",
			command: "fork_session",
			entryId: "entry-1",
			position: "at",
		});
		expect(forkResult).toMatchObject({ sessionPath: forkPath });
		expect(JSON.parse(readFileSync(forkPath, "utf8").split("\n")[0])).toMatchObject({
			type: "session",
			id: "forked-session",
		});

		const importResult = await execute({
			type: "request",
			requestId: "import",
			command: "import_session",
			inputPath: sourcePath,
		});
		expect(importResult).toMatchObject({ cancelled: false, sessionPath: join(agentDir, "import.jsonl") });
		expect(JSON.parse(readFileSync(join(agentDir, "import.jsonl"), "utf8").split("\n")[0])).toMatchObject({
			type: "session",
			id: "source-session",
		});
	});

	it("routes completion lookup through the active session", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "lystar-gui-companion-"));
		tempDirs.add(agentDir);
		const sessionPath = join(agentDir, "session.jsonl");
		writeFileSync(sessionPath, "{}\n");
		const getCompletions = vi.fn(async (text: string, cursor: number) => ({
			prefixStart: 0,
			prefixEnd: cursor,
			items: [{ value: "/settings ", label: "settings", kind: "command" as const }],
			text,
		}));
		const session = {
			...createSession(sessionPath),
			getCompletions,
		} as unknown as AgentSession;
		const server = new GuiCompanionServer(session, agentDir);
		const execute = (
			server as unknown as {
				execute(command: {
					type: "request";
					requestId: string;
					command: "get_completions";
					text?: string;
					cursor?: number;
				}): Promise<unknown>;
			}
		).execute.bind(server);

		await expect(
			execute({ type: "request", requestId: "completion", command: "get_completions", text: "/", cursor: 1 }),
		).resolves.toMatchObject({
			prefixStart: 0,
			prefixEnd: 1,
			items: [{ value: "/settings ", label: "settings", kind: "command" }],
		});
		expect(getCompletions).toHaveBeenCalledWith("/", 1);
	});

	it("does not replace an active companion endpoint", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "lystar-gui-companion-"));
		tempDirs.add(agentDir);
		const sessionPath = join(agentDir, "session.jsonl");
		writeFileSync(sessionPath, "{}\n");
		const endpoint = getGuiCompanionEndpoint(agentDir, sessionPath);
		const first = new GuiCompanionServer(createSession(sessionPath), agentDir);
		const second = new GuiCompanionServer(createSession(sessionPath), agentDir);

		await first.start();
		await expect(second.start()).rejects.toThrow(`GUI companion is already running at ${endpoint}`);
		expect(existsSync(endpoint)).toBe(true);

		await second.dispose();
		await first.dispose();
		expect(existsSync(endpoint)).toBe(false);
	});

	it.runIf(process.platform !== "win32")("recovers from a stale Unix socket", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "lystar-gui-companion-"));
		tempDirs.add(agentDir);
		const sessionPath = join(agentDir, "session.jsonl");
		writeFileSync(sessionPath, "{}\n");
		const endpoint = getGuiCompanionEndpoint(agentDir, sessionPath);
		mkdirSync(join(agentDir, "host", "companions"), { recursive: true });
		await startStaleListener(endpoint);
		expect(existsSync(endpoint)).toBe(true);

		const server = new GuiCompanionServer(createSession(sessionPath), agentDir);
		await server.start();
		expect(existsSync(endpoint)).toBe(true);
		await server.dispose();
		expect(existsSync(endpoint)).toBe(false);
	});
});
