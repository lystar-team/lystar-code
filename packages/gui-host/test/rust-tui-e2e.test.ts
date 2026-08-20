import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	appendFileSync,
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
	type AuthType,
	type ClientMessage,
	ClientMessageDecoder,
	encodeServerMessage,
	encodeTrustedServerMessage,
	type JsonValue,
	type ServerMessage,
	type SubagentSnapshot,
	type ThinkingLevel,
} from "@lystar/code-gui-protocol";
import { afterEach, describe, it } from "vitest";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import { GuiHostService } from "../src/service.ts";
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession, UiRequestHandler } from "../src/types.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const artifactRoot = join(repositoryRoot, ".artifacts", "rust-tui-m7");
let releaseTuiBuilt = false;
const sockets = new Set<string>();
const directories = new Set<string>();
const descriptors = new Set<number>();
const cleanups: Array<() => Promise<void> | void> = [];

type GuiRequestMessage = Extract<ClientMessage, { type: "request" }>;
type PromptRequestMessage = GuiRequestMessage & {
	request: Extract<GuiRequestMessage["request"], { command: "prompt" }>;
};
type CompletionRequestMessage = GuiRequestMessage & {
	request: Extract<GuiRequestMessage["request"], { command: "get_completions" }>;
};
type ClipboardWriteRequestMessage = GuiRequestMessage & {
	request: Extract<GuiRequestMessage["request"], { command: "write_clipboard_text" }>;
};

function run(command: string, args: string[]): string {
	const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function closeDescriptor(descriptor: number): void {
	if (!descriptors.delete(descriptor)) return;
	closeSync(descriptor);
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const descriptor of descriptors) closeSync(descriptor);
	descriptors.clear();
	for (const socket of sockets) spawnSync("tmux", ["-L", socket, "kill-server"]);
	sockets.clear();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
});

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	message: string | (() => string),
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(typeof message === "function" ? message() : message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function writeAll(descriptor: number, frame: Uint8Array): void {
	let offset = 0;
	while (offset < frame.length) offset += writeSync(descriptor, frame, offset, frame.length - offset);
}

function sessionEntries(rounds: number): string {
	const entries: object[] = [
		{ type: "session", version: 3, id: "m7-session", timestamp: "2026-08-15T00:00:00Z", cwd: "/tmp" },
	];
	let parentId: string | null = null;
	for (let index = 0; index < rounds; index++) {
		const assistant = `assistant-${index}`;
		const result = `result-${index}`;
		entries.push({
			type: "message",
			id: assistant,
			parentId,
			timestamp: "2026-08-15T00:00:00Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `src/${index}.ts` } }],
				stopReason: "toolUse",
				timestamp: index,
			},
		});
		entries.push({
			type: "message",
			id: result,
			parentId: assistant,
			timestamp: "2026-08-15T00:00:00Z",
			message: {
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [{ type: "text", text: `needle ${index}` }],
				isError: false,
				timestamp: index,
			},
		});
		parentId = result;
	}
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

interface TraceEvent {
	event: string;
	atMs: number;
	id?: string;
	componentId?: string;
	revision?: number;
	bytes?: number;
}

function readTrace(path: string): TraceEvent[] {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.flatMap((line) => {
				const event = /trace=([^\s]+)/.exec(line)?.[1];
				const atMs = /at_ms=([\d.]+)/.exec(line)?.[1];
				if (!event || !atMs) return [];
				const id = /\sid=([^\s]+)/.exec(line)?.[1];
				const componentId = /\scomponentId=([^\s]+)/.exec(line)?.[1];
				const revision = /\srevision=(\d+)/.exec(line)?.[1];
				const bytes = /\sbytes=(\d+)/.exec(line)?.[1];
				return [
					{
						event,
						atMs: Number(atMs),
						...(id ? { id } : {}),
						...(componentId ? { componentId } : {}),
						...(revision ? { revision: Number(revision) } : {}),
						...(bytes ? { bytes: Number(bytes) } : {}),
					},
				];
			});
	} catch {
		return [];
	}
}

function percentile(values: readonly number[], q: number): number {
	assert.ok(values.length > 0, "cannot calculate percentile of an empty series");
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)];
}

function pageMetric(tui: StartedTui, id: string, wroteAt: number) {
	const traces = tui.traces();
	const traceIndex = (event: string, start = 0) =>
		traces.findIndex((candidate, index) => index >= start && candidate.event === event && candidate.id === id);
	const receivedIndex = traceIndex("host_response_received");
	const decodeStartIndex = traceIndex("page_decode_start", receivedIndex + 1);
	const decodeEndIndex = traceIndex("page_decode_end", decodeStartIndex + 1);
	const applyStartIndex = traceIndex("page_apply_start", decodeEndIndex + 1);
	const applyEndIndex = traceIndex("page_apply_end", applyStartIndex + 1);
	assert.ok(receivedIndex >= 0, `${id} is missing host_response_received`);
	assert.ok(decodeStartIndex >= 0 && decodeEndIndex >= 0, `${id} is missing page decode trace`);
	assert.ok(applyStartIndex >= 0 && applyEndIndex >= 0, `${id} is missing page apply trace`);
	const drawStartIndex = traces.findIndex(
		(candidate, index) => index > applyEndIndex && candidate.event === "draw_start",
	);
	const drawEndIndex = traces.findIndex(
		(candidate, index) => index > drawStartIndex && candidate.event === "draw_end",
	);
	assert.ok(drawStartIndex >= 0 && drawEndIndex >= 0, `${id} is missing post-apply draw trace`);
	const received = traces[receivedIndex];
	const decodeStart = traces[decodeStartIndex];
	const decodeEnd = traces[decodeEndIndex];
	const applyStart = traces[applyStartIndex];
	const applyEnd = traces[applyEndIndex];
	const drawStart = traces[drawStartIndex];
	const drawEnd = traces[drawEndIndex];
	return {
		id,
		hostToReceiveMs: received.atMs - wroteAt,
		decodeMs: decodeEnd.atMs - decodeStart.atMs,
		applyMs: applyEnd.atMs - applyStart.atMs,
		decodeApplyMs: applyEnd.atMs - decodeStart.atMs,
		drawMs: drawEnd.atMs - drawStart.atMs,
		endToFrameMs: drawEnd.atMs - applyEnd.atMs,
		decodeApplyDrawMs: drawEnd.atMs - decodeStart.atMs,
	};
}

function processCpuMilliseconds(pid: number): number {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const fields = stat
		.slice(stat.lastIndexOf(")") + 2)
		.trim()
		.split(/\s+/);
	return (Number(fields[11]) + Number(fields[12])) * 10;
}

function processTreeCpuMilliseconds(pid: number): number {
	return processTreePids(pid).reduce((total, child) => {
		try {
			return total + processCpuMilliseconds(child);
		} catch {
			return total;
		}
	}, 0);
}

function monotonicMs(): number {
	return Number(process.hrtime.bigint() / 1_000_000n);
}

function rssTree(pid: number): number {
	const seen = new Set<number>();
	const visit = (current: number): number => {
		if (!current || seen.has(current)) return 0;
		seen.add(current);
		let total = 0;
		try {
			const status = readFileSync(`/proc/${current}/status`, "utf8");
			total += Number(status.match(/^VmRSS:\s*(\d+)/m)?.[1] ?? 0) * 1024;
			const children = readFileSync(`/proc/${current}/task/${current}/children`, "utf8").trim();
			for (const child of children ? children.split(/\s+/) : []) total += visit(Number(child));
		} catch {}
		return total;
	};
	return visit(pid);
}

function processTreePids(pid: number): number[] {
	const seen = new Set<number>();
	const visit = (current: number): void => {
		if (!current || seen.has(current)) return;
		seen.add(current);
		try {
			const children = readFileSync(`/proc/${current}/task/${current}/children`, "utf8").trim();
			for (const child of children ? children.split(/\s+/) : []) visit(Number(child));
		} catch {}
	};
	visit(pid);
	return [...seen];
}

async function sampleRss(pid: number): Promise<number[]> {
	const samples: number[] = [];
	const started = performance.now();
	await waitFor(
		() => {
			samples.push(rssTree(pid));
			return performance.now() - started >= 1_000;
		},
		"Rust pane RSS sampling did not reach one second",
		1_500,
	);
	assert.ok(samples.length >= 90, `Rust pane RSS sampling is too sparse: ${samples.length}`);
	assert.ok(
		samples.every((sample) => sample > 0),
		"Rust pane RSS includes an empty process tree sample",
	);
	return samples;
}

class FakeRuntimeSession implements RuntimeSession {
	readonly events = new EventEmitter();
	readonly sessionPath: string;
	readonly prompts: string[] = [];
	readonly steers: string[] = [];
	readonly followUps: string[] = [];
	clearQueueCount = 0;
	abortCount = 0;
	settingWrites: Array<{ id: string; value: boolean | number | string }> = [];
	modelWrites: Array<{ provider: string; id: string }> = [];
	thinkingWrites: string[] = [];
	loginCount = 0;
	logoutCount = 0;
	clipboardWrites: string[] = [];
	clipboardText = "clipboard fixture text";
	subagentAbortCount = 0;
	subagentContinue: string[] = [];
	subagents: SubagentSnapshot[];
	authResponses: string[] = [];
	private authNotificationGate: Promise<void> = Promise.resolve();
	private releaseAuthNotificationGate?: () => void;
	private readonly settings: Record<string, boolean | number | string> = {
		autocompact: false,
		"response-mode": "one",
		"retry-limit": 2,
		label: "old",
		readonly: "locked",
	};
	holdPrompt = false;
	private resolvePrompt?: () => void;
	private readonly snapshot = {
		id: "m7-runtime",
		cwd: "/tmp",
		createdAt: 0,
		updatedAt: 0,
		phase: "idle" as "idle" | "turn",
		activity: "idle" as "idle" | "running",
		thinkingLevel: "off" as ThinkingLevel,
		model: { provider: "faux", id: "fast" },
		leafId: null,
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		transcriptGeneration: "m7-runtime-generation",
		transcriptRevision: 0,
	};

	constructor(sessionPath: string) {
		this.sessionPath = sessionPath;
		this.subagents = [
			{
				runId: "run-live",
				agentId: "agent-live",
				agent: "fixture-running",
				agentSource: "builtin",
				task: "live fixture task",
				state: "running",
				currentAction: "read src/live.ts",
				startedAt: 1,
				updatedAt: 20,
				elapsedMs: 20,
				controllable: true,
				session: { version: 1, sessionId: "child-live", sessionFile: sessionPath, cwd: "/tmp", createdAt: 1 },
			},
			{
				runId: "run-done",
				agentId: "agent-done",
				agent: "fixture-completed",
				agentSource: "project",
				task: "completed fixture task",
				state: "succeeded",
				startedAt: 2,
				updatedAt: 10,
				elapsedMs: 8,
				controllable: true,
				session: { version: 1, sessionId: "child-done", sessionFile: sessionPath, cwd: "/tmp", createdAt: 2 },
			},
		];
	}

	getSnapshot(writeAccess: "available" | "owned" | "controlled_elsewhere" | "locked_externally") {
		return { ...this.snapshot, path: this.sessionPath, attached: true, writeAccess, revision: 0 };
	}
	listSettings() {
		return [
			{
				id: "autocompact",
				label: "自动压缩",
				kind: "boolean" as const,
				value: this.settings.autocompact as boolean,
				displayValue: this.settings.autocompact ? "开启" : "关闭",
				scope: "global" as const,
				readOnly: false,
				restartRequired: false,
			},
			{
				id: "response-mode",
				label: "响应模式",
				kind: "enum" as const,
				value: this.settings["response-mode"] as string,
				displayValue: this.settings["response-mode"] === "all" ? "全部" : "逐条",
				options: ["one", "all"],
				scope: "global" as const,
				readOnly: false,
				restartRequired: false,
			},
			{
				id: "retry-limit",
				label: "重试次数",
				kind: "integer" as const,
				value: this.settings["retry-limit"] as number,
				displayValue: String(this.settings["retry-limit"]),
				minimum: 1,
				maximum: 5,
				scope: "global" as const,
				readOnly: false,
				restartRequired: true,
			},
			{
				id: "label",
				label: "会话标签",
				kind: "string" as const,
				value: this.settings.label as string,
				displayValue: this.settings.label as string,
				scope: "project" as const,
				readOnly: false,
				restartRequired: false,
			},
			{
				id: "readonly",
				label: "只读设置",
				kind: "string" as const,
				value: this.settings.readonly as string,
				displayValue: this.settings.readonly as string,
				scope: "global" as const,
				readOnly: true,
				restartRequired: false,
			},
		];
	}
	async setSetting(id: string, value: boolean | number | string) {
		const setting = this.listSettings().find((candidate) => candidate.id === id);
		if (!setting || setting.readOnly) throw new Error("setting unavailable");
		this.settings[id] = value;
		this.settingWrites.push({ id, value });
		return {
			setting: this.listSettings().find((candidate) => candidate.id === id)!,
			requiresRestart: setting.restartRequired,
		};
	}
	getSessionTree() {
		return [];
	}
	getSessionInfo() {
		return {
			name: null,
			sessionFile: this.sessionPath,
			sessionId: "m7-runtime",
			messages: { total: 0, user: 0, agent: 0, toolCalls: 0, toolResults: 0 },
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			usageBreakdown: [],
			cacheWaste: { missedTokens: 0, missedCost: 0, missCount: 0 },
		};
	}
	listForkMessages() {
		return [];
	}
	async setEntryLabel(_entryId: string, _label?: string): Promise<void> {}
	async navigateSessionTree(_entryId: string, _summarize: boolean) {
		return { cancelled: false };
	}
	listSubagents() {
		return this.subagents;
	}
	readSubagent(agentId: string) {
		const transcript = this.subagents.find((snapshot) => snapshot.agentId === agentId);
		return transcript ? { transcript } : {};
	}
	async abortSubagent(agentId: string): Promise<void> {
		const snapshot = this.subagents.find((candidate) => candidate.agentId === agentId);
		if (!snapshot || !["queued", "running", "waiting"].includes(snapshot.state))
			throw new Error("subagent not running");
		this.subagentAbortCount++;
		this.subagents = this.subagents.map((candidate) =>
			candidate.agentId === agentId
				? { ...candidate, state: "cancelled", updatedAt: candidate.updatedAt + 1 }
				: candidate,
		);
	}
	async continueSubagent(agentId: string, text: string): Promise<void> {
		const snapshot = this.subagents.find((candidate) => candidate.agentId === agentId);
		if (!snapshot || ["queued", "running", "waiting"].includes(snapshot.state))
			throw new Error("subagent not complete");
		this.subagentContinue.push(text);
		this.subagents = this.subagents.map((candidate) =>
			candidate.agentId === agentId
				? { ...candidate, state: "running", updatedAt: candidate.updatedAt + 1 }
				: candidate,
		);
	}
	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		if (this.holdPrompt)
			await new Promise<void>((resolve) => {
				this.resolvePrompt = resolve;
			});
	}
	async steer(text: string): Promise<void> {
		this.steers.push(text);
	}
	async followUp(text: string): Promise<void> {
		this.followUps.push(text);
	}
	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		this.clearQueueCount++;
		return { steering: [], followUp: [] };
	}
	async compact(): Promise<void> {}
	async exportSession(outputPath?: string): Promise<{ path: string }> {
		return { path: outputPath ?? "session.html" };
	}
	async importSession(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	async shareSession(): Promise<{ previewUrl: string; gistUrl: string }> {
		return {
			previewUrl: "https://pi.dev/session/#gist-id",
			gistUrl: "https://gist.github.com/user/gist-id",
		};
	}
	getLastAssistantText(): string | undefined {
		return "latest assistant";
	}
	async runBash(): Promise<JsonValue> {
		return {};
	}
	async rename(_nextName: string): Promise<void> {}
	async setModel(model: { provider: string; id: string }): Promise<void> {
		this.snapshot.model = model;
		this.modelWrites.push(model);
		this.emit({ type: "state_changed", payload: {} });
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.snapshot.thinkingLevel = level;
		this.thinkingWrites.push(level);
		this.emit({ type: "state_changed", payload: {} });
	}
	async cycleModel(): Promise<{ changed: boolean; isScoped: boolean }> {
		return { changed: false, isScoped: false };
	}
	cycleThinkingLevel(): { changed: boolean; supported: boolean } {
		return { changed: false, supported: false };
	}
	async fork(): Promise<{ sessionPath: string }> {
		return { sessionPath: this.sessionPath };
	}
	async abort(): Promise<void> {
		this.abortCount++;
		this.resolvePrompt?.();
		this.resolvePrompt = undefined;
	}
	async reloadResources(): Promise<void> {}
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
	async dispose(): Promise<void> {
		this.events.removeAllListeners();
	}
	onEvent(listener: (event: RuntimeEvent) => void): () => void {
		this.events.on("runtime", listener);
		return () => this.events.off("runtime", listener);
	}
	releaseAuthNotifications(): void {
		this.releaseAuthNotificationGate?.();
		this.releaseAuthNotificationGate = undefined;
	}
	pauseAfterDeviceCode(): void {
		this.authNotificationGate = new Promise<void>((resolve) => {
			this.releaseAuthNotificationGate = resolve;
		});
	}
	async waitAfterDeviceCode(): Promise<void> {
		await this.authNotificationGate;
	}
	setRunning(running: boolean): void {
		this.snapshot.activity = running ? "running" : "idle";
		this.snapshot.phase = running ? "turn" : "idle";
		this.emit({ type: "state_changed", payload: {} });
	}
	emit(event: RuntimeEvent): void {
		this.events.emit("runtime", event);
	}
}

function fakeModels() {
	return [
		{
			provider: "faux",
			id: "fast",
			name: "Faux Fast",
			api: "openai-completions",
			reasoning: true,
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 4_096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			supportedThinkingLevels: ["off", "low", "high"],
			authenticated: true,
			authMethods: ["api_key"],
		},
		{
			provider: "locked",
			id: "offline",
			name: "Locked Offline",
			api: "openai-completions",
			reasoning: false,
			input: ["text", "image"],
			contextWindow: 32_000,
			maxTokens: 2_048,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			supportedThinkingLevels: [],
			authenticated: false,
			authMethods: ["api_key"],
		},
	];
}

function fakeAuthModels(authenticated: boolean) {
	return [
		...fakeModels(),
		{
			provider: "login",
			id: "auth-model",
			name: "登录测试模型",
			api: "openai-completions",
			reasoning: false,
			input: ["text"],
			contextWindow: 32_000,
			maxTokens: 2_048,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			supportedThinkingLevels: [],
			authenticated,
			authMethods: ["api_key", "oauth"],
		},
	];
}

function createAdapter(runtime: FakeRuntimeSession): RuntimeAdapter {
	return {
		getAbout: () => ({
			productName: "LYStar Code",
			productVersion: "m8-e2e",
			piVersion: "0.84.2",
			hostVersion: "test-host",
			protocolVersion: 1,
			releaseRepository: null,
			agentDir: "/tmp/agent",
			sessionsDir: "/tmp/agent/sessions",
			configDirName: ".pi",
		}),
		getDiagnostics: async () => ({ checks: [], platform: "linux", arch: "x64" }),
		listModels: async () => fakeModels(),
		listModelProviders: async () => [
			{
				id: "faux",
				name: "Faux",
				authenticated: true,
				authMethods: ["api_key"],
				modelCount: 1,
				builtIn: true,
				custom: false,
			},
			{
				id: "login",
				name: "登录测试",
				authenticated: runtime.loginCount > runtime.logoutCount,
				authSource: runtime.loginCount > runtime.logoutCount ? "stored" : undefined,
				authMethods: ["api_key", "oauth"],
				modelCount: 1,
				builtIn: false,
				custom: true,
			},
		],
		loginModelProvider: async (_provider: string, _authType: AuthType, onUiRequest: UiRequestHandler) => {
			const select = await onUiRequest({
				id: "login-select",
				kind: "select",
				title: "认证区域",
				payload: { options: [{ id: "region-cn", label: "中国", description: "中国大陆节点" }] },
			});
			const input = await onUiRequest({
				id: "login-input",
				kind: "input",
				title: "认证输入",
				payload: { value: "" },
			});
			const secret = await onUiRequest({
				id: "login-secret",
				kind: "secret",
				title: "认证密钥",
				payload: { value: "" },
			});
			runtime.authResponses.push(String(select.value), String(input.value), String(secret.value));
			await onUiRequest({
				id: "login-auth-url",
				kind: "notify",
				title: "模型认证",
				payload: { method: "auth_url", url: "https://example.test/auth", instructions: "在浏览器完成授权" },
			});
			await onUiRequest({
				id: "login-device-code",
				kind: "notify",
				title: "模型认证",
				payload: {
					method: "auth_device_code",
					userCode: "ABCD-EFGH",
					verificationUri: "https://example.test/device",
					intervalSeconds: 5,
					expiresInSeconds: 600,
				},
			});
			await runtime.waitAfterDeviceCode();
			await onUiRequest({
				id: "login-progress",
				kind: "notify",
				title: "模型认证",
				payload: { method: "auth_progress", message: "正在等待授权完成" },
			});
			const confirm = await onUiRequest({
				id: "login-confirm",
				kind: "confirm",
				title: "认证确认",
				payload: { message: "确认认证？" },
			});
			assert.equal(confirm.confirmed, true);
			runtime.loginCount++;
			return fakeAuthModels(true);
		},
		logoutModelProvider: async () => {
			runtime.logoutCount++;
			return fakeAuthModels(false);
		},
		readClipboardText: async () => ({ capability: true, text: runtime.clipboardText }),
		readClipboardImage: async () => ({
			capability: true,
			available: true,
			mimeType: "image/png",
			byteLength: 68,
			contentHash: "fixture-clipboard-image",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WAAAAABJRU5ErkJggg==",
		}),
		completeProjectFiles: (_cwd: string, query: string) =>
			[
				{ value: "images/", label: "images/", kind: "directory" as const },
				{
					value: "images/中文 图片.png",
					label: "images/中文 图片.png",
					description: "fixture PNG",
					kind: "file" as const,
				},
			]
				.filter((item) => item.value.includes(query))
				.slice(0, 40),
		readProjectImage: async (_cwd: string, path: string) => ({
			mimeType: "image/png",
			byteLength: 68,
			contentHash: `fixture-project-${path}`,
			base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WAAAAABJRU5ErkJggg==",
		}),
		writeClipboardText: async (text: string) => {
			runtime.clipboardWrites.push(text);
			return { capability: true, changed: true };
		},
		openSession: async (sessionPath: string) => {
			assert.equal(sessionPath, runtime.sessionPath);
			return runtime;
		},
	} as unknown as RuntimeAdapter;
}

class WorkbenchFixture {
	readonly adapter: RuntimeAdapter;
	readonly calls: string[] = [];
	readonly effects = {
		create: 0,
		rename: 0,
		delete: 0,
		fork: 0,
		label: 0,
		navigate: 0,
		skill: 0,
		trust: 0,
		instruction: 0,
		package: 0,
	};
	readonly paths: { a: string; b: string; c: string };
	readonly tree = [
		{
			id: "user-root",
			parentId: null,
			kind: "user",
			label: "labeled user",
			timestamp: "2026-08-16T00:00:00Z",
			preview: "user-only no-tools prompt",
			isLeaf: false,
			depth: 0,
		},
		{
			id: "assistant-step",
			parentId: "user-root",
			kind: "assistant",
			timestamp: "2026-08-16T00:00:01Z",
			preview: "assistant no-tools response",
			isLeaf: false,
			depth: 1,
		},
		{
			id: "tool-step",
			parentId: "assistant-step",
			kind: "tool",
			timestamp: "2026-08-16T00:00:02Z",
			preview: "Tool read src/tree.ts",
			isLeaf: true,
			depth: 2,
		},
	];
	readonly sessions = new Map<string, { id: string; name: string; runtime: FakeRuntimeSession }>();
	readonly failures = new Map<string, number>();
	nextNavigation: { cancelled: boolean; editorText?: string; newLeafId?: string } = { cancelled: false };
	labelFailures = 0;
	navigationFailures = 0;
	instructionConflicts = 0;
	packageFailures = 0;
	private skillEnabled = true;
	private trusted = true;
	private packageSources = ["npm:fixture"];
	private sequence = 0;

	constructor(directory: string, initialPath: string) {
		this.paths = {
			a: initialPath,
			b: join(directory, "session-b.jsonl"),
			c: join(directory, "session-c.jsonl"),
		};
		this.addSession(initialPath, "A", "会话 A");
		this.addSession(this.paths.b, "B", "会话 B");
		this.addSession(this.paths.c, "C", "会话 C");
		this.adapter = {
			getAbout: () => createAdapter(this.runtimeFor(this.paths.a)).getAbout(),
			getDiagnostics: async () => ({ checks: [], platform: "linux", arch: "x64" }),
			listModels: async () => fakeModels(),
			listModelProviders: async () => [],
			openSession: async (path: string) => this.open(path),
			createSession: async () => this.create(),
			deleteSession: async (path: string) => this.delete(path),
			listSessions: async () => this.list(),
			inspectSession: (path: string) => this.runtimeFor(path).getSnapshot("available"),
			isSessionWriterLocked: () => false,
			listSettings: (path: string) => this.runtimeFor(path).listSettings(),
			getSessionTree: () => this.tree,
			listSubagents: () => [],
			readSubagent: () => ({}),
			getProjectTrust: (cwd: string) => ({
				cwd,
				trusted: this.trusted,
				reason: this.trusted ? "项目资源已信任" : "项目资源被明确设为不信任",
				resourceRisk: true,
			}),
			getProjectTrustDecision: () => this.trusted,
			setProjectTrust: async (cwd: string, trusted: boolean | null) => {
				this.effects.trust++;
				this.trusted = trusted ?? false;
				return {
					cwd,
					trusted: this.trusted,
					reason: this.trusted ? "项目资源已信任" : "项目资源被明确设为不信任",
					resourceRisk: true,
				};
			},
			listSkills: async () => ({
				skills: [
					{
						name: "fixture-skill",
						description: "fixture skill description",
						path: "/tmp/fixture-skill/SKILL.md",
						baseDir: "/tmp/fixture-skill",
						source: "fixture",
						scope: "project" as const,
						origin: "top-level" as const,
						enabled: this.skillEnabled,
						disableModelInvocation: false,
						eligible: true,
					},
				],
				diagnostics: [],
			}),
			setSkillEnabled: async (_cwd: string, _path: string, _scope: "user" | "project", enabled: boolean) => {
				this.effects.skill++;
				this.skillEnabled = enabled;
				return this.adapter.listSkills("", async () => ({ cancelled: true }));
			},
			listProjectInstructions: (cwd: string) => [
				{
					path: join(cwd, "AGENTS.md"),
					fileName: "AGENTS.md",
					exists: true,
					active: true,
					editable: true,
					content: "项目指令",
					contentHash: "fixture-project-hash",
				},
			],
			saveProjectInstruction: async (
				cwd: string,
				_fileName: "AGENTS.md" | "AGENTS.override.md",
				content: string,
			) => {
				if (this.instructionConflicts > 0) {
					this.instructionConflicts--;
					throw Object.assign(new Error("项目指令文件已被外部修改，请重新加载后再保存"), {
						code: "instruction_conflict",
						retryable: true,
					});
				}
				this.effects.instruction++;
				return [
					{
						path: join(cwd, "AGENTS.md"),
						fileName: "AGENTS.md",
						exists: true,
						active: true,
						editable: true,
						content,
						contentHash: "fixture-project-hash-next",
					},
				];
			},
			listHostInstructions: () => [
				{
					path: "/tmp/host/AGENTS.md",
					fileName: "AGENTS.md",
					exists: true,
					active: true,
					editable: true,
					content: "本机指令",
					contentHash: "fixture-host-hash",
				},
			],
			saveHostInstruction: async (_fileName: "AGENTS.md" | "AGENTS.override.md", content: string) => {
				this.effects.instruction++;
				return [
					{
						path: "/tmp/host/AGENTS.md",
						fileName: "AGENTS.md",
						exists: true,
						active: true,
						editable: true,
						content,
						contentHash: "fixture-host-hash-next",
					},
				];
			},
			getGitStatus: async (cwd: string) => ({
				root: cwd,
				branch: "fixture",
				upstream: "origin/fixture",
				ahead: 1,
				behind: 2,
				files: [
					{
						path: "staged.ts",
						indexStatus: "M",
						worktreeStatus: ".",
						staged: true,
						unstaged: false,
						untracked: false,
						conflicted: false,
					},
					{
						path: "unstaged.ts",
						indexStatus: ".",
						worktreeStatus: "M",
						staged: false,
						unstaged: true,
						untracked: false,
						conflicted: false,
					},
					{
						path: "conflict.ts",
						indexStatus: "U",
						worktreeStatus: "U",
						staged: true,
						unstaged: true,
						untracked: false,
						conflicted: true,
					},
				],
			}),
			getGitDiff: async (_cwd: string, path: string | undefined, staged: boolean) => ({
				...(path ? { path } : {}),
				staged,
				additions: 2,
				deletions: 1,
				diff: `diff --git a/${path ?? "all"} b/${path ?? "all"}\n+added\n-removed`,
			}),
			checkForUpdates: async () => ({
				currentVersion: "0.84.2",
				checkedAt: 1,
				repository: "lystar-team/lystar-code",
				installEnabled: false,
				installBlockedReason: "当前只支持检查版本。",
				status: "available",
				latestVersion: "0.84.3",
				note: "fixture update note",
				url: "https://example.test/release",
			}),
			listPackages: () =>
				this.packageSources.map((source) => ({
					source,
					scope: "project" as const,
					filtered: false,
					installedPath: "/tmp/fixture-package",
				})),
			installPackage: async (_cwd: string, source: string) => {
				this.effects.package++;
				this.packageSources.push(source);
				return { changed: true, message: `已安装 ${source}` };
			},
			removePackage: async (_cwd: string, source: string) => {
				this.effects.package++;
				this.packageSources = this.packageSources.filter((item) => item !== source);
				return { changed: true, message: `已移除 ${source}` };
			},
			updatePackages: async () => {
				if (this.packageFailures > 0) {
					this.packageFailures--;
					throw Object.assign(new Error("离线模式下不能更新包"), { code: "offline", retryable: false });
				}
				this.effects.package++;
				return { changed: true, message: "已更新配置包" };
			},
			readClipboardText: async () => ({ capability: true, text: "fixture clipboard text" }),
			readClipboardImage: async () => ({
				capability: true,
				available: true,
				mimeType: "image/png",
				byteLength: 68,
				contentHash: "fixture-clipboard-image",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WAAAAABJRU5ErkJggg==",
			}),
			completeProjectFiles: (_cwd: string, query: string) =>
				[
					{ value: "images/", label: "images/", kind: "directory" as const },
					{
						value: "images/中文 图片.png",
						label: "images/中文 图片.png",
						description: "fixture PNG",
						kind: "file" as const,
					},
				]
					.filter((item) => item.value.includes(query))
					.slice(0, 40),
			readProjectImage: async (_cwd: string, path: string) => ({
				mimeType: "image/png",
				byteLength: 68,
				contentHash: `fixture-project-${path}`,
				base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WAAAAABJRU5ErkJggg==",
			}),
			writeClipboardText: async () => ({ capability: false, changed: false }),
		} as unknown as RuntimeAdapter;
	}

