import { EventEmitter } from "node:events";
import { type Component, CURSOR_MARKER, type Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { LystarTUI, type OutputFlow } from "../src/modes/interactive/lystar-tui.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class CaptureTerminal implements Terminal {
	columns = 80;
	rows = 24;
	writes: string[] = [];

	get kittyProtocolActive(): boolean {
		return true;
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

class TestOutputFlow extends EventEmitter implements OutputFlow {
	writableNeedDrain = false;
}

class ChangingComponent implements Component {
	text = "initial";
	renderCount = 0;
	widths: number[] = [];

	render(width: number): string[] {
		this.renderCount++;
		this.widths.push(width);
		return [this.text.slice(0, width)];
	}

	invalidate(): void {}
}

class CursorAtMarginComponent implements Component {
	render(width: number): string[] {
		return [`${"X".repeat(Math.max(0, width - 1))}${CURSOR_MARKER}`];
	}

	invalidate(): void {}
}

describe("LYStar TUI", () => {
	it("disables autowrap only while the alternate screen is active", async () => {
		const terminal = new CaptureTerminal();
		const tui = new LystarTUI(terminal);
		const component = new ChangingComponent();
		component.text = "X".repeat(terminal.columns - 1);
		tui.addChild(component);

		tui.start();
		await sleep(50);
		tui.stop();

		const output = terminal.writes.join("");
		expect(output.indexOf("\x1b[?1049h")).toBeLessThan(output.indexOf("\x1b[?7l"));
		expect(output.indexOf("\x1b[?7l")).toBeLessThan(output.indexOf(component.text));
		expect(output.indexOf("\x1b[?7h")).toBeLessThan(output.indexOf("\x1b[?1049l"));
		expect(component.widths).toContain(terminal.columns - 1);
	});

	it("enables all-motion tracking inside terminal multiplexers so card hover receives movement events", () => {
		const environmentKeys = ["TMUX", "ZELLIJ", "STY", "TERM"] as const;
		const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
		try {
			for (const key of environmentKeys) delete process.env[key];
			process.env.TERM = "tmux-256color";
			const terminal = new CaptureTerminal();
			const tui = new LystarTUI(terminal);
			tui.start();
			const output = terminal.writes.join("");
			expect(output).toContain("\x1b[?1002h\x1b[?1003h");
			tui.stop();
		} finally {
			for (const key of environmentKeys) {
				const value = previousEnvironment.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("keeps base and overlay frames off the physical right margin", async () => {
		const terminal = new CaptureTerminal();
		const tui = new LystarTUI(terminal);
		const component = new ChangingComponent();
		const overlay = new ChangingComponent();
		tui.addChild(component);
		tui.start();
		await sleep(50);

		tui.showOverlay(overlay, { width: "100%" });
		for (let index = 0; index < 12; index++) {
			component.text = `stream-${index}`;
			tui.requestRender();
			await sleep(17);
		}
		await sleep(50);

		expect(component.widths.every((width) => width === terminal.columns - 1)).toBe(true);
		expect(overlay.widths.every((width) => width === terminal.columns - 1)).toBe(true);
		const output = terminal.writes.join("");
		const frames = terminal.writes.filter((write) => write.startsWith("\x1b[?2026h"));
		expect(output).toContain("stream-11");
		expect(output).not.toContain("\r\n");
		expect(output).not.toMatch(/\x1b\[\d+[AB]/);
		expect(frames.length).toBeGreaterThan(0);
		expect(frames.every((frame) => frame.endsWith("\x1b[?2026l"))).toBe(true);
		tui.stop();
	});

	it("keeps an end cursor inside the protected render width", async () => {
		const terminal = new CaptureTerminal();
		const tui = new LystarTUI(terminal, true);
		tui.addChild(new CursorAtMarginComponent());
		tui.start();
		await sleep(50);

		const frame = terminal.writes.find((write) => write.startsWith("\x1b[?2026h"));
		expect(frame).toContain("\x1b[1;79H\x1b[?25h");
		tui.stop();
	});

	it("keeps only the latest render while stdout is backpressured", async () => {
		const terminal = new CaptureTerminal();
		const outputFlow = new TestOutputFlow();
		outputFlow.writableNeedDrain = true;
		const component = new ChangingComponent();
		const tui = new LystarTUI(terminal, undefined, undefined, {}, outputFlow);
		tui.addChild(component);
		tui.start();

		for (let index = 0; index < 100; index++) {
			component.text = `frame-${index}`;
			tui.requestRender();
		}
		await sleep(50);
		expect(component.renderCount).toBe(0);

		outputFlow.writableNeedDrain = false;
		outputFlow.emit("drain");
		await sleep(50);

		expect(component.renderCount).toBe(1);
		expect(component.widths).toEqual([terminal.columns - 1]);
		expect(terminal.writes.join("")).toContain("frame-99");
		tui.stop();
	});

	it("repaints the full fixed viewport after resize", async () => {
		const terminal = new CaptureTerminal();
		terminal.rows = 8;
		const tui = new LystarTUI(terminal);
		const component = new ChangingComponent();
		tui.addChild(component);
		tui.start();
		await sleep(50);
		terminal.writes = [];

		terminal.columns = 120;
		terminal.rows = 36;
		component.text = "resized";
		tui.requestRender();
		await sleep(50);

		const output = terminal.writes.join("");
		expect(component.widths.at(-1)).toBe(119);
		expect(output).toContain("\x1b[36;1H\x1b[2K");
		expect(output).toContain("\x1b[1;1H\x1b[2K");
		expect(output).toContain("resized");
		expect(output).not.toContain("\x1b[2J");
		tui.stop();
	});

	it("caps paced updates at about 60 frames per second", async () => {
		const terminal = new CaptureTerminal();
		const component = new ChangingComponent();
		const tui = new LystarTUI(terminal);
		tui.addChild(component);
		tui.start();
		await sleep(50);
		component.renderCount = 0;

		for (let index = 0; index < 24; index++) {
			component.text = `paced-${index}`;
			tui.requestRender();
			await sleep(8);
		}
		await sleep(50);

		expect(component.renderCount).toBeGreaterThan(0);
		expect(component.renderCount).toBeLessThanOrEqual(16);
		expect(terminal.writes.join("")).toContain("paced-23");
		tui.stop();
	});
});
