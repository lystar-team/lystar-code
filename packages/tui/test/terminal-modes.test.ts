import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "../src/components/text.ts";
import type { Terminal } from "../src/terminal.ts";
import { TUI } from "../src/tui.ts";

class CaptureTerminal implements Terminal {
	writes: string[] = [];
	columns = 40;
	rows = 8;
	kittyProtocolActive = false;

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

async function waitForRender(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

test("alternate screen and SGR mouse modes are restored on stop", async () => {
	const terminal = new CaptureTerminal();
	const tui = new TUI(terminal);
	tui.setTerminalModes({ alternateScreen: true, mouse: true });
	tui.addChild(new Text("hello", 0, 0));
	tui.start();
	await waitForRender();
	tui.requestRender(true);
	await waitForRender();
	tui.stop();

	const output = terminal.writes.join("");
	assert.match(output, /\x1b\[\?1049h/);
	assert.match(output, /\x1b\[\?1000h\x1b\[\?1006h/);
	assert.match(output, /\x1b\[\?1006l\x1b\[\?1000l\x1b\[\?1049l/);
	assert.equal(output.includes("\x1b[3J"), false);
});