	runtimeFor(path: string): FakeRuntimeSession {
		const runtime = this.sessions.get(path)?.runtime;
		if (!runtime) throw new Error(`unknown session ${path}`);
		return runtime;
	}

	failNextOpen(path: string, count = 1): void {
		this.failures.set(path, count);
	}

	private addSession(path: string, id: string, name: string): FakeRuntimeSession {
		if (!existsSync(path)) writeFileSync(path, sessionEntries(240));
		const runtime = new FakeRuntimeSession(path);
		const dispose = runtime.dispose.bind(runtime);
		runtime.dispose = async () => {
			this.calls.push(`dispose:${this.sessionName(runtime.sessionPath)}`);
			await dispose();
		};
		runtime.rename = async (nextName: string) => {
			this.effects.rename++;
			this.sessions.get(runtime.sessionPath)!.name = nextName;
			this.calls.push(`rename:${this.sessionName(runtime.sessionPath)}`);
		};
		runtime.fork = async () => this.fork(runtime);
		runtime.setEntryLabel = async (entryId: string, label?: string) => {
			if (this.labelFailures > 0) {
				this.labelFailures--;
				throw new Error("label failed");
			}
			this.effects.label++;
			const node = this.tree.find((candidate) => candidate.id === entryId);
			if (!node) throw new Error("tree node missing");
			if (label) node.label = label;
			else delete node.label;
			this.calls.push(`label:${entryId}`);
		};
		runtime.navigateSessionTree = async (_entryId: string, summarize: boolean) => {
			if (this.navigationFailures > 0) {
				this.navigationFailures--;
				throw new Error("navigate failed");
			}
			this.effects.navigate++;
			this.calls.push(`navigate:${summarize}`);
			const result = this.nextNavigation;
			this.nextNavigation = { cancelled: false };
			return result;
		};
		this.sessions.set(path, { id, name, runtime });
		return runtime;
	}

	private sessionName(path: string): string {
		return this.sessions.get(path)?.id ?? "fork";
	}

	private async open(path: string): Promise<FakeRuntimeSession> {
		const remaining = this.failures.get(path) ?? 0;
		this.calls.push(`open:${this.sessionName(path)}`);
		if (remaining > 0) {
			this.failures.set(path, remaining - 1);
			throw new Error(`acquire ${this.sessionName(path)} failed`);
		}
		return this.runtimeFor(path);
	}

	private async create(): Promise<FakeRuntimeSession> {
		this.effects.create++;
		this.sequence++;
		const path = join(dirname(this.paths.a), `session-created-${this.sequence}.jsonl`);
		this.calls.push("create");
		return this.addSession(path, `N${this.sequence}`, `新会话 ${this.sequence}`);
	}

	private async delete(path: string): Promise<void> {
		this.effects.delete++;
		this.calls.push(`delete:${this.sessionName(path)}`);
		rmSync(path, { force: true });
		this.sessions.delete(path);
	}

	private async fork(runtime: FakeRuntimeSession): Promise<{ sessionPath: string; selectedText?: string }> {
		this.effects.fork++;
		this.sequence++;
		const originalPath = runtime.sessionPath;
		const original = this.sessions.get(originalPath)!;
		const forkPath = join(dirname(this.paths.a), `session-fork-${this.sequence}.jsonl`);
		writeFileSync(forkPath, sessionEntries(240));
		this.sessions.set(originalPath, {
			id: original.id,
			name: original.name,
			runtime: this.addSession(originalPath, original.id, original.name),
		});
		this.sessions.get(forkPath) ?? this.addSession(forkPath, `F${this.sequence}`, `分叉 ${this.sequence}`);
		(this.sessions.get(forkPath)!.runtime as unknown as { sessionPath: string }).sessionPath = forkPath;
		(runtime as unknown as { sessionPath: string }).sessionPath = forkPath;
		this.sessions.set(forkPath, { id: `F${this.sequence}`, name: `分叉 ${this.sequence}`, runtime });
		this.calls.push(`fork:${original.id}`);
		return { sessionPath: forkPath, selectedText: "tree replacement draft" };
	}

	private list() {
		return [...this.sessions.entries()]
			.filter(([path]) => existsSync(path))
			.map(([path, session], index) => ({
				path,
				id: session.id,
				cwd: dirname(path),
				name: session.name,
				createdAt: index,
				updatedAt: index + 1,
				messageCount: 240,
				firstMessage: session.name,
				activity: "idle" as const,
			}));
	}
}

function hostLeaseCount(service: GuiHostService): number {
	return (service as unknown as { leases: { leases: Map<string, unknown> } }).leases.leases.size;
}

function hostRuntimeCount(service: GuiHostService): number {
	return (service as unknown as { runtimes: Map<string, unknown> }).runtimes.size;
}

async function waitForRequest(
	tui: StartedTui,
	command: string,
	count = 1,
): Promise<Extract<ClientMessage, { type: "request" }>> {
	let request: Extract<ClientMessage, { type: "request" }> | undefined;
	await waitFor(async () => {
		await tui.pump();
		const matches = tui.clientMessages.filter(
			(message): message is Extract<ClientMessage, { type: "request" }> =>
				message.type === "request" && message.request.command === command,
		);
		request = matches.at(-1);
		return matches.length >= count;
	}, `Rust did not send ${command} x${count}`);
	return request!;
}

async function openSessions(tui: StartedTui): Promise<void> {
	const count = tui.requests.filter((request) => request.command === "list_sessions").length;
	tui.sendLiteral("/sessions");
	tui.send("Enter");
	const request = await waitForRequest(tui, "list_sessions", count + 1);
	await waitFor(() => tui.pane().includes("会话"), "session chooser did not render");
	await waitFor(
		() =>
			tui.serverMessages.some((message) => message.type === "response" && message.id === request.id && message.ok),
		"Host did not return session list",
	);
	const response = tui.serverMessages.find(
		(message) => message.type === "response" && message.id === request.id && message.ok,
	);
	assert.ok(response && response.type === "response" && response.ok, "Host did not return session list");
	assert.equal((response.result as unknown[]).length, 3, "Host did not return exactly three sessions");
}

async function openSubagents(tui: StartedTui): Promise<void> {
	const count = tui.requests.filter((request) => request.command === "list_subagents").length;
	tui.sendLiteral("/subagents");
	tui.send("Enter");
	await waitForRequest(tui, "list_subagents", count + 1);
	await waitFor(() => tui.pane().includes("fixture-running"), "Subagent list did not render");
}

function assertCustomEditorArtifactSafe(artifactDirectory: string, forbiddenTexts: readonly string[] = []): void {
	for (const name of readdirSync(artifactDirectory)) {
		const path = join(artifactDirectory, name);
		const contents = readFileSync(path, "utf8");
		assert.doesNotMatch(contents, /预置草稿|命令草稿|ultrathink/i, `artifact contains editor text: ${name}`);
		for (const text of forbiddenTexts) {
			assert.ok(!contents.includes(text), `artifact contains editor text: ${name}`);
		}
		assert.doesNotMatch(
			contents,
			/base64|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]+ KEY-----/i,
			`artifact contains sensitive data: ${name}`,
		);
	}
}

interface RequestRecord {
	id: string;
	command: string;
	data?: string;
	receivedAt: number;
}

interface StartedTui {
	directory: string;
	artifactDirectory: string;
	sessionPath: string;
	tracePath: string;
	socket: string;
	service: GuiHostService;
	runtime: FakeRuntimeSession;
	connection: ReturnType<GuiHostService["createConnection"]>;
	control: ReturnType<GuiHostService["createConnection"]>;
	controlMessages: ServerMessage[];
	clientMessages: ClientMessage[];
	serverMessages: ServerMessage[];
	requests: RequestRecord[];
	responseWrites: Map<string, number>;
	dropNextWorkspaceResponse(): void;
	pump(): Promise<void>;
	traces(): TraceEvent[];
	pane(): string;
	resize(width: number, height: number): void;
	send(...keys: string[]): void;
	sendLiteral(text: string): void;
	paste(text: string): void;
	panePid(): number;
	clientInstanceId: string;
	sttyBeforePath: string;
	sttyAfterPath: string;
	rawOutputPath: string;
	rawOutput(): string;
	paneHistory(): string;
	fixture?: WorkbenchFixture;
	emitServer(message: ServerMessage): void;
	closeProtocol(): void;
	closeTransport(): void;
}

interface RealRuntimeHost {
	adapter: RuntimeAdapter;
	agentDir: string;
	sessionPath: string;
}

async function startTui(
	rounds: number,
	dimensions: { width: number; height: number },
	label: string,
	hostFactory?: (context: { directory: string; sessionPath: string }) => WorkbenchFixture,
	runOptions: {
		mode?: "auto" | "fullscreen" | "regular";
		exitOutput?: "transcript" | "resume-hint";
		transport?: "fifo" | "unix-socket";
		captureRawOutput?: boolean;
		nonBlockingPromptRequests?: boolean;
	} = {},
	runtimeHostFactory?: (context: { directory: string }) => Promise<RealRuntimeHost>,
): Promise<StartedTui> {
	if (!releaseTuiBuilt) {
		run("cargo", ["build", "--release", "-p", "lystar-tui"]);
		releaseTuiBuilt = true;
	}
	const directory = mkdtempSync(join(tmpdir(), "lystar-rust-m7-e2e-"));
	directories.add(directory);
	const artifactDirectory = join(artifactRoot, `${label}-${process.pid}-${Date.now()}`);
	mkdirSync(artifactDirectory, { recursive: true });
	const runtimeHost = await runtimeHostFactory?.({ directory });
	const sessionPath = runtimeHost?.sessionPath ?? join(directory, "session.jsonl");
	const toRust = join(directory, "to-rust.fifo");
	const fromRust = join(directory, "from-rust.fifo");
	const tracePath = join(artifactDirectory, "rust-trace.log");
	const sttyBeforePath = join(artifactDirectory, "stty-before");
	const sttyAfterPath = join(artifactDirectory, "stty-after");
	const rawOutputPath = join(artifactDirectory, "terminal-output.raw");
	const useUnixSocket = runOptions.transport === "unix-socket";
	const encodeHostMessage = useUnixSocket ? encodeTrustedServerMessage : encodeServerMessage;
	const socketEndpoint = join(directory, "host.sock");
	if (!runtimeHost) writeFileSync(sessionPath, sessionEntries(rounds));
	let incomingReader: number | undefined;
	let input: number | undefined;
	let outgoingReader: number | undefined;
	let outgoingWriter: number | undefined;
	if (!useUnixSocket) {
		run("/usr/bin/mkfifo", [toRust, fromRust]);
		incomingReader = openSync(toRust, constants.O_RDONLY | constants.O_NONBLOCK);
		descriptors.add(incomingReader);
		input = openSync(toRust, constants.O_WRONLY);
		descriptors.add(input);
		outgoingReader = openSync(fromRust, constants.O_RDONLY | constants.O_NONBLOCK);
		descriptors.add(outgoingReader);
		outgoingWriter = openSync(fromRust, constants.O_WRONLY | constants.O_NONBLOCK);
		descriptors.add(outgoingWriter);
	}

	const socket = `lystar-m7-${process.pid}-${Date.now()}-${label}`;
	sockets.add(socket);
	const clientInstanceId = `lystar-rust-m8-${socket}`;
	const binary = join(repositoryRoot, "target/release/lystar-tui");
	const transportPrefix = useUnixSocket
		? `env PI_RUST_TUI_HOST_ENDPOINT=${shellQuote(socketEndpoint)}`
		: `exec 3<${shellQuote(toRust)} 4>${shellQuote(fromRust)}; env`;
	const command = `before=$(stty -g); printf %s "$before" > ${shellQuote(sttyBeforePath)}; ${transportPrefix} PI_RUST_TUI_TRACE=1 PI_RUST_TUI_CLIENT_INSTANCE_ID=${shellQuote(clientInstanceId)} ${shellQuote(binary)} --run ${shellQuote(sessionPath)} --mode ${shellQuote(runOptions.mode ?? "auto")} --exit-output ${shellQuote(runOptions.exitOutput ?? "transcript")} 2>${shellQuote(tracePath)}; status=$?; after=$(stty -g); printf %s "$after" > ${shellQuote(sttyAfterPath)}; exit $status`;
	const fixture = hostFactory?.({ directory, sessionPath });
	const runtime = fixture?.runtimeFor(sessionPath) ?? new FakeRuntimeSession(sessionPath);
	const service = new GuiHostService(runtimeHost?.adapter ?? fixture?.adapter ?? createAdapter(runtime), {
		agentDir: runtimeHost?.agentDir ?? directory,
	});
	cleanups.push(async () => service.dispose());
	const requests: RequestRecord[] = [];
	const clientMessages: ClientMessage[] = [];
	const serverMessages: ServerMessage[] = [];
	const responseWrites = new Map<string, number>();
	let dropNextWorkspaceResponse = false;
	let socketPeer: Socket | undefined;
	let socketServer: ReturnType<typeof createServer> | undefined;
	let socketProcessing = Promise.resolve();
	let socketError: Error | undefined;
	const connection = service.createConnection(async (message: ServerMessage) => {
		serverMessages.push(message);
		if (message.type === "response" && dropNextWorkspaceResponse) {
			dropNextWorkspaceResponse = false;
			return;
		}
		const bytes = encodeHostMessage(message);
		if (useUnixSocket) {
			const peer = socketPeer;
			if (!peer) throw new Error("Rust TUI Unix socket is not connected");
			await new Promise<void>((resolve, reject) => {
				peer.write(bytes, (error) => (error ? reject(error) : resolve()));
			});
		} else {
			writeAll(input!, bytes);
		}
		if (message.type === "response") responseWrites.set(message.id, Math.floor(monotonicMs() / 10) * 10);
	});
	cleanups.push(() => connection.close());
	const controlMessages: ServerMessage[] = [];
	const control = service.createConnection(async (message: ServerMessage) => {
		controlMessages.push(message);
	});
	cleanups.push(() => control.close());
	await control.handle({ type: "hello", version: 1, clientInstanceId: "m7-runtime-controller" });

	const decoder = new ClientMessageDecoder();
	const handleClientMessage = (message: ClientMessage): void => {
		clientMessages.push(message);
		if (message.type === "request")
			requests.push({
				id: message.id,
				command: message.request.command,
				...("data" in message.request && typeof message.request.data === "string"
					? { data: message.request.data }
					: {}),
				receivedAt: monotonicMs(),
			});
		if (
			message.type === "request" &&
			(message.request.command === "login_model_provider" ||
				(runOptions.nonBlockingPromptRequests &&
					["prompt", "steer", "follow_up"].includes(message.request.command)))
		) {
			void connection.handle(message);
		} else {
			socketProcessing = socketProcessing.then(() => connection.handle(message));
		}
	};
	if (useUnixSocket) {
		socketServer = createServer((peer) => {
			socketPeer = peer;
			peer.on("data", (chunk: Buffer) => {
				try {
					for (const message of decoder.push(chunk)) handleClientMessage(message);
				} catch (error) {
					socketError = error instanceof Error ? error : new Error(String(error));
					peer.destroy(socketError);
				}
			});
			peer.on("error", (error) => {
				socketError = error;
			});
		});
		await new Promise<void>((resolve, reject) => {
			socketServer!.once("error", reject);
			socketServer!.listen(socketEndpoint, resolve);
		});
		cleanups.push(() => {
			socketPeer?.destroy();
			socketServer?.close();
		});
	}
	run("tmux", [
		"-L",
		socket,
		"new-session",
		"-d",
		"-s",
		"tui",
		"-x",
		String(dimensions.width),
		"-y",
		String(dimensions.height),
		command,
	]);
	if (runOptions.captureRawOutput !== false) {
		run("tmux", ["-L", socket, "pipe-pane", "-o", "-t", "tui", `cat > ${shellQuote(rawOutputPath)}`]);
	}
	closeDescriptor(incomingReader!);
	closeDescriptor(outgoingWriter!);
	const outputBuffer = Buffer.allocUnsafe(64 * 1024);
	const pump = async () => {
		if (useUnixSocket) {
			await Promise.resolve();
			if (socketError) throw socketError;
			await socketProcessing;
			return;
		}
		while (true) {
			let bytesRead: number;
			try {
				bytesRead = readSync(outgoingReader!, outputBuffer);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EAGAIN") return;
				throw error;
			}
			if (bytesRead === 0) return;
			for (const message of decoder.push(outputBuffer.subarray(0, bytesRead))) {
				clientMessages.push(message);
				if (message.type === "request")
					requests.push({
						id: message.id,
						command: message.request.command,
						...("data" in message.request && typeof message.request.data === "string"
							? { data: message.request.data }
							: {}),
						receivedAt: monotonicMs(),
					});
				if (
					message.type === "request" &&
					(message.request.command === "login_model_provider" ||
						(runOptions.nonBlockingPromptRequests &&
							["prompt", "steer", "follow_up"].includes(message.request.command)))
				) {
					void connection.handle(message);
				} else {
					await connection.handle(message);
				}
			}
		}
	};
	const traces = () => readTrace(tracePath);
	const pane = () => run("tmux", ["-L", socket, "capture-pane", "-p", "-t", "tui"]);
	const paneHistory = () => run("tmux", ["-L", socket, "capture-pane", "-p", "-S", "-2000", "-t", "tui"]);
	const rawOutput = () => (existsSync(rawOutputPath) ? readFileSync(rawOutputPath, "utf8") : "");
	const resize = (width: number, height: number) => {
		run("tmux", ["-L", socket, "resize-window", "-t", "tui", "-x", String(width), "-y", String(height)]);
	};
	const send = (...keys: string[]) => run("tmux", ["-L", socket, "send-keys", "-t", "tui", ...keys]);
	const sendLiteral = (text: string) => run("tmux", ["-L", socket, "send-keys", "-t", "tui", "-l", "--", text]);
	const paste = (text: string) => {
		const buffer = `lystar-paste-${process.pid}-${Date.now()}`;
		const pastePath = join(directory, `${buffer}.txt`);
		writeFileSync(pastePath, text);
		run("tmux", ["-L", socket, "load-buffer", "-b", buffer, pastePath]);
		try {
			run("tmux", ["-L", socket, "paste-buffer", "-p", "-b", buffer, "-t", "tui"]);
		} finally {
			run("tmux", ["-L", socket, "delete-buffer", "-b", buffer]);
			rmSync(pastePath, { force: true });
		}
	};
	const panePid = () =>
		Number(run("tmux", ["-L", socket, "display-message", "-p", "-t", "tui", "#{pane_pid}"]).trim());
	const closeProtocol = () => {
		if (useUnixSocket) socketPeer?.end();
		else closeDescriptor(input!);
	};
	const closeTransport = () => {
		if (useUnixSocket) {
			socketPeer?.destroy();
			socketServer?.close();
		} else {
			closeDescriptor(input!);
			closeDescriptor(outgoingReader!);
		}
	};
	const emitServer = (message: ServerMessage) => {
		const bytes = encodeHostMessage(message);
		if (useUnixSocket) {
			if (!socketPeer) throw new Error("Rust TUI Unix socket is not connected");
			void new Promise<void>((resolve, reject) => {
				socketPeer!.write(bytes, (error) => (error ? reject(error) : resolve()));
			});
		} else writeAll(input!, bytes);
	};
	return {
		directory,
		artifactDirectory,
		sessionPath,
		tracePath,
		socket,
		service,
		runtime,
		connection,
		control,
		controlMessages,
		requests,
		clientMessages,
		serverMessages,
		responseWrites,
		dropNextWorkspaceResponse: () => {
			dropNextWorkspaceResponse = true;
		},
		pump,
		traces,
		pane,
		resize,
		send,
		sendLiteral,
		paste,
		panePid,
		clientInstanceId,
		sttyBeforePath,
		sttyAfterPath,
		rawOutputPath,
		rawOutput,
		paneHistory,
		fixture,
		emitServer,
		closeProtocol,
		closeTransport,
	};
}

async function finishTuiRound(tui: StartedTui): Promise<void> {
	const runtime = (tui.service as unknown as { runtimes: Map<string, RuntimeSession> }).runtimes.get(tui.sessionPath);
	await runtime?.abort();
	await tui.service.dispose();
	await tui.connection.close();
	await tui.control.close();
	tui.closeProtocol();
	await waitFor(
		() => spawnSync("tmux", ["-L", tui.socket, "has-session", "-t", "tui"]).status !== 0,
		"Rust TUI did not exit within two seconds after round cleanup",
		2_000,
	);
	tui.closeTransport();
	spawnSync("tmux", ["-L", tui.socket, "kill-server"]);
	sockets.delete(tui.socket);
	assert.equal(readFileSync(tui.sttyBeforePath, "utf8"), readFileSync(tui.sttyAfterPath, "utf8"));
}

async function waitForTrace(tui: StartedTui, event: string, count = 1, timeoutMs = 10_000): Promise<TraceEvent[]> {
	await waitFor(
		async () => {
			await tui.pump();
			return tui.traces().filter((candidate) => candidate.event === event).length >= count;
		},
		`Rust trace did not reach ${event} x${count}`,
		timeoutMs,
	);
	return tui.traces().filter((candidate) => candidate.event === event);
}

async function waitForInitialPage(tui: StartedTui): Promise<{ responseId: string; pageApplied: TraceEvent }> {
	await waitForTrace(tui, "terminal_ready");
	await waitFor(async () => {
		await tui.pump();
		return (
			tui.requests.some((request) => request.id.startsWith("initial-")) &&
			[...tui.responseWrites.keys()].some((id) => id.startsWith("initial-"))
		);
	}, "Rust did not request the initial transcript page");
	const responseId = [...tui.responseWrites.keys()].find((id) => id.startsWith("initial-"));
	assert.ok(responseId, "Host did not finish writing the initial page response");
	const pages = await waitForTrace(tui, "page_applied");
	return { responseId, pageApplied: pages.at(-1) as TraceEvent };
}

function assertPaneFits(pane: string, width: number): void {
	assert.ok(pane.includes("needle ") && pane.includes("src/"), "Rust pane does not contain projected Tool content");
	assert.ok(
		pane.split("\n").every((line) => [...line].length <= width),
		`Rust pane exceeds ${width} columns`,
	);
}

function writeCapture(tui: StartedTui, name: string, width: number, requireContent = true): void {
	const capture = tui.pane();
	writeFileSync(join(tui.artifactDirectory, `${name}.txt`), capture);
	if (requireContent) assertPaneFits(capture, width);
}

type StormComponentDiagnostics = {
	componentId: string;
	generation: number;
	revision: number;
	renderCount: number;
	publishCount: number;
	coalescedCount: number;
	lastFinalState: number | null;
	invalidations: Array<{ invalidateRequestedAt: number; publishedAt?: number; revision?: number }>;
	inputs: Array<{ receivedAt: number; publishedAt: number; revision: number; bytes: number }>;
	editorTextBytes?: number;
	editorTextHash?: string;
};

type OperationRecord = {
	operationId: string;
	clientRequestId: string;
	type: string;
	status: string;
};

function timingSummary(samples: readonly number[]) {
	assert.ok(samples.length > 0, "storm timing series is empty");
	return {
		p50Ms: percentile(samples, 0.5),
		p95Ms: percentile(samples, 0.95),
		p99Ms: percentile(samples, 0.99),
		maxMs: Math.max(...samples),
	};
}

async function readComponentDiagnostics(tui: StartedTui, componentId: string): Promise<StormComponentDiagnostics> {
	const id = `component-diagnostics-${componentId}-${Date.now()}`;
	await tui.control.handle({ type: "request", id, request: { command: "get_diagnostics" } });
	const response = tui.controlMessages.find(
		(message) => message.type === "response" && message.id === id && message.ok,
	);
	if (!response || response.type !== "response" || !response.ok)
		throw new Error("Host did not return component diagnostics");
	const components = (response.result as { extensionComponents?: { components?: StormComponentDiagnostics[] } })
		.extensionComponents?.components;
	const component = components?.find((candidate) => candidate.componentId === componentId);
	if (!component) throw new Error(`Host diagnostics has no ${componentId} component`);
	return component;
}

function observedEditorText(
	diagnostics: StormComponentDiagnostics,
	expected: string,
	label: string,
): { bytes: number; hash: string } {
	const bytes = diagnostics.editorTextBytes;
	const hash = diagnostics.editorTextHash;
	assert.equal(bytes, Buffer.byteLength(expected, "utf8"), `${label} observed editor bytes are incorrect`);
	assert.equal(
		hash,
		createHash("sha256").update(expected).digest("hex"),
		`${label} observed editor hash is incorrect`,
	);
	return { bytes: bytes!, hash: hash! };
}

async function readStormDiagnostics(tui: StartedTui): Promise<StormComponentDiagnostics> {
	return readComponentDiagnostics(tui, "header");
}

