import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { type AgentConfig, BUILTIN_AGENTS, discoverAgents } from "../src/extensions/subagent/agents.ts";
import subagentExtension, {
	abortSubagent,
	continueSubagentSession,
	followUpSubagent,
	getCurrentSubagentRuns,
	SUBAGENT_RETENTION_MS,
	type SubagentDetails,
	SubagentRunController,
	type SubagentSessionDescriptor,
	steerSubagent,
} from "../src/extensions/subagent/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeFauxRpcScript(): string {
	const dir = mkdtempSync(join(tmpdir(), "lystar-subagent-rpc-"));
	tempDirs.push(dir);
	const script = join(dir, "faux-rpc.mjs");
	writeFileSync(
		script,
		`let turn = 0;
const sessionArg = process.argv.indexOf("--session");
const sessionFile = sessionArg >= 0 ? process.argv[sessionArg + 1] : ${JSON.stringify(join(dir, "child.jsonl"))};
function output(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function respond(command) {
	const data = command.type === "get_state"
		? { sessionId: "faux-session", sessionFile }
		: command.type === "get_messages" ? { messages: [] } : {};
	output({ type: "response", id: command.id, command: command.type, success: true, data });
}
function settle(text) {
	output({ type: "agent_start" });
	output({ type: "tool_execution_start", toolCallId: "tool-" + turn, toolName: "bash", args: { command: "echo " + text } });
	output({ type: "tool_execution_end", toolCallId: "tool-" + turn, toolName: "bash", result: { content: [] }, isError: false });
	output({ type: "tool_result_end", message: { role: "toolResult", toolCallId: "tool-" + turn, toolName: "bash", content: [{ type: "text", text: "tool result:" + text }], details: { preserved: true }, isError: false, timestamp: Date.now() } });
	output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], model: "faux-model", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } } } });
	output({ type: "agent_end", messages: [], willRetry: false });
	output({ type: "agent_settled" });
}
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\\n");
	buffer = lines.pop() || "";
	for (const line of lines) {
		if (!line) continue;
		const command = JSON.parse(line);
		if (command.type === "prompt" || command.type === "follow_up") {
			respond(command);
			if (command.message === "exit") {
				setTimeout(() => process.exit(17), 0);
				continue;
			}
			const text = "done:" + command.message;
			turn += 1;
			setTimeout(() => settle(text), 40);
		} else if (command.type === "abort") {
			respond(command);
			setTimeout(() => output({ type: "agent_settled" }), 0);
		} else {
			respond(command);
		}
	}
});
process.on("SIGTERM", () => {
	if (process.env.SUBAGENT_TERMINATED_FILE) process.stdout.write("");
	process.exit(0);
});
`,
	);
	return script;
}

async function loadSubagentExtension() {
	return loadExtensionFromFactory(
		subagentExtension,
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<inline:subagent>",
	);
}

async function loadSubagentTool() {
	const extension = await loadSubagentExtension();
	return extension.tools.get("subagent")!.definition;
}

async function executeWithFauxRpc(
	params: Record<string, unknown>,
	onUpdate?: (partial: { details?: SubagentDetails }) => void,
) {
	const extension = await loadSubagentExtension();
	const tool = extension.tools.get("subagent")!.definition;
	const script = writeFauxRpcScript();
	const originalScript = process.argv[1];
	process.argv[1] = script;
	try {
		const result = await tool.execute(
			"subagent-test",
			params,
			undefined,
			onUpdate as never,
			{
				cwd: process.cwd(),
				hasUI: false,
				sessionManager: { getSessionFile: () => join(tempDirs.at(-1)!, "parent.jsonl") },
			} as never,
		);
		const shutdown = extension.handlers.get("session_shutdown")?.[0];
		if (shutdown) await shutdown({ type: "session_shutdown", reason: "quit" });
		return result;
	} finally {
		process.argv[1] = originalScript;
	}
}

