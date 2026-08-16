import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import type { RuntimeEvent, RuntimeSession, UiRequest } from "../src/types.ts";

const rpcEntryPath = fileURLToPath(new URL("../../coding-agent/src/rpc-entry.ts", import.meta.url));
const extensionPath = fileURLToPath(new URL("./fixtures/runtime-contract-extension.ts", import.meta.url));
const tsxImportSpecifier = import.meta.resolve("tsx");
const originalScenario = process.env.LYSTAR_GUI_CONTRACT_SCENARIO;

interface Workspace {
	root: string;
	agentDir: string;
	cwd: string;
}

interface TranscriptSummary {
	roles: string[];
	userTexts: string[];
	assistantTexts: string[];
	lastAssistantStopReason?: string;
}

interface ResourceCommand {
	name: string;
	description?: string;
	source: "prompt" | "skill";
	scope?: string;
}

interface ResourceContract {
	commands: ResourceCommand[];
	listedSkills: string[];
	userTexts: string[];
}

interface SessionSwitchContract {
	model: { provider: string; id: string };
	thinkingLevel: string;
	roles: string[];
	userTexts: string[];
}

interface ToolContract {
	model: { provider: string; id: string };
	restoredModel: { provider: string; id: string };
	events: string[];
	transcript: TranscriptSummary;
}

interface UiContract {
	requests: Array<{ kind: string; title: string; detail?: unknown }>;
	result: Record<string, unknown>;
}

interface AbortContract {
	events: string[];
	transcript: Pick<TranscriptSummary, "roles" | "lastAssistantStopReason">;
}

type JsonRecord = Record<string, unknown>;

const children = new Set<ChildProcessWithoutNullStreams>();
const tempDirs = new Set<string>();

afterEach(async () => {
	if (originalScenario === undefined) delete process.env.LYSTAR_GUI_CONTRACT_SCENARIO;
	else process.env.LYSTAR_GUI_CONTRACT_SCENARIO = originalScenario;
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.all(
		[...children].map(
			(child) =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) return resolve();
					child.once("exit", () => resolve());
				}),
		),
	);
	children.clear();
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.clear();
});

function createWorkspace(defaultProjectTrust: "always" | "never" = "always"): Workspace {
	const root = mkdtempSync(join(tmpdir(), "gui-runtime-contract-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "lystar-contract-faux",
			defaultModel: "contract-1",
			defaultThinkingLevel: "off",
			defaultProjectTrust,
			extensions: [extensionPath],
			retry: { enabled: false },
		}),
	);
	tempDirs.add(root);
	return { root, agentDir, cwd };
}

function addProjectResources(workspace: Workspace): void {
	const skillDir = join(workspace.cwd, ".pi", "skills", "contract-project-skill");
	const promptDir = join(workspace.cwd, ".pi", "prompts");
	mkdirSync(skillDir, { recursive: true });
	mkdirSync(promptDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		["---", "name: contract-project-skill", "description: Contract project skill", "---", "Project skill body"].join(
			"\n",
		),
	);
	writeFileSync(
		join(promptDir, "contract-project-prompt.md"),
		["---", "description: Contract project prompt", "---", "Project prompt: $ARGUMENTS"].join("\n"),
	);
}

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null ? (value as JsonRecord) : undefined;
}

function normalizeSessionProgress(events: unknown[]): string[] {
	return events.flatMap((value) => {
		const event = asRecord(value);
		if (!event || typeof event.type !== "string") return [];
		switch (event.type) {
			case "tool_start":
				return typeof event.name === "string" ? [`tool_start:${event.name}`] : [];
			case "tool_end":
				return typeof event.name === "string" && typeof event.status === "string"
					? [`tool_end:${event.name}:${event.status}`]
					: [];
			case "phase":
				return typeof event.phase === "string" ? [`phase:${event.phase}`] : [];
			default:
				return [];
		}
	});
}

function normalizeRpcSessionProgress(records: unknown[]): string[] {
	return records.flatMap((value) => {
		const event = asRecord(value);
		if (!event || typeof event.type !== "string") return [];
		if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
			return [`tool_start:${event.toolName}`];
		}
		if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
			return [`tool_end:${event.toolName}:${event.isError === true ? "error" : "success"}`];
		}
		return event.type === "agent_settled" ? ["phase:idle"] : [];
	});
}