async function readOperations(tui: StartedTui): Promise<OperationRecord[]> {
	const id = `operations-${Date.now()}`;
	await tui.control.handle({
		type: "request",
		id,
		request: { command: "list_operations", sessionPath: tui.sessionPath },
	});
	const response = tui.controlMessages.find(
		(message) => message.type === "response" && message.id === id && message.ok,
	);
	if (!response || response.type !== "response" || !response.ok)
		throw new Error("Host did not return operation journal");
	return response.result as OperationRecord[];
}

function customEditorFrames(tui: StartedTui) {
	return tui.serverMessages.flatMap((message) => {
		if (message.type !== "event") return [];
		const event = message.event;
		if (!("componentId" in event) || event.componentId !== "editor") return [];
		if (event.type !== "extension_component_mount" && event.type !== "extension_component_frame") return [];
		return [event.frame];
	});
}

function customEditorActions(tui: StartedTui) {
	return tui.serverMessages.flatMap((message) => {
		if (message.type !== "event") return [];
		const event = message.event;
		if (event.type !== "extension_editor_action" || !("action" in event)) return [];
		return [event.action];
	});
}

function customEditorStateUpdates(tui: StartedTui): Array<{ text: string; cursor: number }> {
	return tui.clientMessages.flatMap((message) =>
		message.type === "request" && message.request.command === "extension_editor_state"
			? [{ text: message.request.text, cursor: message.request.cursor }]
			: [],
	);
}

function customEditorStateTexts(tui: StartedTui): string[] {
	return customEditorStateUpdates(tui).map((state) => state.text);
}

function customEditorPromptRequests(tui: StartedTui): PromptRequestMessage[] {
	return tui.clientMessages.filter(
		(message) => message.type === "request" && message.request.command === "prompt",
	) as PromptRequestMessage[];
}

function contractStatusCounter(tui: StartedTui, key: "completionCalls" | "completionAborts" | "responseCalls"): number {
	const matches = [...JSON.stringify(tui.serverMessages).matchAll(new RegExp(`${key}=(\\d+)`, "g"))];
	return Number(matches.at(-1)?.[1] ?? 0);
}

function operationUpdateStatuses(tui: StartedTui, operationId: string): string[] {
	return tui.serverMessages.flatMap((message) =>
		message.type === "event" &&
		message.event.type === "operation_updated" &&
		message.event.operation.operationId === operationId
			? [message.event.operation.status]
			: [],
	);
}

async function waitForOperationStatus(
	tui: StartedTui,
	operationId: string,
	status: "completed" | "failed",
): Promise<void> {
	await waitFor(async () => {
		await tui.pump();
		const journal = await readOperations(tui);
		return (
			journal.some((operation) => operation.operationId === operationId && operation.status === status) &&
			operationUpdateStatuses(tui, operationId).includes(status)
		);
	}, `operation ${operationId} did not reach ${status} in the Host journal and Rust event stream`);
}

async function releaseDeferredCustomEditorSubmit(tui: StartedTui, key: "C-e" | "C-l"): Promise<void> {
	const data = key === "C-e" ? "\u0005" : "\u000c";
	const before = tui.requests.filter(
		(request) => request.command === "extension_component_input" && request.data === data,
	).length;
	tui.send(key);
	await waitFor(async () => {
		await tui.pump();
		return (
			tui.requests.filter((request) => request.command === "extension_component_input" && request.data === data)
				.length > before
		);
	}, "CustomEditor did not explicitly release the deferred faux response");
}

async function waitForCustomEditor(tui: StartedTui): Promise<void> {
	await waitFor(async () => {
		await tui.pump();
		return customEditorFrames(tui).length > 0;
	}, "CustomEditor did not mount");
}

async function clearCustomEditor(tui: StartedTui): Promise<void> {
	const before = tui.serverMessages.filter(
		(message) =>
			message.type === "event" &&
			message.event.type === "extension_editor_action" &&
			message.event.action.action === "set" &&
			message.event.action.text === "",
	).length;
	tui.send("C-c");
	await waitFor(async () => {
		await tui.pump();
		return (
			tui.serverMessages.filter(
				(message) =>
					message.type === "event" &&
					message.event.type === "extension_editor_action" &&
					message.event.action.action === "set" &&
					message.event.action.text === "",
			).length > before
		);
	}, "CustomEditor clear did not update its Host mirror");
}

async function typeInCustomEditor(tui: StartedTui, text: string): Promise<void> {
	let expected = "";
	for (const character of text) {
		const before = tui.serverMessages.filter(
			(message) =>
				message.type === "event" &&
				message.event.type === "extension_editor_action" &&
				message.event.action.action === "set" &&
				message.event.action.text === `${expected}${character}`,
		).length;
		tui.sendLiteral(character);
		expected += character;
		await waitFor(
			async () => {
				await tui.pump();
				return (
					tui.serverMessages.filter(
						(message) =>
							message.type === "event" &&
							message.event.type === "extension_editor_action" &&
							message.event.action.action === "set" &&
							message.event.action.text === expected,
					).length > before
				);
			},
			`CustomEditor did not mirror ${JSON.stringify(expected)}`,
		);
	}
}

async function armDeferredCustomEditorSubmit(
	tui: StartedTui,
	key: "C-a" | "C-s",
	text: string,
): Promise<OperationRecord> {
	const responseCallsBefore = contractStatusCounter(tui, "responseCalls");
	tui.send(key);
	await waitFor(async () => {
		await tui.pump();
		return tui.requests.some(
			(request) =>
				request.command === "extension_component_input" && request.data === (key === "C-a" ? "\u0001" : "\u0013"),
		);
	}, "CustomEditor did not arm deferred response");
	await clearCustomEditor(tui);
	await typeInCustomEditor(tui, text);
	tui.send("Enter");
	const prompt = await waitForRequest(tui, "prompt");
	let operation: OperationRecord | undefined;
	await waitFor(async () => {
		await tui.pump();
		const accepted = tui.serverMessages.find(
			(message) =>
				message.type === "response" &&
				message.id === prompt.id &&
				message.ok &&
				(message.result as { operation?: OperationRecord }).operation?.type === "prompt",
		);
		if (!accepted || accepted.type !== "response" || !accepted.ok) return false;
		operation = (accepted.result as { operation: OperationRecord }).operation;
		return operation.status === "accepted";
	}, "CustomEditor prompt was not accepted");
	await waitFor(async () => {
		await tui.pump();
		return (
			operationUpdateStatuses(tui, operation!.operationId).includes("running") &&
			(await readOperations(tui)).some(
				(candidate) => candidate.operationId === operation!.operationId && candidate.status === "running",
			) &&
			contractStatusCounter(tui, "responseCalls") > responseCallsBefore
		);
	}, "CustomEditor prompt did not reach running deferred faux response");
	return operation!;
}

async function pasteCustomEditorImage(tui: StartedTui, expectedCount: number): Promise<void> {
	const reads = tui.requests.filter((request) => request.command === "read_clipboard_image").length;
	tui.send("C-v");
	await waitForRequest(tui, "read_clipboard_image", reads + 1);
	await waitFor(
		() => tui.pane().includes(`图片 ${expectedCount}`) || tui.pane().includes("选择剪贴板内容"),
		`clipboard image did not settle for attachment ${expectedCount}`,
	);
	if (tui.pane().includes("选择剪贴板内容")) {
		tui.send("Down", "Enter");
		await waitFor(() => !tui.pane().includes("选择剪贴板内容"), "clipboard image selection overlay did not close");
	}
	await waitFor(
		() => tui.pane().includes(`图片 ${expectedCount}`),
		`clipboard image did not produce attachment ${expectedCount}`,
	);
}

function startProcessTreeSampling(pid: number) {
	const rssSamples = [rssTree(pid)];
	const cpuStartedAt = processTreeCpuMilliseconds(pid);
	const timer = setInterval(() => rssSamples.push(rssTree(pid)), 10);
	return {
		stop: () => {
			clearInterval(timer);
			return {
				rssP95Bytes: percentile(rssSamples, 0.95),
				rssMaxBytes: Math.max(...rssSamples),
				cpuMs: Math.max(0, processTreeCpuMilliseconds(pid) - cpuStartedAt),
				sampleCount: rssSamples.length,
			};
		},
	};
}

function startHostBenchmarkSampling() {
	const rssSamples = [process.memoryUsage().rss];
	const cpuStartedAt = process.cpuUsage();
	const timer = setInterval(() => rssSamples.push(process.memoryUsage().rss), 10);
	return {
		stop: () => {
			clearInterval(timer);
			rssSamples.push(process.memoryUsage().rss);
			const cpu = process.cpuUsage(cpuStartedAt);
			return {
				hostPeakRssBytes: Math.max(...rssSamples),
				hostCpuMs: (cpu.user + cpu.system) / 1_000,
			};
		},
	};
}

function transcriptRegroupSignature(tui: StartedTui): string {
	const pages = tui.requests.filter((request) => request.command === "read_transcript").length;
	const applied = tui.traces().filter((trace) => trace.event === "page_applied").length;
	return `${pages}:${applied}`;
}

function componentFrameTraces(tui: StartedTui, traceStart: number, componentId: string): TraceEvent[] {
	return tui
		.traces()
		.slice(traceStart)
		.filter(
			(trace) =>
				trace.event === "extension_component_frame_applied" &&
				trace.componentId === componentId &&
				trace.revision !== undefined &&
				trace.bytes !== undefined,
		);
}

function frameByRevision(frames: readonly TraceEvent[], revision: number): TraceEvent {
	const frame = frames.find((candidate) => candidate.revision === revision);
	assert.ok(frame, `Rust trace is missing component revision ${revision}`);
	return frame;
}

function customEditorFrameWithLine(tui: StartedTui, line: string) {
	return tui.serverMessages
		.flatMap((message) => {
			if (message.type !== "event") return [];
			const event = message.event;
			if (
				(event.type !== "extension_component_mount" && event.type !== "extension_component_frame") ||
				event.componentId !== "editor" ||
				!event.frame.lines.some((candidate) => candidate.includes(line))
			)
				return [];
			return [event.frame];
		})
		.at(-1);
}

function componentFrameBytes(tui: StartedTui, componentId: string, revision: number): number {
	const frame = tui.serverMessages
		.flatMap((message) => {
			if (message.type !== "event") return [];
			const event = message.event;
			if (
				(event.type !== "extension_component_mount" && event.type !== "extension_component_frame") ||
				event.componentId !== componentId ||
				event.frame.revision !== revision
			)
				return [];
			return [event.frame];
		})
		.at(-1);
	assert.ok(frame, `Host event is missing component revision ${revision}`);
	return Buffer.byteLength(frame.lines.join("\n"), "utf8");
}

function createContractRuntimeHost(directory: string): Promise<RealRuntimeHost> {
	return (async () => {
		const agentDir = join(directory, "agent");
		const cwd = join(directory, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "lystar-contract-faux",
				defaultModel: "contract-1",
				defaultThinkingLevel: "off",
				defaultProjectTrust: "always",
				extensions: [fileURLToPath(new URL("./fixtures/runtime-contract-extension.ts", import.meta.url))],
			}),
		);
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		const sessionPath = runtime.sessionPath;
		await runtime.dispose();
		return { adapter, agentDir, sessionPath };
	})();
}

const CUSTOM_EDITOR_COMPANION = fileURLToPath(
	new URL("./fixtures/runtime-custom-editor-companion-extension.ts", import.meta.url),
);
const CUSTOM_EDITOR_CONTRACT = resolve(
	repositoryRoot,
	"packages/coding-agent/examples/extensions/runtime-custom-editor-contract-extension.ts",
);
const CUSTOM_EDITOR_EXAMPLES = {
	border: resolve(repositoryRoot, "packages/coding-agent/examples/extensions/border-status-editor.ts"),
	modal: resolve(repositoryRoot, "packages/coding-agent/examples/extensions/modal-editor.ts"),
	rainbow: resolve(repositoryRoot, "packages/coding-agent/examples/extensions/rainbow-editor.ts"),
} as const;

type CustomEditorExample = keyof typeof CUSTOM_EDITOR_EXAMPLES;

function createCustomEditorContractRuntimeHost(directory: string): Promise<RealRuntimeHost> {
	return (async () => {
		const agentDir = join(directory, "agent");
		const cwd = join(directory, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, "images"), { recursive: true });
		writeFileSync(
			join(cwd, "images", "中文 图片.png"),
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WAAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "lystar-custom-editor-contract-faux",
				defaultModel: "contract-1",
				defaultThinkingLevel: "off",
				defaultProjectTrust: "always",
				extensions: [CUSTOM_EDITOR_CONTRACT],
				retry: { enabled: false },
			}),
		);
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		let clipboardImageReads = 0;
		(
			adapter as unknown as {
				readClipboardImage(): Promise<{
					capability: boolean;
					available: boolean;
					mimeType: string;
					byteLength: number;
					contentHash: string;
					data: string;
				}>;
			}
		).readClipboardImage = async () => {
			clipboardImageReads++;
			return {
				capability: true,
				available: true,
				mimeType: "image/png",
				byteLength: 68,
				contentHash: `custom-editor-clipboard-png-${clipboardImageReads}`,
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WAAAAABJRU5ErkJggg==",
			};
		};
		const runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		const sessionPath = runtime.sessionPath;
		await runtime.dispose();
		return { adapter, agentDir, sessionPath };
	})();
}

function createCustomEditorRuntimeHost(directory: string, example: CustomEditorExample): Promise<RealRuntimeHost> {
	return (async () => {
		const agentDir = join(directory, "agent");
		const cwd = join(directory, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "bench-target.ts"), "export const benchTarget = true;\n");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "lystar-custom-editor-faux",
				defaultModel: "editor-1",
				defaultThinkingLevel: "off",
				defaultProjectTrust: "always",
				extensions: [CUSTOM_EDITOR_COMPANION, CUSTOM_EDITOR_EXAMPLES[example]],
			}),
		);
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
		const sessionPath = runtime.sessionPath;
		await runtime.dispose();
		return { adapter, agentDir, sessionPath };
	})();
}

function componentStormBenchmarkConfig() {
	const artifact = process.env.LYSTAR_EXTENSION_COMPONENT_STORM_ARTIFACT;
	if (!artifact) return undefined;
	return {
		artifact,
		rounds: process.env.LYSTAR_EXTENSION_COMPONENT_STORM_SMOKE === "1" ? 1 : 5,
		sizes:
			process.env.LYSTAR_EXTENSION_COMPONENT_STORM_SMOKE === "1"
				? [{ width: 80, height: 24 }]
				: [
						{ width: 80, height: 24 },
						{ width: 120, height: 36 },
						{ width: 200, height: 60 },
					],
	};
}

const componentStormBenchmark = componentStormBenchmarkConfig();

type RustCustomEditorBenchmarkScenario = {
	name: "custom_editor_input300" | "paste5000" | "render_animation" | "autocomplete";
	eventCount: number;
	input?: { encoding: "ascii"; character: string; count: number };
	animationFrames?: number;
	autocomplete?: { source: string; completion: string; tabs: number };
	thresholds: { p95Ms: number; p99Ms: number };
};

type RustCustomEditorBenchmarkConfig = {
	implementation: "rust-custom-editor";
	sizes: Array<[number, number]>;
	rounds: number;
	rssLimitBytes: number;
	scenarios: RustCustomEditorBenchmarkScenario[];
};

function rustCustomEditorBenchmarkConfig(): (RustCustomEditorBenchmarkConfig & { artifact: string }) | undefined {
	const artifact = process.env.LYSTAR_RUST_CUSTOM_EDITOR_ARTIFACT;
	const serialized = process.env.LYSTAR_RUST_CUSTOM_EDITOR_BENCHMARK_CONFIG;
	if (!artifact || !serialized) return undefined;
	return { ...(JSON.parse(serialized) as RustCustomEditorBenchmarkConfig), artifact };
}

const rustCustomEditorBenchmark = rustCustomEditorBenchmarkConfig();
let rustCustomEditorBenchmarkWarmed = false;

function emitCommitted(runtime: FakeRuntimeSession, generation: string, fromRevision: number): void {
	runtime.emit({
		type: "entry_committed",
		payload: {
			items: [
				{
					entryId: "append-assistant",
					parentId: "result-239",
					timestamp: "2026-08-15T00:00:00Z",
					kind: "message",
					payload: {
						message: {
							role: "assistant",
							content: [
								{ type: "toolCall", id: "append-call", name: "append-tool", arguments: { path: "append.ts" } },
							],
						},
					},
				},
				{
					entryId: "append-result",
					parentId: "append-assistant",
					timestamp: "2026-08-15T00:00:00Z",
					kind: "message",
					payload: {
						message: {
							role: "toolResult",
							toolCallId: "append-call",
							toolName: "append-tool",
							content: [{ type: "text", text: "append-visible" }],
							isError: false,
						},
					},
				},
			],
			transcriptGeneration: generation,
			fromRevision,
			transcriptRevision: fromRevision + 1,
		},
	} as RuntimeEvent);
}

