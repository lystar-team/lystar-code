import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ClientMessage, ServerMessage, SessionProgress } from "@lystar/code-gui-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { GuiHostService } from "../src/service.ts";
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];

type BashProgress = Extract<SessionProgress, { type: "bash" }>;

function isBashProgress(value: unknown): value is BashProgress {
	return typeof value === "object" && value !== null && "type" in value && value.type === "bash";
}

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

class FakeRuntime implements RuntimeSession {
	readonly events = new EventEmitter();
	readonly counts: Record<string, number>;
	sessionPath: string;
	readonly cwd: string;
	lastAssistantText: string | undefined = "latest assistant";
	lastBash: { command: string; excludeFromContext: boolean } | undefined;
	private releaseBash: (() => void) | undefined;
	constructor(sessionPath: string, cwd: string, counts: Record<string, number>) {
		this.sessionPath = sessionPath;
		this.cwd = cwd;
		this.counts = counts;
	}
	getSnapshot(writeAccess: "available" | "owned" | "controlled_elsewhere" | "locked_externally") {
		return {
			id: "session",
			path: this.sessionPath,
			cwd: this.cwd,
			createdAt: 0,
			updatedAt: 0,
			phase: "idle" as const,
			activity: "idle" as const,
			thinkingLevel: "off" as const,
			attached: true,
			writeAccess,
			revision: 0,
			leafId: null,
			queuedSteerCount: 0,
			queuedFollowUpCount: 0,
			transcriptGeneration: "generation",
			transcriptRevision: 0,
		};
	}
	listSettings() {
		return [
			{
				id: "project-setting",
				label: "项目设置",
				kind: "boolean" as const,
				value: true,
				displayValue: "开启",
				scope: "project" as const,
				readOnly: false,
				restartRequired: false,
			},
		];
	}
	async setSetting() {
		this.counts.set_setting = (this.counts.set_setting ?? 0) + 1;
		return { setting: this.listSettings()[0], requiresRestart: false };
	}
	getSessionTree() {
		return [];
	}
	getSessionInfo() {
		return {
			name: "测试会话",
			sessionFile: this.sessionPath,
			sessionId: "session",
			messages: { total: 2, user: 1, agent: 1, toolCalls: 0, toolResults: 0 },
			tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, total: 170 },
			cost: 0.25,
			usageBreakdown: [{ key: "faux/model", cost: 0.25, tokens: 170 }],
			cacheWaste: { missedTokens: 0, missedCost: 0, missCount: 0 },
		};
	}
	listForkMessages() {
		return [
			{ entryId: "entry-1", text: "first prompt" },
			{ entryId: "entry-2", text: "latest prompt" },
		];
	}
	async setEntryLabel() {
		this.counts.set_entry_label = (this.counts.set_entry_label ?? 0) + 1;
	}
	async navigateSessionTree() {
		this.counts.navigate_session_tree = (this.counts.navigate_session_tree ?? 0) + 1;
		return { cancelled: false };
	}
	listSubagents() {
		return [];
	}
	readSubagent() {
		return {};
	}
	async abortSubagent() {
		this.counts.abort_subagent = (this.counts.abort_subagent ?? 0) + 1;
	}
	async continueSubagent() {
		this.counts.continue_subagent = (this.counts.continue_subagent ?? 0) + 1;
	}
	async prompt() {}
	async steer() {}
	async followUp() {}
	async clearQueue() {
		return { steering: [], followUp: [] };
	}
	async compact() {
		this.counts.compact = (this.counts.compact ?? 0) + 1;
	}
	async exportSession(outputPath?: string) {
		this.counts.export_session = (this.counts.export_session ?? 0) + 1;
		return { path: outputPath ?? "session.html" };
	}
	async importSession(inputPath: string, cwdOverride?: string) {
		this.counts.import_session = (this.counts.import_session ?? 0) + 1;
		if (basename(inputPath) === "missing-cwd.jsonl" && !cwdOverride) {
			throw Object.assign(new Error("会话保存的工作目录不存在"), {
				code: "missing_session_cwd",
				details: { sessionCwd: "/missing/project", fallbackCwd: this.cwd },
			});
		}
		this.sessionPath = join(dirname(this.sessionPath), basename(inputPath));
		return { cancelled: false };
	}
	async shareSession(signal?: AbortSignal) {
		this.counts.share_session = (this.counts.share_session ?? 0) + 1;
		if (this.counts.block_share) {
			await new Promise<void>((_resolve, reject) => {
				const abort = () => reject(signal?.reason ?? new Error("aborted"));
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		}
		return {
			previewUrl: "https://pi.dev/session/#gist-id",
			gistUrl: "https://gist.github.com/user/gist-id",
		};
	}
	getLastAssistantText() {
		this.counts.copy_last_assistant_message = (this.counts.copy_last_assistant_message ?? 0) + 1;
		return this.lastAssistantText;
	}
	async runBash(command: string, excludeFromContext: boolean, onChunk: (chunk: string) => void) {
		this.counts.run_bash = (this.counts.run_bash ?? 0) + 1;
		this.lastBash = { command, excludeFromContext };
		if (command === "large-output") {
			onChunk("x".repeat(17 * 1024));
			return { output: "x".repeat(17 * 1024), exitCode: 0, cancelled: false };
		}
		if (this.counts.block_bash) {
			await new Promise<void>((resolve) => {
				this.releaseBash = resolve;
			});
			return { output: "", exitCode: null, cancelled: true };
		}
		onChunk("first");
		onChunk("-second");
		return { output: "first-second", exitCode: 0, cancelled: false };
	}
	async rename() {
		this.counts.rename_session = (this.counts.rename_session ?? 0) + 1;
	}
	async setModel() {
		this.counts.set_session_model = (this.counts.set_session_model ?? 0) + 1;
	}
	async setThinkingLevel() {
		this.counts.set_session_thinking = (this.counts.set_session_thinking ?? 0) + 1;
	}
	async cycleModel() {
		this.counts.cycle_session_model = (this.counts.cycle_session_model ?? 0) + 1;
		return { changed: true, isScoped: false };
	}
	async cycleThinkingLevel() {
		this.counts.cycle_session_thinking = (this.counts.cycle_session_thinking ?? 0) + 1;
		return { changed: false, supported: false };
	}
	async fork() {
		this.counts.fork_session = (this.counts.fork_session ?? 0) + 1;
		if (this.counts.block_fork) await new Promise((resolve) => setTimeout(resolve, 20));
		if (this.counts.move_fork) this.sessionPath = `${this.sessionPath}.forked`;
		return { sessionPath: this.sessionPath };
	}
	async abort() {
		this.counts.abort = (this.counts.abort ?? 0) + 1;
		this.releaseBash?.();
		this.releaseBash = undefined;
	}
	async reloadResources() {
		this.counts.reload_resources = (this.counts.reload_resources ?? 0) + 1;
		if (this.counts.fail_reload_once) {
			this.counts.fail_reload_once = 0;
			throw new Error("Extension 初始化失败");
		}
		if (this.counts.block_reload) await new Promise((resolve) => setTimeout(resolve, 20));
	}
	getCompletions() {
		return undefined;
	}
	getToolRecoveryDiagnostics() {
		return {
			mode: "off" as const,
			toolFailureTotal: [],
			toolRecoveryAttemptTotal: [],
			toolRecoverySuccessTotal: [],
			toolRepeatBlockedTotal: [],
			toolUnsafeRetryBlockedTotal: [],
			lessonMatchTotal: [],
			lessonRecoverySuccessTotal: [],
			lessonSuspendedTotal: [],
			duration: { count: 0, totalMs: 0, maxMs: 0 },
			activeCircuits: 0,
		};
	}
	async dispose() {}
	onEvent(listener: (event: RuntimeEvent) => void) {
		this.events.on("event", listener);
		return () => this.events.off("event", listener);
	}
}

function setup() {
	const directory = mkdtempSync(join(tmpdir(), "gui-host-journaled-write-"));
	const cwd = join(directory, "project");
	mkdirSync(cwd, { recursive: true });
	const sessionPath = join(directory, "session.jsonl");
	writeFileSync(sessionPath, "{}\n");
	const counts: Record<string, number> = {};
	let projectTrustDecision: boolean | null = true;
	const clipboardWrites: string[] = [];
	const runtime = new FakeRuntime(sessionPath, cwd, counts);
	const adapter = {
		getAbout: () => ({ productVersion: "test" }),
		createSession: async () => {
			counts.create_session = (counts.create_session ?? 0) + 1;
			return runtime;
		},
		openSession: async () => runtime,
		inspectSession: () => runtime.getSnapshot("available"),
		isSessionWriterLocked: () => false,
		deleteSession: async () => {
			counts.delete_session = (counts.delete_session ?? 0) + 1;
		},
		listSessions: async () => [],
		listModels: async () => [],
		listModelProviders: async () => [],
		addModelProvider: async () => {
			counts.add_model_provider = (counts.add_model_provider ?? 0) + 1;
			return [];
		},
		addProviderModel: async () => {
			counts.add_provider_model = (counts.add_provider_model ?? 0) + 1;
			return [];
		},
		loginModelProvider: async (
			_provider: string,
			_auth: string,
			ui: (request: unknown) => Promise<{ cancelled?: boolean }>,
			signal?: AbortSignal,
		) => {
			counts.login_model_provider = (counts.login_model_provider ?? 0) + 1;
			if (counts.block_login) {
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
				signal?.throwIfAborted();
			}
			const response = await ui({ id: "login-ui", kind: "secret", title: "认证", payload: {} });
			if (response.cancelled) throw Object.assign(new Error("认证已取消"), { code: "auth_cancelled" });
			return [];
		},
		logoutModelProvider: async () => {
			counts.logout_model_provider = (counts.logout_model_provider ?? 0) + 1;
			return [];
		},
		listSkills: async () => ({ skills: [], diagnostics: {} }),
		setSkillEnabled: async () => {
			counts.set_skill_enabled = (counts.set_skill_enabled ?? 0) + 1;
			return { skills: [], diagnostics: {} };
		},
		listProjectInstructions: () => [],
		saveProjectInstruction: () => {
			counts.save_project_instruction = (counts.save_project_instruction ?? 0) + 1;
			return [];
		},
		listHostInstructions: () => [],
		saveHostInstruction: () => {
			counts.save_host_instruction = (counts.save_host_instruction ?? 0) + 1;
			return [];
		},
		listDirectories: () => ({ path: cwd, home: cwd, entries: [] }),
		completeProjectFiles: () => [],
		resolveProjectResource: () => ({}),
		readProjectResource: () => ({}),
		resolveExternalResource: () => ({}),
		readExternalResource: () => ({}),
		getDiagnostics: async () => ({}),
		getGitStatus: async () => ({}),
		getGitDiff: async () => ({}),
		checkForUpdates: async () => ({}),
		listSettings: () => runtime.listSettings(),
		getSessionTree: () => [],
		listSubagents: () => [],
		readSubagent: () => ({}),
		getProjectTrust: () => ({
			cwd,
			trusted: projectTrustDecision,
			reason:
				projectTrustDecision === true
					? "项目资源已信任"
					: projectTrustDecision === false
						? "项目资源被明确设为不信任"
						: "项目包含需信任资源，尚未选择",
			resourceRisk: true,
		}),
		getProjectTrustDecision: () => projectTrustDecision,
		setProjectTrust: async (_cwd: string, trusted: boolean | null) => {
			counts.set_project_trust = (counts.set_project_trust ?? 0) + 1;
			if (counts.block_project_trust) await new Promise((resolve) => setTimeout(resolve, 20));
			projectTrustDecision = trusted;
			return {
				cwd,
				trusted,
				reason: trusted ? "项目资源已信任" : "项目资源被明确设为不信任",
				resourceRisk: true,
			};
		},
		listPackages: () => [],
		installPackage: async () => {
			counts.install_package = (counts.install_package ?? 0) + 1;
			return { changed: true, message: "ok" };
		},
		removePackage: async () => {
			counts.remove_package = (counts.remove_package ?? 0) + 1;
			return { changed: true, message: "ok" };
		},
		updatePackages: async () => {
			counts.update_packages = (counts.update_packages ?? 0) + 1;
			return { changed: true, message: "ok" };
		},
		readClipboardText: async () => ({ capability: true }),
		writeClipboardText: async (text: string) => {
			counts.write_clipboard_text = (counts.write_clipboard_text ?? 0) + 1;
			clipboardWrites.push(text);
			return { capability: true, changed: true };
		},
	} as unknown as RuntimeAdapter;
	const service = new GuiHostService(adapter, { agentDir: directory });
	cleanups.push(async () => {
		await service.dispose();
		rmSync(directory, { recursive: true, force: true });
	});
	return { directory, service, cwd, sessionPath, counts, runtime, clipboardWrites };
}

async function connection(service: GuiHostService, clientInstanceId = "client", dropResponse = false) {
	const messages: ServerMessage[] = [];
	const value = service.createConnection(async (message) => {
		messages.push(message);
		if (dropResponse && message.type === "response") throw new Error("response dropped");
	});
	await value.handle({ type: "hello", version: 1, clientInstanceId });
	return { ...value, messages };
}

async function lease(service: GuiHostService, sessionPath: string, client = "client") {
	const value = await connection(service, client);
	await value.handle({
		type: "request",
		id: "acquire",
		request: { command: "acquire_session", sessionPath, clientInstanceId: client },
	});
	const response = value.messages.find(
		(message) => message.type === "response" && message.id === "acquire",
	) as Extract<ServerMessage, { type: "response"; ok: true }>;
	return { connection: value, leaseId: (response.result as { lease: { leaseId: string } }).lease.leaseId };
}

function request(command: string, cwd: string, sessionPath: string, leaseId: string, clientRequestId: string) {
	const identity = { clientInstanceId: "client", clientRequestId };
	switch (command) {
		case "create_session":
			return { command, cwd, ...identity };
		case "add_model_provider":
			return {
				command,
				provider: "provider",
				baseUrl: "https://example.invalid",
				api: "openai-completions",
				...identity,
			};
		case "add_provider_model":
			return { command, provider: "provider", id: "model", reasoning: false, input: ["text"], ...identity };
		case "login_model_provider":
			return { command, provider: "provider", authType: "api_key", ...identity };
		case "logout_model_provider":
			return { command, provider: "provider", ...identity };
		case "rename_session":
			return { command, sessionPath, leaseId, name: "name", ...identity };
		case "set_session_model":
			return { command, sessionPath, leaseId, model: { provider: "provider", id: "model" }, ...identity };
		case "set_session_thinking":
			return { command, sessionPath, leaseId, level: "off", ...identity };
		case "cycle_session_model":
			return { command, sessionPath, leaseId, direction: "forward", ...identity };
		case "cycle_session_thinking":
			return { command, sessionPath, leaseId, ...identity };
		case "reload_resources":
			return { command, sessionPath, leaseId, ...identity };
		case "fork_session":
			return { command, sessionPath, leaseId, entryId: "entry", ...identity };
		case "export_session":
			return { command, sessionPath, leaseId, outputPath: "session.html", ...identity };
		case "import_session":
			return { command, sessionPath, leaseId, inputPath: join(cwd, "imported.jsonl"), ...identity };
		case "delete_session":
			return { command, cwd, sessionPath, ...identity };
		case "set_skill_enabled":
			return { command, cwd, path: "skill.md", scope: "project", enabled: true, ...identity };
		case "save_project_instruction":
			return { command, cwd, fileName: "AGENTS.md", content: "# Project", ...identity };
		case "save_host_instruction":
			return { command, fileName: "AGENTS.md", content: "# Host", ...identity };
		case "set_setting":
			return { command, sessionPath, leaseId, id: "project-setting", value: true, ...identity };
		case "set_project_trust":
			return { command, sessionPath, leaseId, cwd, trusted: true, ...identity };
		case "install_package":
			return { command, cwd, source: "npm:example", scope: "project", ...identity };
		case "remove_package":
			return { command, cwd, source: "npm:example", scope: "project", ...identity };
		case "update_packages":
			return { command, cwd, source: "npm:example", ...identity };
		case "set_entry_label":
			return { command, sessionPath, leaseId, entryId: "entry", label: "label", ...identity };
		case "navigate_session_tree":
			return { command, sessionPath, leaseId, entryId: "entry", summarize: false, ...identity };
		case "abort_subagent":
			return { command, sessionPath, leaseId, agentId: "agent", ...identity };
		case "continue_subagent":
			return { command, sessionPath, leaseId, agentId: "agent", text: "continue", ...identity };
		case "write_clipboard_text":
			return { command, text: "clipboard", ...identity };
		case "copy_last_assistant_message":
			return { command, sessionPath, ...identity };
		default:
			throw new Error(`unknown write command ${command}`);
	}
}

const WRITE_COMMANDS = [
	"create_session",
	"add_model_provider",
	"add_provider_model",
	"login_model_provider",
	"logout_model_provider",
	"rename_session",
	"set_session_model",
	"set_session_thinking",
	"cycle_session_model",
	"cycle_session_thinking",
	"reload_resources",
	"fork_session",
	"export_session",
	"delete_session",
	"set_skill_enabled",
	"save_project_instruction",
	"save_host_instruction",
	"set_setting",
	"set_project_trust",
	"install_package",
	"remove_package",
	"update_packages",
	"set_entry_label",
	"navigate_session_tree",
	"abort_subagent",
	"continue_subagent",
	"write_clipboard_text",
	"copy_last_assistant_message",
] as const;
const SESSION_COMMANDS = new Set([
	"rename_session",
	"set_session_model",
	"set_session_thinking",
	"cycle_session_model",
	"cycle_session_thinking",
	"reload_resources",
	"fork_session",
	"export_session",
	"set_setting",
	"set_project_trust",
	"set_entry_label",
	"navigate_session_tree",
	"abort_subagent",
	"continue_subagent",
	"copy_last_assistant_message",
]);

describe("GuiHostService journaled writes", () => {
	it("returns Core session information only for the active Session lease", async () => {
		const setupValue = setup();
		const active = await lease(setupValue.service, setupValue.sessionPath);
		for (const [id, leaseId] of [
			["session-info", active.leaseId],
			["session-info-stale", "stale-lease"],
		] as const) {
			await active.connection.handle({
				type: "request",
				id,
				request: { command: "get_session_info", sessionPath: setupValue.sessionPath, leaseId },
			});
		}

		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "session-info"),
		).toMatchObject({ ok: true, result: { name: "测试会话", messages: { total: 2 }, cost: 0.25 } });
		expect(
			active.connection.messages.find(
				(message) => message.type === "response" && message.id === "session-info-stale",
			),
		).toMatchObject({ ok: false, error: { code: "invalid_session_lease" } });
	});

	it("lists Core fork messages only for the active Session lease", async () => {
		const setupValue = setup();
		const active = await lease(setupValue.service, setupValue.sessionPath);
		await active.connection.handle({
			type: "request",
			id: "fork-messages",
			request: {
				command: "list_fork_messages",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
			},
		});
		await active.connection.handle({
			type: "request",
			id: "fork-messages-stale",
			request: {
				command: "list_fork_messages",
				sessionPath: setupValue.sessionPath,
				leaseId: "stale-lease",
			},
		});

		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "fork-messages"),
		).toMatchObject({
			ok: true,
			result: [
				{ entryId: "entry-1", text: "first prompt" },
				{ entryId: "entry-2", text: "latest prompt" },
			],
		});
		expect(
			active.connection.messages.find(
				(message) => message.type === "response" && message.id === "fork-messages-stale",
			),
		).toMatchObject({ ok: false, error: { code: "invalid_session_lease" } });
	});

	it("runs manual compaction once through the operation journal", async () => {
		const setupValue = setup();
		const active = await lease(setupValue.service, setupValue.sessionPath);
		const payload = {
			command: "compact" as const,
			sessionPath: setupValue.sessionPath,
			leaseId: active.leaseId,
			clientInstanceId: "client",
			clientRequestId: "compact-once",
			customInstructions: "保留实现决策",
		};
		await active.connection.handle({ type: "request", id: "compact", request: payload });
		await active.connection.handle({ type: "request", id: "compact-retry", request: payload });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(setupValue.counts.compact).toBe(1);
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "compact-retry"),
		).toMatchObject({ ok: true, result: { duplicate: true, operation: { type: "compact" } } });
	});

	it("runs excluded Shell through the operation journal with cumulative progress", async () => {
		const setupValue = setup();
		const active = await lease(setupValue.service, setupValue.sessionPath);
		await active.connection.handle({
			type: "request",
			id: "bash",
			request: {
				command: "run_bash",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				clientInstanceId: "client",
				clientRequestId: "bash-once",
				commandText: "printf ok",
				excludeFromContext: true,
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(setupValue.runtime.lastBash).toEqual({ command: "printf ok", excludeFromContext: true });
		const progress = active.connection.messages
			.filter((message) => message.type === "event" && message.event.type === "operation_updated")
			.map((message) =>
				message.type === "event" && message.event.type === "operation_updated"
					? message.event.operation.progress
					: undefined,
			)
			.filter(isBashProgress);
		expect(progress).toEqual([
			{ type: "bash", command: "printf ok", output: "" },
			{ type: "bash", command: "printf ok", output: "first" },
			{ type: "bash", command: "printf ok", output: "first-second" },
		]);
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "bash"),
		).toMatchObject({ ok: true, result: { operation: { type: "run_bash" } } });
	});

	it("truncates Shell progress to the latest 16 KiB", async () => {
		const setupValue = setup();
		const active = await lease(setupValue.service, setupValue.sessionPath);
		await active.connection.handle({
			type: "request",
			id: "bash-large",
			request: {
				command: "run_bash",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				clientInstanceId: "client",
				clientRequestId: "bash-large",
				commandText: "large-output",
				excludeFromContext: false,
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		const lastProgress = active.connection.messages
			.filter((message) => message.type === "event" && message.event.type === "operation_updated")
			.map((message) =>
				message.type === "event" && message.event.type === "operation_updated"
					? message.event.operation.progress
					: undefined,
			)
			.filter(isBashProgress)
			.at(-1);
		expect(lastProgress).toMatchObject({ type: "bash", command: "large-output", truncated: true });
		expect(lastProgress?.type === "bash" ? lastProgress.output : "").toHaveLength(16 * 1024);
	});

	it("aborts a running Shell operation through the Runtime", async () => {
		const setupValue = setup();
		setupValue.counts.block_bash = 1;
		const active = await lease(setupValue.service, setupValue.sessionPath);
		await active.connection.handle({
			type: "request",
			id: "bash-running",
			request: {
				command: "run_bash",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				clientInstanceId: "client",
				clientRequestId: "bash-running",
				commandText: "wait",
				excludeFromContext: false,
			},
		});
		const accepted = active.connection.messages.find(
			(message) => message.type === "response" && message.id === "bash-running",
		) as Extract<ServerMessage, { type: "response"; ok: true }>;
		const operationId = (accepted.result as { operation: { operationId: string } }).operation.operationId;
		await new Promise((resolve) => setTimeout(resolve, 0));
		await active.connection.handle({
			type: "request",
			id: "abort-bash",
			request: { command: "abort_operation", operationId, leaseId: active.leaseId },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(setupValue.counts.abort).toBe(1);
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "abort-bash"),
		).toMatchObject({ ok: true, result: { type: "run_bash", status: "aborted" } });
	});

	it("shares once through the operation journal and persists the returned URLs", async () => {
		const setupValue = setup();
		const active = await lease(setupValue.service, setupValue.sessionPath);
		const payload = {
			command: "share_session" as const,
			sessionPath: setupValue.sessionPath,
			leaseId: active.leaseId,
			clientInstanceId: "client",
			clientRequestId: "share-once",
		};
		await active.connection.handle({ type: "request", id: "share", request: payload });
		await active.connection.handle({ type: "request", id: "share-retry", request: payload });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(setupValue.counts.share_session).toBe(1);
		await active.connection.handle({
			type: "request",
			id: "share-operations",
			request: { command: "list_operations", sessionPath: setupValue.sessionPath },
		});
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "share-operations"),
		).toMatchObject({
			ok: true,
			result: [
				expect.objectContaining({
					type: "share_session",
					status: "completed",
					result: {
						previewUrl: "https://pi.dev/session/#gist-id",
						gistUrl: "https://gist.github.com/user/gist-id",
					},
				}),
			],
		});
	});

	it("aborts a running share without aborting the Agent runtime", async () => {
		const setupValue = setup();
		setupValue.counts.block_share = 1;
		const active = await lease(setupValue.service, setupValue.sessionPath);
		await active.connection.handle({
			type: "request",
			id: "share",
			request: {
				command: "share_session",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				clientInstanceId: "client",
				clientRequestId: "share-abort",
			},
		});
		const accepted = active.connection.messages.find(
			(message) => message.type === "response" && message.id === "share",
		) as Extract<ServerMessage, { type: "response"; ok: true }>;
		const operationId = (accepted.result as { operation: { operationId: string } }).operation.operationId;
		await new Promise((resolve) => setTimeout(resolve, 0));
		await active.connection.handle({
			type: "request",
			id: "abort-share",
			request: { command: "abort_operation", operationId, leaseId: active.leaseId },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(setupValue.counts.share_session).toBe(1);
		expect(setupValue.counts.abort).toBeUndefined();
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "abort-share"),
		).toMatchObject({ ok: true, result: { type: "share_session", status: "aborted" } });
	});

	it("locks the session for the full resource reload window", async () => {
		const setupValue = setup();
		setupValue.counts.block_reload = 1;
		const active = await lease(setupValue.service, setupValue.sessionPath);
		const reload = active.connection.handle({
			type: "request",
			id: "reload",
			request: {
				command: "reload_resources",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				clientInstanceId: "client",
				clientRequestId: "reload-blocking",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		await active.connection.handle({
			type: "request",
			id: "prompt-during-reload",
			request: {
				command: "prompt",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				clientInstanceId: "client",
				clientRequestId: "prompt-during-reload",
				text: "should be rejected",
			},
		});
		await reload;

		expect(setupValue.counts.reload_resources).toBe(1);
		expect(
			active.connection.messages.find(
				(message) => message.type === "response" && message.id === "prompt-during-reload",
			),
		).toMatchObject({ ok: false, error: { code: "session_operation_active" } });
	});

	it("binds resource mutations to the active Session and reloads before responding", async () => {
		const setupValue = setup();
		const active = await lease(setupValue.service, setupValue.sessionPath);
		const otherProject = join(setupValue.directory, "other-resource-project");
		mkdirSync(otherProject);

		for (const [id, leaseId, cwd] of [
			["resource-incomplete", undefined, setupValue.cwd],
			["resource-stale", "stale-lease", setupValue.cwd],
			["resource-other-project", active.leaseId, otherProject],
		] as const) {
			await active.connection.handle({
				type: "request",
				id,
				request: {
					command: "set_skill_enabled",
					sessionPath: setupValue.sessionPath,
					...(leaseId ? { leaseId } : {}),
					cwd,
					path: "skill.md",
					scope: "project",
					enabled: true,
					clientInstanceId: "client",
					clientRequestId: id,
				},
			} as ClientMessage);
		}

		setupValue.counts.block_reload = 1;
		const mutation = active.connection.handle({
			type: "request",
			id: "resource-skill",
			request: {
				command: "set_skill_enabled",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				cwd: setupValue.cwd,
				path: "skill.md",
				scope: "project",
				enabled: true,
				clientInstanceId: "client",
				clientRequestId: "resource-skill",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		await active.connection.handle({
			type: "request",
			id: "prompt-during-resource-write",
			request: {
				command: "prompt",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				clientInstanceId: "client",
				clientRequestId: "prompt-during-resource-write",
				text: "should be rejected",
			},
		});
		await mutation;

		await active.connection.handle({
			type: "request",
			id: "resource-host-instruction",
			request: {
				command: "save_host_instruction",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				fileName: "AGENTS.md",
				content: "# Host",
				clientInstanceId: "client",
				clientRequestId: "resource-host-instruction",
			},
		});
		await active.connection.handle({
			type: "request",
			id: "resource-package",
			request: {
				command: "install_package",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				cwd: setupValue.cwd,
				source: "npm:example",
				scope: "project",
				clientInstanceId: "client",
				clientRequestId: "resource-package",
			},
		});

		expect(
			active.connection.messages.find(
				(message) => message.type === "response" && message.id === "resource-incomplete",
			),
		).toMatchObject({ ok: false, error: { code: "session_control_incomplete" } });
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "resource-stale"),
		).toMatchObject({ ok: false, error: { code: "invalid_session_lease" } });
		expect(
			active.connection.messages.find(
				(message) => message.type === "response" && message.id === "resource-other-project",
			),
		).toMatchObject({ ok: false, error: { code: "resource_session_mismatch" } });
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "resource-skill"),
		).toMatchObject({ ok: true, result: { path: "skill.md", scope: "project", enabled: true } });
		expect(
			active.connection.messages.find(
				(message) => message.type === "response" && message.id === "prompt-during-resource-write",
			),
		).toMatchObject({ ok: false, error: { code: "session_operation_active" } });
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "resource-package"),
		).toMatchObject({
			ok: true,
			result: { source: "npm:example", scope: "project", packages: [] },
		});
		expect(setupValue.counts.set_skill_enabled).toBe(1);
		expect(setupValue.counts.save_host_instruction).toBe(1);
		expect(setupValue.counts.install_package).toBe(1);
		expect(setupValue.counts.reload_resources).toBe(3);
	});

	it("binds project trust changes to the active Session and reloads its resources", async () => {
		const setupValue = setup();
		const active = await lease(setupValue.service, setupValue.sessionPath);
		const otherProject = join(setupValue.directory, "other-project");
		mkdirSync(otherProject);
		await active.connection.handle({
			type: "request",
			id: "trust-read",
			request: { command: "get_project_trust", cwd: setupValue.cwd },
		});
		for (const [id, leaseId, cwd] of [
			["trust-stale", "stale-lease", setupValue.cwd],
			["trust-other-project", active.leaseId, otherProject],
		] as const) {
			await active.connection.handle({
				type: "request",
				id,
				request: {
					command: "set_project_trust",
					sessionPath: setupValue.sessionPath,
					leaseId,
					cwd,
					trusted: false,
					clientInstanceId: "client",
					clientRequestId: id,
				},
			});
		}

		setupValue.counts.block_project_trust = 1;
		const mutation = active.connection.handle({
			type: "request",
			id: "trust-set",
			request: {
				command: "set_project_trust",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				cwd: setupValue.cwd,
				trusted: false,
				clientInstanceId: "client",
				clientRequestId: "trust-set",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		await active.connection.handle({
			type: "request",
			id: "prompt-during-trust",
			request: {
				command: "prompt",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				clientInstanceId: "client",
				clientRequestId: "prompt-during-trust",
				text: "should be rejected",
			},
		});
		await mutation;

		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "trust-read"),
		).toMatchObject({ ok: true, result: { cwd: setupValue.cwd, trusted: true } });
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "trust-stale"),
		).toMatchObject({ ok: false, error: { code: "invalid_session_lease" } });
		expect(
			active.connection.messages.find(
				(message) => message.type === "response" && message.id === "trust-other-project",
			),
		).toMatchObject({ ok: false, error: { code: "project_trust_session_mismatch" } });
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "trust-set"),
		).toMatchObject({ ok: true, result: { cwd: setupValue.cwd, trusted: false } });
		expect(
			active.connection.messages.find(
				(message) => message.type === "response" && message.id === "prompt-during-trust",
			),
		).toMatchObject({ ok: false, error: { code: "session_operation_active" } });
		expect(setupValue.counts.set_project_trust).toBe(1);
		expect(setupValue.counts.reload_resources).toBe(1);
	});

	it("restores the previous project trust decision when resource reload fails", async () => {
		const setupValue = setup();
		const active = await lease(setupValue.service, setupValue.sessionPath);
		setupValue.counts.fail_reload_once = 1;
		await active.connection.handle({
			type: "request",
			id: "trust-failed",
			request: {
				command: "set_project_trust",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				cwd: setupValue.cwd,
				trusted: false,
				clientInstanceId: "client",
				clientRequestId: "trust-failed",
			},
		});
		await active.connection.handle({
			type: "request",
			id: "trust-after-failure",
			request: { command: "get_project_trust", cwd: setupValue.cwd },
		});

		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "trust-failed"),
		).toMatchObject({ ok: false, error: { message: "Extension 初始化失败" } });
		expect(
			active.connection.messages.find(
				(message) => message.type === "response" && message.id === "trust-after-failure",
			),
		).toMatchObject({ ok: true, result: { trusted: true } });
		expect(setupValue.counts.set_project_trust).toBe(2);
		expect(setupValue.counts.reload_resources).toBe(2);
	});

	it("locks the session for the full fork window", async () => {
		const setupValue = setup();
		setupValue.counts.block_fork = 1;
		const active = await lease(setupValue.service, setupValue.sessionPath);
		const fork = active.connection.handle({
			type: "request",
			id: "fork",
			request: {
				command: "fork_session",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				entryId: "entry",
				position: "before",
				clientInstanceId: "client",
				clientRequestId: "fork-blocking",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		await active.connection.handle({
			type: "request",
			id: "prompt-during-fork",
			request: {
				command: "prompt",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				clientInstanceId: "client",
				clientRequestId: "prompt-during-fork",
				text: "should be rejected",
			},
		});
		await fork;

		expect(setupValue.counts.fork_session).toBe(1);
		expect(
			active.connection.messages.find(
				(message) => message.type === "response" && message.id === "prompt-during-fork",
			),
		).toMatchObject({ ok: false, error: { code: "session_operation_active" } });
	});

	it("replays a completed fork after the Session path moves", async () => {
		const setupValue = setup();
		setupValue.counts.move_fork = 1;
		const active = await lease(setupValue.service, setupValue.sessionPath);
		const request = {
			command: "fork_session" as const,
			sessionPath: setupValue.sessionPath,
			leaseId: active.leaseId,
			entryId: "entry",
			position: "before" as const,
			clientInstanceId: "client",
			clientRequestId: "fork-path-move",
		};
		await active.connection.handle({ type: "request", id: "fork", request });
		await active.connection.handle({ type: "request", id: "fork-retry", request });

		expect(setupValue.counts.fork_session).toBe(1);
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "fork-retry"),
		).toMatchObject({ ok: true, result: { snapshot: { path: `${setupValue.sessionPath}.forked` } } });
	});

	it("rejects resource reload while the session has an active operation", async () => {
		const setupValue = setup();
		setupValue.counts.block_share = 1;
		const active = await lease(setupValue.service, setupValue.sessionPath);
		await active.connection.handle({
			type: "request",
			id: "share",
			request: {
				command: "share_session",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				clientInstanceId: "client",
				clientRequestId: "share-running",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		await active.connection.handle({
			type: "request",
			id: "reload",
			request: {
				command: "reload_resources",
				sessionPath: setupValue.sessionPath,
				leaseId: active.leaseId,
				clientInstanceId: "client",
				clientRequestId: "reload-busy",
			},
		});

		expect(setupValue.counts.reload_resources).toBeUndefined();
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "reload"),
		).toMatchObject({ ok: false, error: { code: "session_operation_active" } });
	});

	it("copies the Core-selected last assistant message and reports an empty session", async () => {
		const setupValue = setup();
		const active = await lease(setupValue.service, setupValue.sessionPath);
		const copyRequest = {
			command: "copy_last_assistant_message" as const,
			sessionPath: setupValue.sessionPath,
			clientInstanceId: "client",
			clientRequestId: "copy-last",
		};
		await active.connection.handle({
			type: "request",
			id: "copy",
			request: copyRequest,
		});
		await active.connection.handle({ type: "request", id: "copy-retry", request: copyRequest });
		expect(setupValue.clipboardWrites).toEqual(["latest assistant"]);
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "copy"),
		).toMatchObject({ ok: true, result: { capability: true, copied: true } });
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "copy-retry"),
		).toMatchObject({ ok: true, result: { capability: true, copied: true } });

		setupValue.runtime.lastAssistantText = undefined;
		await active.connection.handle({
			type: "request",
			id: "copy-empty",
			request: {
				command: "copy_last_assistant_message",
				sessionPath: setupValue.sessionPath,
				clientInstanceId: "client",
				clientRequestId: "copy-empty",
			},
		});
		expect(setupValue.clipboardWrites).toEqual(["latest assistant"]);
		expect(
			active.connection.messages.find((message) => message.type === "response" && message.id === "copy-empty"),
		).toMatchObject({ ok: true, result: { capability: true, copied: false } });
	});

	it.each(WRITE_COMMANDS)("executes %s once and persists a completed operation", async (command) => {
		const setupValue = setup();
		const acquired = SESSION_COMMANDS.has(command)
			? await lease(setupValue.service, setupValue.sessionPath)
			: undefined;
		const active = acquired?.connection ?? (await connection(setupValue.service));
		const payload = request(
			command,
			setupValue.cwd,
			setupValue.sessionPath,
			acquired?.leaseId ?? "",
			`happy-${command}`,
		);
		if (command === "login_model_provider") {
			const pending = active.handle({ type: "request", id: "happy", request: payload } as ClientMessage);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const ui = active.messages.find((message) => message.type === "event" && message.event.type === "ui_request");
			if (ui?.type === "event" && ui.event.type === "ui_request")
				await active.handle({ type: "ui_response", id: ui.event.id, value: "secret" });
			await pending;
		} else await active.handle({ type: "request", id: "happy", request: payload } as ClientMessage);
		expect(setupValue.counts[command]).toBe(1);
		await active.handle({ type: "request", id: "operations", request: { command: "list_operations" } });
		expect(
			active.messages.find((message) => message.type === "response" && message.id === "operations"),
		).toMatchObject({
			ok: true,
			result: [expect.objectContaining({ clientRequestId: `happy-${command}`, status: "completed" })],
		});
	});

	it.each([
		["session", "rename_session"],
		["collection", "delete_session"],
		["provider", "add_model_provider"],
		["project", "set_skill_enabled"],
		["host", "save_host_instruction"],
	] as const)(
		"replays %s scope writes after response drop, concurrent duplicate, and conflict",
		async (_scope, command) => {
			const setupValue = setup();
			const acquired =
				command === "rename_session" ? await lease(setupValue.service, setupValue.sessionPath) : undefined;
			const first = await connection(setupValue.service, "client", true);
			const payload = request(
				command,
				setupValue.cwd,
				setupValue.sessionPath,
				acquired?.leaseId ?? "",
				`retry-${command}`,
			);
			await first.handle({ type: "request", id: "first", request: payload } as ClientMessage);
			await first.close();
			const retry = await connection(setupValue.service);
			await retry.handle({ type: "request", id: "retry", request: payload } as ClientMessage);
			await Promise.all([
				retry.handle({ type: "request", id: "duplicate-a", request: payload } as ClientMessage),
				retry.handle({ type: "request", id: "duplicate-b", request: payload } as ClientMessage),
			]);
			const conflict = {
				...payload,
				clientRequestId: `retry-${command}`,
				...(command === "rename_session"
					? { name: "other" }
					: command === "delete_session"
						? { sessionPath: join(setupValue.cwd, "other-session.jsonl") }
						: command === "add_model_provider"
							? { baseUrl: "https://other.invalid" }
							: command === "set_skill_enabled"
								? { enabled: false }
								: { content: "# Other" }),
			};
			if (command === "delete_session") writeFileSync((conflict as { sessionPath: string }).sessionPath, "{}\n");
			await retry.handle({ type: "request", id: "conflict", request: conflict } as ClientMessage);
			expect(setupValue.counts[command]).toBe(1);
			expect(
				retry.messages.find((message) => message.type === "response" && message.id === "conflict"),
			).toMatchObject({ ok: false, error: { code: "operation_request_conflict" } });
		},
	);

	it("moves the session lease once and replays a dropped import response", async () => {
		const setupValue = setup();
		const acquired = await lease(setupValue.service, setupValue.sessionPath);
		const payload = request(
			"import_session",
			setupValue.cwd,
			setupValue.sessionPath,
			acquired.leaseId,
			"import-once",
		);
		const dropped = await connection(setupValue.service, "client", true);
		await dropped.handle({ type: "request", id: "dropped", request: payload } as ClientMessage);

		const retry = await connection(setupValue.service);
		await retry.handle({ type: "request", id: "retry", request: payload } as ClientMessage);
		const importedPath = join(setupValue.directory, "imported.jsonl");
		expect(setupValue.counts.import_session).toBe(1);
		expect(retry.messages.find((message) => message.type === "response" && message.id === "retry")).toMatchObject({
			ok: true,
			result: {
				cancelled: false,
				lease: { leaseId: acquired.leaseId },
				snapshot: { path: importedPath },
			},
		});
	});

	it("returns missing cwd details and imports with the selected override", async () => {
		const setupValue = setup();
		const acquired = await lease(setupValue.service, setupValue.sessionPath);
		const payload = {
			command: "import_session" as const,
			sessionPath: setupValue.sessionPath,
			leaseId: acquired.leaseId,
			clientInstanceId: "client",
			clientRequestId: "import-missing-cwd",
			inputPath: join(setupValue.cwd, "missing-cwd.jsonl"),
		};
		await acquired.connection.handle({ type: "request", id: "missing", request: payload });
		expect(
			acquired.connection.messages.find((message) => message.type === "response" && message.id === "missing"),
		).toMatchObject({
			ok: false,
			error: {
				code: "missing_session_cwd",
				details: { sessionCwd: "/missing/project", fallbackCwd: setupValue.cwd },
			},
		});

		await acquired.connection.handle({
			type: "request",
			id: "override",
			request: {
				...payload,
				clientRequestId: "import-with-override",
				cwdOverride: setupValue.cwd,
			},
		});
		expect(setupValue.counts.import_session).toBe(2);
		expect(
			acquired.connection.messages.find((message) => message.type === "response" && message.id === "override"),
		).toMatchObject({
			ok: true,
			result: { cancelled: false, snapshot: { cwd: setupValue.cwd } },
		});
	});

	it("serializes one scope, keeps different scopes parallel, and removes settled queues", async () => {
		const { service } = setup();
		const queues = service as unknown as {
			enqueueWriteScope<T>(scope: string, run: () => Promise<T>): Promise<T>;
			writeScopeQueues: Map<string, Promise<void>>;
		};
		let releaseFirst = () => {};
		const firstReady = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const started: string[] = [];
		const first = queues.enqueueWriteScope("session:/one", async () => {
			started.push("first");
			await firstReady;
		});
		const second = queues.enqueueWriteScope("session:/one", async () => {
			started.push("second");
		});
		const other = queues.enqueueWriteScope("provider:two", async () => {
			started.push("other");
		});
		await other;
		expect(started).toEqual(["first", "other"]);
		releaseFirst();
		await Promise.all([first, second]);
		await Promise.resolve();
		expect(started).toEqual(["first", "other", "second"]);
		expect(queues.writeScopeQueues.size).toBe(0);
		await expect(
			queues.enqueueWriteScope("host", async () => {
				throw new Error("failed");
			}),
		).rejects.toThrow("failed");
		await queues.enqueueWriteScope("host", async () => {
			started.push("after-failure");
		});
		expect(started).toContain("after-failure");
	});
	it("replays a completed login after a response drop without duplicating credentials", async () => {
		const setupValue = setup();
		const payload = request("login_model_provider", setupValue.cwd, setupValue.sessionPath, "", "dropped-login");
		const first = await connection(setupValue.service, "client", true);
		const pending = first.handle({ type: "request", id: "first", request: payload } as ClientMessage);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const ui = first.messages.find((message) => message.type === "event" && message.event.type === "ui_request");
		if (ui?.type !== "event" || ui.event.type !== "ui_request") throw new Error("Missing login UI request");
		await first.handle({ type: "ui_response", id: ui.event.id, value: "credential-secret" });
		await pending;
		await first.close();

		const retry = await connection(setupValue.service);
		await Promise.all([
			retry.handle({ type: "request", id: "retry-a", request: payload } as ClientMessage),
			retry.handle({ type: "request", id: "retry-b", request: payload } as ClientMessage),
		]);
		expect(setupValue.counts.login_model_provider).toBe(1);
		expect(retry.messages.some((message) => message.type === "event" && message.event.type === "ui_request")).toBe(
			false,
		);
		expect(
			retry.messages.filter((message) => message.type === "response" && message.ok).map((message) => message.result),
		).toEqual([[], []]);
		expect(readFileSync(join(setupValue.directory, "host", "operations.jsonl"), "utf8")).not.toContain(
			"credential-secret",
		);
	});

	it("records a failed login and does not replay its UI request", async () => {
		const setupValue = setup();
		const first = await connection(setupValue.service);
		const payload = request("login_model_provider", setupValue.cwd, setupValue.sessionPath, "", "failed-login");
		const pending = first.handle({ type: "request", id: "first", request: payload } as ClientMessage);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const ui = first.messages.find((message) => message.type === "event" && message.event.type === "ui_request");
		if (ui?.type === "event" && ui.event.type === "ui_request")
			await first.handle({ type: "ui_response", id: ui.event.id, cancelled: true });
		await pending;
		expect(first.messages.find((message) => message.type === "response" && message.id === "first")).toMatchObject({
			ok: false,
			error: { code: "auth_cancelled" },
		});
		const retry = await connection(setupValue.service);
		await retry.handle({ type: "request", id: "retry", request: payload } as ClientMessage);
		expect(setupValue.counts.login_model_provider).toBe(1);
		expect(retry.messages.some((message) => message.type === "event" && message.event.type === "ui_request")).toBe(
			false,
		);
		expect(retry.messages.find((message) => message.type === "response" && message.id === "retry")).toMatchObject({
			ok: false,
			error: { code: "operation_failed" },
		});
	});

	it("aborts a pure OAuth wait through the journal without completing the login", async () => {
		const setupValue = setup();
		setupValue.counts.block_login = 1;
		const active = await connection(setupValue.service);
		const pending = active.handle({
			type: "request",
			id: "oauth-login",
			request: {
				command: "login_model_provider",
				provider: "provider",
				authType: "oauth",
				clientInstanceId: "client",
				clientRequestId: "oauth-login",
			},
		} as ClientMessage);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const running = active.messages.find(
			(message) =>
				message.type === "event" &&
				message.event.type === "operation_updated" &&
				message.event.operation.type === "login_model_provider" &&
				message.event.operation.status === "running",
		) as Extract<ServerMessage, { type: "event" }> | undefined;
		if (!running || running.event.type !== "operation_updated") throw new Error("Missing running OAuth operation");

		await active.handle({
			type: "request",
			id: "oauth-abort",
			request: {
				command: "abort_operation",
				operationId: running.event.operation.operationId,
				leaseId: "",
			},
		} as ClientMessage);
		await pending;

		expect(
			active.messages.find((message) => message.type === "response" && message.id === "oauth-abort"),
		).toMatchObject({ ok: true, result: { type: "login_model_provider", status: "aborted" } });
		expect(
			active.messages.find((message) => message.type === "response" && message.id === "oauth-login"),
		).toMatchObject({ ok: false, error: { code: "operation_aborted" } });
		expect(setupValue.counts.login_model_provider).toBe(1);
		expect(setupValue.counts.login_completed).toBeUndefined();
	});

	it("aborts a pure OAuth wait when its owning client disconnects", async () => {
		const setupValue = setup();
		setupValue.counts.block_login = 1;
		const active = await connection(setupValue.service);
		const pending = active.handle({
			type: "request",
			id: "oauth-disconnect",
			request: {
				command: "login_model_provider",
				provider: "provider",
				authType: "oauth",
				clientInstanceId: "client",
				clientRequestId: "oauth-disconnect",
			},
		} as ClientMessage);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			active.messages.some(
				(message) =>
					message.type === "event" &&
					message.event.type === "operation_updated" &&
					message.event.operation.type === "login_model_provider" &&
					message.event.operation.status === "running",
			),
		).toBe(true);

		await active.close();
		await pending;
		expect(
			active.messages.find((message) => message.type === "response" && message.id === "oauth-disconnect"),
		).toMatchObject({ ok: false, error: { code: "operation_aborted" } });
	});
});