function transcriptSummary(path: string): TranscriptSummary {
	const messages = readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as JsonRecord)
		.filter((entry) => entry.type === "message")
		.map((entry) => asRecord(entry.message))
		.filter((message): message is JsonRecord => message !== undefined);
	const assistantMessages = messages.filter((message) => message.role === "assistant");
	const messageText = (message: JsonRecord): string =>
		Array.isArray(message.content)
			? message.content
					.map(asRecord)
					.filter((part): part is JsonRecord => part?.type === "text" && typeof part.text === "string")
					.map((part) => part.text as string)
					.join("")
			: typeof message.content === "string"
				? message.content
				: "";
	return {
		roles: messages.flatMap((message) => (typeof message.role === "string" ? [message.role] : [])),
		userTexts: messages.filter((message) => message.role === "user").map(messageText),
		assistantTexts: assistantMessages.map(messageText),
		lastAssistantStopReason:
			typeof assistantMessages.at(-1)?.stopReason === "string"
				? (assistantMessages.at(-1)?.stopReason as string)
				: undefined,
	};
}

class RpcProcess {
	readonly records: JsonRecord[] = [];
	private readonly child: ChildProcessWithoutNullStreams;
	private stderr = "";
	private stdoutBuffer = "";
	private ready: Promise<void> | undefined;

