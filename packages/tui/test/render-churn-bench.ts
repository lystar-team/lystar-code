import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { type Component, Container, type Terminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { LystarWorkspace } from "../../coding-agent/src/modes/interactive/components/lystar-workspace.ts";
import { initTheme } from "../../coding-agent/src/modes/interactive/theme/theme.ts";

type ScenarioKind = "idle" | "input" | "paste" | "stream" | "scroll" | "resize";
type Scenario = {
	name: string;
	kind: ScenarioKind;
	events: number;
	charactersPerEvent: number;
	itemsPerEvent: number;
	scrollLines: number;
};
type Config = {
	sizes: Array<[number, number]>;
	compatibilitySize: [number, number];
	rounds: number;
	toolRounds: number;
	toolPageSize: number;
	toolPageCachePages: number;
	prefetchViewports: number;
	scenarios: Scenario[];
};
type ToolCall = {
	args: { path: string; query: string; round: number };
	id: string;
	name: string;
	toolId: string;
};
type ToolResult = {
	contentRef: string | null;
	diff: string | null;
	error: string | null;
	id: string;
	imageSummary: string | null;
	output: string;
	status: "error" | "success" | "streaming";
	toolId: string;
};
type ToolRound = { call: ToolCall; result: ToolResult };
type RecordLine = {
	implementation: "ts";
	scenario: string;
	columns: number;
	rows: number;
	round: number;
	events: number;
	frames: number;
	workUnits: number;
	renderedItems: number;
	toolRounds: number;
	toolCallEvents: number;
	toolResultEvents: number;
	streamingUpdates: number;
	cachedToolRounds: number;
	bytesP50: number;
	bytesP95: number;
	bytesP99: number;
	bytesMax: number;
	bytesTotal: number;
	frameP50Ms: number;
	frameP95Ms: number;
	frameP99Ms: number;
	frameMaxMs: number;
	frameTotalMs: number;
	rssBytes: number;
	workloadHash: string;
};

const SCENARIO_TIMEOUT_MS = Number(process.env.RUST_TUI_SPIKE_SCENARIO_TIMEOUT_MS ?? 120_000);

class MemoryTerminal implements Terminal {
	bytesWritten = 0;
	columns: number;
	rows: number;
	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
	}
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytesWritten += Buffer.byteLength(data);
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

class ToolSession {
	readonly rounds: ToolRound[];
	version = 0;
	streamingUpdates = 0;
	constructor(toolRounds: number) {
		this.rounds = Array.from({ length: toolRounds }, (_, index) => createToolRound(index));
	}
	updateStreaming(index: number, update: string): void {
		const result = this.rounds[index]?.result;
		if (!result) throw new Error(`Missing benchmark tool round ${index}`);
		result.status = "streaming";
		result.output = `${result.output}\n${update}`;
		this.streamingUpdates++;
		this.version++;
	}
}

class ComposerLine implements Component {
	invalidate(): void {}
	getRenderVersion(): number {
		return 0;
	}
	render(): string[] {
		return ["> "];
	}
}

class ToolLine implements Component {
	private readonly session: ToolSession;
	private readonly roundIndex: number;
	private readonly kind: "call" | "result";
	constructor(session: ToolSession, roundIndex: number, kind: "call" | "result") {
		this.session = session;
		this.roundIndex = roundIndex;
		this.kind = kind;
	}
	invalidate(): void {}
	getRenderVersion(): number {
		return this.session.version;
	}
	render(width: number): string[] {
		const round = this.session.rounds[this.roundIndex];
		if (!round) return [];
		if (this.kind === "call")
			return [truncate(`toolCall ${round.call.name} ${JSON.stringify(round.call.args)}`, width)];
		const { result } = round;
		const detail = result.error ?? result.diff ?? result.imageSummary ?? result.contentRef ?? result.output;
		return [truncate(`toolResult ${result.status} ${detail}`, width)];
	}
}

function createToolRound(index: number): ToolRound {
	const suffix = index.toString().padStart(5, "0");
	const toolId = `tool-${suffix}`;
	const name = ["read", "grep", "apply_patch", "image_gen", "bash"][index % 5] ?? "read";
	const output =
		index % 127 === 0 ? `long output ${suffix} ${"x".repeat(4096)}` : `tool result ${suffix} Chinese 内容`;
	return {
		call: {
			args: { path: `src/fixture-${suffix}.ts`, query: `needle-${index % 97}`, round: index },
			id: `tool-call-${suffix}`,
			name,
			toolId,
		},
		result: {
			contentRef: index % 43 === 0 ? `content_ref://tool-${suffix}/output` : null,
			diff:
				index % 37 === 0
					? `diff --git a/src/fixture-${suffix}.ts b/src/fixture-${suffix}.ts\n+updated ${suffix}`
					: null,
			error: index % 19 === 0 ? `exit 1: simulated tool failure ${suffix}` : null,
			id: `tool-result-${suffix}`,
			imageSummary: index % 41 === 0 ? `image 1024x1024 generated for ${suffix}` : null,
			output,
			status: index % 19 === 0 ? "error" : "success",
			toolId,
		},
	};
}

function truncate(value: string, width: number): string {
	return value.slice(Math.max(0, value.length - Math.max(1, width)));
}

function percentile(samples: number[], q: number): number {
	const values = [...samples].sort((a, b) => a - b);
	return values[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)] ?? 0;
}