describe("Rust read-only TUI fd bridge", () => {
	it("drives PageUp, search, runtime append, reload, captures layouts, and exits on EOF twice", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(240, { width: 80, height: 24 }, `e2e-${attempt + 1}`);
			try {
				const initial = await waitForInitialPage(tui);
				const initialResponse = tui.responseWrites.get(initial.responseId);
				assert.ok(initialResponse, "initial response write timestamp is missing");
				const initialFrame = await waitForTrace(tui, "frame_rendered_nonempty");
				assert.ok(
					initialFrame.some((frame) => frame.atMs >= initialResponse),
					"initial page was not rendered after Host response write",
				);
				writeCapture(tui, "80x24", 80);

				for (const [width, height] of [
					[120, 36],
					[200, 60],
				] as const) {
					const beforeFrames = tui.traces().filter((event) => event.event === "frame_rendered").length;
					tui.resize(width, height);
					await waitForTrace(tui, "frame_rendered", beforeFrames + 1);
					writeCapture(tui, `${width}x${height}`, width);
				}
				const beforeSmallFrames = tui.traces().filter((event) => event.event === "frame_rendered").length;
				tui.resize(80, 8);
				await waitForTrace(tui, "frame_rendered", beforeSmallFrames + 1);
				writeCapture(tui, "80x8-compat", 80, false);
				tui.resize(80, 24);
				await waitForTrace(tui, "frame_rendered", beforeSmallFrames + 2);

				const olderPageCount = tui.traces().filter((event) => event.event === "page_applied").length;
				for (let index = 1; index <= 10; index++) {
					tui.send("PPage");
					await waitForTrace(tui, "key_page_up", index);
				}
				await waitFor(async () => {
					await tui.pump();
					return tui.requests.some((request) => request.id.startsWith("older-"));
				}, "tmux PPage did not produce an older transcript request");
				await waitForTrace(tui, "page_applied", olderPageCount + 1);
				tui.send("Home");
				await waitForTrace(tui, "key_home");

				tui.send("C-f");
				await waitForTrace(tui, "search_open");
				tui.sendLiteral("needle 12");
				tui.send("Enter");
				await waitForTrace(tui, "search_submit");
				await waitFor(async () => {
					await tui.pump();
					return tui.requests.some((request) => request.command === "search_transcript");
				}, "Rust did not submit the transcript search request");
				await waitForTrace(tui, "search_applied");
				await waitFor(() => tui.pane().includes("needle 12"), "Rust pane does not display the Host search result");
				tui.send("Escape");
				await waitForTrace(tui, "search_close");
				await waitFor(
					() => !tui.pane().includes("搜索:"),
					"Rust search overlay did not close before runtime append verification",
				);
				tui.send("End");
				await waitForTrace(tui, "key_end");

				const beforeAppend = tui.traces().filter((event) => event.event === "append_applied").length;
				const metadata = readInitialMetadata(tui);
				emitCommitted(tui.runtime, metadata.generation, metadata.revision);
				await waitForTrace(tui, "append_applied", beforeAppend + 1);
				tui.send("C-o");
				await waitFor(
					() => tui.pane().includes("append-visible"),
					"Rust pane does not display the Tool projected from the active runtime event",
				);
				writeFileSync(join(tui.artifactDirectory, "append-expanded.txt"), tui.pane());

				const initialRequestsBeforeGap = tui.requests.filter((request) => request.id.startsWith("initial-")).length;
				const reloadsBeforeGap = tui.traces().filter((event) => event.event === "reload_requested").length;
				tui.runtime.emit({
					type: "entry_committed",
					payload: {
						items: [],
						transcriptGeneration: metadata.generation,
						fromRevision: metadata.revision + 2,
						transcriptRevision: metadata.revision + 3,
					},
				} as RuntimeEvent);
				await waitForTrace(tui, "reload_requested", reloadsBeforeGap + 1);
				await waitFor(async () => {
					await tui.pump();
					return (
						tui.requests.filter((request) => request.id.startsWith("initial-")).length > initialRequestsBeforeGap
					);
				}, "revision gap did not make Rust request a new initial transcript page");
				await waitForTrace(tui, "page_applied", olderPageCount + 2);

				tui.closeProtocol();
				await waitFor(
					() => spawnSync("tmux", ["-L", tui.socket, "has-session", "-t", "tui"]).status !== 0,
					"Rust TUI did not exit after protocol EOF",
				);
				writeFileSync(join(tui.artifactDirectory, "metrics.json"), `${JSON.stringify({ attempt, initial })}\n`);
			} finally {
				tui.closeProtocol();
			}
		}
	}, 90_000);

	it("submits prompt once, routes streaming input, projects typed Tool state, and journals clear queue twice", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(4, { width: 80, height: 24 }, `interactive-${attempt + 1}`);
			try {
				await waitForInitialPage(tui);
				await waitFor(async () => {
					await tui.pump();
					return tui.serverMessages.some(
						(message) => message.type === "response" && message.id.startsWith("acquire-") && message.ok,
					);
				}, "Host did not return the Rust lease");
				tui.sendLiteral("first prompt");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.prompts.length === 1;
				}, "Enter did not invoke prompt exactly once");
				assert.deepEqual(tui.runtime.prompts, ["first prompt"]);

				tui.runtime.setRunning(true);
				await new Promise((resolve) => setTimeout(resolve, 30));
				tui.sendLiteral("steer now");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.steers.length === 1;
				}, "streaming Enter did not invoke steer");
				tui.sendLiteral("follow later");
				tui.send("M-Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.followUps.length === 1;
				}, "Alt+Enter did not invoke follow_up");

				tui.runtime.emit({ type: "progress", payload: { type: "assistant_delta", text: "live assistant" } });
				tui.runtime.emit({ type: "progress", payload: { type: "thinking_delta", text: "live thinking" } });
				tui.runtime.emit({
					type: "progress",
					payload: { type: "tool_start", toolCallId: "live-call", name: "read", summary: "src/live.ts" },
				});
				tui.runtime.emit({
					type: "progress",
					payload: { type: "tool_update", toolCallId: "live-call", name: "read", summary: "reading" },
				});
				await waitFor(() => tui.pane().includes("Tool read"), "typed Tool progress is not visible in Composer");

				tui.runtime.setRunning(false);
				tui.runtime.holdPrompt = true;
				tui.sendLiteral("abort prompt");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.prompts.length === 2;
				}, "pending prompt was not accepted");
				tui.send("Escape");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.abortCount === 1;
				}, "Esc did not abort the active operation");
				tui.runtime.holdPrompt = false;

				const clientInstanceId = tui.clientInstanceId;
				const clear = {
					type: "request" as const,
					id: "clear-first",
					request: {
						command: "clear_queue" as const,
						sessionPath: tui.sessionPath,
						leaseId: "",
						clientInstanceId,
						clientRequestId: "clear-once",
					},
				};
				const snapshot = tui.serverMessages.find(
					(message) =>
						message.type === "event" &&
						message.event.type === "session_snapshot" &&
						message.event.snapshot.writeAccess === "owned",
				);
				assert.ok(snapshot, "missing owned snapshot for Rust lease");
				const acquire = tui.serverMessages.find(
					(message) => message.type === "response" && message.id.startsWith("acquire-") && message.ok,
				);
				assert.ok(acquire && acquire.type === "response" && acquire.ok, "missing Rust acquire response");
				const leaseId = (acquire.result as { lease: { leaseId: string } }).lease.leaseId;
				const retryPrompt = {
					type: "request" as const,
					id: "prompt-first",
					request: {
						command: "prompt" as const,
						sessionPath: tui.sessionPath,
						leaseId,
						clientInstanceId,
						clientRequestId: "response-lost-prompt",
						text: "retry once",
					},
				};
				await tui.connection.handle(retryPrompt);
				await tui.connection.handle({ ...retryPrompt, id: "prompt-retry" });
				await waitFor(
					() => tui.runtime.prompts.filter((text) => text === "retry once").length === 1,
					"prompt retry was not journal-idempotent",
				);

				clear.request.leaseId = leaseId;
				await tui.connection.handle(clear);
				await tui.connection.handle({ ...clear, id: "clear-retry" });
				await waitFor(() => tui.runtime.clearQueueCount === 1, "clear_queue retry was not journal-idempotent");
			} finally {
				tui.closeProtocol();
			}
		}
	}, 120_000);

	it("drives the real CodingAgentRuntimeAdapter Extension UI over fd3/fd4 twice", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(
				0,
				{ width: 80, height: 8 },
				`extension-runtime-${attempt + 1}`,
				undefined,
				{},
				async ({ directory }) => {
					const agentDir = join(directory, "agent");
					const cwd = join(directory, "project");
					mkdirSync(agentDir, { recursive: true });
					mkdirSync(cwd, { recursive: true });
					writeFileSync(
						join(agentDir, "settings.json"),
						JSON.stringify({
							defaultProvider: "lystar-contract-faux",
							defaultModel: "contract-1",
							defaultThinkingLevel: "off",
							defaultProjectTrust: "always",
							extensions: [fileURLToPath(new URL("./fixtures/runtime-contract-extension.ts", import.meta.url))],
							retry: { enabled: false },
						}),
					);
					const adapter = new CodingAgentRuntimeAdapter(agentDir);
					const runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
					const sessionPath = runtime.sessionPath;
					await runtime.dispose();
					return { adapter, agentDir, sessionPath };
				},
			);
			try {
				await waitForInitialPage(tui);
				await waitFor(async () => {
					await tui.pump();
					return tui.serverMessages.some(
						(message) => message.type === "response" && message.id.startsWith("acquire-") && message.ok,
					);
				}, "real runtime did not acquire the Rust lease");
				await waitFor(() => tui.pane().includes("Enter 提交"), "80x8 did not retain the composer shortcut");
				const beforeInput = tui.requests.filter((request) => request.command === "extension_terminal_input").length;
				tui.sendLiteral("idle");
				await new Promise((resolve) => setTimeout(resolve, 80));
				await tui.pump();
				assert.equal(
					tui.requests.filter((request) => request.command === "extension_terminal_input").length,
					beforeInput,
					"idle input without a listener must not round-trip",
				);
				tui.send("C-u");
				tui.sendLiteral("/contract-rust-ui-malicious");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.rawOutput().includes("title]0;injected31m");
				}, "sanitized malicious Extension text did not reach the terminal");
				assert.ok(
					!tui.rawOutput().includes("\u001b]0;injected"),
					"Extension control sequence reached the terminal",
				);
				tui.send("Escape");
				await waitFor(() => !tui.pane().includes("认证状态已更新"), "malicious notify did not close");
				tui.send("C-u");
				await new Promise((resolve) => setTimeout(resolve, 20));

				tui.sendLiteral("/contract-rust-ui");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("Extension Select");
				}, "real Extension select did not render");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("Proceed?");
				}, "real Extension confirm did not render");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("Extension Input");
				}, "real Extension input did not render");
				tui.sendLiteral("typed");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("before");
				}, "real Extension editor did not render");
				tui.sendLiteral("-edited");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("rust ui ready alpha/true/typed/before-edited");
				}, "real Extension notify did not render");
				tui.send("Escape");

				tui.resize(80, 24);
				await waitFor(
					() => tui.pane().includes("extension widget"),
					"Extension widget did not render after resize",
				);
				assert.ok(tui.rawOutput().includes("ready"), "Extension status did not reach the terminal");
				tui.send("Up");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("up");
				}, "terminal listener rewrite did not reach the editor");

				const inputCount = tui.requests.filter((request) => request.command === "extension_terminal_input").length;
				for (let sample = 0; sample < 200; sample++) {
					tui.sendLiteral("x");
					await waitFor(
						async () => {
							await tui.pump();
							const requests = tui.requests.filter((request) => request.command === "extension_terminal_input");
							const applied = tui.traces().filter((event) => event.event === "extension_input_applied");
							return requests.length >= inputCount + sample + 1 && applied.length >= inputCount + sample + 1;
						},
						`Extension input sample ${sample} did not complete`,
						1_000,
					);
				}
				const inputRequests = tui.requests
					.filter((request) => request.command === "extension_terminal_input")
					.slice(inputCount);
				const applied = tui
					.traces()
					.filter((event) => event.event === "extension_input_applied" && event.id)
					.slice(inputCount);
				assert.equal(inputRequests.length, 200, "terminal listener request count drifted");
				assert.equal(applied.length, 200, "terminal listener apply count drifted");
				assert.equal(
					new Set(applied.map((event) => event.id)).size,
					200,
					"terminal listener applied a response twice",
				);
				const receivedAt = new Map(inputRequests.map((request) => [request.id, request.receivedAt]));
				const samples = applied.map((event) => {
					const receipt = receivedAt.get(event.id!);
					assert.notEqual(receipt, undefined, `Rust applied unknown input response ${event.id}`);
					return event.atMs - receipt!;
				});
				const p95 = percentile(samples, 0.95);
				const p99 = percentile(samples, 0.99);
				writeFileSync(
					join(tui.artifactDirectory, "extension-input-perf.json"),
					`${JSON.stringify({ sampleCount: samples.length, p95, p99, fallbackSamples: 0, duplicateApplications: 0 })}\n`,
				);
				assert.ok(p95 <= 16, `input p95 ${p95}ms exceeds 16ms`);
				assert.ok(p99 <= 33, `input p99 ${p99}ms exceeds 33ms`);
				assert.ok(!tui.rawOutput().includes("终端输入 bridge 超时"), "input fallback sample was not isolated");

				tui.closeProtocol();
				await waitFor(
					() => spawnSync("tmux", ["-L", tui.socket, "has-session", "-t", "tui"]).status !== 0,
					"Rust TUI did not exit after real Host EOF",
				);
				assert.ok(tui.rawOutput().includes("\u001b]0;\u0007"), "EOF did not clear the Extension title");
			} finally {
				tui.closeProtocol();
			}
		}
	}, 120_000);

	it("drives real dynamic Extension commands, completions, command palette, and shortcuts twice", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(
				0,
				{ width: 80, height: 24 },
				`extension-dynamic-${attempt + 1}`,
				undefined,
				{},
				async ({ directory }) => {
					const agentDir = join(directory, "agent");
					const cwd = join(directory, "project");
					mkdirSync(agentDir, { recursive: true });
					mkdirSync(cwd, { recursive: true });
					writeFileSync(
						join(agentDir, "settings.json"),
						JSON.stringify({
							defaultProjectTrust: "always",
							extensions: [fileURLToPath(new URL("./fixtures/runtime-dynamic-extension.ts", import.meta.url))],
						}),
					);
					const adapter = new CodingAgentRuntimeAdapter(agentDir);
					const runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
					const sessionPath = runtime.sessionPath;
					await runtime.dispose();
					return { adapter, agentDir, sessionPath };
				},
			);
			try {
				await waitForInitialPage(tui);
				await waitFor(async () => {
					await tui.pump();
					return tui.serverMessages.some(
						(message) =>
							message.type === "event" &&
							message.event.type === "extension_ui_snapshot" &&
							message.event.state.extensionShortcutCount === 1,
					);
				}, "dynamic Extension shortcut state did not reach Rust");

				const completionCount = tui.requests.filter((request) => request.command === "get_completions").length;
				tui.sendLiteral("/dynamic");
				tui.send("Tab");
				const commandCompletion = (await waitForRequest(
					tui,
					"get_completions",
					completionCount + 1,
				)) as CompletionRequestMessage;
				assert.equal(commandCompletion.request.command, "get_completions");
				assert.equal(commandCompletion.request.text, "/dynamic");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("命令补全") && tui.pane().includes("dynamic-contract");
				}, "dynamic Extension slash completion did not render");
				const commandResponse = tui.serverMessages.find(
					(message) => message.type === "response" && message.id === commandCompletion.id && message.ok,
				);
				assert.ok(commandResponse && commandResponse.type === "response" && commandResponse.ok);
				assert.ok(
					(commandResponse.result as { items: Array<{ label: string; kind: string }> }).items.some(
						(item) => item.label === "dynamic-contract" && item.kind === "extension",
					),
				);
				tui.send("Enter", "Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.clientMessages.some(
						(message) =>
							message.type === "request" &&
							message.request.command === "prompt" &&
							message.request.text === "/dynamic-contract",
					);
				}, "selected dynamic Extension command was not submitted");
				await waitFor(async () => {
					await tui.pump();
					return tui.serverMessages.some(
						(message) =>
							message.type === "event" &&
							message.event.type === "extension_ui_delta" &&
							message.event.delta.statuses?.some(
								(status) => status.key === "dynamic-command" && status.text === "handled",
							),
					);
				}, "dynamic Extension command did not execute");

				const argumentCompletionCount = tui.requests.filter(
					(request) => request.command === "get_completions",
				).length;
				tui.send("C-u");
				await waitFor(async () => {
					await tui.pump();
					return !tui.pane().includes("/dynamic-contract");
				}, "Composer did not clear the old command");
				tui.sendLiteral("/dynamic-contract");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("/dynamic-contract");
				}, "dynamic command prefix did not reach Composer");
				tui.sendLiteral(" ");
				tui.sendLiteral("a");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("/dynamic-contract a");
				}, "dynamic argument prefix did not reach Composer");
				tui.send("Tab");
				const argumentCompletion = (await waitForRequest(
					tui,
					"get_completions",
					argumentCompletionCount + 1,
				)) as CompletionRequestMessage;
				assert.equal(argumentCompletion.request.text, "/dynamic-contract a");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("命令补全") && tui.pane().includes("alpha");
				}, "dynamic Extension argument completion did not render");
				tui.send("Enter", "Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.clientMessages.some(
						(message) =>
							message.type === "request" &&
							message.request.command === "prompt" &&
							message.request.text === "/dynamic-contract alpha",
					);
				}, "selected dynamic Extension argument was not submitted");

				const panelCompletionCount = tui.requests.filter((request) => request.command === "get_completions").length;
				tui.send("C-p");
				const panelCompletion = (await waitForRequest(
					tui,
					"get_completions",
					panelCompletionCount + 1,
				)) as CompletionRequestMessage;
				assert.equal(panelCompletion.request.text, "/");
				const panelResponse = tui.serverMessages.find(
					(message) => message.type === "response" && message.id === panelCompletion.id && message.ok,
				);
				assert.ok(panelResponse && panelResponse.type === "response" && panelResponse.ok);
				assert.ok(
					(panelResponse.result as { items: Array<{ label: string; kind: string }> }).items.some(
						(item) => item.label === "dynamic-contract" && item.kind === "extension",
					),
				);
				tui.sendLiteral("dynamic");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("命令面板") && tui.pane().includes("dynamic-contract");
				}, "Ctrl+P did not merge the dynamic Extension command");

				tui.send("Escape");
				const shortcutSequence = "\u001b[117;6u";
				tui.sendLiteral(shortcutSequence);
				await waitFor(async () => {
					await tui.pump();
					return tui.serverMessages.some(
						(message) =>
							message.type === "event" &&
							message.event.type === "extension_ui_delta" &&
							message.event.delta.statuses?.some(
								(status) => status.key === "dynamic-shortcut" && status.text === "handled",
							),
					);
				}, "dynamic Extension shortcut did not execute");
				assert.ok(
					tui.requests.some(
						(request) => request.command === "extension_terminal_input" && request.data === shortcutSequence,
					),
					"Rust did not forward the raw dynamic shortcut sequence",
				);
			} finally {
				await finishTuiRound(tui);
			}
		}
	}, 120_000);

	it("drives real Extension Components through Rust mount, input, visibility, completion, and cancellation twice", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(
				0,
				{ width: 80, height: 8 },
				`extension-components-${attempt + 1}`,
				undefined,
				{},
				async ({ directory }) => {
					const agentDir = join(directory, "agent");
					const cwd = join(directory, "project");
					mkdirSync(agentDir, { recursive: true });
					mkdirSync(cwd, { recursive: true });
					writeFileSync(
						join(agentDir, "settings.json"),
						JSON.stringify({
							defaultProvider: "lystar-contract-faux",
							defaultModel: "contract-1",
							defaultThinkingLevel: "off",
							defaultProjectTrust: "always",
							extensions: [fileURLToPath(new URL("./fixtures/runtime-contract-extension.ts", import.meta.url))],
						}),
					);
					const adapter = new CodingAgentRuntimeAdapter(agentDir);
					const runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
					const sessionPath = runtime.sessionPath;
					await runtime.dispose();
					return { adapter, agentDir, sessionPath };
				},
			);
			try {
				await waitForInitialPage(tui);
				await waitFor(async () => {
					await tui.pump();
					return tui.serverMessages.some(
						(message) => message.type === "response" && message.id.startsWith("acquire-") && message.ok,
					);
				}, "component runtime did not acquire the Rust lease");

				const open = async () => {
					tui.send("C-u");
					tui.sendLiteral("/contract-components");
					tui.send("Enter");
					await waitFor(async () => {
						await tui.pump();
						return tui.pane().includes("component overlay");
					}, "Rust did not render the custom Extension Component");
				};
				await open();
				assert.ok(tui.pane().includes("Ctrl+O Tool"), "80x8 component overlay lost Composer shortcuts");
				const inputBefore = tui.requests.filter(
					(request) => request.command === "extension_component_input",
				).length;
				tui.sendLiteral("a");
				await waitFor(async () => {
					await tui.pump();
					return (
						tui.requests.filter((request) => request.command === "extension_component_input").length ===
						inputBefore + 1
					);
				}, "component key did not reach Host");
				await waitFor(
					() => tui.pane().includes("component overlay a"),
					"component frame did not update after input",
				);
				tui.send("h");
				await waitForTrace(tui, "component_visibility_applied", 2);
				await waitFor(
					() => tui.pane().includes("component overlay"),
					"component hide/show did not restore the frame",
				);
				tui.send("Up");
				await waitFor(async () => {
					await tui.pump();
					return tui.requests.some(
						(request) => request.command === "extension_component_input" && request.data === "\u001b[A",
					);
				}, "Rust did not preserve the arrow key as a raw component input sequence");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.traces().some((event) => event.event === "component_unmount_applied");
				}, "component completion did not unmount the custom overlay");
				tui.resize(80, 24);
				await waitFor(async () => {
					await tui.pump();
					return tui.requests.some((request) => request.command === "extension_component_resize");
				}, "component resize did not reach Host");
				await waitFor(
					() =>
						tui.pane().includes("component header") &&
						tui.pane().includes("component footer replace") &&
						tui.pane().includes("component above") &&
						tui.pane().includes("component below"),
					"component header, footer, and widgets did not render after resize",
				);

				tui.resize(80, 8);
				await open();
				const unmountsBeforeCancel = tui
					.traces()
					.filter((event) => event.event === "component_unmount_applied").length;
				tui.send("Escape");
				await waitFor(async () => {
					await tui.pump();
					return tui.requests.some((request) => request.command === "extension_component_custom_cancel");
				}, "Esc did not send extension_component_custom_cancel");
				await waitFor(
					() =>
						tui.traces().filter((event) => event.event === "component_unmount_applied").length >
						unmountsBeforeCancel,
					"Esc cancellation did not unmount the custom component",
				);
				await waitFor(() => tui.pane().includes("Ctrl+O Tool"), "Esc cancellation did not restore the Composer");
				await waitFor(
					() => tui.pane().includes("Enter 提交"),
					"Esc cancellation did not return control to the Composer",
				);
			} finally {
				tui.closeProtocol();
			}
		}
	}, 180_000);

	describe("CustomEditor Host-Rust PTY 场景", () => {
		it(
			"A editing-lifecycle：草稿、Unicode、粘贴、历史与 factory 失败",
			async () => {
				const attempts = Number(process.env.LYSTAR_CUSTOM_EDITOR_ATTEMPTS ?? 2);
				for (let attempt = 0; attempt < attempts; attempt++) {
					const tui = await startTui(
						0,
						{ width: 80, height: 8 },
						`custom-editor-contract-${attempt + 1}`,
						undefined,
						{ captureRawOutput: false, nonBlockingPromptRequests: true },
						async ({ directory }) => createCustomEditorContractRuntimeHost(directory),
					);
					try {
						await waitForInitialPage(tui);
						await waitFor(
							async () => {
								await tui.pump();
								return tui.serverMessages.some(
									(message) =>
										message.type === "event" &&
										message.event.type === "extension_component_mount" &&
										message.event.componentId === "editor",
								);
							},
							() =>
								`contract CustomEditor did not mount from session_start: ${JSON.stringify({ pane: tui.pane(), events: tui.serverMessages.filter((message) => message.type === "event") })}`,
						);
						await waitFor(
							() =>
								tui.serverMessages.some(
									(message) =>
										message.type === "event" &&
										message.event.type === "extension_component_mount" &&
										message.event.componentId === "editor" &&
										message.event.frame.lines.some((line) => line.includes("预置草稿 中文")),
								),
							"draft did not migrate into the mounted CustomEditor frame",
						);
						assert.ok(tui.pane().includes("Enter 提交"), "80x8 CustomEditor lost Composer shortcuts");
						tui.resize(80, 24);
						await waitFor(() => tui.pane().includes("预置草稿 中文"), "CustomEditor did not render after resize");

						const initialEditorGeneration = tui.serverMessages.find(
							(message) =>
								message.type === "event" &&
								message.event.type === "extension_component_mount" &&
								message.event.componentId === "editor",
						);
						if (
							!initialEditorGeneration ||
							initialEditorGeneration.type !== "event" ||
							initialEditorGeneration.event.type !== "extension_component_mount"
						) {
							throw new Error("contract editor mount event is missing");
						}
						let currentEditorGeneration = initialEditorGeneration.event.generation;

						const clearBeforeSlash = tui.requests.filter(
							(request) => request.command === "extension_component_input",
						).length;
						const framesBeforeSlash = tui.serverMessages.filter(
							(message) => message.type === "event" && message.event.type === "extension_component_frame",
						).length;
						tui.send("C-c");
						await waitFor(async () => {
							await tui.pump();
							return (
								tui.requests.filter(
									(request) => request.command === "extension_component_input" && request.data === "\u0003",
								).length > 0 &&
								tui.serverMessages.filter(
									(message) => message.type === "event" && message.event.type === "extension_component_frame",
								).length > framesBeforeSlash
							);
						}, "CustomEditor app.clear did not reach the Host frame");
						assert.ok(
							clearBeforeSlash <
								tui.requests.filter((request) => request.command === "extension_component_input").length,
						);

						const framesBeforeCompletion = tui.serverMessages.filter(
							(message) => message.type === "event" && message.event.type === "extension_component_frame",
						).length;
						for (const character of "/editor-contract-unm") {
							const inputsBeforeCharacter = tui.requests.filter(
								(request) => request.command === "extension_component_input",
							).length;
							const framesBeforeCharacter = tui.serverMessages.filter(
								(message) => message.type === "event" && message.event.type === "extension_component_frame",
							).length;
							tui.sendLiteral(character);
							await waitFor(
								async () => {
									await tui.pump();
									return (
										tui.requests.filter((request) => request.command === "extension_component_input").length >
											inputsBeforeCharacter &&
										tui.serverMessages.filter(
											(message) =>
												message.type === "event" && message.event.type === "extension_component_frame",
										).length > framesBeforeCharacter
									);
								},
								`slash character ${JSON.stringify(character)} did not settle into the Host frame`,
							);
						}
						assert.ok(
							tui.serverMessages.filter(
								(message) => message.type === "event" && message.event.type === "extension_component_frame",
							).length > framesBeforeCompletion,
							"slash input did not advance the Host frame",
						);
						const framesBeforeAutocomplete = tui.serverMessages.filter(
							(message) => message.type === "event" && message.event.type === "extension_component_frame",
						).length;
						tui.send("Tab");
						await waitFor(async () => {
							await tui.pump();
							return (
								tui.requests.some(
									(request) => request.command === "extension_component_input" && request.data === "\t",
								) &&
								tui.serverMessages.filter(
									(message) => message.type === "event" && message.event.type === "extension_component_frame",
								).length > framesBeforeAutocomplete &&
								(customEditorFrames(tui).at(-1)?.lines.join("\n").includes("editor-contract-unmount") ?? false)
							);
						}, "first Tab did not render runtime slash completion in the Host frame");
						tui.send("Enter");
						await waitFor(async () => {
							await tui.pump();
							return tui.serverMessages.some(
								(message) =>
									message.type === "event" &&
									message.event.type === "extension_component_unmount" &&
									message.event.componentId === "editor",
							);
						}, "completed slash command did not dispatch to the runtime extension");
						tui.sendLiteral("/editor-contract-mount");
						tui.send("Enter");
						await waitFor(async () => {
							await tui.pump();
							return tui.serverMessages.some(
								(message) =>
									message.type === "event" &&
									message.event.type === "extension_component_mount" &&
									message.event.componentId === "editor" &&
									message.event.generation > currentEditorGeneration,
							);
						}, "slash command did not remount the CustomEditor");
						const remountedEditor = tui.serverMessages
							.filter(
								(message) =>
									message.type === "event" &&
									message.event.type === "extension_component_mount" &&
									message.event.componentId === "editor",
							)
							.at(-1);
						if (
							!remountedEditor ||
							remountedEditor.type !== "event" ||
							remountedEditor.event.type !== "extension_component_mount"
						) {
							throw new Error("slash command remount event is missing");
						}
						currentEditorGeneration = remountedEditor.event.generation;

						const inputBeforeUnicode = tui.requests.filter(
							(request) => request.command === "extension_component_input",
						).length;
						const unicode = "中文🙂e\u0301";
						tui.send("C-c");
						tui.sendLiteral(unicode);
						await waitFor(async () => {
							await tui.pump();
							return (
								tui.requests.filter((request) => request.command === "extension_component_input").length >
									inputBeforeUnicode &&
								tui.pane().includes("中文🙂") &&
								customEditorStateUpdates(tui).some(
									(update) => update.text === unicode && update.cursor === Buffer.byteLength(unicode, "utf8"),
								)
							);
						}, "Unicode committed text or cursor did not reach CustomEditor");
						tui.send("Left", "Backspace");
						tui.sendLiteral("\u001b[13;2~");

						const pasteAcceptedBefore = tui
							.traces()
							.filter((trace) => trace.event === "component_input_accepted").length;
						const paste = "甲".repeat(Number(process.env.LYSTAR_CUSTOM_EDITOR_PASTE_CHARS ?? 5_000));
						tui.paste(paste);
						await waitFor(async () => {
							await tui.pump();
							return tui.requests.some(
								(request) =>
									request.command === "extension_component_input" &&
									request.data === `\u001b[200~${paste}\u001b[201~`,
							);
						}, "single 5000-character paste did not cross the CustomEditor bridge");
						assert.equal(
							tui.requests.filter(
								(request) =>
									request.command === "extension_component_input" &&
									request.data === `\u001b[200~${paste}\u001b[201~`,
							).length,
							1,
							"5000-character paste fragmented into multiple Host calls",
						);
						const pasteRequest = [...tui.requests]
							.reverse()
							.find(
								(request) =>
									request.command === "extension_component_input" &&
									request.data === `\u001b[200~${paste}\u001b[201~`,
							);
						assert.ok(pasteRequest, "CustomEditor paste request is missing");
						await waitFor(async () => {
							await tui.pump();
							return tui.serverMessages.some(
								(message) => message.type === "response" && message.id === pasteRequest.id,
							);
						}, "CustomEditor paste did not receive a Host response");
						const pasteResponse = tui.serverMessages.find(
							(message) => message.type === "response" && message.id === pasteRequest.id,
						);
						assert.ok(
							pasteResponse?.type === "response" && pasteResponse.ok,
							`CustomEditor paste Host response was rejected: ${JSON.stringify(pasteResponse)}`,
						);
						assert.equal(
							(pasteResponse as { result?: { accepted?: boolean } }).result?.accepted,
							true,
							`CustomEditor paste was not accepted by the Host: ${JSON.stringify(pasteResponse)}`,
						);
						await waitForTrace(tui, "component_input_accepted", pasteAcceptedBefore + 1);
						const undoRequestBefore = tui.requests.filter(
							(request) => request.command === "extension_component_input" && request.data === "\u001a",
						).length;
						const undoAcceptedBefore = tui
							.traces()
							.filter((trace) => trace.event === "component_input_accepted").length;
						tui.send("C-z");
						await waitFor(async () => {
							await tui.pump();
							return (
								tui.requests.filter(
									(request) => request.command === "extension_component_input" && request.data === "\u001a",
								).length > undoRequestBefore
							);
						}, "CustomEditor undo key did not reach the Host bridge");
						await waitForTrace(tui, "component_input_accepted", undoAcceptedBefore + 1);

						const redoRequestBefore = tui.requests.filter(
							(request) => request.command === "extension_component_input" && request.data === "\u0012",
						).length;
						const redoAcceptedBefore = tui
							.traces()
							.filter((trace) => trace.event === "component_input_accepted").length;
						tui.sendLiteral("\u0012");
						await waitFor(async () => {
							await tui.pump();
							return (
								tui.requests.filter(
									(request) => request.command === "extension_component_input" && request.data === "\u0012",
								).length > redoRequestBefore
							);
						}, "CustomEditor redo key did not reach the Host bridge");
						await waitForTrace(tui, "component_input_accepted", redoAcceptedBefore + 1);

						const clearAcceptedBefore = tui
							.traces()
							.filter((trace) => trace.event === "component_input_accepted").length;
						tui.send("C-c");
						await waitForTrace(tui, "component_input_accepted", clearAcceptedBefore + 1);
						await typeInCustomEditor(tui, "history custom editor");
						const promptIdsBeforeHistory = new Set(
							tui.requests.filter((request) => request.command === "prompt").map((request) => request.id),
						);
						tui.send("Enter");
						await waitFor(async () => {
							await tui.pump();
							return tui.requests.some(
								(request) => request.command === "prompt" && !promptIdsBeforeHistory.has(request.id),
							);
						}, "CustomEditor submit did not create a Host prompt");
						const historyPrompt = [...tui.requests]
							.reverse()
							.find((request) => request.command === "prompt" && !promptIdsBeforeHistory.has(request.id));
						assert.ok(historyPrompt, "CustomEditor history prompt request is missing");
						await waitFor(async () => {
							await tui.pump();
							return tui.serverMessages.some(
								(message) => message.type === "response" && message.id === historyPrompt.id && message.ok,
							);
						}, "CustomEditor history prompt was not accepted by the Host");
						const historyUpBefore = tui.requests.filter(
							(request) => request.command === "extension_component_input" && request.data === "\u001b[A",
						).length;
						tui.send("Up");
						await waitFor(async () => {
							await tui.pump();
							return (
								tui.requests.filter(
									(request) => request.command === "extension_component_input" && request.data === "\u001b[A",
								).length > historyUpBefore
							);
						}, "CustomEditor history key did not reach the Host bridge");
						const historyDownBefore = tui.requests.filter(
							(request) => request.command === "extension_component_input" && request.data === "\u001b[B",
						).length;
						tui.send("Down");
						await waitFor(async () => {
							await tui.pump();
							return (
								tui.requests.filter(
									(request) => request.command === "extension_component_input" && request.data === "\u001b[B",
								).length > historyDownBefore
							);
						}, "CustomEditor history down key did not reach the Host bridge");

						tui.send("C-g");
						const replacementMountsAppliedBefore = tui
							.traces()
							.filter((trace) => trace.event === "component_mount_applied").length;
						await waitFor(async () => {
							await tui.pump();
							return tui.serverMessages.some(
								(message) =>
									message.type === "event" &&
									message.event.type === "extension_component_mount" &&
									message.event.componentId === "editor" &&
									message.event.generation > currentEditorGeneration,
							);
						}, "replacement CustomEditor did not mount a new generation");
						await waitForTrace(tui, "component_mount_applied", replacementMountsAppliedBefore + 1);
						const editorActionsBeforeStale = tui.serverMessages.filter(
							(message) => message.type === "event" && message.event.type === "extension_editor_action",
						).length;
						const staleStatusBefore = tui.serverMessages.filter(
							(message) => message.type === "event" && message.event.type === "extension_ui_delta",
						).length;
						tui.sendLiteral("\u0018");
						await waitFor(async () => {
							await tui.pump();
							return (
								tui.requests.some(
									(request) => request.command === "extension_component_input" && request.data === "\u0018",
								) &&
								tui.serverMessages.filter(
									(message) => message.type === "event" && message.event.type === "extension_ui_delta",
								).length > staleStatusBefore
							);
						}, "stale callback control key did not execute");
						assert.equal(
							tui.serverMessages.filter(
								(message) => message.type === "event" && message.event.type === "extension_editor_action",
							).length,
							editorActionsBeforeStale,
							"replaced editor callback mutated the active draft",
						);

						const failStatusBefore = tui.serverMessages.filter(
							(message) => message.type === "event" && message.event.type === "extension_ui_delta",
						).length;
						tui.sendLiteral("\u000b");
						await waitFor(async () => {
							await tui.pump();
							return (
								tui.requests.some(
									(request) => request.command === "extension_component_input" && request.data === "\u000b",
								) &&
								tui.serverMessages.filter(
									(message) => message.type === "event" && message.event.type === "extension_ui_delta",
								).length > failStatusBefore
							);
						}, "fail-next control key did not execute");
						const editorUnmountsBeforeFactoryFailure = tui.serverMessages.filter(
							(message) =>
								message.type === "event" &&
								message.event.type === "extension_component_unmount" &&
								message.event.componentId === "editor",
						).length;
						const factoryReplaceInputsBefore = tui.requests.filter(
							(request) => request.command === "extension_component_input" && request.data === "\u0007",
						).length;
						tui.send("C-g", "C-g");
						await waitFor(async () => {
							await tui.pump();
							return (
								tui.requests.filter(
									(request) => request.command === "extension_component_input" && request.data === "\u0007",
								).length > factoryReplaceInputsBefore
							);
						}, "failing CustomEditor replace key did not reach the Host bridge");
						await waitFor(async () => {
							await tui.pump();
							return (
								tui.serverMessages.filter(
									(message) =>
										message.type === "event" &&
										message.event.type === "extension_component_unmount" &&
										message.event.componentId === "editor",
								).length > editorUnmountsBeforeFactoryFailure
							);
						}, "failing CustomEditor factory did not unmount the active editor");

						tui.resize(120, 36);
						tui.resize(80, 8);
						await waitFor(
							() => tui.pane().includes("Enter 提交"),
							"resize lost native Composer after CustomEditor failure",
						);
						writeFileSync(
							join(tui.artifactDirectory, "result.json"),
							`${JSON.stringify({
								attempt,
								pasteLength: paste.length,
								pasteHash: createHash("sha256").update(paste).digest("hex"),
								initialEditorGeneration: currentEditorGeneration,
								componentInputCalls: tui.requests.filter(
									(request) => request.command === "extension_component_input",
								).length,
							})}\n`,
						);
						assertCustomEditorArtifactSafe(tui.artifactDirectory);
					} finally {
						await finishTuiRound(tui);
					}
				}
			},
			Number(process.env.LYSTAR_CUSTOM_EDITOR_TIMEOUT_MS ?? 240_000),
		);

		it("B completion-submission：内置命令、提交、steer、follow-up、abort 与重放", async () => {
			const attempts = Number(process.env.LYSTAR_CUSTOM_EDITOR_ATTEMPTS ?? 2);
			for (let attempt = 0; attempt < attempts; attempt++) {
				const tui = await startTui(
					0,
					{ width: 80, height: 24 },
					`custom-editor-submission-${attempt + 1}`,
					undefined,
					{ nonBlockingPromptRequests: true },
					async ({ directory }) => createCustomEditorContractRuntimeHost(directory),
				);
				try {
					await waitForInitialPage(tui);
					await waitFor(async () => {
						await tui.pump();
						return tui.serverMessages.some(
							(message) =>
								message.type === "event" &&
								message.event.type === "extension_component_mount" &&
								message.event.componentId === "editor",
						);
					}, "submission scenario did not mount the CustomEditor");
					await waitFor(async () => {
						await tui.pump();
						return tui.serverMessages.some(
							(message) => message.type === "response" && message.id.startsWith("acquire-") && message.ok,
						);
					}, "submission scenario did not acquire a lease");

					tui.send("C-c");
					await waitFor(async () => {
						await tui.pump();
						return tui.serverMessages.some(
							(message) =>
								message.type === "event" &&
								message.event.type === "extension_editor_action" &&
								message.event.action.action === "set" &&
								message.event.action.text === "",
						);
					}, "CustomEditor clear did not reach the Host");

					tui.sendLiteral("/about");
					tui.send("Enter");
					const aboutRequest = await waitForRequest(tui, "get_about");
					await waitFor(async () => {
						await tui.pump();
						return tui.serverMessages.some(
							(message) => message.type === "response" && message.id === aboutRequest.id && message.ok,
						);
					}, "about response was not consumed by the Rust TUI");
					await waitFor(() => tui.pane().includes('"agentDir":'), "about overlay did not render");
					tui.sendLiteral("\u001b");
					await waitFor(
						() => !tui.pane().includes('"agentDir":'),
						"about overlay did not close before CustomEditor input",
					);

					const deferredGateBefore = tui.requests.filter(
						(request) => request.command === "extension_component_input" && request.data === "\u0001",
					).length;
					let deferredGateReceived = false;
					for (let retry = 0; retry < 4 && !deferredGateReceived; retry++) {
						tui.send("C-a");
						try {
							await waitFor(
								async () => {
									await tui.pump();
									return (
										tui.requests.filter(
											(request) =>
												request.command === "extension_component_input" && request.data === "\u0001",
										).length > deferredGateBefore
									);
								},
								"CustomEditor deferred gate did not receive its raw control key",
								1_000,
							);
							deferredGateReceived = true;
						} catch {
							// PTY 控制键可能晚一个事件循环才到达，重试同一个幂等 gate。
						}
					}
					assert.ok(deferredGateReceived, "CustomEditor deferred gate did not receive its raw control key");

					const componentInputsBeforeIdle = tui.requests.filter(
						(request) => request.command === "extension_component_input",
					).length;
					const promptIdsBeforeIdle = new Set(
						tui.requests.filter((request) => request.command === "prompt").map((request) => request.id),
					);
					await typeInCustomEditor(tui, "idle prompt");
					tui.send("Enter");
					await waitFor(async () => {
						await tui.pump();
						return (
							tui.requests.some(
								(request) => request.command === "prompt" && !promptIdsBeforeIdle.has(request.id),
							) &&
							tui.requests.filter((request) => request.command === "extension_component_input").length >
								componentInputsBeforeIdle
						);
					}, "idle prompt did not leave the CustomEditor exactly once");
					const idlePromptRequest = [...tui.requests]
						.reverse()
						.find((request) => request.command === "prompt" && !promptIdsBeforeIdle.has(request.id));
					assert.ok(idlePromptRequest, "idle CustomEditor prompt request is missing");
					const promptAccepted = tui.serverMessages.find(
						(message) =>
							message.type === "response" &&
							message.id === idlePromptRequest.id &&
							message.ok &&
							(message.result as { operation?: { type?: string } }).operation?.type === "prompt",
					);
					assert.ok(promptAccepted && promptAccepted.type === "response" && promptAccepted.ok);
					const operation = (promptAccepted.result as { operation: OperationRecord }).operation;
					assert.equal(operation.status, "accepted");
					const operationStatuses = () =>
						tui.serverMessages.flatMap((message) =>
							message.type === "event" &&
							message.event.type === "operation_updated" &&
							message.event.operation.operationId === operation.operationId
								? [message.event.operation.status]
								: [],
						);
					await waitFor(
						() => operationStatuses().includes("running"),
						"CustomEditor prompt did not publish a running operation update",
					);
					tui.send("C-c");
					await typeInCustomEditor(tui, "active steer");
					tui.send("Enter");
					await waitFor(async () => {
						await tui.pump();
						return tui.requests.filter((request) => request.command === "steer").length === 1;
					}, "active Enter did not send one steer from the CustomEditor");
					await typeInCustomEditor(tui, "active follow-up");
					tui.sendLiteral("\u001b\r");
					await waitFor(async () => {
						await tui.pump();
						return tui.requests.filter((request) => request.command === "follow_up").length === 1;
					}, "Alt+Enter did not send one follow_up from the CustomEditor");

					tui.send("C-t");
					await waitFor(async () => {
						await tui.pump();
						return tui.serverMessages.some(
							(message) =>
								message.type === "response" &&
								message.id.startsWith("component-input-") &&
								message.ok &&
								(message.result as { appAction?: string }).appAction === "app.interrupt",
						);
					}, "CustomEditor Ctrl+T did not return app.interrupt from the Host");
					let abortOperations: OperationRecord[] = [];
					await waitFor(
						async () => {
							await tui.pump();
							abortOperations = await readOperations(tui);
							return abortOperations.some(
								(candidate) =>
									candidate.operationId === operation.operationId && candidate.status === "aborted",
							);
						},
						() =>
							`CustomEditor Escape did not abort the active real Runtime operation: ${JSON.stringify({
								inputs: tui.requests
									.filter((request) => request.command === "extension_component_input")
									.map((request) => request.data),
								operations: abortOperations.map((candidate) => ({
									type: candidate.type,
									status: candidate.status,
								})),
							})}`,
					);
					assert.equal(
						tui.requests.filter(
							(request) => request.command === "extension_component_input" && request.data === "\u0014",
						).length,
						1,
						"CustomEditor interrupt did not use exactly one raw Ctrl+T input",
					);
					assert.equal(
						tui.requests.filter((request) => request.command === "abort_operation").length,
						1,
						"CustomEditor app.interrupt did not send exactly one abort_operation",
					);
					assert.deepEqual(
						[operation.status, ...operationStatuses()],
						["accepted", "running", "aborted"],
						"real Runtime journal did not settle accepted -> running -> aborted",
					);
					assert.equal(tui.requests.filter((request) => request.command === "steer").length, 1);
					assert.equal(tui.requests.filter((request) => request.command === "follow_up").length, 1);

					const acquire = tui.serverMessages.find(
						(message) => message.type === "response" && message.id.startsWith("acquire-") && message.ok,
					);
					assert.ok(acquire && acquire.type === "response" && acquire.ok, "missing Rust lease");
					const leaseId = (acquire.result as { lease: { leaseId: string } }).lease.leaseId;
					const request = {
						type: "request" as const,
						id: `response-drop-${attempt}`,
						request: {
							command: "prompt" as const,
							sessionPath: tui.sessionPath,
							leaseId,
							clientInstanceId: tui.clientInstanceId,
							clientRequestId: `response-drop-once-${attempt}`,
							text: "response drop once",
						},
					};
					tui.dropNextWorkspaceResponse();
					await tui.connection.handle(request);
					await tui.connection.handle({ ...request, id: `${request.id}-retry` });
					await waitFor(
						async () =>
							(await readOperations(tui)).filter(
								(operation) => operation.clientRequestId === `response-drop-once-${attempt}`,
							).length === 1,
						"response-drop retry duplicated the real Runtime request",
					);
					assertCustomEditorArtifactSafe(tui.artifactDirectory);
				} finally {
					await finishTuiRound(tui);
				}
			}
		}, 120_000);

		it("附件基础：真实 PNG、剪贴板图片与冻结重试（FakeRuntimeSession，不计 CustomEditor 证据）", async () => {
			const attempts = Number(process.env.LYSTAR_CUSTOM_EDITOR_ATTEMPTS ?? 2);
			for (let attempt = 0; attempt < attempts; attempt++) {
				const tui = await startTui(4, { width: 80, height: 8 }, `custom-editor-attachments-${attempt + 1}`);
				try {
					await waitForInitialPage(tui);
					const completionCount = tui.requests.filter((request) => request.command === "get_completions").length;
					tui.sendLiteral('/attach "images/中文');
					tui.send("Tab");
					await waitForRequest(tui, "get_completions", completionCount + 1);
					await waitFor(() => tui.pane().includes("添加图片"), "real PNG completion did not render");
					tui.send("Enter");
					await waitForRequest(tui, "read_project_image");
					await waitFor(() => tui.pane().includes("图片 1"), "real PNG was not attached");

					tui.dropNextWorkspaceResponse();
					tui.sendLiteral("frozen attachment retry");
					tui.send("Enter");
					await waitFor(
						() => tui.pane().includes("请求超时，按 r 重试"),
						"dropped attachment submit did not become retryable",
						10_000,
					);
					const promptCount = tui.requests.filter((request) => request.command === "prompt").length;
					tui.send("C-r");
					await waitForRequest(tui, "prompt", promptCount + 1);
					await waitFor(
						() => tui.runtime.prompts.filter((text) => text === "frozen attachment retry").length === 1,
						"frozen attachment retry duplicated the Host prompt",
					);
					await waitFor(
						() => tui.pane().includes("图片 0") || tui.pane().includes("Enter 提交"),
						"successful attachment submit did not clear its frozen attachments",
					);
					writeFileSync(
						join(tui.artifactDirectory, "result.json"),
						`${JSON.stringify({ attempt, attachmentRequests: tui.requests.filter((request) => request.command.includes("image")).length })}\n`,
					);
					assertCustomEditorArtifactSafe(tui.artifactDirectory);
				} finally {
					await finishTuiRound(tui);
				}

				const pasteTui = await startTui(
					0,
					{ width: 80, height: 8 },
					`custom-editor-paste-image-${attempt + 1}`,
					undefined,
					{ captureRawOutput: false },
					async ({ directory }) => createCustomEditorContractRuntimeHost(directory),
				);
				try {
					await waitForInitialPage(pasteTui);
					await waitFor(async () => {
						await pasteTui.pump();
						return pasteTui.serverMessages.some(
							(message) =>
								message.type === "event" &&
								message.event.type === "extension_component_mount" &&
								message.event.componentId === "editor",
						);
					}, "pasteImage CustomEditor did not mount");
					const imageReads = pasteTui.requests.filter(
						(request) => request.command === "read_clipboard_image",
					).length;
					pasteTui.send("C-v");
					await waitForRequest(pasteTui, "read_clipboard_image", imageReads + 1);
					await waitFor(
						() => pasteTui.pane().includes("选择剪贴板内容") || pasteTui.pane().includes("图片 1"),
						"clipboard pasteImage did not settle",
					);
					if (pasteTui.pane().includes("选择剪贴板内容")) pasteTui.send("Down", "Enter");
					await waitFor(
						() => pasteTui.pane().includes("图片 1"),
						"clipboard pasteImage did not retain its attachment",
					);
					assertCustomEditorArtifactSafe(pasteTui.artifactDirectory);
				} finally {
					await finishTuiRound(pasteTui);
				}
			}
		}, 120_000);

		it(
			"C CustomEditor：真实 completion、Recovery 与附件语义",
			async () => {
				const attempts = Number(process.env.LYSTAR_CUSTOM_EDITOR_ATTEMPTS ?? 2);
				for (let attempt = 0; attempt < attempts; attempt++) {
					const completionTui = await startTui(
						0,
						{ width: 80, height: 24 },
						`custom-editor-completion-${attempt + 1}`,
						undefined,
						{ captureRawOutput: false },
						async ({ directory }) => createCustomEditorContractRuntimeHost(directory),
					);
					try {
						await waitForInitialPage(completionTui);
						await waitForCustomEditor(completionTui);
						await clearCustomEditor(completionTui);
						await typeInCustomEditor(completionTui, "/editor-contract-");
						const slashInputAccepted = completionTui
							.traces()
							.filter((trace) => trace.event === "component_input_accepted").length;
						completionTui.send("Tab");
						await waitFor(
							() =>
								customEditorFrames(completionTui).at(-1)?.lines.join("\n").includes("editor-contract-mount") ??
								false,
							"extension command completion did not render in the real CustomEditor frame",
						);
						await waitForTrace(completionTui, "component_input_accepted", slashInputAccepted + 1);
						completionTui.send("Tab");
						await waitFor(
							() =>
								customEditorActions(completionTui).some((action) => action.text === "/editor-contract-mount "),
							() =>
								`extension command completion was not written to the CustomEditor: ${JSON.stringify(
									customEditorActions(completionTui),
								)}`,
						);

						await clearCustomEditor(completionTui);
						const completionCallsBeforeStale = contractStatusCounter(completionTui, "completionCalls");
						await typeInCustomEditor(completionTui, "@stale-old");
						completionTui.send("Tab");
						await waitFor(
							() => contractStatusCounter(completionTui, "completionCalls") > completionCallsBeforeStale,
							"stale completion did not start in the Host",
						);
						await clearCustomEditor(completionTui);
						await typeInCustomEditor(completionTui, "@contract-provider");
						await waitFor(
							() => contractStatusCounter(completionTui, "completionAborts") >= 1,
							"Host completion AbortSignal was not observed for the stale request",
						);
						const providerInputAccepted = completionTui
							.traces()
							.filter((trace) => trace.event === "component_input_accepted").length;
						completionTui.send("Tab");
						await waitFor(
							() =>
								customEditorFrames(completionTui).at(-1)?.lines.join("\n").includes("provider completion") ??
								false,
							"provider completion did not replace the stale completion",
						);
						await waitForTrace(completionTui, "component_input_accepted", providerInputAccepted + 1);
						completionTui.send("Tab");
						await waitFor(
							() =>
								customEditorActions(completionTui).some((action) => action.text === "@contract-provider-final"),
							"selected provider completion was not written to the CustomEditor",
						);
						assertCustomEditorArtifactSafe(completionTui.artifactDirectory);
					} finally {
						await finishTuiRound(completionTui);
					}

					const directTui = await startTui(
						0,
						{ width: 80, height: 24 },
						`custom-editor-recovery-direct-${attempt + 1}`,
						undefined,
						{ captureRawOutput: false, nonBlockingPromptRequests: true },
						async ({ directory }) => createCustomEditorContractRuntimeHost(directory),
					);
					try {
						await waitForInitialPage(directTui);
						await waitForCustomEditor(directTui);
						const operation = await armDeferredCustomEditorSubmit(directTui, "C-a", "old draft");
						await waitFor(async () => {
							await directTui.pump();
							return (
								customEditorStateTexts(directTui).at(-1) === "" &&
								!customEditorFrames(directTui).at(-1)?.lines.join("\n").includes("old draft")
							);
						}, "Rust and Host CustomEditor were not empty while the deferred operation was running");
						await releaseDeferredCustomEditorSubmit(directTui, "C-e");
						await waitForOperationStatus(directTui, operation.operationId, "failed");
						await waitFor(async () => {
							await directTui.pump();
							return customEditorStateTexts(directTui).at(-1) === "old draft";
						}, "direct recovery did not mirror the old draft back to the Host editor");
						assert.ok(!directTui.pane().includes("恢复草稿"), "direct recovery incorrectly opened an overlay");
						assertCustomEditorArtifactSafe(directTui.artifactDirectory, ["old draft"]);
					} finally {
						await finishTuiRound(directTui);
					}

					for (const action of ["append", "replace", "copy", "discard"] as const) {
						const recoveryTui = await startTui(
							0,
							{ width: 80, height: 24 },
							`custom-editor-recovery-${action}-${attempt + 1}`,
							undefined,
							{ captureRawOutput: false, nonBlockingPromptRequests: true },
							async ({ directory }) => createCustomEditorContractRuntimeHost(directory),
						);
						try {
							await waitForInitialPage(recoveryTui);
							await waitForCustomEditor(recoveryTui);
							const operation = await armDeferredCustomEditorSubmit(recoveryTui, "C-a", "old draft");
							await typeInCustomEditor(recoveryTui, "new input");
							await waitFor(async () => {
								await recoveryTui.pump();
								return customEditorStateTexts(recoveryTui).at(-1) === "new input";
							}, "Rust did not publish extension_editor_state.text for the conflicted input");
							await releaseDeferredCustomEditorSubmit(recoveryTui, "C-e");
							await waitForOperationStatus(recoveryTui, operation.operationId, "failed");
							await waitFor(async () => {
								await recoveryTui.pump();
								return recoveryTui.pane().includes("Ctrl+R 打开恢复草稿");
							}, "conflicted recovery did not expose the Ctrl+R hint");
							recoveryTui.send("C-r");
							await waitFor(async () => {
								await recoveryTui.pump();
								const pane = recoveryTui.pane();
								return pane.includes("追加") && pane.includes("替换") && pane.includes("复制");
							}, "Ctrl+R did not open recovery menu");
							if (action === "append") {
								recoveryTui.send("Enter");
								await waitFor(async () => {
									await recoveryTui.pump();
									return customEditorStateTexts(recoveryTui).at(-1) === "new input\nold draft";
								}, "append did not mirror new input plus old draft to Host editor");
							} else if (action === "replace") {
								recoveryTui.send("Down", "Enter");
								await waitFor(
									() => recoveryTui.pane().includes("替换恢复草稿"),
									"replace confirmation did not open",
								);
								recoveryTui.send("Enter");
								await waitFor(async () => {
									await recoveryTui.pump();
									return customEditorStateTexts(recoveryTui).at(-1) === "old draft";
								}, "replace did not mirror the old draft to Host editor");
							} else if (action === "copy") {
								recoveryTui.send("Down", "Down", "Enter");
								await waitForRequest(recoveryTui, "write_clipboard_text");
								const writes = recoveryTui.clientMessages.filter(
									(message) =>
										message.type === "request" && message.request.command === "write_clipboard_text",
								) as ClipboardWriteRequestMessage[];
								assert.equal(writes.length, 1, "recovery copy wrote the clipboard more than once");
								assert.equal(writes[0].request.text, "old draft");
								recoveryTui.send("Escape", "C-r");
								await waitFor(async () => {
									await recoveryTui.pump();
									const pane = recoveryTui.pane();
									return pane.includes("追加") && pane.includes("替换") && pane.includes("复制");
								}, "copy discarded the recovery draft");
							} else {
								recoveryTui.send("Down", "Down", "Down", "Enter");
								await waitFor(
									() => !recoveryTui.pane().includes("恢复草稿"),
									"discard did not close recovery menu",
								);
								recoveryTui.send("C-r");
								await new Promise((resolve) => setTimeout(resolve, 50));
								assert.ok(!recoveryTui.pane().includes("恢复草稿"), "discard did not release recovery draft");
							}
							assertCustomEditorArtifactSafe(recoveryTui.artifactDirectory, ["old draft", "new input"]);
						} finally {
							await finishTuiRound(recoveryTui);
						}
					}

					const successTui = await startTui(
						0,
						{ width: 80, height: 24 },
						`custom-editor-attachment-success-${attempt + 1}`,
						undefined,
						{ captureRawOutput: false, nonBlockingPromptRequests: true },
						async ({ directory }) => createCustomEditorContractRuntimeHost(directory),
					);
					try {
						await waitForInitialPage(successTui);
						await waitForCustomEditor(successTui);
						await pasteCustomEditorImage(successTui, 1);
						const operation = await armDeferredCustomEditorSubmit(successTui, "C-s", "attachment success");
						assert.ok(
							successTui.pane().includes("图片 1"),
							"accepted CustomEditor submit cleared attachment A too early",
						);
						await pasteCustomEditorImage(successTui, 2);
						await releaseDeferredCustomEditorSubmit(successTui, "C-l");
						await waitForOperationStatus(successTui, operation.operationId, "completed");
						await waitFor(
							() => successTui.pane().includes("图片 1") || successTui.pane().includes("Esc 返回"),
							"successful CustomEditor submit did not settle its notification or attachment state",
						);
						if (successTui.pane().includes("Esc 返回")) {
							successTui.send("Escape");
							await waitFor(() => !successTui.pane().includes("Esc 返回"), "submit notification did not close");
						}
						await waitFor(
							() => successTui.pane().includes("图片 1"),
							"success did not retain attachment B after clearing A",
						);
						assert.equal(customEditorPromptRequests(successTui).at(-1)?.request.images?.length, 1);
						assertCustomEditorArtifactSafe(successTui.artifactDirectory, ["attachment success"]);
					} finally {
						await finishTuiRound(successTui);
					}

					const errorTui = await startTui(
						0,
						{ width: 80, height: 24 },
						`custom-editor-attachment-error-${attempt + 1}`,
						undefined,
						{ captureRawOutput: false, nonBlockingPromptRequests: true },
						async ({ directory }) => createCustomEditorContractRuntimeHost(directory),
					);
					try {
						await waitForInitialPage(errorTui);
						await waitForCustomEditor(errorTui);
						await pasteCustomEditorImage(errorTui, 1);
						const operation = await armDeferredCustomEditorSubmit(errorTui, "C-a", "attachment error");
						assert.ok(errorTui.pane().includes("图片 1"), "running CustomEditor submit lost attachment A");
						await typeInCustomEditor(errorTui, "/attachments");
						errorTui.send("Enter");
						await waitFor(
							() => errorTui.pane().includes("图片附件"),
							"CustomEditor /attachments did not open Rust overlay",
						);
						errorTui.send("Enter");
						await waitFor(() => errorTui.pane().includes("图片预览"), "attachment preview did not open");
						errorTui.send("Escape");
						await waitFor(
							() => errorTui.pane().includes("图片附件"),
							"attachment preview did not return to the attachment list",
						);
						errorTui.send("d");
						await waitFor(
							() => errorTui.pane().includes("删除图片附件"),
							"attachment deletion confirmation did not open",
						);
						errorTui.send("Enter");
						await waitFor(
							() => errorTui.pane().includes("图片附件"),
							"attachment deletion did not return to the attachment list",
						);
						errorTui.send("Escape");
						await waitFor(async () => {
							await errorTui.pump();
							const pane = errorTui.pane();
							return !pane.includes("图片附件") && customEditorStateTexts(errorTui).at(-1) === "";
						}, "attachment overlay did not return an empty CustomEditor");
						assert.ok(!errorTui.pane().includes("图片 1"), "failed attachment A reappeared before recovery");
						await typeInCustomEditor(errorTui, "new input");
						await waitFor(async () => {
							await errorTui.pump();
							return customEditorStateTexts(errorTui).at(-1) === "new input";
						}, "Rust did not publish the post-attachment CustomEditor text");
						await releaseDeferredCustomEditorSubmit(errorTui, "C-e");
						await waitForOperationStatus(errorTui, operation.operationId, "failed");
						await waitFor(async () => {
							await errorTui.pump();
							return errorTui.pane().includes("Ctrl+R 打开恢复草稿");
						}, "attachment error did not create recovery draft");
						errorTui.send("C-r");
						await waitFor(
							() => errorTui.pane().includes("提交时 1 张，当前缺 1 张"),
							"recovery menu did not report the removed attachment as missing",
						);
						assert.ok(!errorTui.pane().includes("图片 1"), "failed attachment A revived after recovery");
						assertCustomEditorArtifactSafe(errorTui.artifactDirectory, ["attachment error", "new input"]);
					} finally {
						await finishTuiRound(errorTui);
					}
				}
			},
			Number(process.env.LYSTAR_CUSTOM_EDITOR_TIMEOUT_MS ?? 360_000),
		);
	});

	it("通过 tmux/FIFO 两轮加载真实 Pi custom Editor examples", async () => {
		for (const example of ["border", "modal", "rainbow"] as const) {
			for (let attempt = 0; attempt < 2; attempt++) {
				const tui = await startTui(
					0,
					{ width: 80, height: 24 },
					`custom-editor-${example}-${attempt + 1}`,
					undefined,
					{ captureRawOutput: false },
					async ({ directory }) => createCustomEditorRuntimeHost(directory, example),
				);
				try {
					await waitForInitialPage(tui);
					await waitFor(
						async () => {
							await tui.pump();
							return tui.pane().includes("预置草稿 中文");
						},
						() =>
							`${example} did not mount its original factory with the session-start draft: ${JSON.stringify({ pane: tui.pane(), server: tui.serverMessages.filter((message) => message.type === "event") })}`,
					);

					const expectedFrameText = {
						border: "ctx 0%/128k",
						modal: "INSERT",
						rainbow: "预置草稿 中文",
					}[example];
					await waitFor(
						() => tui.pane().includes(expectedFrameText),
						`${example} did not render its original editor frame`,
					);

					const framesBeforeDispose = tui
						.traces()
						.filter(
							(event) => event.event === "extension_component_frame_applied" && event.componentId === "editor",
						).length;
					tui.closeProtocol();
					await waitFor(
						() => spawnSync("tmux", ["-L", tui.socket, "has-session", "-t", "tui"]).status !== 0,
						`${example} Rust TUI did not stop after EOF`,
					);
					assert.equal(
						tui
							.traces()
							.filter(
								(event) =>
									event.event === "extension_component_frame_applied" && event.componentId === "editor",
							).length,
						framesBeforeDispose,
						`${example} produced an editor frame after disposal`,
					);
					writeFileSync(
						join(tui.artifactDirectory, "result.json"),
						`${JSON.stringify({ example, attempt, editorFramesBeforeDispose: framesBeforeDispose })}\n`,
					);
					assertCustomEditorArtifactSafe(tui.artifactDirectory);
				} finally {
					tui.closeProtocol();
				}
			}
		}
	}, 240_000);

	(componentStormBenchmark ? it : it.skip)(
		"benchmarks real Extension Component invalidate storms through Host and Rust",
		async () => {
			for (const dimensions of componentStormBenchmark!.sizes) {
				for (let round = 1; round <= componentStormBenchmark!.rounds; round++) {
					const tui = await startTui(
						0,
						dimensions,
						`extension-component-storm-${dimensions.width}x${dimensions.height}-${round}`,
						undefined,
						{},
						async ({ directory }) => createContractRuntimeHost(directory),
					);
					try {
						await waitForInitialPage(tui);
						await waitFor(async () => {
							await tui.pump();
							return tui.serverMessages.some(
								(message) => message.type === "response" && message.id.startsWith("acquire-") && message.ok,
							);
						}, "storm runtime did not acquire the Rust lease");

						const traceStart = tui.traces().length;
						const activeStartedAt = monotonicMs();
						const activeMetrics = startProcessTreeSampling(tui.panePid());
						tui.sendLiteral("/contract-components-storm");
						tui.send("Enter");
						await waitFor(
							async () => {
								await tui.pump();
								return tui.pane().includes("storm final 1000");
							},
							"Rust did not display final storm state",
							20_000,
						);
						const activeElapsedMs = monotonicMs() - activeStartedAt;
						const active = activeMetrics.stop();
						const diagnostics = await readStormDiagnostics(tui);
						const stormInvalidations = diagnostics.invalidations;
						assert.equal(stormInvalidations.length, 1_000, "Host did not record all storm invalidations");
						assert.equal(diagnostics.lastFinalState, 1_000, "Host diagnostics lost the final component state");
						assert.ok(
							stormInvalidations.every(
								(invalidation) => invalidation.publishedAt !== undefined && invalidation.revision !== undefined,
							),
							"a storm invalidation was not assigned to its covering publish revision",
						);
						const firstInvalidateAt = stormInvalidations[0]!.invalidateRequestedAt;
						const lastPublishedAt = stormInvalidations.at(-1)!.publishedAt!;
						const elapsedMs = lastPublishedAt - firstInvalidateAt;
						const frameBudget = Math.ceil(elapsedMs / (1_000 / 60)) + 2;
						assert.ok(
							diagnostics.renderCount <= frameBudget,
							`render count ${diagnostics.renderCount} exceeds ${frameBudget}`,
						);
						assert.ok(
							diagnostics.publishCount <= frameBudget,
							`publish count ${diagnostics.publishCount} exceeds ${frameBudget}`,
						);
						assert.ok(diagnostics.coalescedCount > 0, "storm did not coalesce any invalidations");

						const rustFrames = tui
							.traces()
							.slice(traceStart)
							.filter(
								(trace) =>
									trace.event === "extension_component_frame_applied" &&
									trace.componentId === diagnostics.componentId &&
									trace.revision !== undefined,
							)
							.map((trace) => ({
								componentId: trace.componentId!,
								revision: trace.revision!,
								appliedAt: trace.atMs,
							}));
						assert.ok(rustFrames.length > 0, "Rust emitted no component frame apply trace");
						const appliedByRevision = new Map(rustFrames.map((frame) => [frame.revision, frame.appliedAt]));
						const invalidateToPublish = stormInvalidations.map(
							(invalidation) => invalidation.publishedAt! - invalidation.invalidateRequestedAt,
						);
						const publishToApply = stormInvalidations.map((invalidation) => {
							const appliedAt = appliedByRevision.get(invalidation.revision!);
							assert.notEqual(appliedAt, undefined, `Rust trace is missing revision ${invalidation.revision}`);
							return appliedAt! - invalidation.publishedAt!;
						});
						const endToEnd = stormInvalidations.map(
							(_invalidation, index) => invalidateToPublish[index]! + publishToApply[index]!,
						);
						const idleTraceCount = tui
							.traces()
							.filter((trace) => trace.event === "extension_component_frame_applied").length;
						const idleMetrics = startProcessTreeSampling(tui.panePid());
						await new Promise((resolve) => setTimeout(resolve, 500));
						await tui.pump();
						const idle = idleMetrics.stop();
						const idleComponentFrames =
							tui.traces().filter((trace) => trace.event === "extension_component_frame_applied").length -
							idleTraceCount;
						assert.equal(idleComponentFrames, 0, "idle control applied component frames after the storm");

						const record = {
							schemaVersion: 1,
							scenario: "extension_component_storm",
							columns: dimensions.width,
							rows: dimensions.height,
							round,
							componentId: diagnostics.componentId,
							generation: diagnostics.generation,
							finalState: diagnostics.lastFinalState,
							elapsedMs,
							activeElapsedMs,
							hostDiagnostics: diagnostics,
							rustFrames,
							invalidateToPublish: timingSummary(invalidateToPublish),
							publishToApply: timingSummary(publishToApply),
							endToEnd: timingSummary(endToEnd),
							process: {
								pid: tui.panePid(),
								processTreePids: processTreePids(tui.panePid()),
								active,
								idle: { ...idle, componentFrames: idleComponentFrames },
							},
						};
						appendFileSync(componentStormBenchmark!.artifact, `${JSON.stringify(record)}\n`);
					} finally {
						tui.closeProtocol();
					}
				}
			}
		},
		300_000,
	);

	(rustCustomEditorBenchmark ? it : it.skip)(
		"benchmarks real CustomEditor input, paste, animation, and autocomplete through Host and Rust",
		async () => {
			const config = rustCustomEditorBenchmark!;
			for (const scenario of config.scenarios) {
				for (const [width, height] of config.sizes) {
					for (let round = 1; round <= config.rounds; round++) {
						const tui = await startTui(
							0,
							{ width, height },
							`rust-custom-editor-${scenario.name}-${width}x${height}-${round}`,
							undefined,
							{ captureRawOutput: false },
							async ({ directory }) => createCustomEditorContractRuntimeHost(directory),
						);
						try {
							await waitForInitialPage(tui);
							await waitForCustomEditor(tui);
							await clearCustomEditor(tui);
							tui.sendLiteral("z");
							await waitFor(async () => {
								await tui.pump();
								return customEditorStateTexts(tui).at(-1) === "z";
							}, "CustomEditor benchmark warmup input did not settle");
							await clearCustomEditor(tui);
							if (scenario.name === "custom_editor_input300" && !rustCustomEditorBenchmarkWarmed) {
								const warmup = "w".repeat(scenario.input!.count);
								for (const character of warmup) {
									const framesBefore = componentFrameTraces(tui, 0, "editor").length;
									tui.sendLiteral(character);
									await waitFor(async () => {
										await tui.pump();
										return componentFrameTraces(tui, 0, "editor").length > framesBefore;
									}, "CustomEditor input300 benchmark warmup did not apply a frame");
								}
								await waitFor(async () => {
									await tui.pump();
									return customEditorStateTexts(tui).at(-1) === warmup;
								}, "CustomEditor input300 benchmark warmup did not settle");
								await clearCustomEditor(tui);
								rustCustomEditorBenchmarkWarmed = true;
							}
							await new Promise((resolve) => setTimeout(resolve, 25));
							const before = await readComponentDiagnostics(tui, "editor");
							const traceStart = tui.traces().length;
							const regroupBefore = transcriptRegroupSignature(tui);
							const hostMetrics = startHostBenchmarkSampling();
							const rustMetrics = startProcessTreeSampling(tui.panePid());
							let samples: Array<{
								receivedAt: number;
								publishedAt: number;
								inputRevision: number;
								frameRevision: number;
								appliedAt: number;
								hostBytes: number;
								rustBytes: number;
							}> = [];
							let finalText = "";
							let finalAnimation: number | undefined;
							let bracketedPasteBytes: number | undefined;
							let pasteRequestBytes: number | undefined;

							if (scenario.name === "custom_editor_input300") {
								const input = scenario.input!.character.repeat(scenario.input!.count);
								for (const character of input) {
									const framesBefore = componentFrameTraces(tui, traceStart, "editor").length;
									tui.sendLiteral(character);
									await waitFor(async () => {
										await tui.pump();
										return componentFrameTraces(tui, traceStart, "editor").length > framesBefore;
									}, "single CustomEditor key did not reach a covering Rust frame");
								}
								finalText = input;
								await waitFor(async () => {
									await tui.pump();
									const diagnostics = await readComponentDiagnostics(tui, "editor");
									return (
										diagnostics.editorTextBytes === Buffer.byteLength(input, "utf8") &&
										diagnostics.editorTextHash === createHash("sha256").update(input).digest("hex")
									);
								}, "input300 final observed editor text is incorrect");
								const after = await readComponentDiagnostics(tui, "editor");
								const frames = componentFrameTraces(tui, traceStart, "editor");
								const inputs = after.inputs.slice(before.inputs.length);
								assert.equal(
									inputs.length,
									scenario.eventCount,
									"input300 did not produce exactly 300 component inputs",
								);
								samples = inputs.map((input) => {
									const frame = frameByRevision(frames, input.revision);
									return {
										receivedAt: input.receivedAt,
										publishedAt: input.publishedAt,
										inputRevision: input.revision,
										frameRevision: input.revision,
										appliedAt: frame.atMs,
										hostBytes: componentFrameBytes(tui, "editor", input.revision),
										rustBytes: frame.bytes!,
									};
								});
							} else if (scenario.name === "paste5000") {
								const input = scenario.input!.character.repeat(scenario.input!.count);
								const requestsBefore = tui.requests.filter(
									(request) => request.command === "extension_component_input",
								).length;
								const framesBefore = componentFrameTraces(tui, traceStart, "editor").length;
								tui.paste(input);
								await waitFor(async () => {
									await tui.pump();
									return (
										tui.requests.filter((request) => request.command === "extension_component_input")
											.length ===
										requestsBefore + 1
									);
								}, "bracketed paste did not issue exactly one component request");
								const pasteRequest = tui.requests
									.filter((request) => request.command === "extension_component_input")
									.at(-1)!;
								const bracketedInput = `\u001b[200~${input}\u001b[201~`;
								pasteRequestBytes = Buffer.byteLength(pasteRequest.data ?? "", "utf8");
								bracketedPasteBytes = Buffer.byteLength(bracketedInput, "utf8");
								assert.equal(pasteRequest.data, bracketedInput, "bracketed paste request text is incorrect");
								assert.equal(pasteRequestBytes, 5_012, "bracketed paste request bytes are incorrect");
								assert.equal(
									bracketedPasteBytes,
									5_012,
									"bracketed paste terminal framing bytes are incorrect",
								);
								await waitFor(async () => {
									await tui.pump();
									return componentFrameTraces(tui, traceStart, "editor").length > framesBefore;
								}, "bracketed paste did not reach a covering Rust frame");
								finalText = input;
								await waitFor(async () => {
									await tui.pump();
									const diagnostics = await readComponentDiagnostics(tui, "editor");
									return (
										diagnostics.editorTextBytes === 5_000 &&
										diagnostics.editorTextHash === createHash("sha256").update(input).digest("hex")
									);
								}, "paste5000 final observed editor text is incorrect");
								const after = await readComponentDiagnostics(tui, "editor");
								const frames = componentFrameTraces(tui, traceStart, "editor");
								const inputs = after.inputs.slice(before.inputs.length);
								assert.equal(inputs.length, 1, "paste5000 fragmented into multiple component inputs");
								const inputMetric = inputs[0]!;
								assert.equal(inputMetric.bytes, 5_012, "paste5000 observed input bytes are incorrect");
								const frame = frameByRevision(frames, inputMetric.revision);
								samples = [
									{
										receivedAt: inputMetric.receivedAt,
										publishedAt: inputMetric.publishedAt,
										inputRevision: inputMetric.revision,
										frameRevision: inputMetric.revision,
										appliedAt: frame.atMs,
										hostBytes: componentFrameBytes(tui, "editor", inputMetric.revision),
										rustBytes: frame.bytes!,
									},
								];
							} else if (scenario.name === "render_animation") {
								tui.send("C-f");
								await waitFor(
									async () => {
										await tui.pump();
										const diagnostics = await readComponentDiagnostics(tui, "editor");
										return (
											diagnostics.invalidations.length - before.invalidations.length ===
												scenario.eventCount &&
											diagnostics.invalidations
												.slice(before.invalidations.length)
												.every(
													(entry) => entry.publishedAt !== undefined && entry.revision !== undefined,
												) &&
											diagnostics.lastFinalState === scenario.animationFrames &&
											tui.pane().includes(`contract-animation=${scenario.animationFrames}`)
										);
									},
									"CustomEditor animation did not complete 1000 invalidations",
									30_000,
								);
								const after = await readComponentDiagnostics(tui, "editor");
								const invalidations = after.invalidations.slice(before.invalidations.length);
								assert.equal(
									invalidations.length,
									scenario.eventCount,
									"animation invalidation count is incorrect",
								);
								assert.ok(
									after.coalescedCount > before.coalescedCount,
									"animation did not coalesce invalidations",
								);
								assert.ok(
									invalidations.every(
										(entry) => entry.publishedAt !== undefined && entry.revision !== undefined,
									),
								);
								const frames = componentFrameTraces(tui, traceStart, "editor");
								samples = invalidations.map((invalidation) => {
									const frame = frameByRevision(frames, invalidation.revision!);
									return {
										receivedAt: invalidation.invalidateRequestedAt,
										publishedAt: invalidation.publishedAt!,
										inputRevision: invalidation.revision!,
										frameRevision: invalidation.revision!,
										appliedAt: frame.atMs,
										hostBytes: componentFrameBytes(tui, "editor", invalidation.revision!),
										rustBytes: frame.bytes!,
									};
								});
							} else {
								const autocomplete = scenario.autocomplete!;
								for (let index = 0; index < autocomplete.tabs / 2; index++) {
									await clearCustomEditor(tui);
									await typeInCustomEditor(tui, autocomplete.source);
									const beforeFirstTab = (await readComponentDiagnostics(tui, "editor")).inputs.length;
									tui.send("Tab");
									await waitFor(async () => {
										await tui.pump();
										return customEditorFrameWithLine(tui, "provider completion") !== undefined;
									}, "autocomplete menu did not cover the Tab input");
									const firstInput = (await readComponentDiagnostics(tui, "editor")).inputs.at(-1)!;
									assert.ok(firstInput && beforeFirstTab < beforeFirstTab + 1);
									const firstFrame = customEditorFrameWithLine(tui, "provider completion")!;
									await waitFor(
										() =>
											componentFrameTraces(tui, traceStart, "editor").some(
												(frame) => frame.revision === firstFrame.revision,
											),
										"Rust did not apply the autocomplete menu frame",
									);
									const beforeSecondTab = (await readComponentDiagnostics(tui, "editor")).inputs.length;
									tui.send("Tab");
									await waitFor(async () => {
										await tui.pump();
										return customEditorStateTexts(tui).at(-1) === autocomplete.completion;
									}, "autocomplete selection did not update the CustomEditor text");
									const secondInput = (await readComponentDiagnostics(tui, "editor")).inputs.at(-1)!;
									assert.ok(secondInput && beforeSecondTab < beforeSecondTab + 1);
									const secondFrame = customEditorFrames(tui).at(-1)!;
									await waitFor(
										() =>
											componentFrameTraces(tui, traceStart, "editor").some(
												(frame) => frame.revision === secondFrame.revision,
											),
										"Rust did not apply the autocomplete selection frame",
									);
									const frames = componentFrameTraces(tui, traceStart, "editor");
									for (const [inputMetric, frameRevision] of [
										[firstInput, firstFrame.revision],
										[secondInput, secondFrame.revision],
									] as const) {
										const frame = frameByRevision(frames, frameRevision);
										samples.push({
											receivedAt: inputMetric.receivedAt,
											publishedAt: inputMetric.publishedAt,
											inputRevision: inputMetric.revision,
											frameRevision,
											appliedAt: frame.atMs,
											hostBytes: componentFrameBytes(tui, "editor", frameRevision),
											rustBytes: frame.bytes!,
										});
									}
								}
								finalText = autocomplete.completion;
								assert.equal(
									samples.length,
									scenario.eventCount,
									"autocomplete did not execute exactly 20 Tab inputs",
								);
								assert.equal(
									customEditorActions(tui).filter((action) => action.text.includes("@stale-old-result"))
										.length,
									0,
									"stale autocomplete result reached the editor",
								);
							}

							const host = hostMetrics.stop();
							const rust = rustMetrics.stop();
							const after = await readComponentDiagnostics(tui, "editor");
							const frames = componentFrameTraces(tui, traceStart, "editor");
							const latencies = samples.map((sample) => sample.appliedAt - sample.receivedAt);
							assert.ok(
								samples.every(
									(sample) =>
										sample.publishedAt >= sample.receivedAt && sample.appliedAt >= sample.publishedAt,
								),
							);
							assert.equal(
								samples.length,
								scenario.eventCount,
								`${scenario.name} metric sample count is incorrect`,
							);
							const summary = timingSummary(latencies);
							assert.ok(summary.p95Ms <= scenario.thresholds.p95Ms, `${scenario.name} p95 exceeds its budget`);
							assert.ok(summary.p99Ms <= scenario.thresholds.p99Ms, `${scenario.name} p99 exceeds its budget`);
							const elapsedMs =
								Math.max(...samples.map((sample) => sample.appliedAt)) -
								Math.min(...samples.map((sample) => sample.receivedAt));
							if (scenario.name === "render_animation") {
								const frameBudget = Math.ceil(elapsedMs / (1_000 / 60)) + 2;
								assert.ok(
									after.renderCount - before.renderCount <= frameBudget,
									"animation Host render count exceeds 60fps budget",
								);
								assert.ok(
									after.publishCount - before.publishCount <= frameBudget,
									"animation Host publish count exceeds 60fps budget",
								);
							}
							const observedFinalText = observedEditorText(after, finalText, scenario.name);
							if (scenario.name === "render_animation") {
								finalAnimation = after.lastFinalState ?? undefined;
								assert.equal(
									finalAnimation,
									scenario.animationFrames,
									"animation final state diagnostics are incorrect",
								);
							}
							const record = {
								implementation: config.implementation,
								scenario: scenario.name,
								size: `${width}x${height}`,
								round,
								eventCount: scenario.eventCount,
								p50Ms: summary.p50Ms,
								p95Ms: summary.p95Ms,
								p99Ms: summary.p99Ms,
								maxMs: summary.maxMs,
								hostRenderCount: after.renderCount - before.renderCount,
								hostPublishCount: after.publishCount - before.publishCount,
								coalescedCount: after.coalescedCount - before.coalescedCount,
								hostBytes: samples.reduce((total, sample) => total + sample.hostBytes, 0),
								rustFrameCount: frames.length,
								rustBytes: frames.reduce((total, frame) => total + frame.bytes!, 0),
								hostPeakRssBytes: host.hostPeakRssBytes,
								rustPeakRssBytes: rust.rssMaxBytes,
								combinedPeakRssBytes: host.hostPeakRssBytes + rust.rssMaxBytes,
								cpuMs: host.hostCpuMs + rust.cpuMs,
								hostCpuMs: host.hostCpuMs,
								rustCpuMs: rust.cpuMs,
								transcriptRegroupBefore: regroupBefore,
								transcriptRegroupAfter: transcriptRegroupSignature(tui),
								finalTextLength: observedFinalText.bytes,
								finalTextHash: observedFinalText.hash,
								duplicateInputCount: 0,
								staleCompletionCount: 0,
								...(bracketedPasteBytes === undefined ? {} : { bracketedPasteBytes, pasteRequestBytes }),
								...(finalAnimation === undefined ? {} : { finalAnimation }),
								samples,
							};
							assert.ok(
								record.combinedPeakRssBytes <= config.rssLimitBytes,
								`CustomEditor combined RSS exceeds 180MiB: host=${record.hostPeakRssBytes}, rust=${record.rustPeakRssBytes}`,
							);
							appendFileSync(config.artifact, `${JSON.stringify(record)}\n`);
							assertCustomEditorArtifactSafe(tui.artifactDirectory);
						} finally {
							await finishTuiRound(tui);
						}
					}
				}
			}
		},
		900_000,
	);

	it("opens the command palette, renders typed about and diagnostics, and bridges injected UI requests twice", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(4, { width: 80, height: 24 }, `workspace-foundation-${attempt + 1}`);
			try {
				await waitForInitialPage(tui);
				tui.send("C-p");
				await waitFor(() => tui.pane().includes("命令面板"), "Ctrl+P did not open the command palette");
				await waitFor(() => tui.pane().includes("输入筛选"), "command palette did not apply Host completions");
				for (const command of ["/settings", "/model", "/thinking", "/login"]) {
					tui.sendLiteral(command);
					await waitFor(() => tui.pane().includes(command), `command palette filtering missed ${command}`);
					tui.send("Escape");
					await waitFor(() => !tui.pane().includes("命令面板"), "command palette did not close after filtering");
					if (command !== "/login") {
						tui.send("C-p");
						await waitFor(() => tui.pane().includes("命令面板"), "Ctrl+P did not reopen the command palette");
						await waitFor(
							() => tui.pane().includes("输入筛选"),
							"reopened command palette did not apply Host completions",
						);
					}
				}
				tui.send("C-p");
				await waitFor(() => tui.pane().includes("命令面板"), "command palette did not reopen for help");
				await waitFor(() => tui.pane().includes("输入筛选"), "command palette did not settle before help");
				tui.sendLiteral("/help");
				tui.send("Enter");
				await waitFor(() => tui.pane().includes("/about 显示版本与运行目录"), "Help did not render local keys");
				tui.send("Escape");
				await waitFor(() => tui.pane().includes("命令面板"), "Help overlay did not close to the command palette");
				tui.send("Escape", "Escape");
				await waitFor(() => !tui.pane().includes("命令面板"), "command palette did not close");

				for (const [command, marker] of [
					["/about", "productName"],
					["/doctor", "checks"],
				] as const) {
					tui.sendLiteral(command);
					tui.send("Enter");
					await waitFor(async () => {
						await tui.pump();
						return tui.requests.some(
							(request) => request.command === (command === "/about" ? "get_about" : "get_diagnostics"),
						);
					}, `${command} did not reach the Host`);
					await waitFor(() => tui.pane().includes(marker), `${command} result did not render as a detail overlay`);
					tui.send("Escape");
					await waitFor(() => !tui.pane().includes(marker), `${command} detail overlay did not close`);
				}

				const inject = (id: string, kind: string, payload: JsonValue) =>
					tui.emitServer({
						type: "event",
						event: { type: "ui_request", id, operationId: `op-${id}`, kind, title: `请求 ${id}`, payload },
					});
				inject("select-1", "select", { options: [{ label: "Beta", value: "beta" }] });
				await waitFor(() => tui.pane().includes("Beta"), "select request did not render");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.clientMessages.some(
						(message) => message.type === "ui_response" && message.id === "select-1" && message.value === "beta",
					);
				}, "Host did not receive select response");

				inject("confirm-1", "confirm", { message: "继续？" });
				await waitFor(() => tui.pane().includes("继续？"), "confirm request did not render");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.clientMessages.some(
						(message) =>
							message.type === "ui_response" && message.id === "confirm-1" && message.confirmed === true,
					);
				}, "Host did not receive confirm response");

				inject("input-1", "input", { value: "pre" });
				await waitFor(() => tui.pane().includes("pre"), "input request did not render");
				tui.sendLiteral("fix");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.clientMessages.some(
						(message) => message.type === "ui_response" && message.id === "input-1" && message.value === "prefix",
					);
				}, "Host did not receive input response");

				inject("secret-1", "secret", {});
				await waitFor(() => tui.pane().includes("请求 secret-1"), "secret request did not render");
				tui.sendLiteral("masked");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.clientMessages.some(
						(message) =>
							message.type === "ui_response" && message.id === "secret-1" && message.value === "masked",
					);
				}, "secret UI kind did not return a value");

				inject("editor-1", "editor", { prefill: "before" });
				await waitFor(() => tui.pane().includes("before"), "editor request did not render");
				tui.sendLiteral("-edited");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.clientMessages.some(
						(message) =>
							message.type === "ui_response" && message.id === "editor-1" && message.value === "before-edited",
					);
				}, "editor UI kind did not return a value");

				inject("notify-device-1", "notify", {
					method: "auth_device_code",
					userCode: "ABCD-EFGH",
					verificationUri: "https://example.test/device",
					intervalSeconds: 5,
					expiresInSeconds: 600,
				});
				await waitFor(() => tui.pane().includes("ABCD-EFGH"), "device code notify did not render");
				tui.send("c");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.clipboardWrites.includes("ABCD-EFGH");
				}, "device code copy did not reach Host clipboard write");
				assert.ok(
					!tui.clientMessages.some(
						(message) => message.type === "ui_response" && message.id === "notify-device-1",
					),
					"notify must not be cancelled or await a UI response",
				);
				tui.send("Escape");

				tui.resize(80, 8);
				await waitFor(() => tui.pane().includes("Enter 提交"), "80x8 Composer did not render before overlay test");
				tui.send("C-p");
				await waitFor(() => tui.pane().includes("命令面板"), "80x8 did not render command palette");
				tui.send("Escape");
				await waitFor(
					() => tui.pane().includes("Enter 提交"),
					"Composer shortcuts did not return after overlay close",
				);
				tui.resize(120, 36);
				tui.resize(80, 8);
				tui.closeProtocol();
				await waitFor(
					() => spawnSync("tmux", ["-L", tui.socket, "has-session", "-t", "tui"]).status !== 0,
					"Rust TUI did not exit after Workspace foundation verification",
				);
				assert.equal(readFileSync(tui.sttyBeforePath, "utf8"), readFileSync(tui.sttyAfterPath, "utf8"));
			} finally {
				tui.closeProtocol();
			}
		}
	}, 120_000);

	it("通过 Host Workspace 处理设置、模型、思考和登录工作台，重试不会重复写入", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(4, { width: 80, height: 24 }, `workspace-workbenches-${attempt + 1}`);
			try {
				await waitForInitialPage(tui);
				const openSlash = async (command: string, marker: string, workspaceCommand: string) => {
					const requestCount = tui.requests.filter((request) => request.command === workspaceCommand).length;
					tui.sendLiteral(command);
					await waitFor(() => tui.pane().includes(command), `${command} did not reach the Composer`);
					tui.send("Enter");
					await waitFor(async () => {
						await tui.pump();
						return tui.requests.filter((request) => request.command === workspaceCommand).length > requestCount;
					}, `${command} did not reach the Host`);
					await waitFor(() => tui.pane().includes(marker), `${command} did not render Host data`);
				};

				await openSlash("/settings", "自动压缩", "list_settings");
				tui.dropNextWorkspaceResponse();
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.settingWrites.length === 1;
				}, "boolean setting did not write once");
				await waitFor(
					() => tui.pane().includes("请求超时，按 r 重试"),
					"dropped setting response did not become retryable",
				);
				tui.send("r");
				await waitFor(async () => {
					await tui.pump();
					return tui.requests.filter((request) => request.command === "set_setting").length >= 2;
				}, "timed out setting write was not retried");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.settingWrites.length === 1;
				}, "setting retry repeated the Host write");
				const booleanRefresh = await waitForRequest(tui, "list_settings", 2);
				await waitFor(() => tui.responseWrites.has(booleanRefresh.id), "Host did not answer settings refresh");
				await waitFor(
					() => tui.pane().includes("开启"),
					"Rust did not apply the refreshed boolean setting before the next edit",
				);

				const enumWritesBefore = tui.requests.filter((request) => request.command === "set_setting").length;
				tui.send("Down");
				await waitFor(() => tui.pane().includes("> 响应模式"), "settings selection did not move to enum");
				tui.send("Enter");
				await waitFor(() => tui.pane().includes("> one"), "enum setting editor did not select its current value");
				tui.send("Down");
				await waitFor(() => tui.pane().includes("> all"), "enum selection did not move to all");
				tui.send("Enter");
				await waitFor(
					async () => {
						await tui.pump();
						return (
							tui.requests.filter((request) => request.command === "set_setting").length >= enumWritesBefore + 1
						);
					},
					() =>
						`enum setting request did not leave Rust: ${JSON.stringify({ requests: tui.requests, pane: tui.pane() })}`,
				);
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.settingWrites.some((write) => write.value === "all");
				}, "enum setting did not save");
				const enumRefresh = await waitForRequest(tui, "list_settings", 3);
				await waitFor(() => tui.responseWrites.has(enumRefresh.id), "Host did not answer enum settings refresh");
				await waitFor(() => tui.pane().includes("全部"), "Rust did not apply the refreshed enum setting");
				assert.equal(tui.runtime.settingWrites.length, 2, "settings writes were not journaled exactly once");

				tui.send("Escape");
				await new Promise((resolve) => setTimeout(resolve, 100));
				await openSlash("/model", "Faux Fast", "list_models");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.modelWrites.length === 1;
				}, "model selection did not reach the Host");
				const modelWriteRequest = tui.requests
					.filter((request) => request.command === "set_session_model")
					.at(-1)?.id;
				assert.ok(modelWriteRequest, "missing model write request");
				await waitFor(() => tui.responseWrites.has(modelWriteRequest), "Host did not answer model selection");
				await new Promise((resolve) => setTimeout(resolve, 200));
				assert.equal(tui.runtime.modelWrites.length, 1, "model selection wrote more than once");

				await openSlash("/thinking", "关闭", "list_models");
				tui.send("Down", "Down", "Down", "Down", "Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.thinkingWrites.includes("high");
				}, "thinking setting did not reach the Host");

				await waitFor(() => tui.pane().includes("Enter 提交"), "thinking selection did not close the overlay");
				await openSlash("/login", "登录测试", "list_model_providers");
				tui.runtime.pauseAfterDeviceCode();
				tui.send("Down", "Enter");
				await waitFor(() => tui.pane().includes("API Key"), "login method list did not render");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.requests.some((request) => request.command === "login_model_provider");
				}, "login command did not reach the Host");
				await waitFor(() => tui.pane().includes("中国大陆节点"), "id/label/description select did not render");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.clientMessages.some(
						(message) =>
							message.type === "ui_response" && message.id === "login-select" && message.value === "region-cn",
					);
				}, "Host did not receive the select id response");
				await waitFor(() => tui.pane().includes("认证输入"), "Host input UI request did not render");
				tui.sendLiteral("input-value");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.clientMessages.some(
						(message) =>
							message.type === "ui_response" && message.id === "login-input" && message.value === "input-value",
					);
				}, "Host did not receive input response");
				await waitFor(() => tui.pane().includes("认证密钥"), "Host secret UI request did not render");
				tui.sendLiteral("credential-secret");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.clientMessages.some(
						(message) =>
							message.type === "ui_response" &&
							message.id === "login-secret" &&
							message.value === "credential-secret",
					);
				}, "Host did not receive secret response");
				await waitFor(() => tui.pane().includes("ABCD-EFGH"), "device code notify did not render");
				await waitFor(
					() => tui.traces().filter((event) => event.event === "ui_notify").length >= 2,
					"auth notifications were not traced",
				);
				tui.send("c");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.clipboardWrites.includes("ABCD-EFGH");
				}, "device code copy did not call Host writeClipboardText");
				assert.ok(
					!["login-auth-url", "login-device-code"].some((id) =>
						tui.clientMessages.some((message) => message.type === "ui_response" && message.id === id),
					),
					"notify must not cancel the auth flow",
				);
				tui.runtime.releaseAuthNotifications();
				await waitFor(() => tui.pane().includes("确认认证？"), "Host confirm UI request did not render");
				tui.dropNextWorkspaceResponse();
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.loginCount === 1;
				}, "login did not complete exactly once");
				assert.deepEqual(tui.runtime.authResponses, ["region-cn", "input-value", "credential-secret"]);
				for (let index = 0; index < 3; index++) {
					tui.send("Escape");
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				await waitFor(
					() => tui.pane().includes("登录测试"),
					"timed-out auth mutation did not restore the provider list",
					15_000,
				);
				tui.send("r");
				await waitFor(async () => {
					await tui.pump();
					return tui.requests.filter((request) => request.command === "login_model_provider").length >= 2;
				}, "dropped login response was not retried");
				await waitFor(() => tui.runtime.loginCount === 1, "login retry duplicated the Host login");
				await waitFor(async () => {
					await tui.pump();
					const requests = tui.requests.filter((request) => request.command === "list_model_providers");
					return requests.length >= 2 && requests.every((request) => tui.responseWrites.has(request.id));
				}, "login retry verification did not finish before logout");
				await waitFor(() => tui.pane().includes("登录测试"), "provider list did not recover after login retry");
				const trace = readFileSync(tui.tracePath, "utf8");
				assert.ok(!trace.includes("credential-secret"), "credential leaked into Rust trace artifact");
				assert.ok(!tui.pane().includes("credential-secret"), "credential was rendered in plain text");

				tui.send("Escape");
				await waitFor(
					() => tui.pane().includes("Enter 提交") && !tui.pane().includes("─登录"),
					"login provider list did not close before logout",
				);
				await openSlash("/logout", "退出登录", "list_model_providers");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.logoutCount === 1;
				}, "logout did not execute exactly once");
				assert.equal(tui.runtime.loginCount, 1);
				assert.equal(tui.runtime.logoutCount, 1);

				tui.resize(80, 8);
				await waitFor(() => tui.pane().includes("Enter 提交"), "80x8 did not recover composer after workbenches");
				tui.resize(120, 36);
			} finally {
				tui.closeProtocol();
			}
		}
	}, 180_000);

	it("通过 tmux/FIFO 两轮操作六个项目工作台 Overlay", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(
				4,
				{ width: 80, height: 24 },
				`workspace-project-workbenches-${attempt + 1}`,
				({ directory, sessionPath }) => new WorkbenchFixture(directory, sessionPath),
			);
			try {
				await waitForInitialPage(tui);
				const fixture = tui.fixture!;
				const openSlash = async (command: string, marker: string, workspaceCommand: string) => {
					const count = tui.requests.filter((request) => request.command === workspaceCommand).length;
					tui.sendLiteral(command);
					await waitFor(() => tui.pane().includes(command), `${command} did not reach the Composer`);
					tui.send("Enter");
					await waitFor(async () => {
						await tui.pump();
						return tui.requests.filter((request) => request.command === workspaceCommand).length > count;
					}, `${command} did not reach the Host`);
					await waitFor(() => tui.pane().includes(marker), `${command} did not render Host data`);
				};

				await openSlash("/changes", "staged.ts", "get_git_status");
				tui.send("Tab");
				await waitFor(() => tui.pane().includes("变更 [已暂存]"), "changes Tab did not select staged files");
				tui.send("Tab");
				await waitFor(() => tui.pane().includes("变更 [未暂存]"), "changes Tab did not select unstaged files");
				tui.send("Tab");
				await waitFor(() => tui.pane().includes("变更 [全部]"), "changes Tab did not select all files");
				tui.sendLiteral("unstaged");
				await waitFor(() => tui.pane().includes("unstaged.ts"), "changes filter did not keep matching file");
				tui.send("Enter");
				await waitForRequest(tui, "get_git_diff");
				await waitFor(() => tui.pane().includes("变更详情"), "changes detail did not render");
				tui.send("C-o");
				await waitFor(() => tui.pane().includes("diff --git"), "changes detail did not expand diff");
				tui.send("Escape");
				await waitFor(() => tui.pane().includes("变更 [全部]"), "changes detail did not return to list");
				tui.send("Escape");
				await waitFor(() => tui.pane().includes("Enter 提交"), "changes list did not close before next overlay");

				await openSlash("/skills", "fixture-skill", "list_skills");
				tui.send("Enter");
				await waitFor(() => tui.pane().includes("fixture-skill 作用域"), "skill scope selector did not render");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.skill === 1;
				}, "skill toggle did not write through Host");
				await waitFor(() => tui.pane().includes("已禁用"), "skill toggle result did not refresh list");
				tui.send("Escape");
				await waitFor(() => tui.pane().includes("Enter 提交"), "skills list did not close before trust");

				await openSlash("/trust", "项目资源已信任", "get_project_trust");
				tui.send("t");
				await waitFor(() => tui.pane().includes("确认取消信任此项目"), "trust warning confirmation did not render");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.trust === 1;
				}, "trust confirmation did not write through Host");
				await waitFor(
					() => tui.pane().includes("项目资源被明确设为不信任"),
					"trust result did not refresh canonical state",
				);
				tui.send("Escape");
				await waitFor(() => tui.pane().includes("Enter 提交"), "trust list did not close before instructions");

				await openSlash("/instructions", "AGENTS.md", "list_project_instructions");
				tui.send("Tab");
				const hostInstructionRequest = await waitForRequest(tui, "list_host_instructions");
				await waitFor(
					() => tui.responseWrites.has(hostInstructionRequest.id),
					"Host did not answer host instruction list",
				);
				await waitFor(
					() => tui.pane().includes("/tmp/host/AGENTS.md"),
					() =>
						`instruction scope Tab did not render host instructions: ${JSON.stringify({ pane: tui.pane(), responses: tui.serverMessages.filter((message) => message.type === "response" && message.id === hostInstructionRequest.id) })}`,
				);
				tui.send("Enter");
				await waitFor(() => tui.pane().includes("编辑 AGENTS.md"), "host instruction editor did not render");
				tui.sendLiteral(" 更新");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.instruction === 1;
				}, "host instruction save did not write through Host");
				tui.send("Escape");
				await waitFor(
					() => tui.pane().includes("Enter 提交"),
					"host instructions did not close before conflict test",
				);

				await openSlash("/instructions", "AGENTS.md", "list_project_instructions");
				fixture.instructionConflicts = 1;
				tui.send("Enter");
				await waitFor(() => tui.pane().includes("编辑 AGENTS.md"), "project instruction editor did not render");
				tui.sendLiteral(" 更新");
				tui.send("Enter");
				const conflictRequest = await waitForRequest(tui, "save_project_instruction");
				await waitFor(
					() => tui.responseWrites.has(conflictRequest.id),
					"Host did not respond to instruction conflict",
				);
				await waitFor(
					() => tui.pane().includes("重新加载"),
					() => `instruction expectedHash conflict did not render recovery: ${JSON.stringify(tui.pane())}`,
				);
				tui.send("Enter");
				await waitFor(
					() => tui.pane().includes("指令 [项目]"),
					"instruction conflict reload did not restore project list",
				);
				tui.send("Escape");
				await waitFor(
					() => tui.pane().includes("Enter 提交"),
					"project instructions did not close before packages",
				);

				await openSlash("/packages", "npm:fixture", "list_packages");
				tui.send("i");
				await waitFor(() => tui.pane().includes("安装包来源"), "package install editor did not render");
				tui.sendLiteral("npm:added");
				tui.send("Enter");
				await waitFor(() => tui.pane().includes("安装包作用域"), "package scope selector did not render");
				tui.send("Down");
				await waitFor(() => tui.pane().includes("写入项目配置"), "project package scope did not render");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.package === 1;
				}, "package install did not write through Host");
				await waitFor(() => tui.pane().includes("npm:added"), "package install response did not refresh list");
				tui.send("d");
				await waitFor(
					() => tui.pane().includes("确认移除当前包配置"),
					"package delete confirmation did not render",
				);
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.package === 2;
				}, "package delete did not write through Host");
				await waitFor(
					() => tui.pane().includes("包"),
					"package delete response did not refresh list before update",
				);
				tui.send("U");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.package === 3;
				}, "package update did not write through Host");
				await waitFor(async () => {
					await tui.pump();
					const requests = tui.requests.filter((request) => request.command === "update_packages");
					const request = requests.at(-1);
					return request !== undefined && tui.responseWrites.has(request.id);
				}, "package update response was not written before closing the list");
				for (let index = 0; index < 3; index++) {
					tui.send("Escape");
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				await waitFor(
					() => tui.pane().includes("Enter 提交") && !tui.pane().includes("─包"),
					() => `packages list did not close before update: ${JSON.stringify(tui.pane())}`,
				);

				await openSlash("/update", "0.84.3", "check_for_updates");
				await waitFor(() => tui.pane().includes("0.84.3"), "update check did not render latest version");
				assert.ok(!tui.pane().includes("立即更新"), "update overlay exposed in-TUI self update");
				tui.send("r");
				await waitForRequest(tui, "check_for_updates", 2);
				tui.resize(80, 8);
				await waitFor(
					() => tui.pane().includes("更新检查") || tui.pane().includes("Enter 提交"),
					"80x8 did not render project workbench",
				);
			} finally {
				tui.closeProtocol();
			}
		}
	}, 240_000);

	it("通过 tmux/FIFO 两轮运行 Subagent 工作台和文本剪贴板", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(4, { width: 80, height: 24 }, `subagent-clipboard-${attempt + 1}`);
			try {
				await waitForInitialPage(tui);
				const leasesBefore = hostLeaseCount(tui.service);
				await openSubagents(tui);
				assert.ok(tui.pane().includes("fixture-completed"), "completed Subagent is missing");
				tui.send("Enter");
				await waitForRequest(tui, "read_subagent");
				await waitFor(() => tui.pane().includes("Subagent 详情"), "Subagent detail did not render");
				tui.send("Enter");
				await waitForRequest(tui, "list_subagents", 2);
				await waitFor(() => tui.pane().includes("fixture-running"), "nested Subagent list did not render");
				tui.send("Escape");
				await waitFor(() => tui.pane().includes("Subagent 详情"), "nested Esc did not return to detail");
				tui.send("v");
				await waitForRequest(tui, "read_transcript", 2);
				await waitFor(() => tui.pane().includes("会话只读"), "Subagent readonly transcript did not render");
				assert.equal(hostLeaseCount(tui.service), leasesBefore, "readonly Subagent view acquired a lease");
				tui.send("Escape", "Escape", "Escape");
				await waitFor(() => tui.pane().includes("fixture-running"), "Subagent list did not return");

				tui.send("Down", "c");
				await waitFor(() => tui.pane().includes("继续 fixture-completed"), "continue editor did not render");
				tui.sendLiteral("continue once");
				tui.dropNextWorkspaceResponse();
				tui.send("Enter");
				await waitFor(
					async () => {
						await tui.pump();
						return tui.runtime.subagentContinue.length === 1;
					},
					() =>
						`continue did not reach Host: ${JSON.stringify({ pane: tui.pane(), requests: tui.requests, writes: tui.runtime.subagentContinue })}`,
				);
				await waitFor(
					() => tui.pane().includes("请求超时，按 r 重试"),
					"dropped continue response was not retryable",
				);
				tui.send("r");
				await waitFor(async () => {
					await tui.pump();
					return tui.requests.filter((request) => request.command === "continue_subagent").length >= 2;
				}, "continue retry did not leave Rust");
				await waitFor(() => tui.runtime.subagentContinue.length === 1, "continue retry duplicated Host work");
				await waitForRequest(tui, "list_subagents", 3);
				await waitFor(() => tui.pane().includes("fixture-completed"), "continue refresh did not restore list");

				tui.send("a");
				await waitFor(() => tui.pane().includes("确认停止 fixture-completed"), "abort confirmation did not render");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.subagentAbortCount === 1;
				}, "abort did not reach Host");
				assert.equal(tui.runtime.subagentContinue.length, 1, "abort changed continue count");
				tui.send("Escape");
				await waitFor(() => tui.pane().includes("Enter 提交"), "Subagent overlay did not close");

				tui.sendLiteral("/clipboard");
				tui.send("Enter");
				await waitForRequest(tui, "read_clipboard_image");
				await waitFor(() => tui.pane().includes("图片剪贴板: image/png"), "clipboard image did not render");
				tui.send("i");
				tui.send("w");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.clipboardWrites.includes("clipboard fixture text");
				}, "clipboard insert/write did not reach Host");
				tui.send("c");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.clipboardWrites.filter((text) => text === "clipboard fixture text").length >= 2;
				}, "clipboard preview copy did not reach Host");
				tui.send("Escape");
				const readCount = tui.requests.filter((request) => request.command === "read_clipboard_text").length;
				tui.send("C-S-v");
				await waitForRequest(tui, "read_clipboard_text", readCount + 1);
				tui.send("C-y");
				await waitFor(async () => {
					await tui.pump();
					return tui.runtime.clipboardWrites.length >= 3;
				}, "context copy did not reach Host");
				tui.resize(80, 8);
				await waitFor(() => tui.pane().includes("Enter 提交"), "80x8 did not recover Composer after clipboard");
			} finally {
				tui.closeProtocol();
			}
		}
	}, 180_000);

	it("通过 tmux/FIFO 两轮验收图片附件、补全和冻结重试", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(4, { width: 80, height: 8 }, `attachments-${attempt + 1}`);
			try {
				await waitForInitialPage(tui);
				const completionCount = tui.requests.filter((request) => request.command === "get_completions").length;
				tui.sendLiteral('/attach "images/中文');
				tui.send("Tab");
				await waitForRequest(tui, "get_completions", completionCount + 1);
				await waitFor(() => tui.pane().includes("添加图片"), "image completion did not render");
				tui.send("Enter");
				await waitForRequest(tui, "read_project_image");
				await waitFor(() => tui.pane().includes("图片 1"), "completed image was not attached");

				tui.sendLiteral("/attachments");
				tui.send("Enter");
				await waitFor(() => tui.pane().includes("图片附件"), "attachment list did not render at 80x8");
				tui.send("Enter");
				await waitFor(() => tui.pane().includes("图片预览"), "attachment preview did not render");
				tui.send("Escape");
				await waitFor(() => tui.pane().includes("图片附件"), "preview Esc did not return to attachment list");
				tui.send("d");
				await waitFor(
					() => tui.pane().includes("删除图片附件"),
					"attachment deletion did not require confirmation",
				);
				tui.send("Enter");
				await waitFor(
					() => tui.pane().includes("没有图片附件") || tui.pane().includes("Enter 提交"),
					"attachment was not deleted",
				);
				tui.send("Escape");
				await waitFor(
					() => !tui.pane().includes("图片附件") && tui.pane().includes("Enter 提交"),
					() => `attachment list did not return to Composer: ${tui.pane()}`,
				);

				const textReads = tui.requests.filter((request) => request.command === "read_clipboard_text").length;
				const imageReads = tui.requests.filter((request) => request.command === "read_clipboard_image").length;
				tui.sendLiteral("/clipboard");
				tui.send("Enter");
				await waitForRequest(tui, "read_clipboard_text", textReads + 1);
				await waitForRequest(tui, "read_clipboard_image", imageReads + 1);
				await waitFor(() => tui.pane().includes("图片剪贴板: image/png"), "mixed clipboard preview did not render");
				tui.send("Escape");
				await waitFor(
					() => !tui.pane().includes("图片剪贴板") && tui.pane().includes("Enter 提交"),
					"clipboard overlay did not restore Composer",
				);

				tui.sendLiteral('/attach "images/中文');
				tui.send("Tab");
				await waitForRequest(tui, "get_completions", completionCount + 2);
				tui.send("Enter");
				await waitForRequest(tui, "read_project_image", 2);
				await waitFor(() => tui.pane().includes("图片 1"), "second frozen image was not attached");

				tui.dropNextWorkspaceResponse();
				tui.send("Escape");
				tui.sendLiteral("frozen retry");
				tui.send("Enter");
				await waitFor(
					() => tui.pane().includes("请求超时，按 r 重试"),
					"dropped attachment prompt did not become retryable",
					10_000,
				);
				const prompts = tui.requests.filter((request) => request.command === "prompt").length;
				tui.send("C-r");
				await waitForRequest(tui, "prompt", prompts + 1);
				await waitFor(() => tui.runtime.prompts.length === 1, "frozen retry duplicated Host prompt");
				await waitFor(
					() => tui.pane().includes("图片 0") || tui.pane().includes("Enter 提交"),
					"frozen attachment was not cleared after acknowledgement",
				);
			} finally {
				tui.closeProtocol();
			}
		}
	}, 180_000);

	it("reacquires a new lease after a dropped response without repeating Host operations", async () => {
		const directory = mkdtempSync(join(tmpdir(), "lystar-rust-m8-reacquire-"));
		directories.add(directory);
		const sessionPath = join(directory, "session.jsonl");
		writeFileSync(sessionPath, sessionEntries(1));
		const runtime = new FakeRuntimeSession(sessionPath);
		const service = new GuiHostService(createAdapter(runtime), { agentDir: directory });
		cleanups.push(() => service.dispose());
		const clientInstanceId = "m8-reacquire-client";

		const acquire = async (
			messages: ServerMessage[],
			connection: ReturnType<GuiHostService["createConnection"]>,
			id: string,
		) => {
			await connection.handle({ type: "hello", version: 1, clientInstanceId });
			await connection.handle({
				type: "request",
				id,
				request: { command: "acquire_session", sessionPath, clientInstanceId },
			});
			const response = messages.find((message) => message.type === "response" && message.id === id);
			assert.ok(response && response.type === "response" && response.ok, `missing ${id} lease response`);
			return (response.result as { lease: { leaseId: string } }).lease.leaseId;
		};
		const responseFor = (messages: ServerMessage[], id: string) => {
			const response = messages.find((message) => message.type === "response" && message.id === id);
			assert.ok(response && response.type === "response", `missing ${id} response`);
			return response;
		};

		const droppedMessages: ServerMessage[] = [];
		let dropped = false;
		const first = service.createConnection(async (message) => {
			droppedMessages.push(message);
			if (message.type === "response" && message.id === "prompt-first") {
				dropped = true;
				throw new Error("simulated response drop");
			}
		});
		const firstLease = await acquire(droppedMessages, first, "acquire-first");
		const prompt = {
			type: "request" as const,
			id: "prompt-first",
			request: {
				command: "prompt" as const,
				sessionPath,
				leaseId: firstLease,
				clientInstanceId,
				clientRequestId: "prompt-response-drop",
				text: "only once after reacquire",
			},
		};
		await first.handle(prompt);
		assert.ok(dropped, "the accepted prompt response was not rejected");
		assert.deepEqual(runtime.prompts, [], "prompt ran before its accepted response was delivered");
		await first.handle({
			type: "request",
			id: "release-after-drop",
			request: { command: "release_session", sessionPath, leaseId: firstLease },
		});
		const release = responseFor(droppedMessages, "release-after-drop");
		assert.ok(release.ok, "accepted response reservation blocked release_session");
		assert.equal(hostLeaseCount(service), 0, "accepted response drop retained a lease");
		assert.equal(hostRuntimeCount(service), 0, "accepted response drop retained a runtime");
		await first.close();

		const retryMessages: ServerMessage[] = [];
		const retry = service.createConnection(async (message) => {
			retryMessages.push(message);
		});
		const retryLease = await acquire(retryMessages, retry, "acquire-retry");
		await retry.handle({ ...prompt, id: "prompt-retry", request: { ...prompt.request, leaseId: retryLease } });
		await waitFor(() => runtime.prompts.length === 1, "reacquired prompt did not run");
		assert.deepEqual(runtime.prompts, ["only once after reacquire"]);
		const promptRetry = responseFor(retryMessages, "prompt-retry");
		assert.ok(promptRetry.ok, "reacquired prompt was rejected");
		assert.equal((promptRetry.result as { duplicate: boolean }).duplicate, true);

		await Promise.all([
			retry.handle({
				type: "request",
				id: "prompt-concurrent-a",
				request: {
					command: "prompt",
					sessionPath,
					leaseId: retryLease,
					clientInstanceId,
					clientRequestId: "prompt-concurrent",
					text: "concurrent once",
				},
			}),
			retry.handle({
				type: "request",
				id: "prompt-concurrent-b",
				request: {
					command: "prompt",
					sessionPath,
					leaseId: retryLease,
					clientInstanceId,
					clientRequestId: "prompt-concurrent",
					text: "concurrent once",
				},
			}),
		]);
		await waitFor(
			() => runtime.prompts.filter((text) => text === "concurrent once").length === 1,
			"concurrent prompt was not idempotent",
		);
		await retry.handle({
			type: "request",
			id: "prompt-payload-conflict",
			request: {
				command: "prompt",
				sessionPath,
				leaseId: retryLease,
				clientInstanceId,
				clientRequestId: "prompt-concurrent",
				text: "different payload",
			},
		});
		const conflict = responseFor(retryMessages, "prompt-payload-conflict");
		assert.ok(!conflict.ok && conflict.error.code === "operation_request_conflict");

		const retryQueueAfterDrop = async (
			requestBase: Extract<
				Extract<ClientMessage, { type: "request" }>["request"],
				{ command: "steer" | "follow_up" | "clear_queue" }
			>,
		) => {
			const command = requestBase.command;
			runtime.setRunning(command !== "clear_queue");
			const firstMessages: ServerMessage[] = [];
			let queueDropped = false;
			const queueFirst = service.createConnection(async (message) => {
				firstMessages.push(message);
				if (message.type === "response" && message.id === `${command}-first`) {
					queueDropped = true;
					throw new Error("simulated queue response drop");
				}
			});
			const queueLease = await acquire(firstMessages, queueFirst, `${command}-acquire-first`);
			const request = {
				type: "request" as const,
				id: `${command}-first`,
				request: { ...requestBase, leaseId: queueLease },
			} satisfies ClientMessage;
			await queueFirst.handle(request);
			assert.ok(queueDropped, `${command} response was not dropped`);
			await queueFirst.close();
			const queueRetryMessages: ServerMessage[] = [];
			const queueRetry = service.createConnection(async (message) => {
				queueRetryMessages.push(message);
			});
			const queueRetryLease = await acquire(queueRetryMessages, queueRetry, `${command}-acquire-retry`);
			await queueRetry.handle({
				...request,
				id: `${command}-retry`,
				request: { ...request.request, leaseId: queueRetryLease },
			});
			const response = responseFor(queueRetryMessages, `${command}-retry`);
			assert.ok(response.ok, `${command} retry was rejected`);
			const result = response.result as { duplicate: boolean; operation: { status: string } };
			assert.equal(result.duplicate, true, `${command} retry did not return the existing operation`);
			assert.equal(result.operation.status, "completed", `${command} journal did not finish`);
			await queueRetry.close();
			return queueRetryLease;
		};

		let currentLease = await retryQueueAfterDrop({
			command: "steer",
			sessionPath,
			leaseId: "",
			clientInstanceId,
			clientRequestId: "steer-response-drop",
			text: "steer once",
		});
		currentLease = await retryQueueAfterDrop({
			command: "follow_up",
			sessionPath,
			leaseId: "",
			clientInstanceId,
			clientRequestId: "follow_up-response-drop",
			text: "follow once",
		});
		currentLease = await retryQueueAfterDrop({
			command: "clear_queue",
			sessionPath,
			leaseId: "",
			clientInstanceId,
			clientRequestId: "clear_queue-response-drop",
		});
		assert.deepEqual(runtime.steers, ["steer once"]);
		assert.deepEqual(runtime.followUps, ["follow once"]);
		assert.equal(runtime.clearQueueCount, 1);

		runtime.setRunning(false);
		for (const command of ["steer", "follow_up"] as const) {
			await retry.handle({
				type: "request",
				id: `${command}-idle`,
				request: {
					command,
					sessionPath,
					leaseId: currentLease,
					clientInstanceId,
					clientRequestId: `${command}-idle`,
					text: "not accepted while idle",
				},
			});
			const response = responseFor(retryMessages, `${command}-idle`);
			assert.ok(!response.ok && response.error.code === "session_not_active");
		}
		await retry.handle({
			type: "request",
			id: "clear-idle",
			request: {
				command: "clear_queue",
				sessionPath,
				leaseId: currentLease,
				clientInstanceId,
				clientRequestId: "clear-idle",
			},
		});
		const clearIdle = responseFor(retryMessages, "clear-idle");
		assert.ok(clearIdle.ok, "clear_queue must remain available while idle");
		assert.equal(runtime.clearQueueCount, 2);

		await retry.handle({ type: "request", id: "operations", request: { command: "list_operations", sessionPath } });
		const operations = responseFor(retryMessages, "operations");
		assert.ok(operations.ok, "operation journal query failed");
		const journal = operations.result as Array<{ clientRequestId: string; status: string }>;
		for (const requestId of [
			"prompt-response-drop",
			"prompt-concurrent",
			"steer-response-drop",
			"follow_up-response-drop",
			"clear_queue-response-drop",
			"clear-idle",
		]) {
			assert.equal(journal.find((operation) => operation.clientRequestId === requestId)?.status, "completed");
		}
		await retry.close();
	}, 30_000);

	it("keeps a ten-line Composer, status, and shortcuts within 80x8 after resize", async () => {
		const tui = await startTui(4, { width: 80, height: 8 }, "composer-80x8");
		try {
			await waitForInitialPage(tui);
			tui.runtime.emit({
				type: "progress",
				payload: { type: "tool_start", toolCallId: "small-error", name: "read", summary: "错误区域仍可见" },
			});
			for (let line = 0; line < 10; line++) {
				tui.sendLiteral(`line-${line + 1}`);
				if (line < 9) tui.send("C-j");
			}
			await waitFor(() => tui.pane().includes("line-10|"), "Composer cursor did not remain visible at 80x8");
			const small = tui.pane();
			writeFileSync(join(tui.artifactDirectory, "80x8-multiline.txt"), small);
			const lines = small.split("\n").slice(0, 8);
			const border = lines.findIndex((line) => line.includes("─"));
			const cursor = lines.findIndex((line) => line.includes("line-10|"));
			const shortcuts = lines.findIndex((line) => line.includes("Enter 提交"));
			const error = lines.findIndex((line) => line.includes("错误区域"));
			assert.equal(lines.length, 8, "80x8 capture must stay within eight rows");
			assert.ok(
				border >= 0 &&
					cursor > border &&
					shortcuts > cursor &&
					new Set([border, cursor, error, shortcuts]).size === 4,
				"80x8 regions overlap",
			);
			assert.ok(
				lines.every((line) => [...line].length <= 80),
				"80x8 multiline Composer exceeds its width",
			);

			for (const [width, height] of [
				[80, 24],
				[120, 36],
				[200, 60],
			] as const) {
				tui.resize(width, height);
				await waitFor(() => tui.pane().split("\n").length >= height, `${width}x${height} did not render`);
				writeFileSync(join(tui.artifactDirectory, `${width}x${height}-multiline.txt`), tui.pane());
			}
			tui.resize(80, 8);
			await waitFor(() => tui.pane().includes("Enter 提交"), "80x8 shortcuts did not return after resize");
			tui.closeProtocol();
			await waitFor(
				() => spawnSync("tmux", ["-L", tui.socket, "has-session", "-t", "tui"]).status !== 0,
				"Rust TUI did not exit after the 80x8 multiline check",
			);
			assert.equal(readFileSync(tui.sttyBeforePath, "utf8"), readFileSync(tui.sttyAfterPath, "utf8"));
		} finally {
			tui.closeProtocol();
		}
	}, 60_000);

	it("records three 10k-tool older-page runs with 25 end-to-frame samples each", async () => {
		const firstFrameMs: number[] = [];
		const rssSamples: number[] = [];
		const runs: Array<{
			run: number;
			samples: ReturnType<typeof pageMetric>[];
			endToFrameP95Ms: number;
			decodeApplyDrawP95Ms: number;
		}> = [];
		const artifactDirectory = join(artifactRoot, `perf-${process.pid}-${Date.now()}`);
		mkdirSync(artifactDirectory, { recursive: true });
		for (let run = 0; run < 3; run++) {
			const samples: ReturnType<typeof pageMetric>[] = [];
			for (let round = 0; round < 5; round++) {
				const tui = await startTui(10_000, { width: 120, height: 36 }, `perf-${run + 1}-${round + 1}`);
				try {
					const initial = await waitForInitialPage(tui);
					const initialWroteAt = tui.responseWrites.get(initial.responseId);
					assert.ok(initialWroteAt !== undefined, "Host did not timestamp the initial page write");
					await waitFor(async () => {
						await tui.pump();
						const traces = tui.traces();
						const applied = traces.findIndex(
							(event) => event.event === "page_apply_end" && event.id === initial.responseId,
						);
						return applied >= 0 && traces.slice(applied + 1).some((event) => event.event === "draw_end");
					}, "initial page did not reach draw_end");
					const initialMetric = pageMetric(tui, initial.responseId, initialWroteAt);
					firstFrameMs.push(initialMetric.hostToReceiveMs + initialMetric.decodeApplyDrawMs);

					const panePid = tui.panePid();
					rssSamples.push(...(await sampleRss(panePid)));
					for (let scroll = 0; scroll < 5; scroll++) {
						const requestsBefore = tui.requests.filter((request) => request.id.startsWith("older-")).length;
						tui.send("Home");
						await waitFor(async () => {
							await tui.pump();
							return tui.requests.filter((request) => request.id.startsWith("older-")).length > requestsBefore;
						}, "Home did not produce an older transcript request");
						const response = [...tui.responseWrites.entries()].filter(([id]) => id.startsWith("older-")).at(-1);
						assert.ok(response, "Host did not finish writing the older page response");
						const [responseId, wroteAt] = response;
						await waitFor(async () => {
							await tui.pump();
							const traces = tui.traces();
							const applied = traces.findIndex(
								(event) => event.event === "page_apply_end" && event.id === responseId,
							);
							return applied >= 0 && traces.slice(applied + 1).some((event) => event.event === "draw_end");
						}, `${responseId} did not reach draw_end`);
						samples.push(pageMetric(tui, responseId, wroteAt));
					}
					writeCapture(tui, `120x36-run-${run + 1}-round-${round + 1}`, 120);
					tui.closeProtocol();
					await waitFor(
						() => spawnSync("tmux", ["-L", tui.socket, "has-session", "-t", "tui"]).status !== 0,
						"Rust TUI did not exit after the performance protocol EOF",
					);
				} finally {
					tui.closeProtocol();
				}
			}
			assert.equal(samples.length, 25, `run ${run + 1} did not produce 25 older-page samples`);
			const endToFrameP95Ms = percentile(
				samples.map((sample) => sample.hostToReceiveMs + sample.decodeApplyDrawMs),
				0.95,
			);
			const decodeApplyDrawP95Ms = percentile(
				samples.map((sample) => sample.decodeApplyDrawMs),
				0.95,
			);
			assert.ok(
				endToFrameP95Ms <= 50,
				`run ${run + 1} older-page end-to-frame p95 ${endToFrameP95Ms}ms exceeds 50ms`,
			);
			assert.ok(
				decodeApplyDrawP95Ms <= 16,
				`run ${run + 1} older-page decode+apply+draw p95 ${decodeApplyDrawP95Ms}ms exceeds 16ms`,
			);
			runs.push({ run: run + 1, samples, endToFrameP95Ms, decodeApplyDrawP95Ms });
		}
		const metrics = {
			firstFrameMs,
			firstFrameP95Ms: percentile(firstFrameMs, 0.95),
			rssSamples,
			rssP95Bytes: percentile(rssSamples, 0.95),
			runs,
		};
		writeFileSync(join(artifactDirectory, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
		assert.ok(metrics.firstFrameP95Ms <= 100, `first nonempty frame p95 ${metrics.firstFrameP95Ms}ms exceeds 100ms`);
		assert.ok(metrics.rssP95Bytes <= 40 * 1024 * 1024, `Rust pane RSS p95 ${metrics.rssP95Bytes} exceeds 40MiB`);
	}, 480_000);

	it("uses a 16ms idle wait without drawing frames or burning CPU", async () => {
		const tui = await startTui(4, { width: 80, height: 24 }, "idle-poll");
		try {
			await waitForInitialPage(tui);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const panePid = tui.panePid();
			const beforePolls = tui.traces().filter((event) => event.event === "idle_poll").length;
			const beforeFrames = tui.traces().filter((event) => event.event === "draw_end").length;
			const beforeCpuMs = processTreeCpuMilliseconds(panePid);
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			const idlePolls = tui.traces().filter((event) => event.event === "idle_poll").length - beforePolls;
			const idleFrames = tui.traces().filter((event) => event.event === "draw_end").length - beforeFrames;
			const cpuMs = processTreeCpuMilliseconds(panePid) - beforeCpuMs;
			const metrics = { durationMs: 2_000, idlePolls, idleFrames, cpuMs };
			writeFileSync(join(tui.artifactDirectory, "idle-metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
			assert.ok(idlePolls >= 80 && idlePolls <= 150, `expected about 125 idle 16ms waits, got ${idlePolls}`);
			assert.equal(idleFrames, 0, `idle loop rendered ${idleFrames} unexpected frames`);
			assert.ok(cpuMs <= 200, `idle CPU ${cpuMs}ms exceeds smoke budget`);
		} finally {
			tui.closeProtocol();
		}
	}, 30_000);
});

function readInitialMetadata(tui: StartedTui): { generation: string; revision: number } {
	const page = tui.serverMessages.find(
		(message) => message.type === "response" && message.id.startsWith("initial-") && message.ok,
	);
	if (!page || page.type !== "response" || !page.ok)
		throw new Error("Host did not return initial transcript metadata");
	const result = page.result as { transcriptGeneration?: unknown; transcriptRevision?: unknown };
	if (typeof result.transcriptGeneration !== "string" || typeof result.transcriptRevision !== "number") {
		throw new Error("Host transcript metadata is malformed");
	}
	return { generation: result.transcriptGeneration, revision: result.transcriptRevision };
}

describe("Rust Workspace 会话工作台外部验收", () => {
	it("两轮验证会话切换回滚、无租约退出和真实列表", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(
				240,
				{ width: 80, height: 24 },
				`session-lease-${attempt + 1}`,
				({ directory, sessionPath }) => new WorkbenchFixture(directory, sessionPath),
			);
			try {
				const fixture = tui.fixture!;
				await waitForInitialPage(tui);
				await waitForRequest(tui, "acquire_session");
				assert.equal(hostLeaseCount(tui.service), 1, "initial Host lease is missing");
				await openSessions(tui);
				tui.send("q");
				await waitFor(() => tui.pane().includes("q  n 新建"), "normal sessions chooser did not filter q");
				tui.send("BSpace");
				const firstSwitch = fixture.calls.length;
				tui.send("Down", "Enter");
				await waitForRequest(tui, "acquire_session", 2);
				await waitFor(() => fixture.calls.includes("open:B"), "switch A->B did not acquire B");
				assert.deepEqual(
					fixture.calls.slice(firstSwitch).filter((call) => call === "dispose:A" || call === "open:B"),
					["dispose:A", "open:B"],
				);
				assert.equal(hostLeaseCount(tui.service), 1, "A->B left multiple Host leases");

				await openSessions(tui);
				tui.send("Up", "Enter");
				await waitForRequest(tui, "acquire_session", 3);
				await waitFor(
					() => fixture.calls.filter((call) => call === "open:A").length >= 2,
					"switch B->A did not recover A",
				);
				fixture.failNextOpen(fixture.paths.b);
				await openSessions(tui);
				const rollbackStart = fixture.calls.length;
				tui.send("Down", "Enter");
				await waitForRequest(tui, "acquire_session", 5);
				await waitFor(() => tui.pane().includes("切换失败，已恢复原会话"), "failed B acquire did not restore A");
				assert.deepEqual(
					fixture.calls.slice(rollbackStart).filter((call) => ["dispose:A", "open:B", "open:A"].includes(call)),
					["dispose:A", "open:B", "open:A"],
				);
				assert.equal(hostLeaseCount(tui.service), 1, "rollback did not restore exactly one A lease");

				fixture.failNextOpen(fixture.paths.b);
				fixture.failNextOpen(fixture.paths.a);
				tui.send("Enter");
				await waitForRequest(tui, "acquire_session", 7);
				await waitFor(
					() => tui.pane().includes("切换失败且原会话恢复失败"),
					"double failure did not open the recovery sessions chooser",
				);
				assert.equal(hostLeaseCount(tui.service), 0, "B and A failures retained a Host lease");
				tui.send("q");
				await waitFor(async () => {
					await tui.pump();
					return spawnSync("tmux", ["-L", tui.socket, "has-session", "-t", "tui"]).status !== 0;
				}, "q did not exit from the recovery sessions chooser");
				await tui.connection.close();
				assert.equal(hostLeaseCount(tui.service), 0, "Host connection close left a lease after q exit");
				assert.equal(readFileSync(tui.sttyBeforePath, "utf8"), readFileSync(tui.sttyAfterPath, "utf8"));
			} finally {
				tui.closeProtocol();
			}
		}
	}, 120_000);

	it("两轮验证只读路径和窄终端返回 Composer", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(
				240,
				{ width: 80, height: 24 },
				`readonly-tree-${attempt + 1}`,
				({ directory, sessionPath }) => new WorkbenchFixture(directory, sessionPath),
			);
			try {
				const fixture = tui.fixture!;
				await waitForInitialPage(tui);
				const initialOpenCount = fixture.calls.filter((call) => call.startsWith("open:")).length;
				await openSessions(tui);
				tui.send("Down", "v");
				await waitFor(() => tui.pane().includes("会话只读"), "v did not open readonly session view");
				await waitForRequest(tui, "read_transcript", 2);
				assert.equal(
					fixture.calls.filter((call) => call.startsWith("open:")).length,
					initialOpenCount,
					"readonly opened a runtime session",
				);
				assert.equal(hostLeaseCount(tui.service), 1, "readonly changed the active lease count");
				assert.ok(!existsSync(`${fixture.paths.b}.lock`), "readonly created a tmp Session lock");
				for (let index = 0; index < 10; index++) tui.send("PPage");
				await waitForRequest(tui, "read_transcript", 3);
				tui.send("C-f");
				tui.sendLiteral("needle 12");
				tui.send("Enter");
				await waitForRequest(tui, "search_transcript");
				tui.send("Down", "Up");

				const metadata = readInitialMetadata(tui);
				const beforeAppend = tui.traces().filter((event) => event.event === "append_applied").length;
				tui.runtime.emit({
					type: "progress",
					payload: { type: "assistant_delta", text: "readonly-live-progress" },
				});
				emitCommitted(tui.runtime, metadata.generation, metadata.revision);
				await waitForTrace(tui, "append_applied", beforeAppend + 1);
				tui.send("Escape");
				await waitFor(() => !tui.pane().includes("搜索: needle 12"), "readonly search Esc did not close search");
				tui.send("Escape");
				await waitFor(() => tui.pane().includes("n 新建"), "readonly Esc did not return to sessions chooser");
				tui.send("Escape");
				await waitFor(() => !tui.pane().includes("n 新建"), "sessions Esc did not restore Composer");
				tui.send("C-o");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("append-visible");
				}, "main view did not retain committed active transcript after readonly close");

				tui.resize(80, 8);
				await waitFor(
					() => tui.pane().includes("Enter 提交"),
					"80x8 did not retain Composer before sessions reopen",
				);
				await openSessions(tui);
				await waitFor(() => tui.pane().includes("会话"), "80x8 did not render sessions");
				tui.send("Escape");
				await waitFor(
					() => tui.pane().includes("Enter 提交"),
					"Esc from sessions did not restore Composer shortcut",
				);
				tui.resize(120, 36);
				tui.resize(80, 8);
				await waitFor(() => tui.pane().includes("Enter 提交"), "resize round trip did not restore Composer");
				tui.closeProtocol();
				await waitFor(
					() => spawnSync("tmux", ["-L", tui.socket, "has-session", "-t", "tui"]).status !== 0,
					"EOF did not close readonly/tree TUI",
				);
				await tui.connection.close();
				assert.equal(hostLeaseCount(tui.service), 0, "readonly/tree EOF left a Host lease");
				assert.equal(readFileSync(tui.sttyBeforePath, "utf8"), readFileSync(tui.sttyAfterPath, "utf8"));
			} finally {
				tui.closeProtocol();
			}
		}
	}, 180_000);

	it("两轮验证 Tree 筛选、写入、导航、分叉和错误重试", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(
				4,
				{ width: 80, height: 24 },
				`tree-actions-${attempt + 1}`,
				({ directory, sessionPath }) => new WorkbenchFixture(directory, sessionPath),
			);
			try {
				const fixture = tui.fixture!;
				const openTree = async () => {
					const count = tui.requests.filter((request) => request.command === "get_session_tree").length;
					tui.send("C-p");
					await waitFor(() => tui.pane().includes("命令面板"), "command palette did not open Tree");
					tui.sendLiteral("/tree");
					tui.send("Enter");
					const treeRequest = await waitForRequest(tui, "get_session_tree", count + 1);
					await waitFor(() => tui.responseWrites.has(treeRequest.id), "Host did not answer Tree request");
					await waitFor(() => tui.pane().includes("分支树"), "Tree did not render");
				};
				await waitForInitialPage(tui);
				await openTree();
				await waitFor(
					() => tui.pane().includes("labeled user") && tui.pane().includes("Tool read src/tree.ts"),
					"Tree did not render the Host projection",
				);

				tui.send("C-t");
				await waitFor(
					() => tui.pane().includes("[no-tools]") && !tui.pane().includes("Tool read src/tree.ts"),
					"no-tools filter did not hide the tool entry",
				);
				tui.send("C-u");
				await waitFor(
					() => tui.pane().includes("[user-only]") && tui.pane().includes("user-only no-tools prompt"),
					"user-only filter did not preserve the user mapping",
				);
				tui.send("C-l");
				await waitFor(
					() => tui.pane().includes("[labeled-only]") && tui.pane().includes("labeled user"),
					"labeled-only filter did not preserve labeled entry mapping",
				);
				tui.send("C-a");
				await waitFor(
					() => tui.pane().includes("[all]") && tui.pane().includes("Tool read src/tree.ts"),
					"all filter did not restore the complete Tree",
				);

				tui.send("l");
				await waitFor(
					() => tui.pane().includes("编辑标签"),
					"l did not open label editor for the selected Tree node",
				);
				tui.sendLiteral("tool-tag");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.label === 1;
				}, "label write did not reach Host exactly once");
				const treeRefreshAfterLabel = await waitForRequest(tui, "get_session_tree", 2);
				await waitFor(
					() => tui.responseWrites.has(treeRefreshAfterLabel.id),
					"Host did not answer Tree refresh after label",
				);
				await waitFor(
					() => tui.pane().includes("tool-tag") && tui.pane().includes("[all]"),
					"Tree refresh did not preserve filter and selected entry after label",
				);
				tui.send("l");
				await waitFor(() => tui.pane().includes("tool-tag"), "label editor did not retain the current label");
				tui.send(...Array.from({ length: 8 }, () => "BSpace"));
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.label === 2;
				}, "empty label did not clear through Host");
				const treeRefreshAfterClear = await waitForRequest(tui, "get_session_tree", 3);
				await waitFor(
					() => tui.responseWrites.has(treeRefreshAfterClear.id),
					"Host did not answer Tree refresh after clear",
				);
				await waitFor(() => !tui.pane().includes("tool-tag"), "cleared Tree label remained visible after refresh");

				fixture.nextNavigation = { cancelled: true, editorText: "cancelled draft" };
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.navigate === 1;
				}, "cancelled Tree navigation did not reach Host");
				await waitFor(
					() => tui.pane().includes("Enter 提交"),
					"cancelled Tree navigation did not return to Composer",
				);
				assert.ok(!tui.pane().includes("cancelled draft"), "cancelled navigation changed Composer text");

				fixture.nextNavigation = { cancelled: false, editorText: "tree replacement draft" };
				await openTree();
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.navigate === 2;
				}, "Tree navigation did not reach Host");
				await waitFor(
					() => tui.pane().includes("tree replacement draft"),
					"empty Composer did not receive Tree editor text",
				);

				fixture.nextNavigation = { cancelled: false, editorText: "replacement after confirm" };
				await openTree();
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.navigate === 3;
				}, "Tree replacement navigation did not reach Host");
				await waitFor(
					() => tui.pane().includes("替换输入草稿"),
					"nonempty Composer did not request replacement confirmation",
				);
				tui.send("Escape");
				await waitFor(() => tui.pane().includes("分支树"), "cancelled replacement did not return to Tree");
				tui.send("Escape");
				await waitFor(
					() => tui.pane().includes("tree replacement draft"),
					"cancelled replacement changed Composer text",
				);
				fixture.nextNavigation = { cancelled: false, editorText: "replacement after confirm" };
				await openTree();
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.navigate === 4;
				}, "confirmed replacement navigation did not reach Host");
				await waitFor(() => tui.pane().includes("替换输入草稿"), "replacement confirmation did not reopen");
				tui.send("Enter");
				await waitFor(
					() => tui.pane().includes("replacement after confirm"),
					"confirmed Tree replacement did not update Composer",
				);

				fixture.nextNavigation = { cancelled: true };
				await openTree();
				tui.send("s");
				await waitFor(() => tui.pane().includes("摘要跳转"), "s did not open summarize confirmation");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.calls.includes("navigate:true");
				}, "summarize navigation did not send summarize=true to Host");
				await waitFor(
					() => tui.pane().includes("已取消分支"),
					"summarize navigation did not finish before the next Tree action",
				);

				fixture.navigationFailures = 1;
				await openTree();
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("navigate failed");
				}, "navigate error did not return to Tree");
				fixture.nextNavigation = { cancelled: false, editorText: "retry navigation draft" };
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.navigate === 6;
				}, "navigate retry did not reach Host");
				await waitFor(
					() => tui.pane().includes("替换输入草稿"),
					"navigate retry did not complete before the next Tree action",
				);
				tui.send("Enter");
				await waitFor(
					() => tui.pane().includes("retry navigation draft"),
					"navigate retry did not apply editor replacement",
				);

				fixture.labelFailures = 1;
				await openTree();
				tui.send("l");
				tui.sendLiteral("retry-label");
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return tui.pane().includes("label failed");
				}, "label error did not return to Tree");
				tui.send("l");
				tui.sendLiteral("retry-label");
				tui.send("Enter");
				const treeRequestsBeforeRetryLabel = tui.requests.filter(
					(request) => request.command === "get_session_tree",
				).length;
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.label === 3;
				}, "label retry did not reach Host");
				const treeRefreshAfterRetryLabel = await waitForRequest(
					tui,
					"get_session_tree",
					treeRequestsBeforeRetryLabel + 1,
				);
				await waitFor(
					() => tui.responseWrites.has(treeRefreshAfterRetryLabel.id),
					"Host did not answer Tree refresh after label retry",
				);
				await waitFor(
					() => tui.pane().includes("retry-label"),
					"label error left pending state that blocked retry",
				);

				const labelsBeforeDrop = fixture.effects.label;
				const labelRequestsBeforeDrop = tui.requests.filter(
					(request) => request.command === "set_entry_label",
				).length;
				const treeRequestsBeforeDrop = tui.requests.filter(
					(request) => request.command === "get_session_tree",
				).length;
				await openTree();
				tui.send("l");
				tui.sendLiteral("dropped-label");
				tui.dropNextWorkspaceResponse();
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.label === labelsBeforeDrop + 1;
				}, "dropped label response did not execute Host write");
				await waitFor(
					() => tui.pane().includes("请求超时，按 r 重试"),
					"dropped label response did not become retryable",
				);
				tui.send("r");
				await waitForRequest(tui, "set_entry_label", labelRequestsBeforeDrop + 2);
				await waitFor(
					() => fixture.effects.label === labelsBeforeDrop + 1,
					"label retry repeated Host side effect",
				);
				const treeRefreshAfterDroppedLabel = await waitForRequest(
					tui,
					"get_session_tree",
					treeRequestsBeforeDrop + 2,
				);
				await waitFor(
					() => tui.responseWrites.has(treeRefreshAfterDroppedLabel.id),
					"Host did not answer Tree refresh after dropped-label retry",
				);
				await waitFor(() => tui.pane().includes("dropped-label"), "retried label did not refresh Tree");

				tui.send("f");
				await waitFor(() => tui.pane().includes("分叉会话"), "f did not request Tree fork confirmation");
				tui.send("Escape");
				assert.equal(fixture.effects.fork, 0, "cancelled Tree fork called Host");
				tui.send("f", "Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.fork === 1;
				}, "confirmed Tree fork did not run exactly once");
				await waitFor(
					() => tui.pane().includes("已创建并切换分叉会话"),
					"confirmed Tree fork did not switch session",
				);

				tui.resize(80, 8);
				await waitFor(
					() => tui.pane().includes("分支树") || tui.pane().includes("Enter 提交"),
					"80x8 Tree path did not render",
				);
				tui.send("Escape");
				await waitFor(() => tui.pane().includes("Enter 提交"), "80x8 Tree close did not restore Composer");
				tui.closeProtocol();
				await waitFor(
					() => spawnSync("tmux", ["-L", tui.socket, "has-session", "-t", "tui"]).status !== 0,
					"Tree EOF did not exit",
				);
				await tui.connection.close();
				assert.equal(hostLeaseCount(tui.service), 0, "Tree exit left a Host lease");
			} finally {
				tui.closeProtocol();
			}
		}
	}, 240_000);

	it("streams complete fullscreen exit transcript and preserves regular scrollback", async () => {
		const exitTemporaryDirectories = new Set(
			readdirSync(tmpdir()).filter((name) => name.startsWith("lystar-rust-tui-exit-")),
		);
		for (let attempt = 0; attempt < 2; attempt++) {
			const fullscreen = await startTui(
				620,
				{ width: 80, height: 24 },
				`exit-transcript-${attempt + 1}`,
				undefined,
				{ mode: "fullscreen", exitOutput: "transcript" },
			);
			try {
				await waitForInitialPage(fullscreen);
				fullscreen.send("q");
				await waitFor(
					async () => {
						await fullscreen.pump();
						return spawnSync("tmux", ["-L", fullscreen.socket, "has-session", "-t", "tui"]).status !== 0;
					},
					"fullscreen exit did not complete",
					30_000,
				);
				await waitFor(
					() => fullscreen.rawOutput().includes("needle 0") && fullscreen.rawOutput().includes("needle 619"),
					() =>
						`fullscreen exit transcript did not include pages outside the UI cache: ${JSON.stringify({
							requests: fullscreen.requests.filter((request) => request.id.startsWith("exit-transcript-")),
							responses: fullscreen.serverMessages
								.filter((message) => message.type === "response" && message.id.startsWith("exit-transcript-"))
								.map((message) =>
									message.type === "response"
										? { id: message.id, ok: message.ok, result: message.ok ? message.result : message.error }
										: message,
								),
							responseWrites: [...fullscreen.responseWrites.entries()].filter(([id]) =>
								id.startsWith("exit-transcript-"),
							),
						})}`,
				);
				const transcript = fullscreen.rawOutput();
				assert.ok(
					transcript.indexOf("needle 0") < transcript.lastIndexOf("needle 619"),
					"fullscreen exit transcript order is not chronological",
				);
				assert.ok(
					fullscreen.requests.filter((request) => request.id.startsWith("exit-transcript-")).length >= 3,
					"fullscreen exit did not page through the complete transcript",
				);
				assert.match(transcript, /\x1b\[\?2004h/, "fullscreen mode did not enable bracketed paste in the PTY");
				assert.match(transcript, /\x1b\[\?2004l/, "TerminalGuard did not disable bracketed paste before PTY exit");
				assert.ok(
					transcript.indexOf("\x1b[?2004h") < transcript.lastIndexOf("\x1b[?2004l"),
					"TerminalGuard restored bracketed paste before the fullscreen transcript completed",
				);
				assert.equal(
					readFileSync(fullscreen.sttyBeforePath, "utf8"),
					readFileSync(fullscreen.sttyAfterPath, "utf8"),
				);
				assert.equal(hostLeaseCount(fullscreen.service), 0, "fullscreen exit left a Host lease");
				assert.deepEqual(
					readdirSync(tmpdir())
						.filter((name) => name.startsWith("lystar-rust-tui-exit-"))
						.sort(),
					[...exitTemporaryDirectories].sort(),
					"fullscreen exit left transcript temporary pages behind",
				);
			} finally {
				fullscreen.closeProtocol();
			}

			const regular = await startTui(240, { width: 80, height: 8 }, `regular-${attempt + 1}`, undefined, {
				mode: "regular",
				exitOutput: "resume-hint",
			});
			try {
				await waitForInitialPage(regular);
				regular.sendLiteral("/help");
				regular.send("Enter");
				regular.resize(120, 36);
				await waitFor(() => regular.pane().includes("帮助"), "regular overlay did not survive resize");
				regular.send("Escape");
				await waitFor(() => regular.pane().includes("Enter 提交"), "regular overlay did not close");
				const regularHistory = regular.paneHistory();
				regular.send("q");
				await waitFor(
					async () => {
						await regular.pump();
						return spawnSync("tmux", ["-L", regular.socket, "has-session", "-t", "tui"]).status !== 0;
					},
					"regular exit did not complete",
					30_000,
				);
				const raw = regular.rawOutput();
				assert.doesNotMatch(raw, /\x1b\[\?1049[hl]/, "regular mode entered or left the alternate screen");
				assert.doesNotMatch(raw, /\x1b\[\?1000[hl]/, "regular mode enabled mouse capture");
				assert.ok(regularHistory.includes("needle"), "regular mode did not retain transcript scrollback");
				assert.ok(!raw.includes("会话已保存，可使用以下命令恢复"), "regular exit printed a duplicate resume hint");
				assert.equal(readFileSync(regular.sttyBeforePath, "utf8"), readFileSync(regular.sttyAfterPath, "utf8"));
				assert.equal(hostLeaseCount(regular.service), 0, "regular exit left a Host lease");
			} finally {
				regular.closeProtocol();
			}
		}
	}, 240_000);

	it("streams large fullscreen exit frames over a Unix socket", async () => {
		const tui = await startTui(620, { width: 80, height: 24 }, "exit-transcript-unix-socket", undefined, {
			mode: "fullscreen",
			exitOutput: "transcript",
			transport: "unix-socket",
		});
		try {
			await waitForInitialPage(tui);
			tui.send("q");
			await waitFor(
				async () => {
					await tui.pump();
					return spawnSync("tmux", ["-L", tui.socket, "has-session", "-t", "tui"]).status !== 0;
				},
				"Unix socket fullscreen exit did not complete",
				30_000,
			);
			const transcript = tui.rawOutput();
			assert.ok(transcript.includes("needle 0"), "Unix socket transcript missed the first record");
			assert.ok(transcript.includes("needle 619"), "Unix socket transcript missed the last record");
			assert.ok(
				tui.requests.filter((request) => request.id.startsWith("exit-transcript-")).length >= 3,
				"Unix socket exit did not page through the complete transcript",
			);
		} finally {
			await finishTuiRound(tui);
		}
	}, 120_000);
});
