import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	constants,
	fstatSync,
	mkdtempSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
	type ClientMessage,
	ClientMessageDecoder,
	encodeServerMessage,
	type ServerMessage,
} from "@lystar/code-gui-protocol";
import { CodingAgentRuntimeAdapter } from "../packages/gui-host/src/runtime-adapter.ts";
import { GuiHostService } from "../packages/gui-host/src/service.ts";

const repositoryRoot = process.env.LYSTAR_RUST_CUSTOM_EDITOR_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const customEditorExtension = process.env.LYSTAR_RUST_CUSTOM_EDITOR_EXTENSION ?? resolve(
	repositoryRoot,
	"packages/coding-agent/examples/extensions/runtime-custom-editor-contract-extension.ts",
);
const artifact = process.env.LYSTAR_RUST_CUSTOM_EDITOR_ARTIFACT;
const serializedConfig = process.env.LYSTAR_RUST_CUSTOM_EDITOR_BENCHMARK_CONFIG;
if (!artifact || !serializedConfig) throw new Error("CustomEditor benchmark artifact/config is required");
if (!process.versions.bun) throw new Error("CustomEditor benchmark Host must run on Bun");
const config = JSON.parse(serializedConfig) as {
	implementation: string;
	hostRuntime: string;
	rounds: number;
	rssLimitBytes: number;
	sizes: Array<[number, number]>;
	scenarios: Array<{
		name: "custom_editor_input300" | "paste5000" | "render_animation" | "autocomplete";
		eventCount: number;
		input?: { character: string; count: number };
		animationFrames?: number;
		autocomplete?: { source: string; completion: string; roundtrips: number };
		thresholds: { p95Ms: number; p99Ms: number };
	}>;
};
if (`bun-${process.versions.bun}` !== config.hostRuntime) {
	throw new Error(`CustomEditor benchmark requires ${config.hostRuntime}; got bun-${process.versions.bun}`);
}
const stagesArtifact = `${artifact}.stages.jsonl`;
const directories = new Set<string>();
const descriptors = new Set<number>();
const sockets = new Set<string>();
let releaseTuiBuilt = false;
let warmed = false;

