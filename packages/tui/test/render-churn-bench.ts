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
	rounds: number;
	transcriptItems: number;
	prefetchViewports: number;
	scenarios: Scenario[];
};

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
};

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

class MutableLine implements Component {
	private version = 0;
	private text: string;
	constructor(text: string) {
		this.text = text;
	}
	append(value: string): void {
		this.text += value;
		this.version++;
	}
	invalidate(): void {}
	getRenderVersion(): number {
		return this.version;
	}
	render(width: number): string[] {
		return [this.text.slice(Math.max(0, this.text.length - Math.max(1, width)))];
	}
}

function percentile(samples: number[], q: number): number {
	const values = [...samples].sort((a, b) => a - b);
	return values[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)] ?? 0;
}

function visibleItems(rows: number, prefetchViewports: number, itemCount: number): number {
	const viewport = Math.max(1, rows - 1);
	return Math.min(itemCount, viewport * (1 + prefetchViewports));
}

function buildWorkspace(columns: number, rows: number, itemCount: number) {
	const terminal = new MemoryTerminal(columns, rows);
	const tui = new TuiAltScreen(terminal, false, "/tmp/lystar-rust-b0-ts");
	const page = new Container();
	const transcript = Array.from(
		{ length: itemCount },
		(_, index) =>
			new MutableLine(`assistant ${index.toString().padStart(5, "0")} benchmark transcript line with Chinese 内容`),
	);
	for (const item of transcript) page.addChild(item);
	const editor = new MutableLine("> ");
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
	terminal.bytesWritten = 0;
	return { terminal, tui, workspace, page, transcript, editor };
}

function runScenario(scenario: Scenario, columns: number, rows: number, round: number, config: Config): RecordLine {
	const { terminal, tui, workspace, page, transcript, editor } = buildWorkspace(columns, rows, config.transcriptItems);
	if (scenario.kind === "idle") {
		tui.stop();
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
		};
	}
	const frames: number[] = [];
	const bytes: number[] = [];
	let workUnits = 0;
	let renderedItems = 0;
	for (let index = 0; index < scenario.events; index++) {
		const mutation = `${scenario.kind}-${index}:`.padEnd(scenario.charactersPerEvent, "x");
		if (scenario.kind === "input" || scenario.kind === "paste") editor.append(mutation);
		if (scenario.kind === "stream") {
			const item = new MutableLine(mutation);
			transcript.push(item);
			page.addChild(item);
		}
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
		renderedItems += visibleItems(terminal.rows, config.prefetchViewports, transcript.length);
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
	};
	tui.stop();
	return record;
}

const args = process.argv.slice(2);
const config = JSON.parse(
	readFileSync(resolve(import.meta.dirname, "../../../benchmarks/tui-spike-scenarios.json"), "utf8"),
) as Config;
const holdIndex = args.indexOf("--rss-hold-ms");
const holdMs = holdIndex < 0 ? undefined : Number(args[holdIndex + 1]);
if (holdMs !== undefined) {
	initTheme("dark");
	const { tui } = buildWorkspace(120, 36, config.transcriptItems);
	console.log("READY");
	await new Promise((resolveHold) => setTimeout(resolveHold, holdMs));
	tui.stop();
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
