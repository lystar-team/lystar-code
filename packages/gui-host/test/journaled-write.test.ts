import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, ServerMessage } from "@lystar/code-gui-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { GuiHostService } from "../src/service.ts";
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

class FakeRuntime implements RuntimeSession {
	readonly events = new EventEmitter();
	readonly counts: Record<string, number>;
	readonly sessionPath: string;
	readonly cwd: string;
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
	updateExtensionEditorState() {
		this.counts.extension_editor_state = (this.counts.extension_editor_state ?? 0) + 1;
		return this.counts.extension_editor_state;
	}
	async dispatchExtensionTerminalInput() {
		this.counts.extension_terminal_input = (this.counts.extension_terminal_input ?? 0) + 1;
		return { consume: false };
	}
	dispatchExtensionComponentInput() {
		this.counts.extension_component_input = (this.counts.extension_component_input ?? 0) + 1;
		return { accepted: true };
	}
	resizeExtensionComponents() {
		this.counts.extension_component_resize = (this.counts.extension_component_resize ?? 0) + 1;
		return true;
	}
	disposeExtensionComponent() {
		this.counts.extension_component_dispose = (this.counts.extension_component_dispose ?? 0) + 1;
		return true;
	}
	completeExtensionCustom() {
		this.counts.extension_component_custom = (this.counts.extension_component_custom ?? 0) + 1;
		return true;
	}
	async runBash() {
		return {};
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
	async fork() {
		this.counts.fork_session = (this.counts.fork_session ?? 0) + 1;
		return { sessionPath: this.sessionPath };
	}
	async abort() {}
	async reloadResources() {
		this.counts.reload = (this.counts.reload ?? 0) + 1;
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
		) => {
			counts.login_model_provider = (counts.login_model_provider ?? 0) + 1;
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
		getProjectTrust: () => ({ cwd, trusted: true }),
		setProjectTrust: async () => {
			counts.set_project_trust = (counts.set_project_trust ?? 0) + 1;
			return { cwd, trusted: true };
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
		writeClipboardText: async () => {
			counts.write_clipboard_text = (counts.write_clipboard_text ?? 0) + 1;
			return { capability: true, changed: true };
		},
	} as unknown as RuntimeAdapter;
	const service = new GuiHostService(adapter, { agentDir: directory });
	cleanups.push(async () => {
		await service.dispose();
		rmSync(directory, { recursive: true, force: true });
	});
	return { directory, service, cwd, sessionPath, counts };
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
		case "fork_session":
			return { command, sessionPath, leaseId, entryId: "entry", ...identity };
		case "export_session":
			return { command, sessionPath, leaseId, outputPath: "session.html", ...identity };
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
			return { command, cwd, trusted: true, ...identity };
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
] as const;
const SESSION_COMMANDS = new Set([
	"rename_session",
	"set_session_model",
	"set_session_thinking",
	"fork_session",
	"export_session",
	"set_setting",
	"set_entry_label",
	"navigate_session_tree",
	"abort_subagent",
	"continue_subagent",
]);

describe("GuiHostService journaled writes", () => {
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

	it("rejects extension commands from another client or an old lease and journals a dropped response once", async () => {
		const setupValue = setup();
		const owner = await lease(setupValue.service, setupValue.sessionPath, "owner");
		const attacker = await connection(setupValue.service, "attacker");
		const extensionRequests = [
			{
				command: "extension_terminal_input",
				sessionPath: setupValue.sessionPath,
				leaseId: owner.leaseId,
				clientInstanceId: "attacker",
				clientRequestId: "attack-terminal",
				data: "x",
			},
			{
				command: "extension_component_input",
				sessionPath: setupValue.sessionPath,
				leaseId: owner.leaseId,
				clientInstanceId: "attacker",
				clientRequestId: "attack-component",
				componentId: "component",
				generation: 1,
				data: "x",
			},
			{
				command: "extension_component_custom_cancel",
				sessionPath: setupValue.sessionPath,
				leaseId: owner.leaseId,
				clientInstanceId: "attacker",
				clientRequestId: "attack-custom",
				componentId: "component",
				generation: 1,
			},
			{
				command: "extension_editor_state",
				sessionPath: setupValue.sessionPath,
				leaseId: owner.leaseId,
				clientInstanceId: "attacker",
				clientRequestId: "attack-editor",
				text: "attacker",
				cursor: 0,
				revision: 1,
			},
		] as const;
		for (const [index, request] of extensionRequests.entries()) {
			await attacker.handle({ type: "request", id: `attack-${index}`, request } as ClientMessage);
			expect(attacker.messages.at(-1)).toMatchObject({ ok: false, error: { code: "invalid_session_lease" } });
		}
		expect(setupValue.counts.extension_terminal_input).toBeUndefined();
		expect(setupValue.counts.extension_component_input).toBeUndefined();
		expect(setupValue.counts.extension_component_custom).toBeUndefined();
		expect(setupValue.counts.extension_editor_state).toBeUndefined();

		await owner.connection.close();
		const replacement = await lease(setupValue.service, setupValue.sessionPath, "owner");
		await replacement.connection.handle({
			type: "request",
			id: "old-lease",
			request: {
				command: "extension_component_dispose",
				sessionPath: setupValue.sessionPath,
				leaseId: owner.leaseId,
				clientInstanceId: "owner",
				clientRequestId: "old-dispose",
				componentId: "component",
				generation: 1,
			},
		});
		expect(replacement.connection.messages.at(-1)).toMatchObject({
			ok: false,
			error: { code: "invalid_session_lease" },
		});

		const payload = {
			command: "extension_terminal_input" as const,
			sessionPath: setupValue.sessionPath,
			leaseId: replacement.leaseId,
			clientInstanceId: "owner",
			clientRequestId: "dropped-extension-input",
			data: "x",
		};
		const dropped = await connection(setupValue.service, "owner", true);
		await dropped.handle({ type: "request", id: "dropped", request: payload });
		const retry = await connection(setupValue.service, "owner");
		await Promise.all([
			retry.handle({ type: "request", id: "retry-a", request: payload }),
			retry.handle({ type: "request", id: "retry-b", request: payload }),
		]);
		expect(setupValue.counts.extension_terminal_input).toBe(1);
	});
});
