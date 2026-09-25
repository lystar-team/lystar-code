import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { assertWorkspaceCommandResult } from "@lystar/code-web-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../coding-agent/src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../coding-agent/src/core/agent-session-runtime.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../coding-agent/src/core/agent-session-services.ts";
import { getLystarSetting, getLystarSettingsForUi } from "../../coding-agent/src/core/lystar-settings-catalog.ts";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	SessionManager,
} from "../../coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.ts";
import {
	appendSessionRecoveryLedger,
	createRecoveryLedgerEntry,
	getSessionRecoveryLedgerPath,
} from "../../coding-agent/src/core/tool-recovery/ledger.ts";
import { agentStepFromEntry } from "../src/agent-steps.ts";
import { CodingAgentRuntimeAdapter, projectRuntimeProgress } from "../src/runtime-adapter.ts";
import { projectTranscriptItem } from "../src/transcript-projection.ts";
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

	it("adopts the existing AgentSessionRuntime without opening a second writer", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-adopt-runtime-"));
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		const sessionPath = join(tempDir, "session.jsonl");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "adopt-runtime",
				timestamp: new Date().toISOString(),
				cwd,
			})}\n`,
		);
		const manager = SessionManager.open(sessionPath);
		let factoryCalls = 0;
		const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
			factoryCalls++;
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
				...(await createAgentSessionFromServices({
					services,
					sessionManager: options.sessionManager,
					sessionStartEvent: options.sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const initialRuntime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: manager });
		factoryCalls = 0;
		const adapter = new CodingAgentRuntimeAdapter({ agentDir, initialRuntime, createRuntime });
		const runtime = await adapter.openSession(sessionPath, async () => ({ cancelled: true }));
		cleanups.push(async () => {
			await runtime.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});

		expect(adapter.hasClaimedInitialRuntime).toBe(true);
		expect(runtime.sessionPath).toBe(sessionPath);
		expect(factoryCalls).toBe(0);
	});

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
		const assistantStart = {
			type: "message_start",
			message: { role: "assistant", content: [] },
		} as unknown as AgentSessionEvent;
		const queuedUser = {
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "后续任务" }] },
			queueId: "queue-42",
		} as unknown as AgentSessionEvent;

		expect(projectRuntimeProgress(assistantStart)).toEqual([{ type: "phase", phase: "turn" }]);
		expect(projectRuntimeProgress(queuedUser)).toEqual([
			{ type: "user_message", text: "后续任务", queueId: "queue-42" },
		]);
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
		const webSearchCall = {
			type: "webSearchCall",
			id: "web-search-1",
			status: "searching",
			action: { type: "search", query: "uni-app H5 Canvas touch event" },
		};
		const webSearchStart = {
			type: "message_update",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "websearch_start", contentIndex: 0, call: webSearchCall },
		} as unknown as AgentSessionEvent;
		const webSearchUpdate = {
			...webSearchStart,
			assistantMessageEvent: { type: "websearch_update", contentIndex: 0, call: webSearchCall },
		} as unknown as AgentSessionEvent;
		const webSearchEnd = {
			...webSearchStart,
			assistantMessageEvent: {
				type: "websearch_end",
				contentIndex: 0,
				call: {
					...webSearchCall,
					status: "completed",
					action: {
						...webSearchCall.action,
						sources: [{ type: "url", url: "https://uniapp.dcloud.net.cn/api/canvas" }],
					},
				},
			},
		} as unknown as AgentSessionEvent;
		expect(projectRuntimeProgress(webSearchStart)).toEqual([
			{
				type: "tool_start",
				toolCallId: "web-search-1",
				name: "web_search",
				summary: "uni-app H5 Canvas touch event",
				webSearch: {
					status: "searching",
					action: "search",
					query: "uni-app H5 Canvas touch event",
					sources: [],
				},
			},
		]);
		expect(projectRuntimeProgress(webSearchUpdate)).toEqual([
			{
				type: "tool_update",
				toolCallId: "web-search-1",
				name: "web_search",
				summary: "uni-app H5 Canvas touch event",
				webSearch: {
					status: "searching",
					action: "search",
					query: "uni-app H5 Canvas touch event",
					sources: [],
				},
			},
		]);
		expect(projectRuntimeProgress(webSearchEnd)).toEqual([
			{
				type: "tool_end",
				toolCallId: "web-search-1",
				name: "web_search",
				status: "success",
				summary: "uni-app H5 Canvas touch event",
				webSearch: {
					status: "completed",
					action: "search",
					query: "uni-app H5 Canvas touch event",
					sources: [{ url: "https://uniapp.dcloud.net.cn/api/canvas" }],
				},
			},
		]);
		const appended = { type: "entry_appended", entry: {} } as unknown as AgentSessionEvent;
		expect(projectRuntimeProgress(appended)).toEqual([]);
		expect(projectRuntimeProgress({ type: "session_info_changed", name: "x".repeat(2_000) })).toEqual([
			expect.objectContaining({ type: "status", status: "正在处理" }),
		]);
	});

	it("projects tool details into diff facts without recomputing files", () => {
		const start = projectRuntimeProgress({
			type: "tool_execution_start",
			toolCallId: "edit-1",
			toolName: "edit",
			args: { path: "src/app.ts" },
		} as AgentSessionEvent);
		const end = projectRuntimeProgress({
			type: "tool_execution_end",
			toolCallId: "edit-1",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "done" }],
				details: { diff: "--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new", additions: 1, deletions: 1 },
			},
			isError: false,
		} as AgentSessionEvent);
		expect(start).toEqual([
			{
				type: "tool_start",
				toolCallId: "edit-1",
				name: "edit",
				summary: "src/app.ts",
				diff: { files: [{ path: "src/app.ts" }] },
			},
		]);
		expect(end[0]).toMatchObject({
			type: "tool_end",
			summary: "done",
			diff: { files: [{ additions: 1, deletions: 1, diff: expect.stringContaining("+new") }] },
		});

		const projected = projectTranscriptItem({
			entryId: "result",
			parentId: null,
			timestamp: "",
			kind: "message",
			payload: {
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "edit-1",
					toolName: "edit",
					content: [{ type: "text", text: "done" }],
					details: { diff: "--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new", additions: 1, deletions: 1 },
				},
			},
		});
		expect(projected).toMatchObject({
			type: "tool_result",
			diff: { files: [{ additions: 1, deletions: 1, diff: expect.stringContaining("+new") }] },
		});
	});

	it("projects streamed tool-call arguments into live diff progress", () => {
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "write-stream-1",
					name: "write",
					arguments: { path: "src/app.ts", content: "one\ntwo\n" },
				},
			],
		};
		const progress = projectRuntimeProgress({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "two",
				partial: message,
			},
		} as unknown as AgentSessionEvent);

		expect(progress).toEqual([
			{
				type: "tool_update",
				toolCallId: "write-stream-1",
				name: "write",
				summary: "src/app.ts",
			},
		]);

		const editMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "edit-stream-1",
					name: "edit",
					arguments: { path: "src/app.ts", edits: [{ oldText: "old\n", newText: "new\nline\n" }] },
				},
			],
		};
		const editProgress = projectRuntimeProgress({
			type: "message_update",
			message: editMessage,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "line",
				partial: editMessage,
			},
		} as unknown as AgentSessionEvent);

		expect(editProgress).toEqual([
			{
				type: "tool_update",
				toolCallId: "edit-stream-1",
				name: "edit",
				summary: "src/app.ts",
			},
		]);
	});

	it("hides internal Skill expansion from user transcript text", () => {
		const projected = projectTranscriptItem({
			entryId: "user-skill",
			parentId: null,
			timestamp: "",
			kind: "message",
			payload: {
				type: "message",
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: '<skill_references>\n  <skill_reference name="demo" location="/tmp/demo/SKILL.md">\n    demo\n  </skill_reference>\n</skill_references>\n\n请按 $[demo] 处理这个任务',
						},
					],
				},
			},
		});
		expect(projected).toEqual({ type: "user", text: "请按 $[demo] 处理这个任务" });
	});

	it("projects an expanded explicit Skill block without exposing its body", () => {
		expect(
			projectTranscriptItem({
				entryId: "user-explicit-skill",
				parentId: null,
				timestamp: "",
				kind: "message",
				payload: {
					type: "message",
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: '<skill name="demo" location="/tmp/demo/SKILL.md">\n内部 Skill 正文\n</skill>\n\n',
							},
						],
					},
				},
			}),
		).toEqual({ type: "user", text: "" });
	});

	it("projects persisted Shell results with terminal facts", () => {
		expect(
			projectTranscriptItem({
				entryId: "bash",
				parentId: null,
				timestamp: "",
				kind: "message",
				payload: {
					type: "message",
					message: {
						role: "bashExecution",
						command: "exit 7",
						output: "partial",
						exitCode: 7,
						cancelled: false,
						truncated: true,
					},
				},
			}),
		).toEqual({ type: "bash", text: "$ exit 7\npartial\n退出码 7\n输出已截断" });
	});

	it("projects structured compaction lifecycle progress", () => {
		expect(projectRuntimeProgress({ type: "compaction_start", reason: "manual" })).toEqual([
			{ type: "phase", phase: "compaction" },
			{ type: "compaction", status: "running", reason: "manual" },
		]);
		expect(
			projectRuntimeProgress({
				type: "compaction_end",
				reason: "threshold",
				result: undefined,
				aborted: false,
				willRetry: true,
				errorMessage: "temporary",
			}),
		).toEqual([
			{
				type: "compaction",
				status: "waiting_retry",
				reason: "threshold",
				error: "temporary",
			},
		]);
		expect(
			projectRuntimeProgress({
				type: "compaction_end",
				reason: "overflow",
				result: undefined,
				aborted: true,
				willRetry: false,
			}),
		).toEqual([{ type: "compaction", status: "cancelled", reason: "overflow" }]);
		expect(
			projectRuntimeProgress({
				type: "compaction_end",
				reason: "manual",
				result: {} as never,
				aborted: false,
				willRetry: false,
			}),
		).toEqual([{ type: "compaction", status: "completed", reason: "manual" }]);
	});

	it("projects model and summarization retry lifecycle progress", () => {
		expect(
			projectRuntimeProgress({
				type: "auto_retry_start",
				attempt: 2,
				maxAttempts: 3,
				delayMs: 1500,
				errorMessage: "temporary",
			}),
		).toEqual([
			{ type: "phase", phase: "retry" },
			{
				type: "retry",
				status: "waiting",
				kind: "model",
				attempt: 2,
				maxAttempts: 3,
				delayMs: 1500,
				error: "temporary",
			},
		]);
		expect(
			projectRuntimeProgress({ type: "auto_retry_end", success: false, attempt: 3, finalError: "failed" }),
		).toEqual([{ type: "retry", status: "failed", kind: "model", attempt: 3, error: "failed" }]);
		expect(
			projectRuntimeProgress({
				type: "summarization_retry_scheduled",
				attempt: 1,
				maxAttempts: 2,
				delayMs: 500,
				errorMessage: "summary failed",
			}),
		).toEqual([
			{ type: "phase", phase: "retry" },
			{
				type: "retry",
				status: "waiting",
				kind: "summarization",
				attempt: 1,
				maxAttempts: 2,
				delayMs: 500,
				error: "summary failed",
			},
		]);
		expect(
			projectRuntimeProgress({
				type: "summarization_retry_attempt_start",
				source: "compaction",
				reason: "overflow",
			}),
		).toEqual([
			{ type: "phase", phase: "compaction" },
			{ type: "compaction", status: "running", reason: "overflow" },
			{ type: "retry", status: "running", kind: "compaction" },
		]);
		expect(projectRuntimeProgress({ type: "summarization_retry_attempt_start", source: "branchSummary" })).toEqual([
			{ type: "retry", status: "running", kind: "branch_summary" },
		]);
		expect(projectRuntimeProgress({ type: "summarization_retry_finished" })).toEqual([
			{ type: "retry", status: "completed", kind: "summarization" },
		]);
	});

	it("projects image generation stages without placing image bytes in progress summaries", () => {
		const start = {
			type: "tool_execution_start",
			toolCallId: "image-1",
			toolName: "image_gen",
			args: { prompt: "a red circle", model: "auto", profile: "standard" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>;
		const update = {
			type: "tool_execution_update",
			toolCallId: "image-1",
			toolName: "image_gen",
			args: start.args,
			partialResult: { content: [{ type: "text", text: "正在使用 gpt-image-2.5-flare 生成图片" }] },
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>;
		const end = {
			type: "tool_execution_end",
			toolCallId: "image-1",
			toolName: "image_gen",
			result: {
				content: [
					{ type: "text", text: "Generated image saved to /tmp/image.png." },
					{ type: "image", data: "A".repeat(100_000), mimeType: "image/png" },
				],
			},
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

		expect(projectRuntimeProgress(start)).toEqual([
			{
				type: "tool_start",
				toolCallId: "image-1",
				name: "image_gen",
				summary: '{"prompt":"a red circle","model":"auto","profile":"standard"}',
			},
		]);
		expect(projectRuntimeProgress(update)).toEqual([
			{
				type: "tool_update",
				toolCallId: "image-1",
				name: "image_gen",
				summary: "正在使用 gpt-image-2.5-flare 生成图片",
			},
		]);
		expect(projectRuntimeProgress(end)).toEqual([
			{
				type: "tool_end",
				toolCallId: "image-1",
				name: "image_gen",
				status: "success",
				summary: "Generated image saved to /tmp/image.png.",
			},
		]);
	});

	it("projects bash commands and output snapshots without JSON summaries", () => {
		const start: Extract<AgentSessionEvent, { type: "tool_execution_start" }> = {
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "printf ready" },
		};
		const update: Extract<AgentSessionEvent, { type: "tool_execution_update" }> = {
			type: "tool_execution_update",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "printf ready" },
			partialResult: { content: [{ type: "text", text: "first\nsecond" }] },
		};
		const end: Extract<AgentSessionEvent, { type: "tool_execution_end" }> = {
			type: "tool_execution_end",
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "first\nsecond" }] },
			isError: false,
		};

		expect(projectRuntimeProgress(start)).toEqual([
			{ type: "tool_start", toolCallId: "bash-1", name: "bash", summary: "printf ready" },
		]);
		expect(projectRuntimeProgress(update)).toEqual([
			{ type: "tool_update", toolCallId: "bash-1", name: "bash", summary: "first\nsecond" },
		]);
		expect(projectRuntimeProgress(end)).toEqual([
			{ type: "tool_end", toolCallId: "bash-1", name: "bash", status: "success", summary: "first\nsecond" },
		]);
		expect(
			projectRuntimeProgress({
				...update,
				partialResult: {
					content: [{ type: "text", text: "tail" }],
					details: { truncation: { truncated: true } },
				},
			}),
		).toEqual([{ type: "tool_update", toolCallId: "bash-1", name: "bash", summary: "tail\n输出已截断" }]);

		const bounded = projectRuntimeProgress({
			...update,
			partialResult: {
				content: [{ type: "text", text: `${"x".repeat(16 * 1024)}😀` }],
				details: { truncation: { truncated: true } },
			},
		});
		expect(bounded).toHaveLength(1);
		const summary = bounded[0]?.type === "tool_update" ? bounded[0].summary : "";
		expect(summary.length).toBeLessThanOrEqual(16 * 1024);
		expect(summary.endsWith("输出已截断")).toBe(true);
		const firstCodeUnit = summary.charCodeAt(0);
		expect(firstCodeUnit < 0xdc00 || firstCodeUnit > 0xdfff).toBe(true);
	});

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("distinguishes inherited and direct project trust decisions", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-trust-"));
		const agentDir = join(tempDir, "agent");
		const parent = join(tempDir, "projects");
		const cwd = join(parent, "project");
		for (const dir of [agentDir, cwd]) mkdirSync(dir, { recursive: true });
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));

		await adapter.setProjectTrust(parent, true);
		expect(adapter.getProjectTrust(cwd).trusted).toBe(true);
		expect(adapter.getProjectTrustDecision(cwd)).toBeNull();
		await adapter.setProjectTrust(cwd, false);
		expect(adapter.getProjectTrustDecision(cwd)).toBe(false);
		await adapter.setProjectTrust(cwd, null);
		expect(adapter.getProjectTrust(cwd).trusted).toBe(true);
		expect(adapter.getProjectTrustDecision(cwd)).toBeNull();
	});

	it("lists and writes the same catalog descriptors used by the selector", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-settings-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		mkdirSync(join(agentDir, "themes"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const paperTheme = JSON.parse(
			readFileSync(join(import.meta.dirname, "../../coding-agent/src/modes/interactive/theme/dark.json"), "utf8"),
		) as Record<string, unknown>;
		writeFileSync(join(agentDir, "themes", "paper.json"), JSON.stringify({ ...paperTheme, name: "paper" }));
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		expect(existsSync(runtime.sessionPath)).toBe(true);
		cleanups.push(async () => {
			await runtime.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});

		const settings = runtime.listSettings();
		expect(settings.map((setting) => setting.id)).toEqual(getLystarSettingsForUi().map((setting) => setting.id));
		expect(settings.find((setting) => setting.id === "theme")).toMatchObject({
			kind: "string",
			options: ["dark", "light", "paper"],
			optionLabels: ["dark", "light", "paper"],
		});
		expect(settings.find((setting) => setting.id === "steering-mode")).toMatchObject({
			options: ["one-at-a-time", "all"],
			optionLabels: ["逐条处理", "全部处理"],
		});
		expect(runtime.getSessionInfo()).toMatchObject({
			name: null,
			sessionFile: runtime.sessionPath,
			messages: { total: 0, user: 0, agent: 0, toolCalls: 0, toolResults: 0 },
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			usageBreakdown: [],
		});
		expect(() => assertWorkspaceCommandResult("get_session_info", runtime.getSessionInfo())).not.toThrow();
		const result = await runtime.setSetting("http-idle-timeout", 0);
		expect(result.setting).toMatchObject({ id: "http-idle-timeout", value: 0 });
		expect(getLystarSetting("http-idle-timeout")?.get(SettingsManager.create(cwd, agentDir))).toBe(0);
		const changelog = adapter.getChangelog(runtime.sessionPath, 80, cwd);
		expect(changelog.lines.length).toBeGreaterThan(10_000);
		expect(
			changelog.lines
				.at(-1)
				?.replaceAll(/\x1b\[[0-9;:]*m/g, "")
				.trim(),
		).toContain("HTML export");
		expect(changelog.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(() => assertWorkspaceCommandResult("get_changelog", changelog)).not.toThrow();
	});

	it("does not duplicate identical collaboration result delivery", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-collaboration-result-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		let disposed = false;
		cleanups.push(async () => {
			if (!disposed) await runtime.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});
		const result = {
			taskId: "task-idempotent",
			outcome: "completed" as const,
			resultText: "已完成",
			completedAt: "2026-09-21T00:00:00.000Z",
		};

		await runtime.recordCollaborationResult?.(result);
		await runtime.recordCollaborationResult?.(result);
		await runtime.dispose();
		disposed = true;
		const manager = SessionManager.open(runtime.sessionPath);
		expect(
			manager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "lystar.collaboration.result"),
		).toHaveLength(1);
	});

	it("persists, exports, and restores bash when it is the first transcript entry", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-bash-"));
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
		await runtime.runBash("printf native-ok", false, () => {});

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
		expect(listed[0].messageCount).toBe(1);
		expect(listed[0].activity).toBe("completed");
		const htmlPath = join(tempDir, "session export.html");
		expect(await runtime.exportSession("../session export.html")).toEqual({ path: htmlPath });
		expect(readFileSync(htmlPath, "utf8")).toContain("<!DOCTYPE html>");
		const jsonlPath = join(tempDir, "session export.jsonl");
		expect(await runtime.exportSession("../session export.jsonl")).toEqual({ path: jsonlPath });
		expect(readFileSync(jsonlPath, "utf8")).toContain('"role":"bashExecution"');
		expect(await runtime.importSession("../session export.jsonl")).toEqual({ cancelled: false });
		const importedSessionPath = runtime.sessionPath;
		expect(importedSessionPath).not.toBe(sessionPath);
		expect(runtime.getSnapshot("owned")).toMatchObject({ cwd, transcriptRevision: expect.any(Number) });
		expect(adapter.isSessionWriterLocked(sessionPath)).toBe(false);
		expect(adapter.isSessionWriterLocked(importedSessionPath)).toBe(true);

		await runtime.dispose();
		expect(adapter.isSessionWriterLocked(importedSessionPath)).toBe(false);
		runtime = await adapter.openSession(importedSessionPath, async () => ({ cancelled: true }));
		expect(runtime.getSnapshot("owned").transcriptRevision).toBeGreaterThan(0);
	});

	it("routes excluded Shell through the Extension hook and records its full result", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-extension-bash-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		for (const dir of [agentDir, cwd]) mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProjectTrust: "always",
				extensions: [fileURLToPath(new URL("./fixtures/runtime-contract-extension.ts", import.meta.url))],
			}),
		);

		let runtime: RuntimeSession | undefined;
		cleanups.push(async () => {
			await runtime?.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});
		runtime = await new CodingAgentRuntimeAdapter(agentDir).createSession(cwd, async () => ({ cancelled: true }));
		const chunks: string[] = [];
		expect(await runtime.runBash("extension-bash", true, (chunk) => chunks.push(chunk))).toMatchObject({
			output: "extension:true",
			exitCode: 0,
			cancelled: false,
		});
		expect(chunks).toEqual(["extension:true"]);
		const persisted = readFileSync(runtime.sessionPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { message?: Record<string, unknown> });
		expect(persisted.find((entry) => entry.message?.role === "bashExecution")?.message).toMatchObject({
			command: "extension-bash",
			output: "extension:true",
			excludeFromContext: true,
		});
	});

	it("generates and persists a title for the first Web Runtime prompt", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-session-name-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		const faux = registerFauxProvider();
		let responseCount = 0;
		faux.setResponses([
			() => fauxAssistantMessage(responseCount++ === 0 ? "自动标题" : "主回复"),
			() => fauxAssistantMessage(responseCount++ === 0 ? "自动标题" : "主回复"),
		]);
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

		let runtime: RuntimeSession | undefined;
		cleanups.push(async () => {
			await runtime?.dispose();
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		});
		runtime = await new CodingAgentRuntimeAdapter(agentDir).createSession(cwd, async () => ({ cancelled: true }));
		const events: RuntimeEvent[] = [];
		runtime.onEvent((event) => events.push(event));

		await runtime.prompt("请修复 Web 会话自动命名");
		const deadline = Date.now() + 3_000;
		while (runtime.getSnapshot("owned").name !== "自动标题" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		expect(runtime.getSnapshot("owned")).toMatchObject({ name: "自动标题" });
		expect(
			events.some(
				(event) => event.type === "state_changed" && (event.payload as { name?: string }).name === "自动标题",
			),
		).toBe(true);
		const entries = readFileSync(runtime.sessionPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type?: string; name?: string });
		expect(entries).toContainEqual(expect.objectContaining({ type: "session_info", name: "自动标题" }));
		expect((await new CodingAgentRuntimeAdapter(agentDir).listSessions(cwd))[0]).toMatchObject({ name: "自动标题" });
	});

	it("queues ordinary input behind an active Room turn without sharing its turn context", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-room-turn-queue-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		const faux = registerFauxProvider();
		let releaseRoom!: () => void;
		let signalRoomStarted!: () => void;
		let userResponseStarted = false;
		const roomResponseStarted = new Promise<void>((resolve) => {
			signalRoomStarted = resolve;
		});
		const roomResponseGate = new Promise<void>((resolve) => {
			releaseRoom = resolve;
		});
		faux.setResponses([
			async () => {
				signalRoomStarted();
				await roomResponseGate;
				return fauxAssistantMessage("Room 已完成");
			},
			fauxAssistantMessage("普通输入标题"),
			async () => {
				userResponseStarted = true;
				return fauxAssistantMessage("普通输入已完成");
			},
		]);
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

		let runtime: RuntimeSession | undefined;
		cleanups.push(async () => {
			releaseRoom();
			await runtime?.dispose();
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		});
		runtime = await new CodingAgentRuntimeAdapter(agentDir).createSession(cwd, async () => ({ cancelled: true }));

		const roomPrompt = runtime.promptWithOrigin!("Room 输入", undefined, {
			inputId: "room-message-1",
			origin: {
				type: "room",
				roomId: "room-1",
				messageId: "room-message-1",
				seq: 1,
				kind: "task",
				senderSessionId: "sender",
			},
			activeToolNames: [],
			capabilities: { allowedTools: [], readRoots: [], writeRoots: [], shell: "disabled" },
		});
		await roomResponseStarted;
		const userPrompt = runtime.promptWithOrigin!("普通输入", undefined, {
			inputId: "user-message-1",
			origin: { type: "user", channel: "rpc" },
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(userResponseStarted).toBe(false);

		releaseRoom();
		const [roomTurn, userTurn] = await Promise.all([roomPrompt, userPrompt]);
		expect(roomTurn?.rootOrigin).toBe("room");
		expect(userTurn?.rootOrigin).toBe("user");
		expect(userTurn?.turnId).not.toBe(roomTurn?.turnId);
		expect(userResponseStarted).toBe(true);
		expect(runtime.getSessionInfo().messages.total).toBeGreaterThanOrEqual(5);
	});

	it("refreshes an existing session ModelRuntime after Web adds a provider model", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-model-refresh-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		const faux = registerFauxProvider({ provider: "initial-web-provider" });
		const initialModel = faux.getModel();
		for (const dir of [agentDir, cwd]) mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[initialModel.provider]: {
						baseUrl: initialModel.baseUrl,
						apiKey: "initial-key",
						api: faux.api,
						models: [
							{
								id: initialModel.id,
								name: initialModel.name,
								reasoning: initialModel.reasoning,
								input: initialModel.input,
								cost: initialModel.cost,
								contextWindow: initialModel.contextWindow,
								maxTokens: initialModel.maxTokens,
							},
						],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: initialModel.provider,
				defaultModel: initialModel.id,
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

		const provider = "new-web-provider";
		const baseUrl = "https://new-web-provider.example/v1";
		await adapter.addModelProvider({ provider, name: "新 Provider", baseUrl, api: faux.api, apiKey: "new-key" });
		await adapter.addProviderModel({
			provider,
			id: "new-model",
			name: "New Model",
			api: faux.api,
			baseUrl,
			reasoning: false,
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 16_384,
		});

		await runtime.setModel({ provider, id: "new-model" });
		expect(runtime.getSnapshot("owned").model).toEqual({ provider, id: "new-model" });
	});

	it("runs the real Core runtime, persists JSONL, and resumes with continuous transcript revisions", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-runtime-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		const faux = registerFauxProvider();
		faux.setResponses([
			(context) =>
				fauxAssistantMessage(JSON.stringify(context.messages).includes("会话命名助手") ? "自动标题" : "first"),
			(context) =>
				fauxAssistantMessage(JSON.stringify(context.messages).includes("会话命名助手") ? "自动标题" : "second"),
			(context) =>
				fauxAssistantMessage(JSON.stringify(context.messages).includes("会话命名助手") ? "自动标题" : "forked"),
		]);
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
		expect(
			firstCommitted.flatMap((event) => event.items.map((item) => item.payload.message?.role)).filter(Boolean),
		).toEqual(["system", "user", "assistant"]);
		expect(firstCommitted[0]?.fromRevision).toBe(0);
		expect(
			firstCommitted.every(
				(event, index) => index === 0 || event.fromRevision === firstCommitted[index - 1]?.transcriptRevision,
			),
		).toBe(true);
		const firstRevision = firstCommitted.at(-1)!.transcriptRevision;
		const firstGeneration = firstCommitted[0]!.transcriptGeneration;
		const persistedRoles = readFileSync(sessionPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { message?: { role?: string } })
			.flatMap((entry) => (entry.message?.role ? [entry.message.role] : []));
		expect(persistedRoles).toEqual(["system", "user", "assistant"]);

		await runtime.dispose();
		runtime = await adapter.openSession(sessionPath, async () => ({ cancelled: true }));
		const resumedEvents: RuntimeEvent[] = [];
		runtime.onEvent((event) => resumedEvents.push(event));
		expect(runtime.getSnapshot("owned").model).toEqual({ provider: model.provider, id: model.id });
		await runtime.prompt("again");

		const resumedCommitted = resumedEvents.filter((event) => event.type === "entry_committed").map(eventPayload);
		expect(
			resumedCommitted.flatMap((event) => event.items.map((item) => item.payload.message?.role)).filter(Boolean),
		).toEqual(["user", "assistant"]);
		expect(resumedCommitted[0].transcriptGeneration).toBe(firstGeneration);
		expect(resumedCommitted[0].fromRevision).toBe(firstRevision);
		expect(
			resumedCommitted.every(
				(event, index) => index === 0 || event.fromRevision === resumedCommitted[index - 1]?.transcriptRevision,
			),
		).toBe(true);
		expect(resumedCommitted.at(-1)!.transcriptRevision).toBeGreaterThan(firstRevision);

		await runtime.rename("Web 控制契约");
		await runtime.setModel({ provider: model.provider, id: model.id });
		const modelSummary = (await adapter.listModels()).find(
			(candidate) => candidate.provider === model.provider && candidate.id === model.id,
		);
		const thinkingLevel = modelSummary?.supportedThinkingLevels.at(-1);
		if (!thinkingLevel) throw new Error("Model has no supported thinking level");
		await runtime.setThinkingLevel(thinkingLevel);
		expect(runtime.getSnapshot("owned")).toMatchObject({
			name: "Web 控制契约",
			model: { provider: model.provider, id: model.id },
			thinkingLevel,
		});

		const firstUserEntryId = firstCommitted
			.flatMap((event) => event.items)
			.find((item) => item.payload.message?.role === "user")?.entryId;
		if (!firstUserEntryId) throw new Error("Missing user entry for fork");
		expect(runtime.listForkMessages()).toEqual([
			{ entryId: firstUserEntryId, text: "hello" },
			expect.objectContaining({ text: "again" }),
		]);
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
				sessionId: "web-session",
				turnId: "0",
				toolCallId: "web-call",
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

	it("keeps a task active through a retryable error and separates the final answer", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-step-retry-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				{ type: "toolCall", id: "start-recovered", name: "step_start", arguments: { title: "错误后继续" } },
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage(
				{ type: "toolCall", id: "read-after-error", name: "read", arguments: { path: "README.md" } },
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("检查完成"),
			fauxAssistantMessage(
				{ type: "toolCall", id: "start-failed", name: "step_start", arguments: { title: "最终失败" } },
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
		]);
		const model = faux.getModel();
		for (const dir of [agentDir, cwd]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(cwd, "README.md"), "测试读取\n");
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
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
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
		await runtime.rename("任务步骤回归");

		await expect(runtime.prompt("错误后继续处理")).resolves.toBeUndefined();
		const firstEntries = readFileSync(runtime.sessionPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as SessionEntry);
		const recoveredStep = firstEntries
			.map(agentStepFromEntry)
			.filter((step) => step?.title === "错误后继续")
			.at(-1);
		const finalEntry = [...firstEntries]
			.reverse()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some((part) => part.type === "text" && part.text.includes("检查完成")),
			);
		if (!recoveredStep) throw new Error("Missing recovered task step");
		if (!finalEntry || finalEntry.type !== "message") throw new Error("Missing final assistant message");
		expect(recoveredStep).toMatchObject({ status: "completed", toolCallIds: ["read-after-error"] });
		expect(recoveredStep.messageEntryIds).not.toContain(finalEntry.id);

		await expect(runtime.prompt("最终失败的处理")).rejects.toThrow("invalid_api_key");
		const failedEntries = readFileSync(runtime.sessionPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as SessionEntry);
		const failedStep = failedEntries
			.map(agentStepFromEntry)
			.filter((step) => step?.title === "最终失败")
			.at(-1);
		expect(failedStep).toMatchObject({ status: "failed" });
	});

	it("atomically manages project instructions and validates project resources", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-project-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		const outside = join(tempDir, "outside.txt");
		mkdirSync(join(cwd, "src"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, "src", "app.ts"), "const first = 1;\nconst second = 2;\n");
		writeFileSync(join(cwd, "report.xlsx"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
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
		expect(resource.contentVersion).toEqual(expect.any(String));
		const chunk = adapter.readProjectResource(cwd, resource.path, 0, 1024);
		const originalContent = Buffer.from(chunk.data, "base64").toString("utf8");
		expect(originalContent).toContain("const second = 2");
		const savedFile = adapter.saveProjectFile(
			cwd,
			"src/app.ts",
			"const first = 1;\nconst second = 3;\n",
			createHash("sha256").update(originalContent).digest("hex"),
		);
		expect(savedFile).toMatchObject({
			path: "src/app.ts",
			mimeType: "text/plain; charset=utf-8",
			contentHash: createHash("sha256").update("const first = 1;\nconst second = 3;\n").digest("hex"),
		});
		expect(readFileSync(join(cwd, "src", "app.ts"), "utf8")).toContain("const second = 3");
		writeFileSync(join(cwd, "src", "app.ts"), "external change\n");
		expect(() => adapter.saveProjectFile(cwd, "src/app.ts", "stale write\n", savedFile.contentHash)).toThrow(
			"外部修改",
		);
		expect(() =>
			adapter.saveProjectFile(
				cwd,
				"src/app.ts",
				"x".repeat(2 * 1024 * 1024 + 1),
				createHash("sha256").update("external change\n").digest("hex"),
			),
		).toThrow("2 MiB");
		const officeResource = adapter.resolveProjectResource(cwd, "report.xlsx");
		expect(officeResource).toMatchObject({
			kind: "binary",
			mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});
		expect(Buffer.from(adapter.readProjectResource(cwd, officeResource.path, 0, 1024).data, "base64")).toEqual(
			Buffer.from([0x50, 0x4b, 0x03, 0x04]),
		);
		expect(() =>
			adapter.saveProjectFile(
				cwd,
				"report.xlsx",
				"not binary",
				createHash("sha256")
					.update(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
					.digest("hex"),
			),
		).toThrow("文本文件");
		expect(adapter.completeProjectFiles(cwd, "src/app", 10)).toEqual([
			expect.objectContaining({ value: "@src/app.ts ", label: "app.ts", description: "src", kind: "file" }),
		]);
		expect(() => adapter.resolveProjectResource(cwd, outside)).toThrow("项目范围");
	});

	it("manages Host instructions, directory browsing, and one-time external resource grants", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-scoped-settings-"));
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
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-git-"));
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
		expect(worktreeDiff.original).toBe("base\n");
		expect(worktreeDiff.modified).toBe("base\nworktree\n");
		const stagedDiff = await adapter.getGitDiff(tempDir, "staged.txt", true);
		expect(stagedDiff).toMatchObject({ path: "staged.txt", staged: true, additions: 1, deletions: 0 });
		expect(stagedDiff.diff).toContain("+staged");
		expect(stagedDiff.original).toBe("");
		expect(stagedDiff.modified).toBe("staged\n");
		const stats = await adapter.getGitStats(tempDir);
		expect(stats.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "tracked.txt", staged: false, additions: 1, deletions: 0 }),
				expect.objectContaining({ path: "staged.txt", staged: true, additions: 1, deletions: 0 }),
				expect.objectContaining({ path: "renamed.txt", originalPath: "rename-me.txt", staged: true }),
			]),
		);
		const branches = await adapter.getGitBranches(tempDir);
		expect(branches).toMatchObject({ current: "main", detached: false, merging: false, remotes: [] });
		expect(branches.branches).toEqual([
			expect.objectContaining({ name: "main", current: true, remote: false, ahead: 0, behind: 0 }),
		]);
		const history = await adapter.getGitHistory(tempDir, 0, 1);
		expect(history).toMatchObject({ offset: 0, hasMore: false });
		expect(history.commits).toHaveLength(1);
		const commit = await adapter.getGitCommit(tempDir, history.commits[0].hash, undefined, "tracked.txt");
		expect(commit).toMatchObject({ subject: "base", authorName: "LYStar Test" });
		expect(commit.files).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "tracked.txt", additions: 1 })]),
		);
		expect(commit.diff).toMatchObject({
			path: "tracked.txt",
			revision: history.commits[0].hash,
			original: "",
			modified: "base\n",
		});
		expect(await adapter.getGitStatus(tempDir)).toEqual(before);
	});

	it("runs bounded Git mutations, remote sync, history pagination, and conflict recovery", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-git-mutations-"));
		const repositoryDir = join(tempDir, "repository");
		const remoteDir = join(tempDir, "remote.git");
		const updaterDir = join(tempDir, "updater");
		const runGit = (cwd: string, ...args: string[]) =>
			execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
		mkdirSync(repositoryDir, { recursive: true });
		runGit(tempDir, "init", "--bare", "--initial-branch=main", remoteDir);
		runGit(repositoryDir, "init", "--initial-branch=main");
		runGit(repositoryDir, "config", "user.name", "LYStar Test");
		runGit(repositoryDir, "config", "user.email", "lystar@example.invalid");
		writeFileSync(join(repositoryDir, "tracked.txt"), "base\n");
		runGit(repositoryDir, "add", "tracked.txt");
		runGit(repositoryDir, "commit", "-m", "base");
		runGit(repositoryDir, "remote", "add", "origin", remoteDir);
		runGit(repositoryDir, "push", "-u", "origin", "main");

		const adapter = new CodingAgentRuntimeAdapter(join(tempDir, "agent"));
		writeFileSync(join(repositoryDir, "tracked.txt"), "base\nlocal\n");
		await adapter.mutateGit(repositoryDir, undefined, { type: "stage", paths: ["tracked.txt"] });
		expect((await adapter.getGitStatus(repositoryDir)).files[0]).toMatchObject({ staged: true, unstaged: false });
		await adapter.mutateGit(repositoryDir, undefined, { type: "unstage", paths: ["tracked.txt"] });
		expect((await adapter.getGitStatus(repositoryDir)).files[0]).toMatchObject({ staged: false, unstaged: true });
		await adapter.mutateGit(repositoryDir, undefined, { type: "stage", paths: ["tracked.txt"] });
		await adapter.mutateGit(repositoryDir, undefined, { type: "commit", message: "local change" });
		await adapter.mutateGit(repositoryDir, undefined, { type: "push" });
		expect(runGit(remoteDir, "rev-parse", "main").trim()).toBe(runGit(repositoryDir, "rev-parse", "HEAD").trim());

		runGit(tempDir, "clone", remoteDir, updaterDir);
		runGit(updaterDir, "config", "user.name", "Remote Test");
		runGit(updaterDir, "config", "user.email", "remote@example.invalid");
		writeFileSync(join(updaterDir, "remote.txt"), "remote\n");
		runGit(updaterDir, "add", "remote.txt");
		runGit(updaterDir, "commit", "-m", "remote change");
		runGit(updaterDir, "push");
		await adapter.mutateGit(repositoryDir, undefined, { type: "fetch" });
		expect(await adapter.getGitStatus(repositoryDir)).toMatchObject({ ahead: 0, behind: 1 });
		await adapter.mutateGit(repositoryDir, undefined, { type: "pull" });
		expect(readFileSync(join(repositoryDir, "remote.txt"), "utf8")).toBe("remote\n");

		await adapter.mutateGit(repositoryDir, undefined, { type: "create_branch", name: "conflict" });
		writeFileSync(join(repositoryDir, "tracked.txt"), "feature\n");
		await adapter.mutateGit(repositoryDir, undefined, { type: "stage", paths: ["tracked.txt"] });
		await adapter.mutateGit(repositoryDir, undefined, { type: "commit", message: "feature conflict" });
		await adapter.mutateGit(repositoryDir, undefined, { type: "switch_branch", name: "main" });
		writeFileSync(join(repositoryDir, "tracked.txt"), "main\n");
		await adapter.mutateGit(repositoryDir, undefined, { type: "stage", paths: ["tracked.txt"] });
		await adapter.mutateGit(repositoryDir, undefined, { type: "commit", message: "main conflict" });
		await expect(
			adapter.mutateGit(repositoryDir, undefined, { type: "merge", source: "conflict" }),
		).rejects.toMatchObject({
			code: "git_merge_conflict",
		});
		const conflicted = await adapter.getGitStatus(repositoryDir);
		expect(conflicted.merging).toBe(true);
		expect(conflicted.files).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "tracked.txt", conflicted: true })]),
		);
		await adapter.mutateGit(repositoryDir, undefined, { type: "abort_merge" });
		const afterAbort = await adapter.getGitStatus(repositoryDir);
		expect(afterAbort.branch).toBe("main");
		expect(afterAbort.merging).not.toBe(true);
		await expect(
			adapter.mutateGit(repositoryDir, undefined, { type: "delete_branch", name: "conflict" }),
		).rejects.toThrow();

		await adapter.mutateGit(repositoryDir, undefined, { type: "create_branch", name: "merged" });
		writeFileSync(join(repositoryDir, "merged.txt"), "merged\n");
		await adapter.mutateGit(repositoryDir, undefined, { type: "stage", paths: ["merged.txt"] });
		await adapter.mutateGit(repositoryDir, undefined, { type: "commit", message: "merged branch" });
		await adapter.mutateGit(repositoryDir, undefined, { type: "switch_branch", name: "main" });
		await adapter.mutateGit(repositoryDir, undefined, { type: "merge", source: "merged" });
		await adapter.mutateGit(repositoryDir, undefined, { type: "delete_branch", name: "merged" });
		expect((await adapter.getGitBranches(repositoryDir)).branches.some((branch) => branch.name === "merged")).toBe(
			false,
		);

		writeFileSync(join(repositoryDir, "tracked.txt"), "discarded\n");
		writeFileSync(join(repositoryDir, "untracked.txt"), "untracked\n");
		await adapter.mutateGit(repositoryDir, undefined, { type: "discard", paths: ["tracked.txt", "untracked.txt"] });
		expect(readFileSync(join(repositoryDir, "tracked.txt"), "utf8")).toBe("main\n");
		expect(existsSync(join(repositoryDir, "untracked.txt"))).toBe(false);

		const firstPage = await adapter.getGitHistory(repositoryDir, 0, 1);
		expect(firstPage).toMatchObject({ offset: 0, hasMore: true, nextOffset: 1 });
		expect(firstPage.commits).toHaveLength(1);
		const secondPage = await adapter.getGitHistory(repositoryDir, firstPage.nextOffset ?? 0, 1);
		expect(secondPage.commits).toHaveLength(1);
		await expect(
			adapter.mutateGit(repositoryDir, undefined, { type: "create_branch", name: "--invalid" }),
		).rejects.toMatchObject({ code: "git_branch_name_invalid" });
	});

	it("discovers nested repositories and reads their diffs", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-nested-git-"));
		const projectDir = join(tempDir, "project");
		const nestedDir = join(projectDir, "packages", "nested");
		const sourceDir = join(tempDir, "worktree-source");
		const worktreeDir = join(projectDir, "tools", "worktree");
		const runGit = (cwd: string, ...args: string[]) =>
			execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
		const initRepo = (cwd: string, branch: string) => {
			mkdirSync(cwd, { recursive: true });
			runGit(cwd, "init", "--initial-branch", branch);
			runGit(cwd, "config", "user.name", "LYStar Test");
			runGit(cwd, "config", "user.email", "lystar@example.invalid");
		};
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));

		initRepo(projectDir, "main");
		writeFileSync(join(projectDir, "root.txt"), "root\n");
		runGit(projectDir, "add", "root.txt");
		runGit(projectDir, "commit", "-m", "root");
		writeFileSync(join(projectDir, "root.txt"), "root\nchanged\n");

		initRepo(nestedDir, "develop");
		writeFileSync(join(nestedDir, "nested.txt"), "nested\n");
		runGit(nestedDir, "add", "nested.txt");
		runGit(nestedDir, "commit", "-m", "nested");
		writeFileSync(join(nestedDir, "nested.txt"), "nested\nchanged\n");
		writeFileSync(join(nestedDir, "staged.txt"), "staged\n");
		runGit(nestedDir, "add", "staged.txt");
		writeFileSync(join(nestedDir, "untracked.txt"), "untracked\n");

		initRepo(sourceDir, "main");
		writeFileSync(join(sourceDir, "worktree.txt"), "worktree\n");
		runGit(sourceDir, "add", "worktree.txt");
		runGit(sourceDir, "commit", "-m", "worktree");
		runGit(sourceDir, "worktree", "add", "-b", "feature", worktreeDir);
		writeFileSync(join(worktreeDir, "worktree.txt"), "worktree\nchanged\n");

		const adapter = new CodingAgentRuntimeAdapter(join(tempDir, "agent"));
		const status = await adapter.getGitStatus(projectDir);
		const repositories = status.repositories ?? [];
		expect(repositories).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "", kind: "root", branch: "main" }),
				expect.objectContaining({ path: "packages/nested", kind: "nested", branch: "develop" }),
				expect.objectContaining({ path: "tools/worktree", kind: "nested", branch: "feature" }),
			]),
		);
		const nested = repositories.find((repository) => repository.path === "packages/nested");
		expect(nested?.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "nested.txt", unstaged: true }),
				expect.objectContaining({ path: "staged.txt", staged: true }),
				expect.objectContaining({ path: "untracked.txt", untracked: true }),
			]),
		);

		const nestedDiff = await adapter.getGitDiff(projectDir, "nested.txt", false, "packages/nested");
		expect(nestedDiff).toMatchObject({ path: "nested.txt", repositoryPath: "packages/nested", additions: 1 });
		expect(nestedDiff.original).toBe("nested\n");
		expect(nestedDiff.modified).toBe("nested\nchanged\n");
		await expect(adapter.getGitDiff(projectDir, "nested.txt", false, "../outside")).rejects.toThrow(
			"Git 仓库不在当前项目范围内",
		);
	});

	it("discovers multiple independent repositories under a non-Git project directory", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-multi-git-"));
		const projectDir = join(tempDir, "workspace");
		const firstRepo = join(projectDir, "repo-a");
		const secondRepo = join(projectDir, "repo-b");
		const runGit = (cwd: string, ...args: string[]) =>
			execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
		const initRepo = (cwd: string, fileName: string, branch: string) => {
			mkdirSync(cwd, { recursive: true });
			runGit(cwd, "init", "--initial-branch", branch);
			runGit(cwd, "config", "user.name", "LYStar Test");
			runGit(cwd, "config", "user.email", "lystar@example.invalid");
			writeFileSync(join(cwd, fileName), "base\n");
			runGit(cwd, "add", fileName);
			runGit(cwd, "commit", "-m", "base");
			writeFileSync(join(cwd, fileName), "base\nchanged\n");
		};
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
		initRepo(firstRepo, "a.txt", "main");
		initRepo(secondRepo, "b.txt", "develop");

		const adapter = new CodingAgentRuntimeAdapter(join(tempDir, "agent"));
		const status = await adapter.getGitStatus(projectDir);
		const repositories = status.repositories ?? [];
		expect(repositories).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "repo-a", branch: "main" }),
				expect.objectContaining({ path: "repo-b", branch: "develop" }),
			]),
		);
		expect(repositories.some((repository) => repository.path === "")).toBe(false);
		const diff = await adapter.getGitDiff(projectDir, "a.txt", false, "repo-a");
		expect(diff).toMatchObject({ repositoryPath: "repo-a", path: "a.txt", additions: 1, deletions: 0 });
		await adapter.mutateGit(projectDir, "repo-a", { type: "stage", paths: ["a.txt"] });
		const updated = await adapter.getGitStatus(projectDir);
		const updatedRepositories = updated.repositories ?? [];
		expect(updatedRepositories.find((repository) => repository.path === "repo-a")?.files[0]).toMatchObject({
			staged: true,
			unstaged: false,
		});
		expect(updatedRepositories.find((repository) => repository.path === "repo-b")?.files[0]).toMatchObject({
			staged: false,
			unstaged: true,
		});
	});

	it("bridges dynamic Extension command completions", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-dynamic-extension-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		for (const dir of [agentDir, cwd]) mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProjectTrust: "always",
				extensions: [fileURLToPath(new URL("./fixtures/runtime-dynamic-extension.ts", import.meta.url))],
			}),
		);
		let runtime: RuntimeSession | undefined;
		cleanups.push(async () => {
			await runtime?.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});
		runtime = await new CodingAgentRuntimeAdapter(agentDir).createSession(cwd, async () => ({ cancelled: true }));

		const commandText = "/dynamic";
		const commandCompletion = await runtime.getCompletions(commandText, commandText.length);
		expect(commandCompletion?.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ label: "dynamic-contract", kind: "extension" })]),
		);
		const builtinCompletion = await runtime.getCompletions("/", 1);
		expect(builtinCompletion?.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ label: "model", kind: "command" })]),
		);
		const argumentText = "/dynamic-contract a";
		const argumentCompletion = await runtime.getCompletions(argumentText, argumentText.length);
		expect(argumentCompletion).toMatchObject({
			prefixStart: argumentText.length - 1,
			prefixEnd: argumentText.length,
			items: [expect.objectContaining({ value: "alpha", kind: "extension" })],
		});
	});

	it("reloads dynamic Extension commands", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-dynamic-edge-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		for (const dir of [agentDir, cwd]) mkdirSync(dir, { recursive: true });
		const previousVariant = process.env.LYSTAR_WEB_DYNAMIC_EDGE_VARIANT;
		process.env.LYSTAR_WEB_DYNAMIC_EDGE_VARIANT = "before";
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProjectTrust: "always",
				extensions: [fileURLToPath(new URL("./fixtures/runtime-dynamic-edge-extension.ts", import.meta.url))],
			}),
		);
		let runtime: RuntimeSession | undefined;
		cleanups.push(async () => {
			if (previousVariant === undefined) delete process.env.LYSTAR_WEB_DYNAMIC_EDGE_VARIANT;
			else process.env.LYSTAR_WEB_DYNAMIC_EDGE_VARIANT = previousVariant;
			await runtime?.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});
		runtime = await new CodingAgentRuntimeAdapter(agentDir).createSession(cwd, async () => ({ cancelled: true }));

		expect((await runtime.getCompletions("/edge", 5))?.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ label: "edge-before", kind: "extension" })]),
		);
		await runtime.prompt("/edge-before");

		process.env.LYSTAR_WEB_DYNAMIC_EDGE_VARIANT = "after";
		await runtime.reloadResources();
		expect((await runtime.getCompletions("/edge", 5))?.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ label: "edge-after", kind: "extension" })]),
		);
		expect((await runtime.getCompletions("/edge", 5))?.items).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ label: "edge-before", kind: "extension" })]),
		);
		await runtime.prompt("/edge-after");
	});

	it("isolates Room sessions from user AGENTS.md and retains profile and project context", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-room-context-"));
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		const profileDir = join(agentDir, "agents", "room-worker");
		const faux = registerFauxProvider();
		const capturedContexts: string[] = [];
		const captureResponse = (context: TranscriptContext) => {
			capturedContexts.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("done");
		};
		faux.setResponses(Array.from({ length: 24 }, () => captureResponse));
		const model = faux.getModel();
		for (const dir of [agentDir, cwd, profileDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(agentDir, "AGENTS.md"), "GLOBAL_AGENTS_MARKER");
		writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "GLOBAL_APPEND_MARKER");
		writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_AGENTS_MARKER");
		writeFileSync(join(profileDir, "profile.json"), JSON.stringify({ name: "Room Worker" }));
		writeFileSync(join(profileDir, "PROMPT.md"), "PROFILE_SYSTEM_MARKER");
		writeFileSync(join(profileDir, "AGENTS.md"), "PROFILE_AGENTS_MARKER");
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

		let runtime: RuntimeSession | undefined;
		cleanups.push(async () => {
			await runtime?.dispose();
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		});
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }), {
			profileId: "room-worker",
			roomAgent: true,
		});
		const roomSessionPath = runtime.sessionPath;
		await runtime.prompt("Room context check");
		await runtime.dispose();
		runtime = undefined;

		const roomContext = capturedContexts.find((context) => context.includes("PROJECT_AGENTS_MARKER"));
		expect(roomContext).toContain("PROFILE_SYSTEM_MARKER");
		expect(roomContext).toContain("PROFILE_AGENTS_MARKER");
		expect(roomContext).toContain("GLOBAL_APPEND_MARKER");
		expect(roomContext).toContain("expert coding assistant operating inside pi");
		expect(roomContext).not.toContain("GLOBAL_AGENTS_MARKER");

		capturedContexts.length = 0;
		runtime = await adapter.openSession(roomSessionPath, async () => ({ cancelled: true }));
		await runtime.prompt("Room context restore check");
		await runtime.dispose();
		runtime = undefined;
		const restoredRoomContext = capturedContexts.find((context) => context.includes("PROJECT_AGENTS_MARKER"));
		expect(restoredRoomContext).toContain("PROFILE_AGENTS_MARKER");
		expect(restoredRoomContext).not.toContain("GLOBAL_AGENTS_MARKER");

		capturedContexts.length = 0;
		runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }), { profileId: "room-worker" });
		await runtime.prompt("Regular context check");
		const regularContext = capturedContexts.find((context) => context.includes("PROJECT_AGENTS_MARKER"));
		expect(regularContext).toContain("GLOBAL_AGENTS_MARKER");
		expect(regularContext).toContain("PROFILE_AGENTS_MARKER");
	});

	it("routes API key login through a secret UI request and Core credential storage", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "web-runtime-auth-"));
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
			return { value: "sk-web-test" };
		});

		expect(requests).toMatchObject([
			{ kind: "secret", payload: { message: "Enter OpenAI API key", placeholder: "" } },
		]);
		expect(() => assertWorkspaceCommandResult("login_model_provider", loggedIn)).not.toThrow();
		expect(JSON.stringify(loggedIn)).not.toContain("sk-web-test");
		const automaticRouter = loggedIn.find(
			(model) => model.provider === "openrouter" && model.id === "openrouter/auto",
		);
		expect(automaticRouter?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(loggedIn.find((model) => model.provider === "openai")).toMatchObject({
			authenticated: true,
			authMethods: ["api_key"],
			authSource: "stored",
		});
		expect(existsSync(join(tempDir, "auth.json"))).toBe(true);

		const loggedOut = await adapter.logoutModelProvider("openai");
		expect(loggedOut.find((model) => model.provider === "openai")).toMatchObject({
			authenticated: false,
			authMethods: ["api_key"],
		});
		expect((await adapter.listModelProviders()).find((provider) => provider.id === "openai")).toMatchObject({
			authenticated: false,
			authMethods: ["api_key"],
			builtIn: true,
		});
		const listedModels = await adapter.listModels();
		expect(() => assertWorkspaceCommandResult("list_models", listedModels)).not.toThrow();
	});
});
