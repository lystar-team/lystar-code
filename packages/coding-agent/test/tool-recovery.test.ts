import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTool, ToolRecoveryObservation } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	appendSessionRecoveryLedger,
	cleanupOrphanRecoveryLedgers,
	createRecoveryLedgerEntry,
	getSessionRecoveryLedgerPath,
	readSessionRecoveryLedger,
	removeSessionRecoveryLedger,
} from "../src/core/tool-recovery/ledger.ts";
import { ObserveOnlyToolRecoveryController } from "../src/core/tool-recovery/policies.ts";
import { classifyToolFailureForTest, getToolSideEffect } from "../src/core/tool-recovery/registry.ts";

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
const tempDirs: string[] = [];

function createTempDir(): string {
	const directory = join(tmpdir(), `pi-tool-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	tempDirs.push(directory);
	return directory;
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

function createObservation(toolCallId: string): ToolRecoveryObservation {
	return {
		toolCallId,
		toolName: "read",
		callSignature: HASH_A,
		sideEffect: "unknown",
		action: "observe",
		outcome: "failure",
		durationMs: 3,
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

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Tool recovery observe ledger", () => {
	it("classifies every built-in side effect and keeps unknown tools unclassified", () => {
		expect(getToolSideEffect("read")).toBe("read_only");
		expect(getToolSideEffect("grep")).toBe("read_only");
		expect(getToolSideEffect("find")).toBe("read_only");
		expect(getToolSideEffect("ls")).toBe("read_only");
		expect(getToolSideEffect("edit")).toBe("conditional_write");
		expect(getToolSideEffect("write")).toBe("conditional_write");
		expect(getToolSideEffect("apply_patch")).toBe("conditional_write");
		expect(getToolSideEffect("bash")).toBe("unknown");
		expect(getToolSideEffect("third_party")).toBe("unknown");
		expect(classifyToolFailureForTest({ toolName: "third_party", error: new Error("permission denied") })).toEqual({
			code: "UNCLASSIFIED",
			category: "unknown",
			retryable: false,
			sideEffect: "unknown",
		});
	});

	it("maps only structured and narrow built-in failure forms", () => {
		expect(
			classifyToolFailureForTest({
				toolName: "read",
				error: Object.assign(new Error("no access"), { code: "EACCES" }),
			}),
		).toMatchObject({ code: "PERMISSION_DENIED", category: "permission", retryable: false });
		expect(
			classifyToolFailureForTest({
				toolName: "read",
				error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
			}),
		).toMatchObject({ code: "TIMEOUT", category: "transient", retryable: true });
		expect(
			classifyToolFailureForTest({ toolName: "bash", error: new Error("output\n\nCommand exited with code 7") }),
		).toMatchObject({ code: "PROCESS_EXIT_NONZERO", category: "execution", retryable: false });
		expect(
			classifyToolFailureForTest({ toolName: "bash", error: new Error("Command timed out after 1 seconds") }),
		).toMatchObject({ code: "TIMEOUT", category: "transient", retryable: false });
		const abort = new AbortController();
		abort.abort();
		expect(
			classifyToolFailureForTest({ toolName: "edit", error: new Error("ignored"), signal: abort.signal }),
		).toMatchObject({
			code: "CANCELLED",
			category: "cancelled",
		});
	});

	it("uses a stable non-path ledger filename and appends safely across concurrent writers", async () => {
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

	it("ignores only a truncated final JSONL entry and does not apply duplicate IDs", async () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "sessions", "session.jsonl");
		mkdirSync(dirname(sessionPath), { recursive: true });
		writeFileSync(sessionPath, "{}\n");
		const entry = createLedgerEntry("same");
		expect(await appendSessionRecoveryLedger(agentDir, sessionPath, entry)).toBe(true);
		expect(await appendSessionRecoveryLedger(agentDir, sessionPath, entry)).toBe(false);
		const path = await getSessionRecoveryLedgerPath(agentDir, sessionPath);
		writeFileSync(path, '{"truncated"', { flag: "a" });
		const entries = await readSessionRecoveryLedger(agentDir, sessionPath);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.id).toBe(entry.id);
	});

	it("only TTL-cleans orphan ledgers and removes a deleted session ledger", async () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "sessions", "live.jsonl");
		const orphanPath = join(agentDir, "sessions", "orphan.jsonl");
		mkdirSync(dirname(sessionPath), { recursive: true });
		writeFileSync(sessionPath, "{}\n");
		writeFileSync(orphanPath, "{}\n");
		await appendSessionRecoveryLedger(agentDir, sessionPath, createLedgerEntry("live"));
		await appendSessionRecoveryLedger(agentDir, orphanPath, createLedgerEntry("orphan"));
		rmSync(orphanPath);
		expect(await cleanupOrphanRecoveryLedgers(agentDir, { ttlMs: 0 })).toBe(1);
		expect(await readSessionRecoveryLedger(agentDir, sessionPath)).toHaveLength(1);
		await removeSessionRecoveryLedger(agentDir, sessionPath);
		expect(existsSync(await getSessionRecoveryLedgerPath(agentDir, sessionPath))).toBe(false);
	});

	it("never persists paths, URL credentials, query values, patch content, or secrets", async () => {
		const agentDir = createTempDir();
		const secret = "super-secret-token";
		const sessionPath = join(agentDir, "sessions", "sensitive", "session.jsonl");
		mkdirSync(dirname(sessionPath), { recursive: true });
		writeFileSync(sessionPath, "{}\n");
		const entry = createLedgerEntry("privacy", {
			sessionId: sessionPath,
			turnId: "/absolute/turn",
			toolCallId: "https://alice:password@example.invalid/path?token=secret#hash",
			toolName: "apply_patch",
			failureCode: secret,
		});
		await appendSessionRecoveryLedger(agentDir, sessionPath, entry);
		const content = JSON.stringify(await readSessionRecoveryLedger(agentDir, sessionPath));
		for (const forbidden of [sessionPath, "alice", "password", "token=secret", "*** Begin Patch", secret]) {
			expect(content).not.toContain(forbidden);
		}
	});

	it("isolates parallel tool calls and emits local observe-only diagnostics", async () => {
		const agentDir = createTempDir();
		const sessionManager = SessionManager.create(agentDir, join(agentDir, "sessions"), { id: "parallel-session" });
		const sessionPath = sessionManager.getSessionFile()!;
		const controller = new ObserveOnlyToolRecoveryController({
			agentDir,
			sessionManager,
			getTurnId: () => "7",
		});
		await Promise.all([
			controller.observe(
				createObservation("call-one"),
				undefined,
				Object.assign(new Error("denied"), { code: "EACCES" }),
			),
			controller.observe(
				createObservation("call-two"),
				undefined,
				Object.assign(new Error("denied"), { code: "EACCES" }),
			),
		]);
		const entries = await readSessionRecoveryLedger(agentDir, sessionPath);
		expect(entries.map((entry) => entry.toolCallId).sort()).toEqual(["call-one", "call-two"]);
		expect(entries.map((entry) => entry.attempt)).toEqual([1, 1]);
		expect(controller.getDiagnostics()).toMatchObject({
			mode: "observe",
			toolFailureTotal: [{ tool: "read", code: "PERMISSION_DENIED", count: 2 }],
			toolRecoveryAttemptTotal: [{ tool: "read", action: "observe", count: 2 }],
			activeCircuits: 0,
		});
		sessionManager.dispose();
	});

	it("injects the controller into AgentSession and leaves the Pi Session JSONL unchanged", async () => {
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
		const failingRead: AgentTool = {
			name: "read",
			label: "read",
			description: "test read failure",
			parameters: Type.Object({ path: Type.String() }),
			async execute() {
				throw Object.assign(new Error("denied"), { code: "EACCES" });
			},
		};
		session.agent.state.tools = [failingRead];
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
		expect(ledger[0]).toMatchObject({ toolName: "read", failureCode: "PERMISSION_DENIED", action: "observe" });
		expect(session.getToolRecoveryDiagnostics().toolFailureTotal).toEqual([
			{ tool: "read", code: "PERMISSION_DENIED", count: 1 },
		]);
		const sessionJsonl = readFileSync(sessionFile, "utf8");
		expect(sessionJsonl).not.toContain("tool_recovery_observe");
		expect(sessionJsonl).toContain("/private/project/secret.ts");
		session.dispose();
	});
});
