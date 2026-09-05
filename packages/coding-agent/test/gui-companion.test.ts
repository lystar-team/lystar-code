import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
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