	constructor(
		workspace: Workspace,
		scenario: string,
		options: { sessionPath?: string; resources?: boolean; trust?: "approve" | "deny" } = {},
	) {
		const resourceFlags = options.resources
			? ["--no-themes", "--no-context-files"]
			: ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];
		const args = [
			"--import",
			tsxImportSpecifier,
			rpcEntryPath,
			options.trust === "deny" ? "--no-approve" : "--approve",
			"--offline",
			...resourceFlags,
			...(options.sessionPath ? ["--session", options.sessionPath] : []),
		];
		this.child = spawn(process.execPath, args, {
			cwd: workspace.cwd,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: workspace.agentDir,
				PI_OFFLINE: "1",
				LYSTAR_GUI_CONTRACT_SCENARIO: scenario,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.add(this.child);
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
		this.child.stderr.on("data", (chunk: string) => {
			this.stderr += chunk;
		});
	}

	send(message: JsonRecord): number {
		const start = this.records.length;
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
		return start;
	}

	async request(message: JsonRecord): Promise<JsonRecord> {
		this.ready ??= this.verifyContractExtension();
		await this.ready;
		return this.requestUnchecked(message);
	}

	private async requestUnchecked(message: JsonRecord): Promise<JsonRecord> {
		const id = message.id;
		if (typeof id !== "string") throw new Error("RPC contract requests require an id");
		const start = this.send(message);
		return (await this.waitFor((record) => record.type === "response" && record.id === id, start)).record;
	}

	private async verifyContractExtension(): Promise<void> {
		const response = responseData(
			await this.requestUnchecked({ id: "contract-fixture-ready", type: "get_commands" }),
		);
		const names = Array.isArray(response.commands)
			? response.commands.flatMap((command) => {
					const value = asRecord(command)?.name;
					return typeof value === "string" ? [value] : [];
				})
			: [];
		for (const name of ["contract-commands", "contract-ui"]) {
			if (!names.includes(name)) {
				throw new Error(`RPC contract Extension did not load ${name}: ${this.stderr}`);
			}
		}
	}

	async waitFor(
		predicate: (record: JsonRecord) => boolean,
		start = 0,
		timeoutMs = 10_000,
	): Promise<{ record: JsonRecord; index: number }> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			for (let index = start; index < this.records.length; index++) {
				const record = this.records[index];
				if (record && predicate(record)) return { record, index };
			}
			if (this.child.exitCode !== null || this.child.signalCode !== null) {
				throw new Error(`RPC process exited before the contract completed: ${this.stderr}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`Timed out waiting for RPC output: ${this.stderr}`);
	}

	async stop(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		this.child.stdin.end();
		await Promise.race([
			new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
			new Promise<void>((_, reject) => setTimeout(() => reject(new Error("RPC process did not stop")), 5_000)),
		]);
		children.delete(this.child);
	}

	private handleStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		while (true) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.stdoutBuffer.slice(0, newline);
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (line.trim()) this.records.push(JSON.parse(line) as JsonRecord);
		}
	}
}

function responseData(response: JsonRecord): JsonRecord {
	if (response.success !== true) throw new Error(String(response.error ?? "RPC request failed"));
	const data = asRecord(response.data);
	if (!data) throw new Error("RPC response did not contain object data");
	return data;
}

function modelRef(value: unknown): { provider: string; id: string } {
	const model = asRecord(value);
	if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
		throw new Error("Missing model reference");
	}
	return { provider: model.provider, id: model.id };
}

function normalizeResourceCommands(value: unknown): ResourceCommand[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(asRecord)
		.filter((command): command is JsonRecord => command !== undefined)
		.flatMap((command) => {
			const name = command.name;
			const source = command.source;
			if (
				typeof name !== "string" ||
				(source !== "prompt" && source !== "skill") ||
				(!name.startsWith("contract-project-") && !name.startsWith("skill:contract-project-"))
			) {
				return [];
			}
			const sourceInfo = asRecord(command.sourceInfo);
			const resource: ResourceCommand = {
				name,
				...(typeof command.description === "string" ? { description: command.description } : {}),
				source,
				...(typeof command.scope === "string"
					? { scope: command.scope }
					: typeof sourceInfo?.scope === "string"
						? { scope: sourceInfo.scope }
						: {}),
			};
			return [resource];
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeWorkspaceText(text: string, workspace: Workspace): string {
	return text.replaceAll(workspace.root, "<workspace>");
}

async function promptRpcAndWait(rpc: RpcProcess, id: string, message: string): Promise<void> {
	const start = rpc.records.length;
	const response = await rpc.request({ id, type: "prompt", message });
	expect(response.success).toBe(true);
	await rpc.waitFor((record) => record.type === "agent_settled", start);
}

async function createRpcTargetSession(workspace: Workspace): Promise<string> {
	const rpc = new RpcProcess(workspace, "text");
	const thinking = await rpc.request({ id: "target-thinking", type: "set_thinking_level", level: "high" });
	expect(thinking.success).toBe(true);
	await promptRpcAndWait(rpc, "target-prompt", "target session message");
	const state = responseData(await rpc.request({ id: "target-state", type: "get_state" }));
	if (typeof state.sessionFile !== "string") throw new Error("Target Session was not persisted");
	await rpc.stop();
	return state.sessionFile;
}

async function runRpcSessionSwitchContract(workspace: Workspace): Promise<SessionSwitchContract> {
	const targetPath = await createRpcTargetSession(workspace);
	const rpc = new RpcProcess(workspace, "text");
	await promptRpcAndWait(rpc, "source-prompt", "source session message");
	const switched = await rpc.request({ id: "switch", type: "switch_session", sessionPath: targetPath });
	expect(responseData(switched).cancelled).toBe(false);
	const state = responseData(await rpc.request({ id: "switched-state", type: "get_state" }));
	const transcript = transcriptSummary(targetPath);
	await rpc.stop();
	return {
		model: modelRef(state.model),
		thinkingLevel: String(state.thinkingLevel),
		roles: transcript.roles,
		userTexts: transcript.userTexts,
	};
}

async function runGuiSessionSwitchContract(workspace: Workspace): Promise<SessionSwitchContract> {
	const targetPath = await createRpcTargetSession(workspace);
	process.env.LYSTAR_GUI_CONTRACT_SCENARIO = "text";
	const runtime = await new CodingAgentRuntimeAdapter(workspace.agentDir).openSession(targetPath, async () => ({
		cancelled: true,
	}));
	const snapshot = runtime.getSnapshot("owned");
	const transcript = transcriptSummary(targetPath);
	await runtime.dispose();
	return {
		model: modelRef(snapshot.model),
		thinkingLevel: snapshot.thinkingLevel,
		roles: transcript.roles,
		userTexts: transcript.userTexts,
	};
}

async function runRpcResourceContract(workspace: Workspace, trusted: boolean): Promise<ResourceContract> {
	const rpc = new RpcProcess(workspace, "resources", { resources: true, trust: trusted ? "approve" : "deny" });
	const commandData = responseData(await rpc.request({ id: "commands", type: "get_commands" }));
	const commands = normalizeResourceCommands(commandData.commands);
	await promptRpcAndWait(rpc, "prompt-resource", "/contract-project-prompt alpha beta");
	await promptRpcAndWait(rpc, "skill-resource", "/skill:contract-project-skill extra instructions");
	const state = responseData(await rpc.request({ id: "resource-state", type: "get_state" }));
	if (typeof state.sessionFile !== "string") throw new Error("RPC resource Session was not persisted");
	const transcript = transcriptSummary(state.sessionFile);
	await rpc.stop();
	return {
		commands,
		listedSkills: commands.filter((command) => command.source === "skill").map((command) => command.name),
		userTexts: transcript.userTexts.map((text) => normalizeWorkspaceText(text, workspace)),
	};
}

async function runGuiResourceContract(workspace: Workspace): Promise<ResourceContract> {
	process.env.LYSTAR_GUI_CONTRACT_SCENARIO = "resources";
	const adapter = new CodingAgentRuntimeAdapter(workspace.agentDir);
	const listed = await adapter.listSkills(workspace.cwd, async () => ({ cancelled: true }));
	let commands: ResourceCommand[] = [];
	const runtime = await adapter.createSession(workspace.cwd, async (request) => {
		if (request.kind === "notify" && request.title.startsWith("[")) {
			commands = normalizeResourceCommands(JSON.parse(request.title));
		}
		return {};
	});
	await runtime.prompt("/contract-commands");
	await runtime.prompt("/contract-project-prompt alpha beta");
	await runtime.prompt("/skill:contract-project-skill extra instructions");
	const transcript = transcriptSummary(runtime.sessionPath);
	await runtime.dispose();
	return {
		commands,
		listedSkills: listed.skills
			.filter((skill) => skill.name.startsWith("contract-project-"))
			.map((skill) => `skill:${skill.name}`)
			.sort(),
		userTexts: transcript.userTexts.map((text) => normalizeWorkspaceText(text, workspace)),
	};
}

async function runRpcToolContract(workspace: Workspace): Promise<ToolContract> {
	const rpc = new RpcProcess(workspace, "tool");
	const initialState = responseData(await rpc.request({ id: "state", type: "get_state" }));
	const eventStart = rpc.records.length;
	const promptResponse = await rpc.request({ id: "prompt", type: "prompt", message: "use the tool" });
	expect(promptResponse.success).toBe(true);
	await rpc.waitFor((record) => record.type === "agent_settled", eventStart);
	const finalState = responseData(await rpc.request({ id: "final-state", type: "get_state" }));
	const sessionPath = finalState.sessionFile;
	if (typeof sessionPath !== "string") throw new Error("RPC session was not persisted");
	const result = {
		model: modelRef(initialState.model),
		events: normalizeRpcSessionProgress(rpc.records.slice(eventStart)),
		transcript: transcriptSummary(sessionPath),
	};
	await rpc.stop();

	const reopened = new RpcProcess(workspace, "tool", { sessionPath });
	const reopenedState = responseData(await reopened.request({ id: "reopened", type: "get_state" }));
	await reopened.stop();
	return { ...result, restoredModel: modelRef(reopenedState.model) };
}

async function runGuiToolContract(workspace: Workspace): Promise<ToolContract> {
	process.env.LYSTAR_GUI_CONTRACT_SCENARIO = "tool";
	const adapter = new CodingAgentRuntimeAdapter(workspace.agentDir);
	let runtime: RuntimeSession | undefined = await adapter.createSession(workspace.cwd, async () => ({
		cancelled: true,
	}));
	const events: RuntimeEvent[] = [];
	runtime.onEvent((event) => events.push(event));
	const model = modelRef(runtime.getSnapshot("owned").model);
	await runtime.prompt("use the tool");
	const sessionPath = runtime.sessionPath;
	const result = {
		model,
		events: normalizeSessionProgress(
			events.filter((event) => event.type === "progress").map((event) => event.payload),
		),
		transcript: transcriptSummary(sessionPath),
	};
	await runtime.dispose();
	runtime = await adapter.openSession(sessionPath, async () => ({ cancelled: true }));
	const restoredModel = modelRef(runtime.getSnapshot("owned").model);
	await runtime.dispose();
	return { ...result, restoredModel };
}

function rpcUiRequest(record: JsonRecord): { kind: string; title: string; detail?: unknown } {
	const kind = String(record.method);
	if (kind === "select") return { kind, title: String(record.title), detail: record.options };
	if (kind === "confirm") return { kind, title: String(record.title), detail: record.message };
	if (kind === "input") return { kind, title: String(record.title), detail: record.placeholder };
	if (kind === "editor") return { kind, title: String(record.title), detail: record.prefill };
	return { kind, title: String(record.message) };
}

function guiUiRequest(request: UiRequest): { kind: string; title: string; detail?: unknown } {
	const payload = asRecord(request.payload);
	if (request.kind === "select") return { kind: request.kind, title: request.title, detail: payload?.options };
	if (request.kind === "confirm") return { kind: request.kind, title: request.title, detail: payload?.message };
	if (request.kind === "input") return { kind: request.kind, title: request.title, detail: payload?.placeholder };
	if (request.kind === "editor") return { kind: request.kind, title: request.title, detail: payload?.prefill };
	return { kind: request.kind, title: request.title };
}

async function runRpcUiContract(workspace: Workspace): Promise<UiContract> {
	const rpc = new RpcProcess(workspace, "text");
	let cursor = rpc.send({ id: "ui", type: "prompt", message: "/contract-ui" });
	const requests: UiContract["requests"] = [];
	let result: Record<string, unknown> | undefined;
	while (!result) {
		const next = await rpc.waitFor((record) => record.type === "extension_ui_request", cursor);
		cursor = next.index + 1;
		const request = next.record;
		requests.push(rpcUiRequest(request));
		if (request.method === "select") rpc.send({ type: "extension_ui_response", id: request.id, value: "beta" });
		else if (request.method === "confirm")
			rpc.send({ type: "extension_ui_response", id: request.id, confirmed: true });
		else if (request.method === "input") rpc.send({ type: "extension_ui_response", id: request.id, value: "typed" });
		else if (request.method === "editor")
			rpc.send({ type: "extension_ui_response", id: request.id, value: "edited\ntext" });
		else if (request.method === "notify") result = JSON.parse(String(request.message)) as Record<string, unknown>;
	}
	const promptResponse = (await rpc.waitFor((record) => record.type === "response" && record.id === "ui", 0)).record;
	expect(promptResponse.success).toBe(true);
	await rpc.stop();
	return { requests, result };
}

async function runGuiUiContract(workspace: Workspace): Promise<UiContract> {
	process.env.LYSTAR_GUI_CONTRACT_SCENARIO = "text";
	const requests: UiContract["requests"] = [];
	let result: Record<string, unknown> | undefined;
	const runtime = await new CodingAgentRuntimeAdapter(workspace.agentDir).createSession(
		workspace.cwd,
		async (request) => {
			requests.push(guiUiRequest(request));
			if (request.kind === "select") return { value: "beta" };
			if (request.kind === "confirm") return { confirmed: true };
			if (request.kind === "input") return { value: "typed" };
			if (request.kind === "editor") return { value: "edited\ntext" };
			result = JSON.parse(request.title) as Record<string, unknown>;
			return {};
		},
	);
	await runtime.prompt("/contract-ui");
	await runtime.dispose();
	if (!result) throw new Error("GUI adapter did not emit the contract notification");
	return { requests, result };
}

async function runRpcAbortContract(workspace: Workspace): Promise<AbortContract> {
	const rpc = new RpcProcess(workspace, "abort");
	const eventStart = rpc.send({ id: "prompt", type: "prompt", message: "stream" });
	const promptResponse = (
		await rpc.waitFor((record) => record.type === "response" && record.id === "prompt", eventStart)
	).record;
	expect(promptResponse.success).toBe(true);
	const abortResponse = await rpc.request({ id: "abort", type: "abort" });
	expect(abortResponse.success).toBe(true);
	await rpc.waitFor((record) => record.type === "agent_settled", eventStart);
	const state = responseData(await rpc.request({ id: "state", type: "get_state" }));
	if (typeof state.sessionFile !== "string") throw new Error("RPC aborted session was not persisted");
	const transcript = transcriptSummary(state.sessionFile);
	const result = {
		events: normalizeRpcSessionProgress(rpc.records.slice(eventStart)),
		transcript: { roles: transcript.roles, lastAssistantStopReason: transcript.lastAssistantStopReason },
	};
	await rpc.stop();
	return result;
}

async function runGuiAbortContract(workspace: Workspace): Promise<AbortContract> {
	process.env.LYSTAR_GUI_CONTRACT_SCENARIO = "abort";
	const runtime = await new CodingAgentRuntimeAdapter(workspace.agentDir).createSession(workspace.cwd, async () => ({
		cancelled: true,
	}));
	const events: RuntimeEvent[] = [];
	runtime.onEvent((event) => events.push(event));
	const prompt = runtime.prompt("stream");
	while (!events.some((event) => event.type === "progress" && asRecord(event.payload)?.type === "assistant_delta")) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	await runtime.abort();
	await prompt;
	const transcript = transcriptSummary(runtime.sessionPath);
	const result = {
		events: normalizeSessionProgress(
			events.filter((event) => event.type === "progress").map((event) => event.payload),
		),
		transcript: { roles: transcript.roles, lastAssistantStopReason: transcript.lastAssistantStopReason },
	};
	await runtime.dispose();
	return result;
}

describe("CodingAgentRuntimeAdapter RPC contract", () => {
	it("matches RPC project resource discovery and Skill/Prompt expansion", async () => {
		const rpcWorkspace = createWorkspace();
		const guiWorkspace = createWorkspace();
		addProjectResources(rpcWorkspace);
		addProjectResources(guiWorkspace);
		const rpc = await runRpcResourceContract(rpcWorkspace, true);
		const gui = await runGuiResourceContract(guiWorkspace);

		expect(gui).toEqual(rpc);
		expect(gui.commands).toEqual([
			{
				name: "contract-project-prompt",
				description: "Contract project prompt",
				source: "prompt",
				scope: "project",
			},
			{
				name: "skill:contract-project-skill",
				description: "Contract project skill",
				source: "skill",
				scope: "project",
			},
		]);
		expect(gui.userTexts[0]).toBe("Project prompt: alpha beta");
		expect(gui.userTexts[1]).toContain('<skill name="contract-project-skill"');
		expect(gui.userTexts[1]).toContain("Project skill body");
		expect(gui.userTexts[1]).toContain("extra instructions");
	}, 30_000);

	it("matches RPC project trust isolation for resources and commands", async () => {
		const rpcWorkspace = createWorkspace("never");
		const guiWorkspace = createWorkspace("never");
		addProjectResources(rpcWorkspace);
		addProjectResources(guiWorkspace);
		const rpc = await runRpcResourceContract(rpcWorkspace, false);
		const gui = await runGuiResourceContract(guiWorkspace);

		expect(gui).toEqual(rpc);
		expect(gui.commands).toEqual([]);
		expect(gui.listedSkills).toEqual([]);
		expect(gui.userTexts).toEqual([
			"/contract-project-prompt alpha beta",
			"/skill:contract-project-skill extra instructions",
		]);
	}, 30_000);

	it("matches RPC Session switching state and transcript restoration", async () => {
		const rpc = await runRpcSessionSwitchContract(createWorkspace());
		const gui = await runGuiSessionSwitchContract(createWorkspace());

		expect(gui).toEqual(rpc);
		expect(gui.thinkingLevel).toBe("high");
		expect(gui.roles).toEqual(["user", "assistant"]);
		expect(gui.userTexts).toEqual(["target session message"]);
	}, 30_000);

	it("matches RPC model restoration, tool events, and persisted transcript semantics", async () => {
		const rpc = await runRpcToolContract(createWorkspace());
		const gui = await runGuiToolContract(createWorkspace());

		expect(gui).toEqual(rpc);
		expect(gui.transcript.roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(gui.transcript.assistantTexts).toEqual(["", "tool complete"]);
	}, 30_000);

	it("matches RPC serializable extension UI request and response semantics", async () => {
		const rpc = await runRpcUiContract(createWorkspace());
		const gui = await runGuiUiContract(createWorkspace());

		expect(gui).toEqual(rpc);
		expect(gui.result).toEqual({ selected: "beta", confirmed: true, input: "typed", edited: "edited\ntext" });
	}, 30_000);

	it("matches RPC abort settlement and persisted stop reason", async () => {
		const rpc = await runRpcAbortContract(createWorkspace());
		const gui = await runGuiAbortContract(createWorkspace());

		expect(gui).toEqual(rpc);
		expect(gui.transcript.lastAssistantStopReason).toBe("aborted");
		expect(gui.events.at(-1)).toBe("phase:idle");
	}, 30_000);
});