function visibleToolRounds(rows: number, prefetchViewports: number, toolRounds: number): number {
	const viewportLines = Math.max(1, rows - 1);
	return Math.min(toolRounds, Math.ceil(viewportLines / 2) * (1 + prefetchViewports));
}

function mutationForEvent(kind: ScenarioKind, index: number, characterCount: number): string {
	return `${kind}-${index}:`.slice(0, characterCount).padEnd(characterCount, "x");
}

function workloadHash(
	editor: string,
	session: ToolSession,
	workspace: LystarWorkspace,
	terminal: MemoryTerminal,
): string {
	const { scrollTop, viewportHeight } = workspace.getAltScreenSearchTarget().getViewport();
	const start = Math.floor(scrollTop / 2);
	const height = Math.ceil(viewportHeight / 2);
	const state = {
		editor,
		size: { columns: terminal.columns, rows: terminal.rows },
		toolRounds: session.rounds,
		viewport: { end: Math.min(session.rounds.length, start + height), height, start },
	};
	return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function buildWorkspace(columns: number, rows: number, toolRounds: number) {
	const terminal = new MemoryTerminal(columns, rows);
	const tui = new TuiAltScreen(terminal, false, "/tmp/lystar-rust-b0-ts");
	const page = new Container();
	const session = new ToolSession(toolRounds);
	for (let index = 0; index < session.rounds.length; index++) {
		page.addChild(new ToolLine(session, index, "call"));
		page.addChild(new ToolLine(session, index, "result"));
	}
	const editor = new ComposerLine();
	const workspace = new LystarWorkspace({
		getHeight: () => terminal.rows,
		header: new Container(),
		scrollContainers: [page],
		bottomContainers: [editor],
		fixedBottomContainers: [editor],
		fullscreen: true,
		scrollbar: "hidden",
	});
	tui.setLayoutRoot(workspace);
	tui.start();
	for (let index = 0; index < 8; index++) tui.renderNow();
	workspace.scrollToBottom();
	tui.renderNow();
	terminal.bytesWritten = 0;
	return { terminal, tui, workspace, session };
}

function runScenario(scenario: Scenario, columns: number, rows: number, round: number, config: Config): RecordLine {
	const started = performance.now();
	const { terminal, tui, workspace, session } = buildWorkspace(columns, rows, config.toolRounds);
	let editor = "> ";
	if (scenario.kind === "idle") {
		const hash = workloadHash(editor, session, workspace, terminal);
		tui.stop();
		return emptyRecord(scenario, columns, rows, round, config, hash, session);
	}
	const frames: number[] = [];
	const bytes: number[] = [];
	let workUnits = 0;
	let renderedItems = 0;
	for (let index = 0; index < scenario.events; index++) {
		const mutation = mutationForEvent(scenario.kind, index, scenario.charactersPerEvent);
		if (scenario.kind === "input" || scenario.kind === "paste") editor += mutation;
		if (scenario.kind === "stream") session.updateStreaming(config.toolRounds - 1 - (index % 120), mutation);
		if (scenario.kind === "scroll") workspace.scrollBy(-scenario.scrollLines);
		if (scenario.kind === "resize") {
			terminal.columns = index % 2 === 0 ? columns : Math.max(20, columns - 4);
			terminal.rows = index % 2 === 0 ? rows : Math.max(8, rows - 2);
		}
		const beforeBytes = terminal.bytesWritten;
		const began = performance.now();
		tui.renderNow();
		frames.push(performance.now() - began);
		bytes.push(terminal.bytesWritten - beforeBytes);
		workUnits +=
			scenario.charactersPerEvent +
			scenario.itemsPerEvent +
			scenario.scrollLines +
			(scenario.kind === "resize" ? 1 : 0);
		renderedItems += visibleToolRounds(terminal.rows, config.prefetchViewports, config.toolRounds) * 2;
		if (performance.now() - started > SCENARIO_TIMEOUT_MS) {
			tui.stop();
			throw new Error(`${scenario.name}/${columns}x${rows} exceeded ${SCENARIO_TIMEOUT_MS}ms`);
		}
	}
	const record: RecordLine = {
		implementation: "ts",
		scenario: scenario.name,
		columns,
		rows,
		round,
		events: scenario.events,
		frames: frames.length,
		workUnits,
		renderedItems,
		toolRounds: config.toolRounds,
		toolCallEvents: config.toolRounds,
		toolResultEvents: config.toolRounds,
		streamingUpdates: session.streamingUpdates,
		cachedToolRounds: session.rounds.length,
		bytesP50: percentile(bytes, 0.5),
		bytesP95: percentile(bytes, 0.95),
		bytesP99: percentile(bytes, 0.99),
		bytesMax: Math.max(...bytes),
		bytesTotal: bytes.reduce((total, value) => total + value, 0),
		frameP50Ms: percentile(frames, 0.5),
		frameP95Ms: percentile(frames, 0.95),
		frameP99Ms: percentile(frames, 0.99),
		frameMaxMs: Math.max(...frames),
		frameTotalMs: frames.reduce((total, value) => total + value, 0),
		rssBytes: process.memoryUsage().rss,
		workloadHash: workloadHash(editor, session, workspace, terminal),
	};
	tui.stop();
	return record;
}

function emptyRecord(
	scenario: Scenario,
	columns: number,
	rows: number,
	round: number,
	config: Config,
	workloadHash: string,
	session: ToolSession,
): RecordLine {
	return {
		implementation: "ts",
		scenario: scenario.name,
		columns,
		rows,
		round,
		events: 0,
		frames: 0,
		workUnits: 0,
		renderedItems: 0,
		toolRounds: config.toolRounds,
		toolCallEvents: config.toolRounds,
		toolResultEvents: config.toolRounds,
		streamingUpdates: session.streamingUpdates,
		cachedToolRounds: session.rounds.length,
		bytesP50: 0,
		bytesP95: 0,
		bytesP99: 0,
		bytesMax: 0,
		bytesTotal: 0,
		frameP50Ms: 0,
		frameP95Ms: 0,
		frameP99Ms: 0,
		frameMaxMs: 0,
		frameTotalMs: 0,
		rssBytes: process.memoryUsage().rss,
		workloadHash,
	};
}

function runCompatibility(config: Config): void {
	const [columns, rows] = config.compatibilitySize;
	const { tui, workspace } = buildWorkspace(columns, rows, config.toolRounds);
	const lines = workspace.render(columns);
	assert.equal(lines.length, rows, "80x8 workspace did not preserve terminal height");
	assert.match(lines.at(-1) ?? "", /> /, "80x8 composer is not fixed at the bottom");
	tui.stop();
}

const args = process.argv.slice(2);
const config = JSON.parse(
	readFileSync(resolve(import.meta.dirname, "../../../benchmarks/tui-spike-scenarios.json"), "utf8"),
) as Config;
assert.equal(config.toolRounds, 10_000, "Rust TUI fixture must contain 10,000 tool rounds");
assert(SCENARIO_TIMEOUT_MS > 0, "RUST_TUI_SPIKE_SCENARIO_TIMEOUT_MS must be positive");
const holdIndex = args.indexOf("--rss-hold-ms");
const compatibility = args.includes("--compatibility");
if (holdIndex >= 0) {
	initTheme("dark");
	const { tui } = buildWorkspace(120, 36, config.toolRounds);
	console.log("READY");
	await new Promise((resolveHold) => setTimeout(resolveHold, Number(args[holdIndex + 1])));
	tui.stop();
	process.exit(0);
}
if (compatibility) {
	initTheme("dark");
	runCompatibility(config);
	process.exit(0);
}
const out = resolve(args[args.indexOf("--out") + 1] ?? ".artifacts/rust-tui-spike/benchmark-ts.jsonl");
const smoke = args.includes("--smoke");
const rounds = smoke ? 1 : config.rounds;
const sizes = smoke ? config.sizes.slice(0, 1) : config.sizes;
mkdirSync(resolve(out, ".."), { recursive: true });
rmSync(out, { force: true });
initTheme("dark");
for (let round = 1; round <= rounds; round++) {
	for (const [columns, rows] of sizes) {
		for (const scenario of config.scenarios)
			appendFileSync(out, `${JSON.stringify(runScenario(scenario, columns, rows, round, config))}\n`);
	}
}
