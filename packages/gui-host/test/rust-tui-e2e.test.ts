import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	closeSync,
	constants,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
	ClientMessageDecoder,
	encodeServerMessage,
	type JsonValue,
	type ServerMessage,
} from "@lystar/code-gui-protocol";
import { afterEach, describe, it } from "vitest";
import { GuiHostService } from "../src/service.ts";
import type { RuntimeAdapter, RuntimeEvent, RuntimeSession } from "../src/types.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const artifactRoot = join(repositoryRoot, ".artifacts", "rust-tui-m7");
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
	message: string,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(message);
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
}

function readTrace(path: string): TraceEvent[] {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.flatMap((line) => {
				const match = /trace=([^\s]+) at_ms=(\d+)/.exec(line);
				return match ? [{ event: match[1], atMs: Number(match[2]) }] : [];
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
	holdPrompt = false;
	private resolvePrompt?: () => void;
	private readonly snapshot = {
		id: "m7-runtime",
		cwd: "/tmp",
		createdAt: 0,
		updatedAt: 0,
		phase: "idle" as "idle" | "turn",
		activity: "idle" as "idle" | "running",
		thinkingLevel: "off" as const,
		leafId: null,
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		transcriptGeneration: "m7-runtime-generation",
		transcriptRevision: 0,
	};

	constructor(sessionPath: string) {
		this.sessionPath = sessionPath;
	}

	getSnapshot(writeAccess: "available" | "owned" | "controlled_elsewhere" | "locked_externally") {
		return { ...this.snapshot, path: this.sessionPath, attached: true, writeAccess, revision: 0 };
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
	async rename(): Promise<void> {}
	async setModel(): Promise<void> {}
	async setThinkingLevel(): Promise<void> {}
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
	setRunning(running: boolean): void {
		this.snapshot.activity = running ? "running" : "idle";
		this.snapshot.phase = running ? "turn" : "idle";
		this.emit({ type: "state_changed", payload: {} });
	}
	emit(event: RuntimeEvent): void {
		this.events.emit("runtime", event);
	}
}

function createAdapter(runtime: FakeRuntimeSession): RuntimeAdapter {
	return {
		getAbout: () => ({ productVersion: "m7-e2e" }),
		openSession: async (sessionPath: string) => {
			assert.equal(sessionPath, runtime.sessionPath);
			return runtime;
		},
	} as unknown as RuntimeAdapter;
}

interface RequestRecord {
	id: string;
	command: string;
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
	requests: RequestRecord[];
	serverMessages: ServerMessage[];
	responseWrites: Map<string, number>;
	pump(): Promise<void>;
	traces(): TraceEvent[];
	pane(): string;
	resize(width: number, height: number): void;
	send(...keys: string[]): void;
	sendLiteral(text: string): void;
	panePid(): number;
	closeProtocol(): void;
}

async function startTui(
	rounds: number,
	dimensions: { width: number; height: number },
	label: string,
): Promise<StartedTui> {
	run("cargo", ["build", "--release", "-p", "lystar-tui"]);
	const directory = mkdtempSync(join(tmpdir(), "lystar-rust-m7-e2e-"));
	directories.add(directory);
	const artifactDirectory = join(artifactRoot, `${label}-${process.pid}-${Date.now()}`);
	mkdirSync(artifactDirectory, { recursive: true });
	const sessionPath = join(directory, "session.jsonl");
	const toRust = join(directory, "to-rust.fifo");
	const fromRust = join(directory, "from-rust.fifo");
	const tracePath = join(artifactDirectory, "rust-trace.log");
	writeFileSync(sessionPath, sessionEntries(rounds));
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
	const binary = join(repositoryRoot, "target/release/lystar-tui");
	const command = `exec 3<${shellQuote(toRust)} 4>${shellQuote(fromRust)}; exec env PI_RUST_TUI_TRACE=1 ${shellQuote(binary)} --run ${shellQuote(sessionPath)} 2>${shellQuote(tracePath)}`;
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
	closeDescriptor(incomingReader);
	closeDescriptor(outgoingWriter);

	const runtime = new FakeRuntimeSession(sessionPath);
	const service = new GuiHostService(createAdapter(runtime), { agentDir: directory });
	cleanups.push(async () => service.dispose());
	const requests: RequestRecord[] = [];
	const serverMessages: ServerMessage[] = [];
	const responseWrites = new Map<string, number>();
	const connection = service.createConnection(async (message: ServerMessage) => {
		serverMessages.push(message);
		writeAll(input, encodeServerMessage(message));
		if (message.type === "response") responseWrites.set(message.id, Date.now());
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
				if (message.type === "request") requests.push({ id: message.id, command: message.request.command });
				await connection.handle(message);
			}
		}
	};
	const traces = () => readTrace(tracePath);
	const pane = () => run("tmux", ["-L", socket, "capture-pane", "-p", "-t", "tui"]);
	const resize = (width: number, height: number) => {
		run("tmux", ["-L", socket, "resize-window", "-t", "tui", "-x", String(width), "-y", String(height)]);
	};
	const send = (...keys: string[]) => run("tmux", ["-L", socket, "send-keys", "-t", "tui", ...keys]);
	const sendLiteral = (text: string) => run("tmux", ["-L", socket, "send-keys", "-t", "tui", "-l", text]);
	const panePid = () =>
		Number(run("tmux", ["-L", socket, "display-message", "-p", "-t", "tui", "#{pane_pid}"]).trim());
	const closeProtocol = () => closeDescriptor(input);
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
		requests,
		serverMessages,
		responseWrites,
		pump,
		traces,
		pane,
		resize,
		send,
		sendLiteral,
		panePid,
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

	it("submits prompt once, routes streaming input, projects typed Tool state, and journals clear queue", async () => {
		const tui = await startTui(4, { width: 80, height: 24 }, "interactive");
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

			const clientInstanceId = `lystar-rust-m8-${tui.panePid()}`;
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
	}, 60_000);

	it("records five 10k-tool first-frame, RSS, and older-page samples", async () => {
		const firstFrameMs: number[] = [];
		const scrollMs: number[] = [];
		const rssSamples: number[] = [];
		const rssRounds: Array<{
			round: number;
			panePid: number;
			targetPids: number[];
			sampleCount: number;
			intervalMs: number;
			samples: number[];
		}> = [];
		const artifactDirectory = join(artifactRoot, `perf-${process.pid}-${Date.now()}`);
		mkdirSync(artifactDirectory, { recursive: true });
		for (let round = 0; round < 5; round++) {
			const tui = await startTui(10_000, { width: 120, height: 36 }, `perf-${round + 1}`);
			try {
				const initial = await waitForInitialPage(tui);
				const wroteAt = tui.responseWrites.get(initial.responseId);
				assert.ok(wroteAt, "Host did not timestamp the initial page write");
				const initialFrame = await waitForTrace(tui, "frame_rendered_nonempty");
				const rendered = initialFrame.find((event) => event.atMs >= wroteAt);
				assert.ok(rendered, "Rust did not render a nonempty frame after the initial response write");
				firstFrameMs.push(rendered.atMs - wroteAt);

				const panePid = tui.panePid();
				const samples = await sampleRss(panePid);
				rssSamples.push(...samples);
				rssRounds.push({
					round: round + 1,
					panePid,
					targetPids: processTreePids(panePid),
					sampleCount: samples.length,
					intervalMs: 10,
					samples,
				});
				for (let scroll = 0; scroll < 5; scroll++) {
					const requestsBefore = tui.requests.filter((request) => request.id.startsWith("older-")).length;
					const pagesBefore = tui.traces().filter((event) => event.event === "page_applied").length;
					tui.send("Home");
					await waitForTrace(tui, "key_home", scroll + 1);
					await waitFor(async () => {
						await tui.pump();
						return tui.requests.filter((request) => request.id.startsWith("older-")).length > requestsBefore;
					}, "Home did not produce an older transcript request");
					const olderResponse = [...tui.responseWrites.entries()].filter(([id]) => id.startsWith("older-")).at(-1);
					assert.ok(olderResponse, "Host did not finish writing the older page response");
					await waitForTrace(tui, "page_applied", pagesBefore + 1);
					const framesBefore = tui.traces().filter((event) => event.event === "frame_rendered_nonempty").length;
					const frames = await waitForTrace(tui, "frame_rendered_nonempty", framesBefore + 1);
					const frame = frames.at(-1) as TraceEvent;
					scrollMs.push(frame.atMs - olderResponse[1]);
				}
				writeCapture(tui, `120x36-round-${round + 1}`, 120);
				tui.closeProtocol();
				await waitFor(
					() => spawnSync("tmux", ["-L", tui.socket, "has-session", "-t", "tui"]).status !== 0,
					"Rust TUI did not exit after the performance protocol EOF",
				);
			} finally {
				tui.closeProtocol();
			}
		}
		const metrics = {
			firstFrameMs,
			firstFrameP95Ms: percentile(firstFrameMs, 0.95),
			rssRounds,
			rssSamples,
			rssP95Bytes: percentile(rssSamples, 0.95),
			scrollMs,
			scrollP95Ms: percentile(scrollMs, 0.95),
		};
		writeFileSync(join(artifactDirectory, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
		assert.ok(metrics.firstFrameP95Ms <= 100, `first nonempty frame p95 ${metrics.firstFrameP95Ms}ms exceeds 100ms`);
		assert.ok(metrics.rssP95Bytes <= 40 * 1024 * 1024, `Rust pane RSS p95 ${metrics.rssP95Bytes} exceeds 40MiB`);
		assert.ok(metrics.scrollP95Ms <= 50, `older-page frame p95 ${metrics.scrollP95Ms}ms exceeds 50ms`);
	}, 180_000);
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
