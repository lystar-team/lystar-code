import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { type Component, Container, type Terminal, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import {
	LystarWorkspace,
	WorkspaceComposer,
	WorkspaceHeader,
} from "../../coding-agent/src/modes/interactive/components/lystar-workspace.ts";
import { initTheme } from "../../coding-agent/src/modes/interactive/theme/theme.ts";

type Scenario = { name: string; kind: "idle" | "input" | "paste" | "stream" | "scroll" | "resize"; events: number };
type Config = { sizes: Array<[number, number]>; rounds: number; scenarios: Scenario[] };

type RecordLine = {
	implementation: "ts";
	scenario: string;
	columns: number;
	rows: number;
	round: number;
	frames: number;
	bytes: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
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

class MutableText implements Component {
	private version = 0;
	private text: string;
	constructor(text: string) {
		this.text = text;
	}
	append(value: string): void {
		this.text += value;
		this.version++;
	}
	set(value: string): void {
		this.text = value;
		this.version++;
	}
	invalidate(): void {}
	getRenderVersion(): number {
		return this.version;
	}
	render(width: number): string[] {
		return new Text(this.text, 0, 0).render(width);
	}
}

function percentile(samples: number[], q: number): number {
	const values = [...samples].sort((a, b) => a - b);
	return values[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)] ?? 0;
}

function buildWorkspace(columns: number, rows: number) {
	const terminal = new MemoryTerminal(columns, rows);
	const tui = new TuiAltScreen(terminal, false, "/tmp/lystar-rust-b0-ts");
	const source = Array.from(
		{ length: 10_000 },
		(_, index) => `assistant ${index.toString().padStart(5, "0")} benchmark transcript line with Chinese 内容`,
	);
	const page = new Container();
	const reloadPage = (offset: number) => {
		page.clear();
		for (const line of source.slice(offset, offset + 400)) page.addChild(new MutableText(line));
	};
	reloadPage(9_600);
	const editorText = new MutableText("  ");
	const editor = new Container();
	editor.addChild(editorText);
	const composer = new WorkspaceComposer({
		editor,
		fullscreen: true,
		getInfo: () => ({ primary: "benchmark/model" }),
	});
	const footer = new Container();
	footer.addChild(new Text("Ctrl+C: 取消  Enter: 发送", 0, 0));
	const header = new Container();
	header.addChild(new WorkspaceHeader(() => ({ path: "~/lystar", context: "B0 benchmark" })));
	const workspace = new LystarWorkspace({
		getHeight: () => terminal.rows,
		header,
		scrollContainers: [page],
		bottomContainers: [composer, footer],
		fixedBottomContainers: [composer, footer],
		fullscreen: true,
		scrollbar: "hidden",
	});
	tui.setLayoutRoot(workspace);
	tui.start();
	for (let index = 0; index < 8; index++) tui.renderNow();
	terminal.bytesWritten = 0;
	return { terminal, tui, workspace, editorText, reloadPage };
}

function runScenario(scenario: Scenario, columns: number, rows: number, round: number): RecordLine {
	const { terminal, tui, workspace, editorText, reloadPage } = buildWorkspace(columns, rows);
	if (scenario.kind === "idle") {
		tui.stop();
		return {
			implementation: "ts",
			scenario: scenario.name,
			columns,
			rows,
			round,
			frames: 0,
			bytes: 0,
			p50Ms: 0,
			p95Ms: 0,
			p99Ms: 0,
			maxMs: 0,
			rssBytes: process.memoryUsage().rss,
		};
	}
	const samples: number[] = [];
	const batch = Math.max(10, Math.ceil(scenario.events / 20));
	for (let start = 0; start < scenario.events; start += batch) {
		const count = Math.min(batch, scenario.events - start);
		const began = performance.now();
		for (let index = 0; index < count; index++) {
			if (scenario.kind === "input") editorText.append(String.fromCharCode(97 + (index % 26)));
			if (scenario.kind === "paste") editorText.append("x".repeat(5_000));
			if (scenario.kind === "stream") editorText.append(` stream-${start + index}`);
			if (scenario.kind === "scroll") {
				workspace.scrollBy(-1);
				if ((start + index) % 75 === 0) reloadPage(Math.max(0, 9_600 - start - index));
			}
			if (scenario.kind === "resize") {
				terminal.columns = index % 2 === 0 ? columns : Math.max(20, columns - 4);
				terminal.rows = index % 2 === 0 ? rows : Math.max(8, rows - 2);
			}
			tui.renderNow();
		}
		samples.push((performance.now() - began) / count);
	}
	const bytes = terminal.bytesWritten;
	tui.stop();
	return {
		implementation: "ts",
		scenario: scenario.name,
		columns,
		rows,
		round,
		frames: scenario.events,
		bytes,
		p50Ms: percentile(samples, 0.5),
		p95Ms: percentile(samples, 0.95),
		p99Ms: percentile(samples, 0.99),
		maxMs: Math.max(...samples),
		rssBytes: process.memoryUsage().rss,
	};
}

const args = process.argv.slice(2);
const out = resolve(args[args.indexOf("--out") + 1] ?? ".artifacts/rust-tui-spike/benchmark-ts.jsonl");
const config = JSON.parse(
	readFileSync(resolve(import.meta.dirname, "../../../benchmarks/tui-spike-scenarios.json"), "utf8"),
) as Config;
const smoke = args.includes("--smoke");
const rounds = smoke ? 1 : config.rounds;
const sizes = smoke ? config.sizes.slice(0, 1) : config.sizes;
mkdirSync(resolve(out, ".."), { recursive: true });
rmSync(out, { force: true });
initTheme("dark");
for (let round = 1; round <= rounds; round++) {
	for (const [columns, rows] of sizes) {
		for (const scenario of config.scenarios)
			appendFileSync(out, `${JSON.stringify(runScenario(scenario, columns, rows, round))}\n`);
	}
}
