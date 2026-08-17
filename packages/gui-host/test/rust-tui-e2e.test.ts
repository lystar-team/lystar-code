import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
	type AuthType,
	type ClientMessage,
	ClientMessageDecoder,
	encodeServerMessage,
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
				return [
					{
						event,
						atMs: Number(atMs),
						...(id ? { id } : {}),
						...(componentId ? { componentId } : {}),
						...(revision ? { revision: Number(revision) } : {}),
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
			return fakeModels();
		},
		logoutModelProvider: async () => {
			runtime.logoutCount++;
			return fakeModels();
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
			setProjectTrust: async (cwd: string, trusted: boolean) => {
				this.effects.trust++;
				this.trusted = trusted;
				return {
					cwd,
					trusted,
					reason: trusted ? "项目资源已信任" : "项目资源被明确设为不信任",
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
	dropNextB3Response(): void;
	pump(): Promise<void>;
	traces(): TraceEvent[];
	pane(): string;
	resize(width: number, height: number): void;
	send(...keys: string[]): void;
	sendLiteral(text: string): void;
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
	runOptions: { mode?: "auto" | "fullscreen" | "regular"; exitOutput?: "transcript" | "resume-hint" } = {},
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
	if (!runtimeHost) writeFileSync(sessionPath, sessionEntries(rounds));
	run("/usr/bin/mkfifo", [toRust, fromRust]);

	const incomingReader = openSync(toRust, constants.O_RDONLY | constants.O_NONBLOCK);
	descriptors.add(incomingReader);
	const input = openSync(toRust, constants.O_WRONLY);
	descriptors.add(input);
	const outgoingReader = openSync(fromRust, constants.O_RDONLY | constants.O_NONBLOCK);
	descriptors.add(outgoingReader);
	const outgoingWriter = openSync(fromRust, constants.O_WRONLY | constants.O_NONBLOCK);
	descriptors.add(outgoingWriter);

	const socket = `lystar-m7-${process.pid}-${Date.now()}-${label}`;
	sockets.add(socket);
	const clientInstanceId = `lystar-rust-m8-${socket}`;
	const binary = join(repositoryRoot, "target/release/lystar-tui");
	const command = `exec 3<${shellQuote(toRust)} 4>${shellQuote(fromRust)}; before=$(stty -g); printf %s "$before" > ${shellQuote(sttyBeforePath)}; env PI_RUST_TUI_TRACE=1 PI_RUST_TUI_CLIENT_INSTANCE_ID=${shellQuote(clientInstanceId)} ${shellQuote(binary)} --run ${shellQuote(sessionPath)} --mode ${shellQuote(runOptions.mode ?? "auto")} --exit-output ${shellQuote(runOptions.exitOutput ?? "transcript")} 2>${shellQuote(tracePath)}; status=$?; after=$(stty -g); printf %s "$after" > ${shellQuote(sttyAfterPath)}; exit $status`;
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
	run("tmux", ["-L", socket, "pipe-pane", "-o", "-t", "tui", `cat > ${shellQuote(rawOutputPath)}`]);
	closeDescriptor(incomingReader);
	closeDescriptor(outgoingWriter);

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
	let dropNextB3Response = false;
	const connection = service.createConnection(async (message: ServerMessage) => {
		serverMessages.push(message);
		if (message.type === "response" && dropNextB3Response) {
			dropNextB3Response = false;
			return;
		}
		writeAll(input, encodeServerMessage(message));
		if (message.type === "response") responseWrites.set(message.id, Math.floor(monotonicMs() / 10) * 10);
	});
	cleanups.push(() => connection.close());
	const controlMessages: ServerMessage[] = [];
	const control = service.createConnection(async (message) => {
		controlMessages.push(message);
	});
	cleanups.push(() => control.close());
	await control.handle({ type: "hello", version: 1, clientInstanceId: "m7-runtime-controller" });

	const decoder = new ClientMessageDecoder();
	const outputBuffer = Buffer.allocUnsafe(64 * 1024);
	const pump = async () => {
		while (true) {
			let bytesRead: number;
			try {
				bytesRead = readSync(outgoingReader, outputBuffer);
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
				if (message.type === "request" && message.request.command === "login_model_provider") {
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
	const panePid = () =>
		Number(run("tmux", ["-L", socket, "display-message", "-p", "-t", "tui", "#{pane_pid}"]).trim());
	const closeProtocol = () => closeDescriptor(input);
	const emitServer = (message: ServerMessage) => writeAll(input, encodeServerMessage(message));
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
		dropNextB3Response: () => {
			dropNextB3Response = true;
		},
		pump,
		traces,
		pane,
		resize,
		send,
		sendLiteral,
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
	};
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

async function readStormDiagnostics(tui: StartedTui): Promise<StormComponentDiagnostics> {
	const id = `storm-diagnostics-${Date.now()}`;
	await tui.control.handle({ type: "request", id, request: { command: "get_diagnostics" } });
	const response = tui.controlMessages.find(
		(message) => message.type === "response" && message.id === id && message.ok,
	);
	if (!response || response.type !== "response" || !response.ok)
		throw new Error("Host did not return component diagnostics");
	const components = (response.result as { extensionComponents?: { components?: StormComponentDiagnostics[] } })
		.extensionComponents?.components;
	const component = components?.find((candidate) => candidate.componentId === "header");
	if (!component) throw new Error("Host diagnostics has no storm header component");
	return component;
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

	it("opens the command palette, renders typed about and diagnostics, and bridges injected UI requests twice", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(4, { width: 80, height: 24 }, `b3-foundation-${attempt + 1}`);
			try {
				await waitForInitialPage(tui);
				tui.send("C-p");
				await waitFor(() => tui.pane().includes("命令面板"), "Ctrl+P did not open the command palette");
				for (const command of ["/settings", "/model", "/thinking", "/login"]) {
					assert.ok(tui.pane().includes(command), `command palette is missing ${command}`);
				}
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
					"Rust TUI did not exit after B3 foundation verification",
				);
				assert.equal(readFileSync(tui.sttyBeforePath, "utf8"), readFileSync(tui.sttyAfterPath, "utf8"));
			} finally {
				tui.closeProtocol();
			}
		}
	}, 120_000);

	it("通过 Host B3 处理设置、模型、思考和登录工作台，重试不会重复写入", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const tui = await startTui(4, { width: 80, height: 24 }, `b3-workbenches-${attempt + 1}`);
			try {
				await waitForInitialPage(tui);
				const openSlash = async (command: string, marker: string, b3Command: string) => {
					const requestCount = tui.requests.filter((request) => request.command === b3Command).length;
					tui.sendLiteral(command);
					tui.send("Enter");
					await waitFor(async () => {
						await tui.pump();
						return tui.requests.filter((request) => request.command === b3Command).length > requestCount;
					}, `${command} did not reach the Host`);
					await waitFor(() => tui.pane().includes(marker), `${command} did not render Host data`);
				};

				await openSlash("/settings", "自动压缩", "list_settings");
				tui.dropNextB3Response();
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
				tui.dropNextB3Response();
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
					"auth notifications did not return to the provider list",
				);
				await new Promise((resolve) => setTimeout(resolve, 3_200));
				tui.send("r");
				await waitFor(async () => {
					await tui.pump();
					return tui.requests.filter((request) => request.command === "login_model_provider").length >= 2;
				}, "dropped login response was not retried");
				await waitFor(() => tui.runtime.loginCount === 1, "login retry duplicated the Host login");
				await waitFor(() => tui.pane().includes("登录测试"), "provider list did not recover after login retry");
				const trace = readFileSync(tui.tracePath, "utf8");
				assert.ok(!trace.includes("credential-secret"), "credential leaked into Rust trace artifact");
				assert.ok(!tui.pane().includes("credential-secret"), "credential was rendered in plain text");

				tui.send("d");
				await waitFor(() => tui.pane().includes("确认退出"), "logout confirm did not render");
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
				`b3-project-workbenches-${attempt + 1}`,
				({ directory, sessionPath }) => new WorkbenchFixture(directory, sessionPath),
			);
			try {
				await waitForInitialPage(tui);
				const fixture = tui.fixture!;
				const openSlash = async (command: string, marker: string, b3Command: string) => {
					const count = tui.requests.filter((request) => request.command === b3Command).length;
					tui.sendLiteral(command);
					tui.send("Enter");
					await waitFor(async () => {
						await tui.pump();
						return tui.requests.filter((request) => request.command === b3Command).length > count;
					}, `${command} did not reach the Host`);
					await waitFor(
						() => tui.pane().includes(marker),
						() => `${command} did not render Host data: ${JSON.stringify(tui.pane())}`,
					);
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
				tui.send("Enter");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.package === 1;
				}, "package install did not write through Host");
				const packageRefresh = await waitForRequest(tui, "list_packages", 2);
				await waitFor(async () => {
					await tui.pump();
					return tui.responseWrites.has(packageRefresh.id) && tui.pane().includes("npm:added");
				}, "package install did not refresh list");
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
				const packageDeleteRefresh = await waitForRequest(tui, "list_packages", 3);
				await waitFor(async () => {
					await tui.pump();
					return tui.responseWrites.has(packageDeleteRefresh.id) && tui.pane().includes("包");
				}, "package delete did not refresh list before update");
				tui.send("U");
				await waitFor(async () => {
					await tui.pump();
					return fixture.effects.package === 3;
				}, "package update did not write through Host");
				tui.send("Escape");
				await waitFor(() => tui.pane().includes("Enter 提交"), "packages list did not close before update");

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
				tui.dropNextB3Response();
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

				tui.dropNextB3Response();
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
			assert.ok(border >= 0 && cursor > border && error > cursor && shortcuts > error, "80x8 regions overlap");
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

describe("Rust B3 会话工作台外部验收", () => {
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
				tui.dropNextB3Response();
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
					"fullscreen exit transcript did not include pages outside the UI cache",
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
});
