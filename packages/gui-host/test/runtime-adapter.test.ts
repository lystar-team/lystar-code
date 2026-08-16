import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../coding-agent/src/core/agent-session.ts";
import { getLystarSetting, LYSTAR_SETTINGS_CATALOG } from "../../coding-agent/src/core/lystar-settings-catalog.ts";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.ts";
import {
	appendSessionRecoveryLedger,
	createRecoveryLedgerEntry,
	getSessionRecoveryLedgerPath,
} from "../../coding-agent/src/core/tool-recovery/ledger.ts";
import { CodingAgentRuntimeAdapter, projectRuntimeProgress } from "../src/runtime-adapter.ts";
import type { RuntimeEvent, RuntimeSession } from "../src/types.ts";

function eventPayload(event: RuntimeEvent): {
	items: Array<{ entryId: string; payload: { message?: { role?: string } } }>;
	transcriptGeneration: string;
	fromRevision: number;
	transcriptRevision: number;
} {
	return event.payload as {
		items: Array<{ entryId: string; payload: { message?: { role?: string } } }>;
		transcriptGeneration: string;
		fromRevision: number;
		transcriptRevision: number;
	};
}

describe("CodingAgentRuntimeAdapter", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	it("projects real AgentSessionEvent variants into bounded typed progress", () => {
		const toolStart: Extract<AgentSessionEvent, { type: "tool_execution_start" }> = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "src/app.ts" },
		};
		const toolUpdate: Extract<AgentSessionEvent, { type: "tool_execution_update" }> = {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "src/app.ts" },
			partialResult: { output: "partial" },
		};
		const toolEnd: Extract<AgentSessionEvent, { type: "tool_execution_end" }> = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: { output: "done" },
			isError: false,
		};
		const queue: Extract<AgentSessionEvent, { type: "queue_update" }> = {
			type: "queue_update",
			steering: ["steer"],
			followUp: ["follow"],
		};
		const assistant = {
			type: "message_update",
			message: {
				role: "assistant",
				usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
			},
			assistantMessageEvent: { type: "text_delta", delta: "answer" },
		} as AgentSessionEvent;
		const thinking = {
			...assistant,
			assistantMessageEvent: { type: "thinking_delta", delta: "reason" },
		} as AgentSessionEvent;

		expect(projectRuntimeProgress(toolStart)).toEqual([
			expect.objectContaining({ type: "tool_start", toolCallId: "call-1", name: "read" }),
		]);
		expect(projectRuntimeProgress(toolUpdate)).toEqual([
			expect.objectContaining({ type: "tool_update", toolCallId: "call-1", name: "read" }),
		]);
		expect(projectRuntimeProgress(toolEnd)).toEqual([
			expect.objectContaining({ type: "tool_end", toolCallId: "call-1", status: "success" }),
		]);
		expect(projectRuntimeProgress(queue)).toEqual([{ type: "queue_update", steeringCount: 1, followUpCount: 1 }]);
		expect(projectRuntimeProgress(assistant)).toEqual([
			{ type: "assistant_delta", text: "answer" },
			{ type: "usage", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } },
		]);
		expect(projectRuntimeProgress(thinking)).toEqual([
			{ type: "thinking_delta", text: "reason" },
			{ type: "usage", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } },
		]);
		expect(projectRuntimeProgress({ type: "session_info_changed", name: "x".repeat(2_000) })).toEqual([
			expect.objectContaining({ type: "status", status: "session_info_changed" }),
		]);
	});

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("lists and writes the same catalog descriptors used by the selector", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "gui-host-settings-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		cleanups.push(async () => {
			await runtime.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});

		expect(runtime.listSettings().map((setting) => setting.id)).toEqual(
			LYSTAR_SETTINGS_CATALOG.map((setting) => setting.id),
		);
		const result = await runtime.setSetting("http-idle-timeout", 0);
		expect(result.setting).toMatchObject({ id: "http-idle-timeout", value: 0 });
		expect(getLystarSetting("http-idle-timeout")?.get(SettingsManager.create(cwd, agentDir))).toBe(0);
	});

	it("persists and restores bash when it is the first transcript entry", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "gui-host-bash-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		for (const dir of [agentDir, cwd]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));

		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		let runtime: RuntimeSession | undefined;
		cleanups.push(async () => {
			await runtime?.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});

		runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		const events: RuntimeEvent[] = [];
		runtime.onEvent((event) => events.push(event));
		await runtime.runBash("printf native-ok", () => {});

		const sessionPath = runtime.sessionPath;
		expect(existsSync(sessionPath)).toBe(true);
		expect(adapter.isSessionWriterLocked(sessionPath)).toBe(true);
		const committed = events.filter((event) => event.type === "entry_committed").map(eventPayload);
		expect(committed.map((event) => event.items.map((item) => item.payload.message?.role))).toEqual([
			["bashExecution"],
		]);
		const persisted = readFileSync(sessionPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { message?: { role?: string; output?: string } });
		expect(persisted.find((entry) => entry.message?.role === "bashExecution")?.message?.output).toBe("native-ok");
		const listed = await adapter.listSessions(cwd);
		if (!Array.isArray(listed) || !listed[0] || typeof listed[0] !== "object" || Array.isArray(listed[0])) {
			throw new Error("Expected one listed Session summary");
		}
		expect(listed[0].firstMessage).toBe("未命名会话");
		expect(listed[0].activity).toBe("completed");

		await runtime.dispose();
		expect(adapter.isSessionWriterLocked(sessionPath)).toBe(false);
		runtime = await adapter.openSession(sessionPath, async () => ({ cancelled: true }));
		expect(runtime.getSnapshot("owned").transcriptRevision).toBeGreaterThan(0);
	});

	it("runs the real Core runtime, persists JSONL, and resumes with continuous transcript revisions", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "gui-host-runtime-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const model = faux.getModel();
		for (const dir of [agentDir, cwd]) mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[model.provider]: {
						baseUrl: model.baseUrl,
						apiKey: "faux-key",
						api: faux.api,
						models: [
							{
								id: model.id,
								name: model.name,
								reasoning: model.reasoning,
								input: model.input,
								cost: model.cost,
								contextWindow: model.contextWindow,
								maxTokens: model.maxTokens,
							},
						],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: model.provider,
				defaultModel: model.id,
				defaultThinkingLevel: "off",
				defaultProjectTrust: "always",
			}),
		);

		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		let runtime: RuntimeSession | undefined;
		cleanups.push(async () => {
			await runtime?.dispose();
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		});

		runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		const firstEvents: RuntimeEvent[] = [];
		runtime.onEvent((event) => firstEvents.push(event));
		expect(runtime.getSnapshot("owned").model).toEqual({ provider: model.provider, id: model.id });

		await runtime.prompt("hello");
		const sessionPath = runtime.sessionPath;
		expect(existsSync(sessionPath)).toBe(true);
		expect(isAbsolute(relative(join(agentDir, "sessions"), sessionPath))).toBe(false);
		const firstCommitted = firstEvents.filter((event) => event.type === "entry_committed").map(eventPayload);
		expect(firstCommitted).toHaveLength(1);
		expect(firstCommitted[0].items.map((item) => item.payload.message?.role)).toEqual(["user", "assistant"]);
		expect(firstCommitted[0].fromRevision).toBe(0);
		const firstRevision = firstCommitted[0].transcriptRevision;
		const firstGeneration = firstCommitted[0].transcriptGeneration;
		const persistedRoles = readFileSync(sessionPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { message?: { role?: string } })
			.flatMap((entry) => (entry.message?.role ? [entry.message.role] : []));
		expect(persistedRoles).toEqual(["user", "assistant"]);

		await runtime.dispose();
		runtime = await adapter.openSession(sessionPath, async () => ({ cancelled: true }));
		const resumedEvents: RuntimeEvent[] = [];
		runtime.onEvent((event) => resumedEvents.push(event));
		expect(runtime.getSnapshot("owned").model).toEqual({ provider: model.provider, id: model.id });
		await runtime.prompt("again");

		const resumedCommitted = resumedEvents.filter((event) => event.type === "entry_committed").map(eventPayload);
		expect(resumedCommitted.map((event) => event.items.map((item) => item.payload.message?.role))).toEqual([
			["user"],
			["assistant"],
		]);
		expect(resumedCommitted[0].transcriptGeneration).toBe(firstGeneration);
		expect(resumedCommitted[0].fromRevision).toBe(firstRevision);
		expect(resumedCommitted[1].fromRevision).toBe(resumedCommitted[0].transcriptRevision);
		expect(resumedCommitted[1].transcriptRevision).toBeGreaterThan(resumedCommitted[0].transcriptRevision);

		await runtime.rename("GUI 控制契约");
		await runtime.setModel({ provider: model.provider, id: model.id });
		const modelSummary = (await adapter.listModels()).find(
			(candidate) => candidate.provider === model.provider && candidate.id === model.id,
		);
		const thinkingLevel = modelSummary?.supportedThinkingLevels.at(-1);
		if (!thinkingLevel) throw new Error("Model has no supported thinking level");
		await runtime.setThinkingLevel(thinkingLevel);
		expect(runtime.getSnapshot("owned")).toMatchObject({
			name: "GUI 控制契约",
			model: { provider: model.provider, id: model.id },
			thinkingLevel,
		});

		const firstUserEntryId = firstCommitted[0].items.find((item) => item.payload.message?.role === "user")?.entryId;
		if (!firstUserEntryId) throw new Error("Missing user entry for fork");
		const originalSessionPath = runtime.sessionPath;
		const forked = await runtime.fork(firstUserEntryId);
		const forkedSessionPath = runtime.sessionPath;
		expect(forked).toEqual({ sessionPath: forkedSessionPath, selectedText: "hello" });
		expect(forkedSessionPath).not.toBe(originalSessionPath);
		faux.setResponses([fauxAssistantMessage("forked")]);
		await runtime.prompt("continue");
		expect(existsSync(forkedSessionPath)).toBe(true);

		await runtime.dispose();
		runtime = undefined;
		await appendSessionRecoveryLedger(
			agentDir,
			forkedSessionPath,
			createRecoveryLedgerEntry({
				sessionId: "gui-session",
				turnId: "0",
				toolCallId: "gui-call",
				toolName: "read",
				callSignature: "a".repeat(64),
				failureFingerprint: "b".repeat(64),
				failureCode: "PERMISSION_DENIED",
				attempt: 1,
				action: "observe",
				outcome: "failed",
				durationMs: 1,
				createdAt: "2026-08-15T00:00:00.000Z",
			}),
		);
		const ledgerPath = await getSessionRecoveryLedgerPath(agentDir, forkedSessionPath);
		await adapter.deleteSession(forkedSessionPath);
		expect(existsSync(forkedSessionPath)).toBe(false);
		expect(existsSync(ledgerPath)).toBe(false);
	});

	it("atomically manages project instructions and validates project resources", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "gui-host-project-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		const outside = join(tempDir, "outside.txt");
		mkdirSync(join(cwd, "src"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, "src", "app.ts"), "const first = 1;\nconst second = 2;\n");
		writeFileSync(outside, "outside\n");
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
		const adapter = new CodingAgentRuntimeAdapter(agentDir);

		const initial = adapter.listProjectInstructions(cwd);
		expect(initial.filter((file) => file.editable).map((file) => file.fileName)).toEqual([
			"AGENTS.override.md",
			"AGENTS.md",
		]);
		expect(initial.every((file) => !file.exists)).toBe(true);
		const saved = adapter.saveProjectInstruction(cwd, "AGENTS.md", "# Project\n");
		const agents = saved.find((file) => file.fileName === "AGENTS.md");
		expect(agents).toMatchObject({ exists: true, active: true, editable: true, content: "# Project\n" });
		if (!agents?.contentHash) throw new Error("Missing instruction hash");
		writeFileSync(join(cwd, "AGENTS.md"), "external change\n");
		expect(() => adapter.saveProjectInstruction(cwd, "AGENTS.md", "stale write\n", agents.contentHash)).toThrow(
			"外部修改",
		);

		const resource = adapter.resolveProjectResource(cwd, "src/app.ts:2");
		expect(resource).toMatchObject({ displayPath: "src/app.ts", kind: "text", line: 2 });
		const chunk = adapter.readProjectResource(cwd, resource.path, 0, 1024);
		expect(Buffer.from(chunk.data, "base64").toString("utf8")).toContain("const second = 2");
		expect(adapter.completeProjectFiles(cwd, "src/app", 10)).toEqual([
			expect.objectContaining({ value: "@src/app.ts ", label: "app.ts", description: "src", kind: "file" }),
		]);
		expect(() => adapter.resolveProjectResource(cwd, outside)).toThrow("项目范围");
	});

	it("manages Host instructions, directory browsing, and one-time external resource grants", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "gui-host-scoped-settings-"));
		const agentDir = join(tempDir, "agent");
		const browseRoot = join(tempDir, "browse");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(browseRoot, "visible"), { recursive: true });
		mkdirSync(join(browseRoot, ".hidden"), { recursive: true });
		const outside = join(tempDir, "outside.txt");
		writeFileSync(outside, "external content\n");
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));

		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const created = adapter.saveHostInstruction("AGENTS.md", "# Host\n");
		const agents = created.find((file) => file.fileName === "AGENTS.md");
		expect(agents).toMatchObject({ exists: true, active: true, editable: true, content: "# Host\n" });
		if (!agents?.contentHash) throw new Error("Missing Host instruction hash");
		adapter.saveHostInstruction("AGENTS.md", "# Updated Host\n", agents.contentHash);
		expect(adapter.listDirectories(browseRoot).entries).toEqual([
			expect.objectContaining({ name: ".hidden", hidden: true }),
			expect.objectContaining({ name: "visible", hidden: false }),
		]);

		const resource = adapter.resolveExternalResource(outside);
		if (!resource.accessToken) throw new Error("Missing external resource token");
		const chunk = adapter.readExternalResource(resource.path, resource.accessToken, 0, 1024);
		expect(Buffer.from(chunk.data, "base64").toString("utf8")).toBe("external content\n");
		expect(() => adapter.readExternalResource(resource.path, "invalid", 0, 1024)).toThrow("授权已失效");
	});

	it("reads structured status and diffs from a real Git repository without changing it", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "gui-host-git-"));
		const runGit = (...args: string[]) =>
			execFileSync("git", args, { cwd: tempDir, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
		runGit("init", "--initial-branch=main");
		runGit("config", "user.name", "LYStar Test");
		runGit("config", "user.email", "lystar@example.invalid");
		writeFileSync(join(tempDir, "tracked.txt"), "base\n");
		writeFileSync(join(tempDir, "rename-me.txt"), "rename\n");
		runGit("add", ".");
		runGit("commit", "-m", "base");
		writeFileSync(join(tempDir, "tracked.txt"), "base\nworktree\n");
		writeFileSync(join(tempDir, "staged.txt"), "staged\n");
		runGit("add", "staged.txt");
		runGit("mv", "rename-me.txt", "renamed.txt");

		const adapter = new CodingAgentRuntimeAdapter(join(tempDir, "agent"));
		const before = await adapter.getGitStatus(tempDir);
		expect(before).toMatchObject({ root: tempDir, branch: "main", ahead: 0, behind: 0 });
		expect(before.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "tracked.txt", staged: false, unstaged: true }),
				expect.objectContaining({ path: "staged.txt", staged: true, unstaged: false }),
				expect.objectContaining({ path: "renamed.txt", originalPath: "rename-me.txt", staged: true }),
			]),
		);
		const worktreeDiff = await adapter.getGitDiff(tempDir, "tracked.txt", false);
		expect(worktreeDiff).toMatchObject({ path: "tracked.txt", staged: false, additions: 1, deletions: 0 });
		expect(worktreeDiff.diff).toContain("+worktree");
		const stagedDiff = await adapter.getGitDiff(tempDir, "staged.txt", true);
		expect(stagedDiff).toMatchObject({ path: "staged.txt", staged: true, additions: 1, deletions: 0 });
		expect(stagedDiff.diff).toContain("+staged");
		expect(await adapter.getGitStatus(tempDir)).toEqual(before);
	});

	it("routes API key login through a secret UI request and Core credential storage", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "gui-host-auth-"));
		const previousOpenAiKey = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		cleanups.push(() => {
			if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previousOpenAiKey;
			rmSync(tempDir, { recursive: true, force: true });
		});

		const adapter = new CodingAgentRuntimeAdapter(tempDir);
		const requests: Array<{ kind: string; payload: unknown }> = [];
		const loggedIn = await adapter.loginModelProvider("openai", "api_key", async (request) => {
			requests.push({ kind: request.kind, payload: request.payload });
			return { value: "sk-gui-test" };
		});

		expect(requests).toMatchObject([
			{ kind: "secret", payload: { message: "Enter OpenAI API key", placeholder: "" } },
		]);
		expect(loggedIn.find((model) => model.provider === "openai")).toMatchObject({
			authenticated: true,
			authMethods: ["api_key"],
			authSource: "stored",
		});
		expect(existsSync(join(tempDir, "auth.json"))).toBe(true);

		const loggedOut = await adapter.logoutModelProvider("openai");
		expect(loggedOut.some((model) => model.provider === "openai")).toBe(false);
		expect((await adapter.listModelProviders()).find((provider) => provider.id === "openai")).toMatchObject({
			authenticated: false,
			authMethods: ["api_key"],
			builtIn: true,
		});
	});
});
