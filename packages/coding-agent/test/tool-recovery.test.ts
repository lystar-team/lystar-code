import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type AgentTool, ToolExecutionError, type ToolRecoveryObservation } from "@earendil-works/pi-agent-core";
import { estimateTextTokens } from "@earendil-works/pi-ai";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	appendSessionRecoveryLedger,
	cleanupOrphanRecoveryLedgers,
	createRecoveryLedgerEntry,
	deleteSessionWithRecoveryLedger,
	getSessionRecoveryLedgerPath,
	readSessionRecoveryLedger,
	removeSessionRecoveryLedger,
} from "../src/core/tool-recovery/ledger.ts";
import {
	approveToolRecoveryLesson,
	createToolRecoveryLesson,
	disableToolRecoveryLesson,
	hashToolRecoveryLessonScope,
	listToolRecoveryLessons,
} from "../src/core/tool-recovery/lessons-store.ts";
import {
	AssistToolRecoveryController,
	AutoToolRecoveryController,
	ObserveOnlyToolRecoveryController,
} from "../src/core/tool-recovery/policies.ts";
import { parseToolRecoveryRefinerProposal } from "../src/core/tool-recovery/refiner.ts";
import {
	adaptToolRecoveryObservation,
	classifyToolFailureForTest,
	getToolSideEffect,
	registerBuiltInRecoveryError,
	registerBuiltInToolIdentity,
} from "../src/core/tool-recovery/registry.ts";
import { createToolRecoverySafeRefreshRegistry } from "../src/core/tool-recovery/safe-refresh.ts";
import applyPatchExtension from "../src/extensions/apply-patch/index.ts";
import { createHarness, createHarnessWithExtensions } from "./test-harness.ts";

const execFileAsync = promisify(execFile);

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CREATED_AT = "2026-08-15T00:00:00.000Z";
const FUTURE = "2030-01-01T00:00:00.000Z";
const originalToolRecoveryMode = process.env.PI_TOOL_RECOVERY_MODE;
const tempDirs: string[] = [];