type TraceEvent = {
	event: string;
	atMs: number;
	componentId?: string;
	revision?: number;
	bytes?: number;
};
type ComponentDiagnostics = {
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
type RequestRecord = { id: string; command: string; data?: string; receivedAt: number };
type StartedTui = {
	directory: string;
	socket: string;
	sessionPath: string;
	tracePath: string;
	service: GuiHostService;
	connection: ReturnType<GuiHostService["createConnection"]>;
	control: ReturnType<GuiHostService["createConnection"]>;
	controlMessages: ServerMessage[];
	serverMessages: ServerMessage[];
	editorFramesByRevision: Map<number, { revision: number; lines: string[] }>;
	editorTextState?: string;
	extensionInputCount: number;
	lastExtensionInput?: RequestRecord;
	staleCompletionCount: number;
	traceOffset: number;
	traceRemainder: string;
	traceEvents: TraceEvent[];
	traceByRevision: Map<number, TraceEvent>;
	lastTraceRevision: number;
	pump(): Promise<void>;
	traces(): readonly TraceEvent[];
	send(...keys: string[]): void;
	sendLiteral(text: string): void;
	paste(text: string): void;
	panePid(): number;
	close(): Promise<void>;
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

function writeAll(descriptor: number, frame: Uint8Array): void {
	let offset = 0;
	while (offset < frame.length) offset += writeSync(descriptor, frame, offset, frame.length - offset);
}

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

const hostMonotonicOffsetMs =
	Number(readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0]) * 1_000 - performance.now();

function monotonicMs(): number {
	return hostMonotonicOffsetMs + performance.now();
}

function pushRing<T>(items: T[], value: T, limit = 128): void {
	items.push(value);
	if (items.length > limit) items.splice(0, items.length - limit);
}

function parseTraceLine(line: string): TraceEvent | undefined {
	const event = /trace=([^\s]+)/.exec(line)?.[1];
	const atMs = /at_ms=([\d.]+)/.exec(line)?.[1];
	if (!event || atMs === undefined) return undefined;
	const componentId = /\scomponentId=([^\s]+)/.exec(line)?.[1];
	const revision = /\srevision=(\d+)/.exec(line)?.[1];
	const bytes = /\sbytes=(\d+)/.exec(line)?.[1];
	return {
		event,
		atMs: Number(atMs),
		...(componentId ? { componentId } : {}),
		...(revision ? { revision: Number(revision) } : {}),
		...(bytes ? { bytes: Number(bytes) } : {}),
	};
}

function readTraceDelta(tui: Pick<StartedTui, "tracePath" | "traceOffset" | "traceRemainder" | "traceEvents" | "traceByRevision" | "lastTraceRevision">): void {
	try {
		const descriptor = openSync(tui.tracePath, constants.O_RDONLY);
		const size = fstatSync(descriptor).size;
		if (size < tui.traceOffset) {
			tui.traceOffset = 0;
			tui.traceRemainder = "";
			tui.traceEvents.length = 0;
			tui.traceByRevision.clear();
			tui.lastTraceRevision = 0;
		}
		const length = size - tui.traceOffset;
		if (length === 0) {
			closeSync(descriptor);
			return;
		}
		const chunk = Buffer.allocUnsafe(length);
		let offset = 0;
		while (offset < length) offset += readSync(descriptor, chunk, offset, length - offset, tui.traceOffset + offset);
		closeSync(descriptor);
		tui.traceOffset = size;
		const lines = `${tui.traceRemainder}${chunk.toString("utf8")}`.split("\n");
		tui.traceRemainder = lines.pop() ?? "";
		for (const line of lines) {
			const trace = parseTraceLine(line);
			if (!trace) continue;
			pushRing(tui.traceEvents, trace, 256);
			if (
				trace.event === "extension_component_frame_applied" &&
				trace.componentId === "editor" &&
				trace.revision !== undefined &&
				trace.bytes !== undefined
			) {
				tui.traceByRevision.set(trace.revision, trace);
				tui.lastTraceRevision = Math.max(tui.lastTraceRevision, trace.revision);
			}
		}
	} catch {
		// The trace is created asynchronously with the Rust process.
	}
}

function percentile(values: readonly number[], quantile: number): number {
	assert.ok(values.length > 0, "cannot calculate percentile of an empty series");
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

function timingSummary(samples: readonly number[]) {
	return {
		p50Ms: percentile(samples, 0.5),
		p95Ms: percentile(samples, 0.95),
		p99Ms: percentile(samples, 0.99),
		maxMs: Math.max(...samples),
	};
}

function processCpuMilliseconds(pid: number): number {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
	return (Number(fields[11]) + Number(fields[12])) * 10;
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

function processTreeCpuMilliseconds(pid: number): number {
	return processTreePids(pid).reduce((total, child) => {
		try {
			return total + processCpuMilliseconds(child);
		} catch {
			return total;
		}
	}, 0);
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

function startRustSampling(pid: number) {
	const baselineRssBytes = rssTree(pid);
	const rssSamples = [baselineRssBytes];
	const cpuStartedAt = processTreeCpuMilliseconds(pid);
	const timer = setInterval(() => rssSamples.push(rssTree(pid)), 10);
	return {
		stop: () => {
			clearInterval(timer);
			const endRssBytes = rssTree(pid);
			rssSamples.push(endRssBytes);
			return {
				rustBaselineRssBytes: baselineRssBytes,
				rustEndRssBytes: endRssBytes,
				rustPeakRssBytes: Math.max(...rssSamples),
				rustCpuMs: Math.max(0, processTreeCpuMilliseconds(pid) - cpuStartedAt),
			};
		},
	};
}

function startHostSampling() {
	const baselineRssBytes = process.memoryUsage().rss;
	const rssSamples = [baselineRssBytes];
	const cpuStartedAt = process.cpuUsage();
	const timer = setInterval(() => rssSamples.push(process.memoryUsage().rss), 10);
	return {
		stop: () => {
			clearInterval(timer);
			const endRssBytes = process.memoryUsage().rss;
			rssSamples.push(endRssBytes);
			const cpu = process.cpuUsage(cpuStartedAt);
			return {
				hostBaselineRssBytes: baselineRssBytes,
				hostEndRssBytes: endRssBytes,
				hostPeakRssBytes: Math.max(...rssSamples),
				hostCpuMs: (cpu.user + cpu.system) / 1_000,
			};
		},
	};
}

async function createRuntimeHost(directory: string): Promise<{ adapter: CodingAgentRuntimeAdapter; agentDir: string; sessionPath: string }> {
	const agentDir = join(directory, "agent");
	const cwd = join(directory, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "lystar-custom-editor-contract-faux",
			defaultModel: "contract-1",
			defaultThinkingLevel: "off",
			defaultProjectTrust: "always",
			extensions: [customEditorExtension],
			retry: { enabled: false },
		}),
	);
	const adapter = new CodingAgentRuntimeAdapter(agentDir);
	const runtime = await adapter.createSession(cwd, async () => ({ cancelled: true }));
	const sessionPath = runtime.sessionPath;
	await runtime.dispose();
	return { adapter, agentDir, sessionPath };
}

async function startTui(label: string, width: number, height: number): Promise<StartedTui> {
	if (!releaseTuiBuilt) {
		run("cargo", ["build", "--release", "-p", "lystar-tui"]);
		releaseTuiBuilt = true;
	}
	const directory = mkdtempSync(join(tmpdir(), "lystar-custom-editor-benchmark-"));
	directories.add(directory);
	const runtimeHost = await createRuntimeHost(directory);
	const toRust = join(directory, "to-rust.fifo");
	const fromRust = join(directory, "from-rust.fifo");
	const tracePath = join(directory, "rust-trace.log");
	run("/usr/bin/mkfifo", [toRust, fromRust]);
	const incomingReader = openSync(toRust, constants.O_RDONLY | constants.O_NONBLOCK);
	descriptors.add(incomingReader);
	const input = openSync(toRust, constants.O_WRONLY);
	descriptors.add(input);
	const outgoingReader = openSync(fromRust, constants.O_RDONLY | constants.O_NONBLOCK);
	descriptors.add(outgoingReader);
	const outgoingWriter = openSync(fromRust, constants.O_WRONLY | constants.O_NONBLOCK);
	descriptors.add(outgoingWriter);
	const socket = `lystar-custom-editor-${process.pid}-${Date.now()}-${label}`;
	sockets.add(socket);
	const binary = join(repositoryRoot, "target/release/lystar-tui");
	const command = `exec 3<${shellQuote(toRust)} 4>${shellQuote(fromRust)}; env PI_RUST_TUI_TRACE=1 PI_RUST_TUI_CLIENT_INSTANCE_ID=${shellQuote(`custom-editor-${socket}`)} ${shellQuote(binary)} --run ${shellQuote(runtimeHost.sessionPath)} 2>${shellQuote(tracePath)}`;
	run("tmux", ["-L", socket, "new-session", "-d", "-s", "tui", "-x", String(width), "-y", String(height), command]);
	closeDescriptor(incomingReader);
	closeDescriptor(outgoingWriter);

	const service = new GuiHostService(runtimeHost.adapter, { agentDir: runtimeHost.agentDir });
	const serverMessages: ServerMessage[] = [];
	const editorFramesByRevision = new Map<number, { revision: number; lines: string[] }>();
	let editorTextState: string | undefined;
	let extensionInputCount = 0;
	let lastExtensionInput: RequestRecord | undefined;
	let staleCompletionCount = 0;
	const connection = service.createConnection(async (message: ServerMessage) => {
		pushRing(serverMessages, message);
		if (message.type === "event") {
			const event = message.event;
			if (
				(event.type === "extension_component_mount" || event.type === "extension_component_frame") &&
				event.componentId === "editor"
			) {
				editorFramesByRevision.set(event.frame.revision, event.frame);
			}
			if (
				event.type === "extension_editor_action" &&
				event.action.text.includes("@stale-old-result")
			) {
				staleCompletionCount++;
			}
		}
		writeAll(input, encodeServerMessage(message));
	});
	const controlMessages: ServerMessage[] = [];
	const control = service.createConnection(async (message) => controlMessages.push(message));
	await control.handle({ type: "hello", version: 1, clientInstanceId: `controller-${socket}` });
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
				if (message.type === "request") {
					if (message.request.command === "extension_editor_state") editorTextState = message.request.text;
					if (message.request.command === "extension_component_input") {
						extensionInputCount++;
						lastExtensionInput = {
							id: message.id,
							command: message.request.command,
							...("data" in message.request && typeof message.request.data === "string"
								? { data: message.request.data }
								: {}),
							receivedAt: monotonicMs(),
						};
					}
				}
				await connection.handle(message);
			}
		}
	};
	const close = async () => {
		await service.dispose();
		await connection.close();
		await control.close();
		closeDescriptor(input);
		await waitFor(
			() => spawnSync("tmux", ["-L", socket, "has-session", "-t", "tui"]).status !== 0,
			"Rust TUI did not exit within two seconds after benchmark cleanup",
			2_000,
		).catch(() => {});
		closeDescriptor(outgoingReader);
		spawnSync("tmux", ["-L", socket, "kill-server"]);
		sockets.delete(socket);
	};
	return {
		directory,
		socket,
		sessionPath: runtimeHost.sessionPath,
		tracePath,
		service,
		connection,
		control,
		controlMessages,
		serverMessages,
		editorFramesByRevision,
		get editorTextState() {
			return editorTextState;
		},
		get extensionInputCount() {
			return extensionInputCount;
		},
		get lastExtensionInput() {
			return lastExtensionInput;
		},
		get staleCompletionCount() {
			return staleCompletionCount;
		},
		traceOffset: 0,
		traceRemainder: "",
		traceEvents: [],
		traceByRevision: new Map(),
		lastTraceRevision: 0,
		pump,
		traces() {
			readTraceDelta(this);
			return this.traceEvents;
		},
		send: (...keys) => run("tmux", ["-L", socket, "send-keys", "-t", "tui", ...keys]),
		sendLiteral: (text) => run("tmux", ["-L", socket, "send-keys", "-t", "tui", "-l", "--", text]),
		paste: (text) => {
			const buffer = `custom-editor-paste-${process.pid}-${Date.now()}`;
			run("tmux", ["-L", socket, "set-buffer", "-b", buffer, text]);
			try {
				run("tmux", ["-L", socket, "paste-buffer", "-p", "-b", buffer, "-t", "tui"]);
			} finally {
				run("tmux", ["-L", socket, "delete-buffer", "-b", buffer]);
			}
		},
		panePid: () => Number(run("tmux", ["-L", socket, "display-message", "-p", "-t", "tui", "#{pane_pid}"]).trim()),
		close,
	};
}

