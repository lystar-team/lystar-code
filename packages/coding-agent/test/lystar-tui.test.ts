import { EventEmitter } from "node:events";
import type { Component, Terminal } from "@earendil-works/pi-tui";
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

	render(): string[] {
		this.renderCount++;
		return [this.text];
	}

	invalidate(): void {}
}

describe("LYStar TUI", () => {
	it("disables autowrap only while the alternate screen is active", async () => {
		const terminal = new CaptureTerminal();
		const tui = new LystarTUI(terminal);
		const component = new ChangingComponent();
		component.text = "X".repeat(terminal.columns);
		tui.setTerminalModes({ alternateScreen: true, mouse: false });
		tui.addChild(component);

		tui.start();
		await sleep(50);
		tui.stop();

		const output = terminal.writes.join("");
		expect(output.indexOf("\x1b[?1049h")).toBeLessThan(output.indexOf("\x1b[?7l"));
		expect(output.indexOf("\x1b[?7l")).toBeLessThan(output.indexOf(component.text));
		expect(output.indexOf("\x1b[?7h")).toBeLessThan(output.indexOf("\x1b[?1049l"));
	});

	it("leaves terminal autowrap unchanged in inline mode", async () => {
		const terminal = new CaptureTerminal();
		const tui = new LystarTUI(terminal);
		tui.addChild(new ChangingComponent());

		tui.start();
		await sleep(50);
		tui.stop();

		const output = terminal.writes.join("");
		expect(output).not.toContain("\x1b[?7l");
		expect(output).not.toContain("\x1b[?7h");
	});

	it("keeps only the latest render while stdout is backpressured", async () => {
		const terminal = new CaptureTerminal();
		const outputFlow = new TestOutputFlow();
		outputFlow.writableNeedDrain = true;
		const component = new ChangingComponent();
		const tui = new LystarTUI(terminal, undefined, undefined, outputFlow);
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
		expect(terminal.writes.join("")).toContain("frame-99");
		tui.stop();
	});

	it("caps paced updates at about 30 frames per second", async () => {
		const terminal = new CaptureTerminal();
		const component = new ChangingComponent();
		const tui = new LystarTUI(terminal);
		tui.addChild(component);
		tui.start();
		await sleep(50);
		component.renderCount = 0;

		for (let index = 0; index < 12; index++) {
			component.text = `paced-${index}`;
			tui.requestRender();
			await sleep(17);
		}
		await sleep(50);

		expect(component.renderCount).toBeGreaterThan(0);
		expect(component.renderCount).toBeLessThanOrEqual(8);
		expect(terminal.writes.join("")).toContain("paced-11");
		tui.stop();
	});
});