function createTempDir(): string {
	const directory = join(tmpdir(), `pi-tool-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	tempDirs.push(directory);
	return directory;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function createLedgerEntry(id: string, overrides: Partial<Parameters<typeof createRecoveryLedgerEntry>[0]> = {}) {
	return createRecoveryLedgerEntry({
		sessionId: "session-1",
		turnId: "0",
		toolCallId: `call-${id}`,
		toolName: "read",
		callSignature: HASH_A,
		failureFingerprint: HASH_B,
		failureCode: "PERMISSION_DENIED",
		attempt: 1,
		action: "observe",
		outcome: "failed",
		durationMs: 1,
		createdAt: CREATED_AT,
		...overrides,
	});
}

function createObservation(
	toolCallId: string,
	toolRuntimeContext?: unknown,
	toolName = "read",
): ToolRecoveryObservation {
	return {
		toolCallId,
		toolName,
		callSignature: HASH_A,
		sideEffect: "unknown",
		action: "observe",
		outcome: "failure",
		durationMs: 3,
		...(toolRuntimeContext === undefined ? {} : { toolRuntimeContext }),
		failure: {
			schema: 1,
			toolName: "read",
			code: "UNCLASSIFIED",
			category: "unknown",
			sideEffect: "unknown",
			retryable: false,
			fingerprint: HASH_B,
			callSignature: HASH_A,
			evidence: {},
			occurredAt: CREATED_AT,
		},
	};
}

function createTrustedBuiltInTool(name: "read" | "bash" | "edit"): AgentTool {
	const tool: AgentTool = {
		name,
		label: name,
		description: `test ${name}`,
		parameters: Type.Object({}),
		async execute() {
			return { content: [], details: {} };
		},
	};
	registerBuiltInToolIdentity(tool);
	return tool;
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

beforeEach(() => {
	delete process.env.PI_TOOL_RECOVERY_MODE;
});

afterEach(() => {
	delete process.env.PI_TOOL_RECOVERY_MODE;
	if (originalToolRecoveryMode !== undefined) process.env.PI_TOOL_RECOVERY_MODE = originalToolRecoveryMode;
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Tool recovery observe ledger", () => {
	it("uses only explicitly registered builtin Tool identities for side effects", () => {
		const builtinRead = createTrustedBuiltInTool("read");
		const builtinEdit = createTrustedBuiltInTool("edit");
		expect(getToolSideEffect(builtinRead.runtimeContext)).toBe("read_only");
		expect(getToolSideEffect(builtinEdit.runtimeContext)).toBe("conditional_write");
		expect(
			classifyToolFailureForTest({
				toolName: "read",
				runtimeContext: builtinRead.runtimeContext,
				error: Object.assign(new Error("no access"), { code: "EACCES" }),
			}),
		).toMatchObject({ code: "PERMISSION_DENIED", sideEffect: "read_only" });

		const thirdPartyRead = createTrustedBuiltInTool("read");
		thirdPartyRead.runtimeContext = undefined;
		expect(
			classifyToolFailureForTest({
				toolName: "read",
				error: Object.assign(new Error("no access"), { code: "EACCES" }),
			}),
		).toEqual({
			code: "UNCLASSIFIED",
			category: "unknown",
			retryable: false,
			sideEffect: "unknown",
		});
	});

	it("maps narrow raw failures only for registered builtin Tools", () => {
		const builtinRead = createTrustedBuiltInTool("read");
		const builtinBash = createTrustedBuiltInTool("bash");
		expect(
			classifyToolFailureForTest({
				toolName: "read",
				runtimeContext: builtinRead.runtimeContext,
				error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
			}),
		).toMatchObject({ code: "TIMEOUT", category: "transient", retryable: true });
		expect(
			classifyToolFailureForTest({
				toolName: "bash",
				runtimeContext: builtinBash.runtimeContext,
				error: new Error("output\n\nCommand exited with code 7"),
			}),
		).toMatchObject({ code: "PROCESS_EXIT_NONZERO", category: "execution", retryable: false });
		const abort = new AbortController();
		abort.abort();
		expect(
			classifyToolFailureForTest({ toolName: "edit", error: new Error("ignored"), signal: abort.signal }),
		).toMatchObject({
			code: "CANCELLED",
			category: "cancelled",
		});
	});

	it("keeps safe_refresh handlers explicit and isolates handler failures", async () => {
		const registry = createToolRecoverySafeRefreshRegistry();
		expect(registry.has("read")).toBe(true);
		expect(registry.has("edit")).toBe(true);

		registry.register("inspect_custom", ({ args }) => `snapshot:${JSON.stringify(args)}`);
		expect(await registry.run("inspect_custom", { key: "value" }, process.cwd())).toBe('snapshot:{"key":"value"}');
		await expect(registry.run("missing_custom", {}, process.cwd())).resolves.toBeUndefined();

		registry.register("broken_custom", () => {
			throw new Error("handler failed");
		});
		await expect(registry.run("broken_custom", {}, process.cwd())).resolves.toBeUndefined();
		expect(() => registry.register("read", () => "override")).toThrow("已注册");
	});

	it("preserves POST_HOOK_FAILURE even when the hook error resembles a timeout", async () => {
		const observation = createObservation("post-hook");
		observation.failure = {
			...observation.failure!,
			code: "POST_HOOK_FAILURE",
			category: "execution",
			retryable: true,
		};
		await adaptToolRecoveryObservation(
			observation,
			new ToolExecutionError("Command timed out after 1 seconds", {
				code: "TIMEOUT",
				category: "transient",
				retryable: true,
			}),
		);
		expect(observation.failure).toMatchObject({
			code: "POST_HOOK_FAILURE",
			category: "execution",
			retryable: false,
		});
	});

	it("uses a stable non-path ledger filename and serializes same-process appenders", async () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "sessions", "project", "session.jsonl");
		mkdirSync(dirname(sessionPath), { recursive: true });
		writeFileSync(sessionPath, "{}\n");
		const firstPath = await getSessionRecoveryLedgerPath(agentDir, sessionPath);
		const secondPath = await getSessionRecoveryLedgerPath(agentDir, sessionPath);
		expect(firstPath).toBe(secondPath);
		expect(firstPath).not.toContain(sessionPath);

		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				appendSessionRecoveryLedger(agentDir, sessionPath, createLedgerEntry(String(index))),
			),
		);
		expect(await readSessionRecoveryLedger(agentDir, sessionPath)).toHaveLength(12);
	});

	it("keeps all entries when independent Node processes append the same ledger", async () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "sessions", "session.jsonl");
		const worker = join(import.meta.dirname, "fixtures", "recovery-ledger-worker.ts");
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				execFileAsync(process.execPath, ["--import", "tsx", worker, agentDir, sessionPath, String(index)]),
			),
		);
		const entries = await readSessionRecoveryLedger(agentDir, sessionPath);
		expect(entries).toHaveLength(8);
		expect(new Set(entries.map((entry) => entry.toolCallId))).toHaveLength(8);
	});

	it("atomically repairs a truncated ledger tail before appending", async () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "sessions", "session.jsonl");
		mkdirSync(dirname(sessionPath), { recursive: true });
		writeFileSync(sessionPath, "{}\n");
		const first = createLedgerEntry("first");
		const second = createLedgerEntry("second");
		await appendSessionRecoveryLedger(agentDir, sessionPath, first);
		const path = await getSessionRecoveryLedgerPath(agentDir, sessionPath);
		writeFileSync(path, '{"truncated"\n', { flag: "a" });
		await appendSessionRecoveryLedger(agentDir, sessionPath, second);

		const raw = readFileSync(path, "utf8");
		const parsed = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { id: string });
		expect(parsed.map((entry) => entry.id)).toEqual([first.id, second.id]);
		expect(await readSessionRecoveryLedger(agentDir, sessionPath)).toHaveLength(2);
	});

	it("scans canonical Session paths under the ledger lock and keeps a concurrent live append", async () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "sessions", "live.jsonl");
		mkdirSync(dirname(sessionPath), { recursive: true });
		writeFileSync(sessionPath, "{}\n");
		await appendSessionRecoveryLedger(agentDir, sessionPath, createLedgerEntry("first"));
		await Promise.all([
			cleanupOrphanRecoveryLedgers(agentDir, { ttlMs: 0 }),
			appendSessionRecoveryLedger(agentDir, sessionPath, createLedgerEntry("second")),
		]);
		expect(await readSessionRecoveryLedger(agentDir, sessionPath)).toHaveLength(2);
	});

	it("cleans only orphaned ledgers and removes aliases through the shared deletion transaction", async () => {
		const agentDir = createTempDir();
		const realSessions = join(agentDir, "real-sessions");
		const aliasA = join(agentDir, "sessions-a");
		const aliasB = join(agentDir, "sessions-b");
		mkdirSync(realSessions, { recursive: true });
		symlinkSync(realSessions, aliasA);
		symlinkSync(realSessions, aliasB);
		const sessionA = join(aliasA, "session.jsonl");
		const sessionB = join(aliasB, "session.jsonl");
		writeFileSync(sessionA, "{}\n");
		await appendSessionRecoveryLedger(agentDir, sessionA, createLedgerEntry("live"));
		const ledgerPath = await getSessionRecoveryLedgerPath(agentDir, sessionA);

		await deleteSessionWithRecoveryLedger(agentDir, sessionB, () => unlinkSync(sessionB));
		expect(existsSync(sessionA)).toBe(false);
		expect(existsSync(ledgerPath)).toBe(false);

		const orphanSession = join(realSessions, "orphan.jsonl");
		writeFileSync(orphanSession, "{}\n");
		await appendSessionRecoveryLedger(agentDir, orphanSession, createLedgerEntry("orphan"));
		unlinkSync(orphanSession);
		expect(await cleanupOrphanRecoveryLedgers(agentDir, { ttlMs: 0 })).toBe(1);
	});

	it("hashes every session identifier and persists no raw paths, URLs, or secrets", async () => {
		const agentDir = createTempDir();
		const secret = "super-secret-token";
		const sessionPath = join(agentDir, "sessions", "sensitive", "session.jsonl");
		mkdirSync(dirname(sessionPath), { recursive: true });
		writeFileSync(sessionPath, "{}\n");
		const entry = createLedgerEntry("privacy", {
			sessionId: sessionPath,
			turnId: "/absolute/turn",
			toolCallId: "https://alice:password@example.invalid/path?token=secret#hash",
			toolName: "https://bad.example/",
			failureCode: secret,
		});
		expect(entry.sessionId).toBe(sha256(sessionPath));
		expect(entry.turnId).toBe(sha256("/absolute/turn"));
		expect(entry.toolCallId).toBe(sha256("https://alice:password@example.invalid/path?token=secret#hash"));
		expect(entry.toolName).toBe("unknown");
		expect(entry.failureCode).toBe("UNCLASSIFIED");
		await appendSessionRecoveryLedger(agentDir, sessionPath, entry);
		const bytes = readFileSync(await getSessionRecoveryLedgerPath(agentDir, sessionPath), "utf8");
		for (const forbidden of [sessionPath, "alice", "password", "token=secret", "#hash", "*** Begin Patch", secret]) {
			expect(bytes).not.toContain(forbidden);
		}
	});

	it("does not trust a third-party Tool injected under the builtin read name", async () => {
		const agentDir = createTempDir();
		const sessionManager = SessionManager.create(agentDir, join(agentDir, "sessions"), { id: "parallel-session" });
		const sessionPath = sessionManager.getSessionFile()!;
		const controller = new ObserveOnlyToolRecoveryController({
			agentDir,
			sessionManager,
			getTurnId: () => "7",
		});
		await controller.observe(
			createObservation("third-party-read"),
			undefined,
			Object.assign(new Error("denied"), { code: "EACCES" }),
		);
		const entries = await readSessionRecoveryLedger(agentDir, sessionPath);
		expect(entries[0]).toMatchObject({ failureCode: "UNCLASSIFIED", toolName: "read" });
		sessionManager.dispose();
	});

	it("injects an assist controller into AgentSession without changing Session JSONL", async () => {
		const root = createTempDir();
		const agentDir = join(root, "agent");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			allowModelNetwork: false,
		});
		const sessionManager = SessionManager.create(root, join(agentDir, "sessions"), { id: "recovery-session" });
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			modelRuntime,
			sessionManager,
		});
		const thirdPartyRead: AgentTool = {
			name: "read",
			label: "read",
			description: "test read failure",
			parameters: Type.Object({ path: Type.String() }),
			async execute() {
				throw Object.assign(new Error("denied"), { code: "EACCES" });
			},
		};
		session.agent.state.tools = [thirdPartyRead];
		let request = 0;
		session.agent.streamFunction = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				request++;
				stream.push({
					type: "done",
					reason: request === 1 ? "toolUse" : "stop",
					message:
						request === 1
							? assistantMessage(
									[
										{
											type: "toolCall",
											id: "call-recovery",
											name: "read",
											arguments: { path: "/private/project/secret.ts" },
										},
									],
									"toolUse",
								)
							: assistantMessage([{ type: "text", text: "done" }], "stop"),
				});
			});
			return stream;
		};

		await session.prompt("run");
		const sessionFile = session.sessionFile!;
		const ledger = await readSessionRecoveryLedger(agentDir, sessionFile);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({
			toolName: "read",
			failureCode: "UNCLASSIFIED",
			action: "stop",
			outcome: "failed",
		});
		expect(session.getToolRecoveryDiagnostics()).toMatchObject({
			mode: "assist",
			activeCircuits: 1,
			toolUnsafeRetryBlockedTotal: [{ tool: "read", count: 1 }],
		});
		const sessionJsonl = readFileSync(sessionFile, "utf8");
		expect(sessionJsonl).not.toContain("tool_recovery_observe");
		expect(sessionJsonl).toContain("/private/project/secret.ts");
		session.dispose();
	});

	it("runs a registered custom safe_refresh handler only for an active lesson", async () => {
		process.env.PI_TOOL_RECOVERY_MODE = "assist";
		const agentDir = createTempDir();
		const sessionManager = SessionManager.create(agentDir, join(agentDir, "sessions"), {
			id: "custom-refresh-session",
		});
		const registry = createToolRecoverySafeRefreshRegistry();
		registry.register("inspect_custom", ({ args }) => {
			const key =
				typeof args === "object" && args !== null && !Array.isArray(args)
					? String((args as Record<string, unknown>).key ?? "")
					: "";
			return `自定义状态：${key}`;
		});
		const customTool: AgentTool = {
			name: "inspect_custom",
			label: "inspect_custom",
			description: "test custom inspection tool",
			parameters: Type.Object({ key: Type.String() }),
			async execute() {
				throw new ToolExecutionError("custom target missing", {
					code: "TARGET_NOT_FOUND",
					category: "precondition",
					retryable: false,
				});
			},
		};
		const harness = await createHarness({
			agentDir,
			sessionManager,
			baseToolsOverride: { inspect_custom: customTool },
			toolRecoverySafeRefreshRegistry: registry,
			responses: [
				{ toolCalls: [{ id: "custom-first", name: "inspect_custom", args: { key: "first" } }] },
				"after first",
				{ toolCalls: [{ id: "custom-second", name: "inspect_custom", args: { key: "second" } }] },
				"after second",
			],
		});
		try {
			await harness.session.prompt("inspect first");
			const firstResult = harness.session.messages.find((message) => message.role === "toolResult");
			const firstText =
				firstResult?.role === "toolResult"
					? firstResult.content
							.filter((content): content is { type: "text"; text: string } => content.type === "text")
							.map((content) => content.text)
							.join("\n")
					: "";
			expect(firstText).not.toContain("自定义状态：first");
			const ledger = await readSessionRecoveryLedger(agentDir, sessionManager.getSessionFile()!);
			const failure = ledger.find((entry) => entry.toolName === "inspect_custom");
			if (!failure) throw new Error("missing custom Tool failure ledger");
			const candidate = await createToolRecoveryLesson(
				agentDir,
				{
					scope: "project",
					scopeHash: hashToolRecoveryLessonScope(harness.tempDir),
					matcher: {
						toolName: failure.toolName,
						failureCode: failure.failureCode,
						fingerprintPrefix: failure.failureFingerprint.slice(0, 16),
					},
					guidance: "先读取自定义 Tool 的当前状态，再决定下一步。",
					allowedAction: "safe_refresh",
					expiresAt: FUTURE,
				},
				{ now: new Date(CREATED_AT) },
			);
			await approveToolRecoveryLesson(agentDir, candidate.id, candidate.version, { now: new Date(CREATED_AT) });

			await harness.session.prompt("inspect second");
			const results = harness.session.messages.filter(
				(message): message is Extract<(typeof harness.session.messages)[number], { role: "toolResult" }> =>
					message.role === "toolResult",
			);
			const result = results[results.length - 1];
			const text =
				result?.content
					.filter((content): content is { type: "text"; text: string } => content.type === "text")
					.map((content) => content.text)
					.join("\n") ?? "";
			expect(result?.isError).toBe(true);
			expect(text).toContain("自定义状态：second");
			expect(text).toContain("先读取自定义 Tool 的当前状态");
		} finally {
			harness.cleanup();
			sessionManager.dispose();
		}
	});

	it("separates off, observe, assist, and auto for the same transient read failure", async () => {
		for (const mode of ["off", "observe", "assist", "auto"] as const) {
			process.env.PI_TOOL_RECOVERY_MODE = mode;
			const agentDir = createTempDir();
			const harness = await createHarness({
				agentDir,
				sessionManager: SessionManager.create(agentDir, join(agentDir, "sessions"), { id: `mode-${mode}` }),
				responses: [{ toolCalls: [{ name: "read", args: { path: "target.txt" } }] }, "done"],
			});
			try {
				const readTool = harness.agent.state.tools.find((tool) => tool.name === "read");
				if (!readTool) throw new Error("missing builtin read tool");
				let executions = 0;
				readTool.execute = async () => {
					executions++;
					if (mode === "auto" && executions === 2) {
						return { content: [{ type: "text", text: "recovered" }], details: {} };
					}
					throw registerBuiltInRecoveryError(
						"read",
						new ToolExecutionError("timed out", {
							code: "TIMEOUT",
							category: "transient",
							retryable: true,
						}),
					);
				};
				registerBuiltInToolIdentity(readTool);

				await harness.session.prompt(`run ${mode}`);
				const diagnostics = harness.session.getToolRecoveryDiagnostics();
				const ledger = await readSessionRecoveryLedger(agentDir, harness.session.sessionFile!);
				expect(diagnostics.mode).toBe(mode);
				if (mode === "off") {
					expect(executions).toBe(1);
					expect(diagnostics.toolFailureTotal).toEqual([]);
					expect(ledger).toEqual([]);
				} else if (mode === "observe") {
					expect(executions).toBe(1);
					expect(diagnostics.toolRecoveryAttemptTotal).toEqual([{ tool: "read", action: "observe", count: 1 }]);
					expect(ledger).toHaveLength(1);
				} else if (mode === "assist") {
					expect(executions).toBe(1);
					expect(diagnostics.toolRecoveryAttemptTotal).toEqual([
						{ tool: "read", action: "ask_model_to_rebuild", count: 1 },
					]);
					const result = harness.session.messages.find((message) => message.role === "toolResult");
					expect(result?.role === "toolResult" ? result.content : []).toContainEqual(
						expect.objectContaining({ type: "text", text: expect.stringContaining("暂时性错误") }),
					);
				} else {
					expect(executions).toBe(2);
					expect(diagnostics.toolRecoveryAttemptTotal).toEqual([
						{ tool: "read", action: "retry_same_args", count: 1 },
					]);
					expect(diagnostics.toolRecoverySuccessTotal).toEqual([
						{ tool: "read", action: "retry_same_args", count: 1 },
					]);
				}
			} finally {
				harness.cleanup();
			}
		}
	});

	it("associates a rebuilt Tool call with the original failure and records a candidate", async () => {
		const agentDir = createTempDir();
		const sessionManager = SessionManager.create(agentDir, join(agentDir, "sessions"), { id: "rebuild-session" });
		let turnId = "0";
		const controller = new AssistToolRecoveryController({
			agentDir,
			sessionManager,
			getTurnId: () => turnId,
			scopeHash: hashToolRecoveryLessonScope(agentDir),
		});
		const builtinEdit = createTrustedBuiltInTool("edit");
		const error = registerBuiltInRecoveryError(
			"edit",
			new ToolExecutionError("old text was not found", {
				code: "MATCH_NOT_FOUND",
				category: "arguments",
				retryable: false,
			}),
		);
		Object.defineProperty(error, Symbol.for("pi.toolRecoveryHandler"), {
			value: async () => ({
				type: "ask_model_to_rebuild",
				guidance: "先读取当前内容，再重建编辑。",
				replacementResult: { content: [{ type: "text", text: "先读取当前内容，再重建编辑。" }], details: {} },
			}),
		});

		const failed = createObservation("failed-edit", builtinEdit.runtimeContext, "edit");
		const decision = await controller.decideAttempt(failed, undefined, error);
		expect(decision.action.type).toBe("ask_model_to_rebuild");

		turnId = "1";
		const rebuilt = createObservation("rebuilt-edit", builtinEdit.runtimeContext, "edit");
		rebuilt.callSignature = HASH_B;
		rebuilt.outcome = "success";
		rebuilt.failure = undefined;
		await controller.observe(rebuilt);

		const ledger = await readSessionRecoveryLedger(agentDir, sessionManager.getSessionFile()!);
		expect(ledger.map((entry) => [entry.toolName, entry.failureCode, entry.action, entry.outcome])).toEqual([
			["edit", "MATCH_NOT_FOUND", "ask_model_to_rebuild", "needs_model"],
			["edit", "MATCH_NOT_FOUND", "ask_model_to_rebuild", "recovered"],
		]);
		const lessons = await listToolRecoveryLessons(agentDir, { status: "candidate" });
		expect(lessons).toHaveLength(1);
		expect(lessons[0]).toMatchObject({
			matcher: { toolName: "edit", failureCode: "MATCH_NOT_FOUND" },
			evidence: { occurrences: 1, sessions: 1, recovered: 1, failed: 0 },
		});
		sessionManager.dispose();
	});

	it("blocks an identical assist retry within the same Session without rerunning the Tool", async () => {
		process.env.PI_TOOL_RECOVERY_MODE = "assist";
		const harness = await createHarness({
			responses: [
				{ toolCalls: [{ name: "read", args: { path: "target.txt" } }] },
				{ toolCalls: [{ name: "read", args: { path: "target.txt" } }] },
				"done",
			],
		});
		try {
			const readTool = harness.agent.state.tools.find((tool) => tool.name === "read");
			if (!readTool) throw new Error("missing builtin read tool");
			let executions = 0;
			readTool.execute = async () => {
				executions++;
				throw registerBuiltInRecoveryError(
					"read",
					new ToolExecutionError("timed out", {
						code: "TIMEOUT",
						category: "transient",
						retryable: true,
					}),
				);
			};
			registerBuiltInToolIdentity(readTool);
			await harness.session.prompt("run twice");
			expect(executions).toBe(1);
			expect(harness.session.getToolRecoveryDiagnostics()).toMatchObject({
				mode: "assist",
				activeCircuits: 1,
				toolRepeatBlockedTotal: [{ tool: "read", code: "TIMEOUT", count: 1 }],
			});
		} finally {
			harness.cleanup();
		}
	});

	it("applies the bounded trusted-read retry policy and opens a Session circuit", async () => {
		const agentDir = createTempDir();
		const sessionManager = SessionManager.create(agentDir, join(agentDir, "sessions"), { id: "assist-session" });
		const controller = new AutoToolRecoveryController({
			agentDir,
			sessionManager,
			getTurnId: () => "3",
			now: () => 10,
			sleep: async () => {
				throw new Error("policy tests must not sleep");
			},
		});
		const builtinRead = createTrustedBuiltInTool("read");
		const transient = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
		const decisions = [];
		for (let attempt = 1; attempt <= 3; attempt++) {
			decisions.push(
				await controller.decideAttempt(createObservation("same", builtinRead.runtimeContext), undefined, transient),
			);
		}
		expect(decisions.map((decision) => decision.action.type)).toEqual(["retry_same_args", "retry_same_args", "stop"]);
		expect(decisions[1]?.observation.warning).toBe(true);
		const failure = decisions[2]?.observation.failure;
		if (!failure) throw new Error("missing final failure");
		await expect(
			controller.preflight({
				toolCallId: "next",
				toolName: "read",
				callSignature: HASH_A,
				sideEffect: "unknown",
				toolRuntimeContext: builtinRead.runtimeContext,
			}),
		).resolves.toMatchObject({ blocked: true, failure: { code: "TIMEOUT", fingerprint: failure.fingerprint } });
		await expect(
			controller.preflight({
				toolCallId: "changed",
				toolName: "read",
				callSignature: "c".repeat(64),
				sideEffect: "unknown",
				toolRuntimeContext: builtinRead.runtimeContext,
			}),
		).resolves.toBeUndefined();
		const ledger = await readSessionRecoveryLedger(agentDir, sessionManager.getSessionFile()!);
		expect(ledger.map((entry) => [entry.action, entry.outcome, entry.attempt])).toEqual([
			["retry_same_args", "failed", 1],
			["retry_same_args", "failed", 2],
			["stop", "failed", 3],
			["stop", "blocked", 3],
		]);
		expect(controller.getDiagnostics()).toMatchObject({
			mode: "auto",
			activeCircuits: 1,
			toolRecoveryAttemptTotal: [
				{ tool: "read", action: "retry_same_args", count: 2 },
				{ tool: "read", action: "stop", count: 1 },
			],
			toolRepeatBlockedTotal: [{ tool: "read", code: "TIMEOUT", count: 1 }],
		});
		sessionManager.dispose();
	});

	it("refuses automatic retry for Bash, writes, third-party Tools, and ordinary errors", async () => {
		const agentDir = createTempDir();
		const sessionManager = SessionManager.create(agentDir, join(agentDir, "sessions"), { id: "unsafe-session" });
		const controller = new AutoToolRecoveryController({ agentDir, sessionManager, getTurnId: () => "4" });
		const builtinBash = createTrustedBuiltInTool("bash");
		const builtinEdit = createTrustedBuiltInTool("edit");
		const thirdPartyRead = createTrustedBuiltInTool("read");
		thirdPartyRead.runtimeContext = undefined;
		for (const [id, tool, error] of [
			["bash", builtinBash, Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })],
			["edit", builtinEdit, Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })],
			["third-party", thirdPartyRead, Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })],
			["ordinary", thirdPartyRead, new Error("ordinary")],
		] as const) {
			const decision = await controller.decideAttempt(
				createObservation(id, tool.runtimeContext, tool.name),
				undefined,
				error,
			);
			expect(decision.action.type).toBe("stop");
		}
		expect(controller.getDiagnostics().toolRecoveryAttemptTotal).toEqual([
			{ tool: "bash", action: "stop", count: 1 },
			{ tool: "edit", action: "stop", count: 1 },
			{ tool: "read", action: "stop", count: 2 },
		]);
		expect(controller.getDiagnostics().toolUnsafeRetryBlockedTotal).toEqual([
			{ tool: "bash", count: 1 },
			{ tool: "edit", count: 1 },
			{ tool: "read", count: 2 },
		]);
		sessionManager.dispose();
	});

	it("runs edit rebuild recovery once per fingerprint across changed call signatures", async () => {
		process.env.PI_TOOL_RECOVERY_MODE = "auto";
		for (const scenario of [
			{ name: "missing", content: "stable\n", oldText: "missing" },
			{ name: "ambiguous", content: "duplicate\nbody\nduplicate\n", oldText: "duplicate" },
		] as const) {
			const harness = await createHarness({
				responses: [
					{
						toolCalls: [
							{
								name: "edit",
								args: { path: "target.txt", edits: [{ oldText: scenario.oldText, newText: "first" }] },
							},
						],
					},
					"after first",
					{
						toolCalls: [
							{
								name: "edit",
								args: { path: "target.txt", edits: [{ oldText: scenario.oldText, newText: "second" }] },
							},
						],
					},
					"after second",
					{
						toolCalls: [
							{
								name: "edit",
								args: { path: "target.txt", edits: [{ oldText: scenario.oldText, newText: "third" }] },
							},
						],
					},
					"after third",
				],
			});
			try {
				writeFileSync(join(harness.tempDir, "target.txt"), scenario.content);
				const activeEdit = harness.agent.state.tools.find((tool) => tool.name === "edit");
				expect(getToolSideEffect(activeEdit?.runtimeContext)).toBe("conditional_write");
				let directError: unknown;
				try {
					await activeEdit?.execute("direct", {
						path: "target.txt",
						edits: [{ oldText: scenario.oldText, newText: "direct" }],
					});
				} catch (error) {
					directError = error;
				}
				expect(directError).toBeInstanceOf(ToolExecutionError);
				const directHandler = (
					directError as unknown as {
						[key: symbol]: (context: Record<string, never>) => Promise<unknown>;
					}
				)[Symbol.for("pi.toolRecoveryHandler")];
				expect(directHandler).toBeTypeOf("function");
				expect(await directHandler({})).toMatchObject({ type: "ask_model_to_rebuild" });
				await harness.session.prompt("first");
				await harness.session.prompt("second");
				await harness.session.prompt("third");

				const diagnostics = harness.session.getToolRecoveryDiagnostics();
				expect(diagnostics.toolRecoveryAttemptTotal).toEqual([
					{ tool: "edit", action: "ask_model_to_rebuild", count: 1 },
					{ tool: "edit", action: "stop", count: 2 },
				]);
				const firstResult = harness.session.messages.find(
					(message): message is Extract<(typeof harness.session.messages)[number], { role: "toolResult" }> =>
						message.role === "toolResult",
				);
				const evidence =
					firstResult?.content
						.filter((content): content is { type: "text"; text: string } => content.type === "text")
						.map((content) => content.text)
						.join("\n") ?? "";
				expect(evidence.match(/^\d+: /gm)?.length ?? 0).toBeLessThanOrEqual(200);
				expect(evidence).toContain("最新 target.txt");
			} finally {
				harness.cleanup();
			}
		}
	});

	it("locates edit recovery evidence around the failed edit anchor", async () => {
		const harness = await createHarness();
		try {
			const lines = Array.from({ length: 420 }, (_, index) => `line ${index + 1}`);
			lines[349] = "stable target anchor";
			lines[350] = "current value";
			writeFileSync(join(harness.tempDir, "target.txt"), `${lines.join("\n")}\n`);

			const activeEdit = harness.agent.state.tools.find((tool) => tool.name === "edit");
			let directError: unknown;
			try {
				await activeEdit?.execute("anchor-failure", {
					path: "target.txt",
					edits: [{ oldText: "stable target anchor\nold value", newText: "updated" }],
				});
			} catch (error) {
				directError = error;
			}
			expect(directError).toBeInstanceOf(ToolExecutionError);
			const directHandler = (
				directError as unknown as {
					[key: symbol]: (context: Record<string, never>) => Promise<{
						type: string;
						replacementResult?: {
							content: Array<{ type: string; text: string }>;
							details: Record<string, unknown>;
						};
					}>;
				}
			)[Symbol.for("pi.toolRecoveryHandler")];
			expect(directHandler).toBeTypeOf("function");

			const resolution = await directHandler({});
			const evidence = resolution.replacementResult?.content.map((content) => content.text).join("\n") ?? "";
			expect(resolution).toMatchObject({ type: "ask_model_to_rebuild" });
			expect(evidence).toContain("350: stable target anchor");
			expect(evidence).toContain("351: current value");
			expect(evidence).not.toContain("1: line 1");
			expect(resolution.replacementResult?.details).toMatchObject({
				recovery: { code: "MATCH_NOT_FOUND", failedEditIndex: 0, evidenceLine: 350 },
			});
		} finally {
			harness.cleanup();
		}
	});

	it("rebuilds an apply_patch failure through the AgentSession recovery path", async () => {
		process.env.PI_TOOL_RECOVERY_MODE = "assist";
		const agentDir = createTempDir();
		const sessionManager = SessionManager.create(agentDir, join(agentDir, "sessions"), {
			id: "apply-patch-recovery-session",
		});
		const applyPatch = { name: "apply-patch", factory: applyPatchExtension, hidden: true };
		const patch = (lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
		const harness = await createHarnessWithExtensions({
			agentDir,
			sessionManager,
			extensionFactories: [applyPatch],
			responses: [
				{
					toolCalls: [
						{
							id: "patch-failure",
							name: "apply_patch",
							args: {
								input: patch(["*** Update File: target.txt", "@@", "-missing", "+updated"]),
							},
						},
					],
				},
				{
					toolCalls: [
						{
							id: "patch-rebuild",
							name: "apply_patch",
							args: {
								input: patch(["*** Update File: target.txt", "@@", "-old", "+updated"]),
							},
						},
					],
				},
				"done",
			],
		});
		try {
			writeFileSync(join(harness.tempDir, "target.txt"), "old\n");
			await harness.session.prompt("apply the patch");
			expect(readFileSync(join(harness.tempDir, "target.txt"), "utf8")).toBe("updated\n");
			const ledger = await readSessionRecoveryLedger(agentDir, sessionManager.getSessionFile()!);
			expect(ledger.map((entry) => [entry.toolName, entry.failureCode, entry.action, entry.outcome])).toEqual([
				["apply_patch", "PATCH_MATCH_NOT_FOUND", "ask_model_to_rebuild", "needs_model"],
				["apply_patch", "PATCH_MATCH_NOT_FOUND", "ask_model_to_rebuild", "recovered"],
			]);
			expect(await listToolRecoveryLessons(agentDir, { status: "candidate" })).toHaveLength(1);
		} finally {
			harness.cleanup();
			sessionManager.dispose();
		}
	});

	it("refreshes read target-missing parent evidence without changing the path, but never refreshes permission failures", async () => {
		process.env.PI_TOOL_RECOVERY_MODE = "auto";
		const missingHarness = await createHarness({
			responses: [{ toolCalls: [{ name: "read", args: { path: "missing.txt" } }] }, "after refresh"],
		});
		try {
			for (let index = 0; index < 220; index++) {
				writeFileSync(join(missingHarness.tempDir, `entry-${index}.txt`), "x");
			}
			const activeRead = missingHarness.agent.state.tools.find((tool) => tool.name === "read");
			expect(getToolSideEffect(activeRead?.runtimeContext)).toBe("read_only");
			let directError: unknown;
			try {
				await activeRead?.execute("direct", { path: "missing.txt" });
			} catch (error) {
				directError = error;
			}
			expect(directError).toBeInstanceOf(ToolExecutionError);
			const directHandler = (
				directError as unknown as {
					[key: symbol]: (context: Record<string, never>) => Promise<unknown>;
				}
			)[Symbol.for("pi.toolRecoveryHandler")];
			expect(directHandler).toBeTypeOf("function");
			expect(await directHandler({})).toMatchObject({ type: "refresh_context" });
			await missingHarness.session.prompt("read missing");
			const result = missingHarness.session.messages.find(
				(message): message is Extract<(typeof missingHarness.session.messages)[number], { role: "toolResult" }> =>
					message.role === "toolResult",
			);
			const evidence =
				result?.content
					.filter((content): content is { type: "text"; text: string } => content.type === "text")
					.map((content) => content.text)
					.join("\n") ?? "";
			expect(evidence).toContain("父目录刷新结果");
			expect(evidence.match(/^entry-\d+\.txt$/gm)?.length ?? 0).toBe(200);
			expect(missingHarness.session.getToolRecoveryDiagnostics().toolRecoveryAttemptTotal).toEqual([
				{ tool: "read", action: "refresh_context", count: 1 },
			]);
			const assistant = missingHarness.session.messages.find((message) => message.role === "assistant");
			expect(
				assistant?.role === "assistant"
					? assistant.content.find((content) => content.type === "toolCall")?.arguments
					: undefined,
			).toMatchObject({ path: "missing.txt" });
		} finally {
			missingHarness.cleanup();
		}

		const permissionHarness = await createHarness({
			responses: [{ toolCalls: [{ name: "read", args: { path: "private.txt" } }] }, "after permission"],
		});
		try {
			const readTool = permissionHarness.agent.state.tools.find((tool) => tool.name === "read");
			if (!readTool) throw new Error("missing builtin read tool");
			readTool.execute = async () => {
				throw new ToolExecutionError("permission denied", {
					code: "PERMISSION_DENIED",
					category: "permission",
					retryable: false,
				});
			};
			await permissionHarness.session.prompt("read private");
			expect(permissionHarness.session.getToolRecoveryDiagnostics().toolRecoveryAttemptTotal).toEqual([
				{ tool: "read", action: "stop", count: 1 },
			]);
			expect(permissionHarness.session.getToolRecoveryDiagnostics().toolRecoveryAttemptTotal).not.toContainEqual(
				expect.objectContaining({ action: "refresh_context" }),
			);
		} finally {
			permissionHarness.cleanup();
		}
	});

	it("injects at most three budgeted active guidance entries only into final failure ToolResults", async () => {
		const agentDir = createTempDir();
		const createActive = async (guidance: string) => {
			const candidate = await createToolRecoveryLesson(
				agentDir,
				{
					scope: "global",
					matcher: { toolName: "read", failureCode: "TARGET_NOT_FOUND" },
					guidance,
					allowedAction: "guidance",
					expiresAt: "2030-01-01T00:00:00.000Z",
				},
				{ now: new Date("2026-08-15T00:00:00.000Z") },
			);
			return await approveToolRecoveryLesson(agentDir, candidate.id, candidate.version, {
				now: new Date("2026-08-15T00:00:00.000Z"),
			});
		};
		for (let index = 0; index < 4; index++) await createActive(`经验${index}${"甲".repeat(380)}`);
		const suspended = await createActive("暂停经验。");
		await disableToolRecoveryLesson(agentDir, suspended.id, suspended.version, {
			now: new Date("2026-08-15T00:00:00.000Z"),
		});

		const failureHarness = await createHarness({
			agentDir,
			responses: [{ toolCalls: [{ name: "read", args: { path: "missing.txt" } }] }, "after failure"],
		});
		try {
			await failureHarness.session.prompt("read missing");
			const result = failureHarness.session.messages.find(
				(message): message is Extract<(typeof failureHarness.session.messages)[number], { role: "toolResult" }> =>
					message.role === "toolResult",
			);
			expect(result?.isError).toBe(true);
			const injected =
				result?.content.find((block) => block.type === "text" && block.text.startsWith("相关恢复经验：")) ??
				undefined;
			expect(injected?.type === "text" ? injected.text.split("\n").length - 1 : 0).toBeLessThanOrEqual(3);
			if (injected?.type !== "text") throw new Error("missing injected guidance");
			expect(estimateTextTokens(injected.text)).toBeLessThanOrEqual(500);
			expect(failureHarness.session.getToolRecoveryDiagnostics()).toMatchObject({
				lessonMatchTotal: expect.arrayContaining([expect.objectContaining({ count: 1 })]),
				lessonSuspendedTotal: [{ lesson: suspended.id, count: 1 }],
				toolRecoveryAttemptTotal: [{ tool: "read", action: "stop", count: 1 }],
			});
		} finally {
			failureHarness.cleanup();
		}

		const successHarness = await createHarness({
			agentDir,
			responses: [{ toolCalls: [{ name: "read", args: { path: "present.txt" } }] }, "after success"],
		});
		try {
			writeFileSync(join(successHarness.tempDir, "present.txt"), "present");
			await successHarness.session.prompt("read present");
			const result = successHarness.session.messages.find(
				(message): message is Extract<(typeof successHarness.session.messages)[number], { role: "toolResult" }> =>
					message.role === "toolResult",
			);
			expect(result?.isError).toBe(false);
			expect(result?.content.some((block) => block.type === "text" && block.text.startsWith("相关恢复经验："))).toBe(
				false,
			);
		} finally {
			successHarness.cleanup();
		}
	});

	it("calls an explicit refiner only at turn end with sanitized data and rejects unsafe proposals", async () => {
		process.env.PI_TOOL_RECOVERY_MODE = "auto";
		const agentDir = createTempDir();
		const sessionManager = SessionManager.create(agentDir, join(agentDir, "sessions"), { id: "refiner-session" });
		let refinerCalls = 0;
		let refinerInput: unknown;
		const harness = await createHarness({
			agentDir,
			sessionManager,
			responses: [{ toolCalls: [{ name: "read", args: { path: "/private/test-secret.txt" } }] }, "after recovery"],
			getToolRecoveryUserCorrections: () => ["这是明确纠正。", "/private/test-secret"],
			toolRecoveryRefiner: async (input) => {
				refinerCalls++;
				refinerInput = input;
				return {
					type: "create",
					scope: "project",
					matcher: { toolName: "read", failureCode: "RATE_LIMITED" },
					guidance: "先确认当前状态，再继续读取。",
					allowedAction: "guidance",
					expiresAt: "2030-01-01T00:00:00.000Z",
				};
			},
		});
		try {
			const readTool = harness.agent.state.tools.find((tool) => tool.name === "read");
			if (!readTool) throw new Error("missing read tool");
			readTool.execute = async () => {
				const error = new ToolExecutionError("rate limited", {
					code: "RATE_LIMITED",
					category: "transient",
					retryable: true,
				});
				Object.assign(error, {
					[Symbol.for("pi.toolRecoveryHandler")]: () => ({
						type: "accept_as_success",
						replacementResult: { content: [{ type: "text", text: "recovered" }], details: {} },
					}),
				});
				throw registerBuiltInRecoveryError("read", error);
			};
			await harness.session.prompt("never leak /private/test-secret");
			expect(harness.session.getToolRecoveryDiagnostics().toolRecoveryAttemptTotal).toEqual([
				{ tool: "read", action: "accept_as_success", count: 1 },
			]);
			expect(refinerCalls).toBe(1);
			expect(refinerInput).toMatchObject({
				failures: [{ code: "RATE_LIMITED", action: "accept_as_success", outcome: "recovered" }],
				userCorrections: ["这是明确纠正。"],
			});
			const serialized = JSON.stringify(refinerInput);
			for (const forbidden of ["test-secret", "/private", "never leak", "path", "thinking"]) {
				expect(serialized).not.toContain(forbidden);
			}
			expect(await listToolRecoveryLessons(agentDir)).toHaveLength(1);
		} finally {
			harness.cleanup();
		}

		for (const proposal of [
			{ type: "approve", id: "anything" },
			{ type: "retry_same_args" },
			{ type: "create", body: "正文", scope: "project" },
		]) {
			expect(parseToolRecoveryRefinerProposal(proposal)).toBeUndefined();
		}
		const defaultCalls = 0;
		const defaultHarness = await createHarness({
			agentDir,
			sessionManager: SessionManager.create(agentDir, join(agentDir, "sessions"), { id: "default-refiner-session" }),
			responses: ["done"],
		});
		try {
			await defaultHarness.session.prompt("plain turn");
			expect(defaultCalls).toBe(0);
		} finally {
			defaultHarness.cleanup();
		}
	});

	it("removes a ledger after an explicit direct cleanup call", async () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "sessions", "session.jsonl");
		mkdirSync(dirname(sessionPath), { recursive: true });
		writeFileSync(sessionPath, "{}\n");
		await appendSessionRecoveryLedger(agentDir, sessionPath, createLedgerEntry("cleanup"));
		await removeSessionRecoveryLedger(agentDir, sessionPath);
		expect(existsSync(await getSessionRecoveryLedgerPath(agentDir, sessionPath))).toBe(false);
	});
});