async function readDiagnostics(tui: StartedTui): Promise<ComponentDiagnostics> {
	const id = `diagnostics-${Date.now()}`;
	await tui.control.handle({ type: "request", id, request: { command: "get_diagnostics" } });
	const response = tui.controlMessages.find((message) => message.type === "response" && message.id === id && message.ok);
	if (!response || response.type !== "response" || !response.ok) throw new Error("Host did not return component diagnostics");
	const components = (response.result as { extensionComponents?: { components?: ComponentDiagnostics[] } }).extensionComponents?.components;
	const editor = components?.find((component) => component.componentId === "editor");
	if (!editor) throw new Error("Host diagnostics has no editor component");
	return editor;
}

function componentFrames(tui: StartedTui): Array<{ revision: number; lines: string[] }> {
	return [...tui.editorFramesByRevision.values()];
}

function componentFrameTraces(tui: StartedTui, traceStartRevision: number): TraceEvent[] {
	tui.traces();
	return [...tui.traceByRevision.values()].filter((trace) => trace.revision! > traceStartRevision);
}

function frameByRevision(tui: StartedTui, revision: number): TraceEvent {
	tui.traces();
	const frame = tui.traceByRevision.get(revision);
	assert.ok(frame, `Rust trace is missing editor revision ${revision}`);
	return frame;
}

