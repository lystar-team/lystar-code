import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, type Terminal, TUI } from "../src/index.ts";

class TestTerminal implements Terminal {
	private inputHandler?: (data: string) => void;
	readonly writes: string[] = [];

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.inputHandler = onInput;
	}

	stop(): void {
		this.inputHandler = undefined;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}
}

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

const ST = "\x1b\\";
const encode = (value: string | Uint8Array) => Buffer.from(value).toString("base64");
const response = (metadata: string, payload?: string) =>
	`\x1b]5522;${metadata}${payload === undefined ? "" : `;${payload}`}${ST}`;

describe("TUI.queryTerminalClipboard", () => {
	it("lists MIME types before reading and combines image chunks", async () => {
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		tui.start();
		try {
			const query = tui.queryTerminalClipboard({
				mimeTypes: ["image/png", "image/jpeg"],
				listTimeoutMs: 1000,
				readTimeoutMs: 1000,
			});
			assert.ok(terminal.writes.includes(`\x1b]5522;type=read:id=pi-1;${encode(".")}${ST}`));

			terminal.sendInput(response("type=read:status=OK:id=pi-1"));
			terminal.sendInput(response(`type=read:status=DATA:id=pi-1:mime=${encode("image/png")}`));
			terminal.sendInput(response(`type=read:status=DATA:id=pi-1:mime=${encode("text/plain")}`));
			terminal.sendInput(response("type=read:status=DONE:id=pi-1"));

			assert.ok(terminal.writes.includes(`\x1b]5522;type=read:id=pi-1;${encode("image/png")}${ST}`));
			terminal.sendInput(response("type=read:status=OK:id=pi-1"));
			terminal.sendInput(
				response(`type=read:status=DATA:id=pi-1:mime=${encode("image/png")}`, encode(Uint8Array.from([1, 2]))),
			);
			terminal.sendInput(
				response(`type=read:status=DATA:id=pi-1:mime=${encode("image/png")}`, encode(Uint8Array.from([3, 4]))),
			);
			terminal.sendInput(response("type=read:status=DONE:id=pi-1"));

			const content = await query;
			assert.strictEqual(content?.mimeType, "image/png");
			assert.deepStrictEqual(Array.from(content?.bytes ?? []), [1, 2, 3, 4]);
		} finally {
			tui.stop();
		}
	});

	it("returns undefined when none of the requested MIME types are available", async () => {
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		tui.start();
		try {
			const query = tui.queryTerminalClipboard({ mimeTypes: ["image/png"], listTimeoutMs: 1000 });
			terminal.sendInput(response(`type=read:status=DATA:id=pi-1:mime=${encode("text/plain")}`));
			terminal.sendInput(response("type=read:status=DONE:id=pi-1"));

			assert.strictEqual(await query, undefined);
			assert.strictEqual(
				terminal.writes.some((write) => write.includes(encode("image/png"))),
				false,
			);
		} finally {
			tui.stop();
		}
	});

	it("wraps requests for tmux and never forwards clipboard responses to the focused component", async () => {
		const terminal = new TestTerminal();
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();
		tui.addChild(recorder);
		tui.setFocus(recorder);
		tui.start();
		try {
			const query = tui.queryTerminalClipboard({ mimeTypes: ["image/png"], listTimeoutMs: 1000, tmux: true });
			const request = terminal.writes.find((write) => write.startsWith("\x1bPtmux;"));
			assert.ok(request?.includes("\x1b\x1b]5522;"));

			terminal.sendInput(response("type=read:status=ENOSYS:id=pi-1"));
			assert.strictEqual(await query, undefined);
			assert.deepStrictEqual(recorder.inputs, []);

			terminal.sendInput(response("type=read:status=DONE:id=pi-1"));
			assert.deepStrictEqual(recorder.inputs, []);
		} finally {
			tui.stop();
		}
	});
});