describe("built-in subagent extension", () => {
	initTheme("dark");

	it("is bundled as a hidden extension and registers its tool", async () => {
		expect(builtInExtensions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "subagent", factory: subagentExtension, hidden: true }),
			]),
		);
		const tool = await loadSubagentTool();
		expect(tool.name).toBe("subagent");
	});

	it("ships three fallback agents without fixed models", () => {
		expect(BUILTIN_AGENTS.map((agent) => agent.name)).toEqual(["research-specialist", "review-specialist", "worker"]);
		expect(BUILTIN_AGENTS.every((agent) => agent.model === undefined)).toBe(true);
	});

	it("lets a project agent override a built-in agent", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-subagent-"));
		tempDirs.push(root);
		const agentsDir = join(root, CONFIG_DIR_NAME, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "worker.md"),
			"---\nname: worker\ndescription: Project worker\ntools: read\n---\n\nProject instructions.\n",
		);

		const result = discoverAgents(root, "project");
		expect(result.agents.find((agent) => agent.name === "worker")).toMatchObject({
			source: "project",
			description: "Project worker",
		});
		expect(result.agents).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "research-specialist", source: "builtin" })]),
		);
	});

	it("runs single, parallel, and chain tasks through RPC with stable identities", async () => {
		const single = await executeWithFauxRpc({ agent: "worker", task: "single", agentScope: "user" });
		const singleDetails = single.details as SubagentDetails;
		expect(singleDetails.runId).toEqual(expect.any(String));
		const singleResult = singleDetails.results[0]!;
		expect(singleResult).toMatchObject({
			runId: singleDetails.runId,
			agentId: `${singleDetails.runId}:1`,
			state: "succeeded",
			currentAction: undefined,
		});
		expect(singleResult.finalOutput).toBe("done:single");
		expect(singleResult.messages).toBeUndefined();
		expect(singleResult.session).toMatchObject({
			version: 1,
			sessionId: "faux-session",
			parentSessionFile: expect.stringContaining("parent.jsonl"),
		});
		expect(singleDetails.results[0].usage).toMatchObject({ input: 1, output: 1, turns: 1 });
		expect(single.content).toEqual([{ type: "text", text: "done:single" }]);

		const parallel = await executeWithFauxRpc({
			tasks: [
				{ agent: "worker", task: "one" },
				{ agent: "worker", task: "two" },
			],
			agentScope: "user",
		});
		const parallelDetails = parallel.details as SubagentDetails;
		expect(parallelDetails.results.map((result) => result.agentId)).toEqual([
			`${parallelDetails.runId}:1`,
			`${parallelDetails.runId}:2`,
		]);
		expect(parallelDetails.results.every((result) => result.state === "succeeded")).toBe(true);

		const chain = await executeWithFauxRpc({
			chain: [
				{ agent: "worker", task: "first" },
				{ agent: "worker", task: "second {previous}" },
			],
			agentScope: "user",
		});
		const chainDetails = chain.details as SubagentDetails;
		expect(chainDetails.results[1].task).toBe("second done:first");
		expect(chain.content).toEqual([{ type: "text", text: "done:second done:first" }]);
	});

	it("renders the parallel count from the active mode and live result details", async () => {
		const tool = await loadSubagentTool();
		const component = tool.renderCall!(
			{
				chain: [],
				tasks: [
					{ agent: "worker", task: "one" },
					{ agent: "worker", task: "two" },
				],
			},
			theme,
			{
				resultDetails: {
					mode: "parallel",
					results: [{ agent: "worker" }, { agent: "worker" }],
				},
			} as never,
		);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("parallel · 2 个 Agent");
	});

	it("publishes each latest parallel command even when the tool finishes in the same event batch", async () => {
		const actions: string[] = [];
		await executeWithFauxRpc(
			{
				tasks: [
					{ agent: "worker", task: "one" },
					{ agent: "worker", task: "two" },
				],
			},
			(partial) => {
				for (const result of partial.details?.results ?? []) {
					if (result.currentAction) actions.push(result.currentAction);
				}
			},
		);

		expect(actions).toContain("$ echo done:one");
		expect(actions).toContain("$ echo done:two");
	});

	it("exposes copied current-run snapshots and typed controls only for the active extension", async () => {
		const extension = await loadSubagentExtension();
		const tool = extension.tools.get("subagent")!.definition;
		const script = writeFauxRpcScript();
		const originalScript = process.argv[1];
		process.argv[1] = script;
		try {
			const execution = tool.execute(
				"subagent-registry",
				{ agent: "worker", task: "registry" },
				undefined,
				undefined,
				{
					cwd: process.cwd(),
					hasUI: false,
					sessionManager: { getSessionFile: () => join(tempDirs.at(-1)!, "parent.jsonl") },
				} as never,
			);
			await new Promise((resolve) => setTimeout(resolve, 110));

			const [snapshot] = getCurrentSubagentRuns();
			expect(snapshot).toMatchObject({ agent: "worker", controllable: true });
			expect(["queued", "running"]).toContain(snapshot.state);
			snapshot.state = "failed";
			snapshot.events.push({ type: "mutated", at: 0 });
			expect(getCurrentSubagentRuns()[0]!.state).not.toBe("failed");
			expect(getCurrentSubagentRuns()[0]!.events.some((event) => event.type === "mutated")).toBe(false);

			await steerSubagent(snapshot.agentId, "focus");
			await execution;
			expect(getCurrentSubagentRuns()[0]).toMatchObject({ state: "succeeded", controllable: true });
			await expect(followUpSubagent(snapshot.agentId, "follow-up")).resolves.toMatchObject({ state: "succeeded" });

			const beforeSwitch = extension.handlers.get("session_before_switch")?.[0];
			if (beforeSwitch) {
				await beforeSwitch({ type: "session_before_switch", reason: "switch" });
			} else {
				const shutdown = extension.handlers.get("session_shutdown")?.[0];
				if (shutdown) await shutdown({ type: "session_shutdown", reason: "quit" });
			}
			expect(getCurrentSubagentRuns()).toEqual([]);
			await expect(abortSubagent(snapshot.agentId)).rejects.toThrow("No active subagent registry");
		} finally {
			process.argv[1] = originalScript;
		}
	});

	it("resumes a completed subagent from the same persistent session after the RPC registry is recreated", async () => {
		const script = writeFauxRpcScript();
		const originalScript = process.argv[1];
		process.argv[1] = script;
		try {
			const firstExtension = await loadSubagentExtension();
			const firstResult = await firstExtension.tools
				.get("subagent")!
				.definition.execute("subagent-resume", { agent: "worker", task: "first" }, undefined, undefined, {
					cwd: process.cwd(),
					hasUI: false,
					sessionManager: { getSessionFile: () => join(tempDirs.at(-1)!, "parent.jsonl") },
				} as never);
			const completed = (firstResult.details as SubagentDetails).results[0]!;
			const descriptor: SubagentSessionDescriptor = {
				agentId: completed.agentId!,
				agent: completed.agent,
				agentSource: completed.agentSource!,
				task: completed.task,
				agentScope: "user",
				session: completed.session!,
			};
			await firstExtension.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" });

			const resumedExtension = await loadSubagentExtension();
			await continueSubagentSession(descriptor, "resume");
			await vi.waitFor(() => expect(getCurrentSubagentRuns()[0]?.state).toBe("succeeded"));
			expect(getCurrentSubagentRuns()[0]?.session?.sessionFile).toBe(descriptor.session.sessionFile);
			await resumedExtension.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" });
		} finally {
			process.argv[1] = originalScript;
		}
	});

	it("supports steer, follow-up, abort, and retention disposal through the RPC controller", async () => {
		const agent: AgentConfig = { ...BUILTIN_AGENTS.find((candidate) => candidate.name === "worker")! };
		let updateCount = 0;
		const controller = new SubagentRunController({
			runId: "run-1",
			agentId: "agent-1",
			agent,
			task: "first",
			cwd: process.cwd(),
			command: process.execPath,
			commandArgs: [writeFauxRpcScript()],
			args: ["--no-session", "--no-extensions", "--exclude-tools", "subagent"],
			onUpdate: () => updateCount++,
		});

		const first = controller.start();
		await new Promise((resolve) => setTimeout(resolve, 10));
		await controller.steer("focus");
		expect((await first).state).toBe("succeeded");
		expect(updateCount).toBeGreaterThan(0);
		expect(updateCount).toBeLessThanOrEqual(4);
		expect((await controller.followUp("second")).messages?.at(-1)).toMatchObject({ role: "assistant" });

		const runningFollowUp = controller.followUp("cancel me");
		await new Promise((resolve) => setTimeout(resolve, 10));
		await controller.abort();
		expect((await runningFollowUp).state).toBe("cancelled");

		const crashed = new SubagentRunController({
			runId: "run-exit",
			agentId: "agent-exit",
			agent,
			task: "exit",
			cwd: process.cwd(),
			command: process.execPath,
			commandArgs: [writeFauxRpcScript()],
			args: ["--no-session"],
		});
		expect((await crashed.start()).state).toBe("failed");

		const retained = new SubagentRunController({
			runId: "run-2",
			agentId: "agent-2",
			agent,
			task: "retained",
			cwd: process.cwd(),
			command: process.execPath,
			commandArgs: [writeFauxRpcScript()],
			args: ["--no-session"],
		});
		await retained.start();
		vi.useFakeTimers();
		(retained as unknown as { scheduleRetention: () => void }).scheduleRetention();
		await vi.advanceTimersByTimeAsync(SUBAGENT_RETENTION_MS);
		await expect(retained.followUp("expired")).rejects.toThrow("no longer available");
	});
});