function componentFrameBytes(tui: StartedTui, revision: number): number {
	const frame = tui.editorFramesByRevision.get(revision);
	assert.ok(frame, `Host event is missing editor revision ${revision}`);
	return Buffer.byteLength(frame.lines.join("\n"), "utf8");
}

function editorStateTexts(tui: StartedTui): string[] {
	return tui.editorTextState === undefined ? [] : [tui.editorTextState];
}

async function clearEditor(tui: StartedTui): Promise<void> {
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
	}, "CustomEditor clear did not settle");
}

async function typeEditor(tui: StartedTui, text: string): Promise<void> {
	let expected = "";
	for (const character of text) {
		tui.sendLiteral(character);
		expected += character;
		await waitFor(async () => {
			await tui.pump();
			return editorStateTexts(tui).at(-1) === expected;
		}, `CustomEditor did not mirror ${JSON.stringify(expected)}`);
	}
}

function observedEditorText(diagnostics: ComponentDiagnostics, expected: string, label: string): { bytes: number; hash: string } {
	const bytes = Buffer.byteLength(expected, "utf8");
	const hash = createHash("sha256").update(expected).digest("hex");
	assert.equal(diagnostics.editorTextBytes, bytes, `${label} observed editor bytes are incorrect`);
	assert.equal(diagnostics.editorTextHash, hash, `${label} observed editor hash is incorrect`);
	return { bytes, hash };
}

async function runScenario(scenario: (typeof config.scenarios)[number], width: number, height: number, round: number): Promise<void> {
	const tui = await startTui(`${scenario.name}-${width}x${height}-${round}`, width, height);
	try {
		await waitFor(async () => {
			await tui.pump();
			return componentFrames(tui).length > 0;
		}, () => {
			const extensionErrors = tui.serverMessages.flatMap((message) => {
				if (message.type !== "event" || message.event.type !== "session_progress") return [];
				const payload = message.event.progress as { type?: string; error?: string };
				return payload.type === "extension_error" ? [payload.error ?? "unknown extension error"] : [];
			});
			return `CustomEditor did not mount: ${JSON.stringify({
				serverMessages: tui.serverMessages.map((message) =>
					message.type === "event" ? message.event.type : message.type,
				),
				extensionErrors,
			})}`;
		});
		await clearEditor(tui);
		tui.sendLiteral("z");
		await waitFor(async () => {
			await tui.pump();
			return editorStateTexts(tui).at(-1) === "z";
		}, "CustomEditor warmup input did not settle");
		await clearEditor(tui);
		if (scenario.name === "custom_editor_input300" && !warmed) {
			await typeEditor(tui, "w".repeat(scenario.input!.count));
			await clearEditor(tui);
			warmed = true;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
		const before = await readDiagnostics(tui);
		tui.traces();
		const traceStartRevision = tui.lastTraceRevision;
		const hostMetrics = startHostSampling();
		const rustMetrics = startRustSampling(tui.panePid());
		let finalText = "";
		let finalAnimation: number | undefined;
		let bracketedPasteBytes: number | undefined;
		let pasteRequestBytes: number | undefined;
		let samples: Array<{
			receivedAt: number;
			publishedAt: number;
			inputRevision: number;
			frameRevision: number;
			appliedAt: number;
			hostBytes: number;
			rustBytes: number;
		}> = [];
		let hostInputCount: number | undefined;

		if (scenario.name === "custom_editor_input300") {
			finalText = scenario.input!.character.repeat(scenario.input!.count);
			for (const character of finalText) {
				const lastFrameRevision = tui.lastTraceRevision;
				tui.sendLiteral(character);
				await waitFor(async () => {
					await tui.pump();
					tui.traces();
					return tui.lastTraceRevision > lastFrameRevision;
				}, "single CustomEditor key did not reach a covering Rust frame");
			}
			await waitFor(async () => {
				await tui.pump();
				const diagnostics = await readDiagnostics(tui);
				return diagnostics.editorTextBytes === 300 && diagnostics.editorTextHash === createHash("sha256").update(finalText).digest("hex");
			}, "input300 final observed editor text is incorrect");
			const after = await readDiagnostics(tui);
			const inputs = after.inputs.slice(before.inputs.length);
			assert.equal(inputs.length, scenario.eventCount, "input300 did not produce exactly 300 component inputs");
			samples = inputs.map((input) => {
				const frame = frameByRevision(tui, input.revision);
				return {
					receivedAt: input.receivedAt,
					publishedAt: input.publishedAt,
					inputRevision: input.revision,
					frameRevision: input.revision,
					appliedAt: frame.atMs,
					hostBytes: componentFrameBytes(tui, input.revision),
					rustBytes: frame.bytes!,
				};
			});
		} else if (scenario.name === "paste5000") {
			finalText = scenario.input!.character.repeat(scenario.input!.count);
			const requestsBefore = tui.extensionInputCount;
			const lastFrameRevision = tui.lastTraceRevision;
			tui.paste(finalText);
			await waitFor(async () => {
				await tui.pump();
				return tui.extensionInputCount === requestsBefore + 1;
			}, "bracketed paste did not issue exactly one component request");
			const request = tui.lastExtensionInput!;
			const bracketedInput = `\u001b[200~${finalText}\u001b[201~`;
			pasteRequestBytes = Buffer.byteLength(request.data ?? "", "utf8");
			bracketedPasteBytes = Buffer.byteLength(bracketedInput, "utf8");
			assert.equal(request.data, bracketedInput, "bracketed paste request text is incorrect");
			assert.equal(pasteRequestBytes, 5_012, "bracketed paste request bytes are incorrect");
			assert.equal(bracketedPasteBytes, 5_012, "bracketed paste terminal framing bytes are incorrect");
			await waitFor(async () => {
				await tui.pump();
				tui.traces();
				return tui.lastTraceRevision > lastFrameRevision;
			}, "bracketed paste did not reach a covering Rust frame");
			await waitFor(async () => {
				await tui.pump();
				const diagnostics = await readDiagnostics(tui);
				return diagnostics.editorTextBytes === 5_000 && diagnostics.editorTextHash === createHash("sha256").update(finalText).digest("hex");
			}, "paste5000 final observed editor text is incorrect");
			const after = await readDiagnostics(tui);
			const inputs = after.inputs.slice(before.inputs.length);
			assert.equal(inputs.length, 1, "paste5000 fragmented into multiple component inputs");
			assert.equal(inputs[0]?.bytes, 5_012, "paste5000 observed input bytes are incorrect");
			const frame = frameByRevision(tui, inputs[0]!.revision);
			samples = [
				{
					receivedAt: inputs[0]!.receivedAt,
					publishedAt: inputs[0]!.publishedAt,
					inputRevision: inputs[0]!.revision,
					frameRevision: inputs[0]!.revision,
					appliedAt: frame.atMs,
					hostBytes: componentFrameBytes(tui, inputs[0]!.revision),
					rustBytes: frame.bytes!,
				},
			];
		} else if (scenario.name === "render_animation") {
			tui.send("C-f");
			await waitFor(async () => {
				await tui.pump();
				return componentFrames(tui).some((frame) => frame.lines.includes(`contract-animation=${scenario.animationFrames}`));
			}, "CustomEditor animation did not render its final frame", 30_000);
			const after = await readDiagnostics(tui);
			const invalidations = after.invalidations.slice(before.invalidations.length);
			assert.equal(invalidations.length, scenario.eventCount, "animation invalidation count is incorrect");
			assert.ok(invalidations.every((entry) => entry.publishedAt !== undefined && entry.revision !== undefined));
			samples = invalidations.map((invalidation) => {
				const frame = frameByRevision(tui, invalidation.revision!);
				return {
					receivedAt: invalidation.invalidateRequestedAt,
					publishedAt: invalidation.publishedAt!,
					inputRevision: invalidation.revision!,
					frameRevision: invalidation.revision!,
					appliedAt: frame.atMs,
					hostBytes: componentFrameBytes(tui, invalidation.revision!),
					rustBytes: frame.bytes!,
				};
			});
		} else {
			const autocomplete = scenario.autocomplete!;
			for (let index = 0; index < autocomplete.roundtrips; index++) {
				await clearEditor(tui);
				await typeEditor(tui, autocomplete.source);
				tui.send("Escape");
				await waitFor(async () => {
					await tui.pump();
					const diagnostics = await readDiagnostics(tui);
					return diagnostics.editorTextHash === createHash("sha256").update(autocomplete.source).digest("hex");
				}, "autocomplete reset did not preserve the source text");
				const beforeFirstTab = tui.extensionInputCount;
				tui.send("Tab");
				await waitFor(async () => {
					await tui.pump();
					return componentFrames(tui).some((frame) => frame.lines.some((line) => line.includes("provider completion")));
				}, () =>
					`autocomplete menu did not cover the Tab input: ${JSON.stringify({
						inputCount: tui.extensionInputCount,
						editorText: tui.editorTextState,
						lastFrame: componentFrames(tui).at(-1)?.lines,
					})}`,
				);
				assert.equal(tui.extensionInputCount, beforeFirstTab + 1, "first autocomplete Tab did not issue exactly one Host input");
				const first = tui.lastExtensionInput!;
				const firstFrame = componentFrames(tui).findLast((frame) => frame.lines.some((line) => line.includes("provider completion")))!;
				await waitFor(() => {
					tui.traces();
					return tui.traceByRevision.has(firstFrame.revision);
				}, "Rust did not apply autocomplete menu frame");
				const beforeSecondTab = tui.extensionInputCount;
				tui.send("Tab");
				await waitFor(async () => {
					await tui.pump();
					const diagnostics = await readDiagnostics(tui);
					return diagnostics.editorTextHash === createHash("sha256").update(autocomplete.completion).digest("hex");
				}, "autocomplete selection did not update observed editor text");
				assert.equal(tui.extensionInputCount, beforeSecondTab, "second autocomplete Tab must remain local");
				const secondFrame = componentFrames(tui).at(-1)!;
				await waitFor(() => {
					tui.traces();
					return tui.traceByRevision.has(secondFrame.revision);
				}, "Rust did not apply autocomplete selection frame");
				const frame = frameByRevision(tui, firstFrame.revision);
				samples.push({
					receivedAt: first.receivedAt,
					publishedAt: first.publishedAt,
					inputRevision: first.revision,
					frameRevision: firstFrame.revision,
					appliedAt: frame.atMs,
					hostBytes: componentFrameBytes(tui, firstFrame.revision),
					rustBytes: frame.bytes!,
				});
			}
			finalText = autocomplete.completion;
			hostInputCount = samples.length;
			assert.equal(hostInputCount, autocomplete.roundtrips, "autocomplete Host input delta does not match completion roundtrips");
		}

		const host = hostMetrics.stop();
		const rust = rustMetrics.stop();
		const after = await readDiagnostics(tui);
		const frames = componentFrameTraces(tui, traceStartRevision);
		assert.equal(samples.length, scenario.eventCount, `${scenario.name} metric sample count is incorrect`);
		assert.ok(samples.every((sample) => sample.publishedAt >= sample.receivedAt && sample.appliedAt >= sample.publishedAt));
		const summary = timingSummary(samples.map((sample) => sample.appliedAt - sample.receivedAt));
		assert.ok(
			summary.p95Ms <= scenario.thresholds.p95Ms,
			`${scenario.name} p95 ${summary.p95Ms}ms exceeds its ${scenario.thresholds.p95Ms}ms budget; first=${JSON.stringify(samples[0])}`,
		);
		assert.ok(
			summary.p99Ms <= scenario.thresholds.p99Ms,
			`${scenario.name} p99 ${summary.p99Ms}ms exceeds its ${scenario.thresholds.p99Ms}ms budget`,
		);
		if (scenario.name === "render_animation") {
			finalAnimation = after.lastFinalState ?? undefined;
			assert.equal(finalAnimation, scenario.animationFrames, "animation final state diagnostics are incorrect");
		}
		const observed = observedEditorText(after, finalText, scenario.name);
		const record = {
			implementation: config.implementation,
			hostRuntime: `bun-${process.versions.bun}`,
			scenario: scenario.name,
			size: `${width}x${height}`,
			round,
			eventCount: scenario.eventCount,
			...summary,
			hostRenderCount: after.renderCount - before.renderCount,
			hostPublishCount: after.publishCount - before.publishCount,
			coalescedCount: after.coalescedCount - before.coalescedCount,
			hostBytes: samples.reduce((total, sample) => total + sample.hostBytes, 0),
			rustFrameCount: frames.length,
			rustBytes: frames.reduce((total, frame) => total + frame.bytes!, 0),
			...host,
			...rust,
			combinedPeakRssBytes: host.hostPeakRssBytes + rust.rustPeakRssBytes,
			cpuMs: host.hostCpuMs + rust.rustCpuMs,
			transcriptRegroupBefore: "independent-runner",
			transcriptRegroupAfter: "independent-runner",
			finalTextLength: observed.bytes,
			finalTextHash: observed.hash,
			duplicateInputCount: 0,
			staleCompletionCount: tui.staleCompletionCount,
			...(hostInputCount === undefined ? {} : { hostInputCount }),
			...(bracketedPasteBytes === undefined ? {} : { bracketedPasteBytes, pasteRequestBytes }),
			...(finalAnimation === undefined ? {} : { finalAnimation }),
			samples,
		};
		appendFileSync(artifact, `${JSON.stringify(record)}\n`);
		appendFileSync(
			stagesArtifact,
			`${JSON.stringify({
				scenario: scenario.name,
				size: `${width}x${height}`,
				round,
				host: { baselineRssBytes: host.hostBaselineRssBytes, endRssBytes: host.hostEndRssBytes },
				rust: { baselineRssBytes: rust.rustBaselineRssBytes, endRssBytes: rust.rustEndRssBytes },
			})}\n`,
		);
	} finally {
		await tui.close();
	}
}

try {
	for (const scenario of config.scenarios) {
		for (const [width, height] of config.sizes) {
			for (let round = 1; round <= config.rounds; round++) await runScenario(scenario, width, height, round);
		}
	}
} finally {
	for (const descriptor of [...descriptors]) closeDescriptor(descriptor);
	for (const socket of sockets) spawnSync("tmux", ["-L", socket, "kill-server"]);
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
}
