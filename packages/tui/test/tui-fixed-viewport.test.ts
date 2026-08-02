import assert from "node:assert";
import { describe, it } from "node:test";
import { encodeKitty } from "../src/terminal-image.ts";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	getWriteChunks(): readonly string[] {
		return this.writes;
	}

	clearWrites(): void {
		this.writes = [];
	}
}

class FixedViewportTUI extends TUI {
	protected override useFixedViewportRenderer(): boolean {
		return true;
	}
}

class InsetFixedViewportTUI extends FixedViewportTUI {
	protected override getRenderWidth(): number {
		return Math.max(1, this.terminal.columns - 1);
	}
}

describe("TUI fixed viewport rendering", () => {
	it("uses absolute rows after the real cursor drifts from internal state", async () => {
		const terminal = new LoggingVirtualTerminal(20, 5);
		const tui = new FixedViewportTUI(terminal);
		const component = new TestComponent();
		component.lines = ["Header", "Line 1", "Line 2", "Editor", "Footer"];
		tui.setTerminalModes({ alternateScreen: true, mouse: false });
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		terminal.write("\x1b[1;1H");
		await terminal.flush();
		terminal.clearWrites();
		component.lines[2] = "Updated";
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const clearIndex = writes.indexOf("\x1b[3;1H\x1b[2K");
		const drawIndex = writes.indexOf("\x1b[3;1HUpdated");
		assert.deepStrictEqual(terminal.getViewport(), ["Header", "Line 1", "Updated", "Editor", "Footer"]);
		assert.ok(clearIndex >= 0 && clearIndex < drawIndex);
		assert.doesNotMatch(writes, /\r\n|\x1b\[\d+[AB]/);
		tui.stop();
	});

	it("repairs an externally corrupted screen without a logical content change", async () => {
		const terminal = new LoggingVirtualTerminal(20, 5);
		const tui = new FixedViewportTUI(terminal);
		const component = new TestComponent();
		component.lines = ["Header", "Line 1", "Line 2", "Editor", "Footer"];
		tui.setTerminalModes({ alternateScreen: true, mouse: false });
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		terminal.write("\x1b[1;1H\x1b[2KCorrupt");
		await terminal.flush();
		terminal.clearWrites();
		await new Promise((resolve) => setTimeout(resolve, 550));
		tui.requestRender();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["Header", "Line 1", "Line 2", "Editor", "Footer"]);
		assert.match(terminal.getWrites(), /\x1b\[1;1H\x1b\[2K/);
		assert.match(terminal.getWrites(), /\x1b\[1;1HHeader/);
		assert.doesNotMatch(terminal.getWrites(), /\x1b\[2J/);
		tui.stop();
	});

	it("clears Kitty image rows before absolute placement", async () => {
		const terminal = new LoggingVirtualTerminal(40, 5);
		const tui = new FixedViewportTUI(terminal);
		const component = new TestComponent();
		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 42, moveCursor: false });
		component.lines = ["Header", image, "", "Editor", "Footer"];
		tui.setTerminalModes({ alternateScreen: true, mouse: false });
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const reservedRowClear = writes.indexOf("\x1b[3;1H\x1b[2K");
		const imagePlacement = writes.indexOf(`\x1b[2;1H${image}`);
		assert.ok(reservedRowClear >= 0);
		assert.ok(imagePlacement > reservedRowClear);
		assert.doesNotMatch(writes.slice(imagePlacement), /\x1b\[\d+;1H\x1b\[2K/);
		tui.stop();
	});

	it("clips components that exceed the protected render width", async () => {
		const terminal = new LoggingVirtualTerminal(20, 3);
		const tui = new InsetFixedViewportTUI(terminal);
		const component = new TestComponent();
		component.lines = ["X".repeat(30), "Editor", "Footer"];
		tui.setTerminalModes({ alternateScreen: true, mouse: false });
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(terminal.getViewport()[0], "X".repeat(19));
		assert.ok(!terminal.getWrites().includes("X".repeat(20)));
		tui.stop();
	});

	it("writes the frame and hardware cursor in one synchronized chunk", async () => {
		const terminal = new LoggingVirtualTerminal(20, 5);
		const tui = new FixedViewportTUI(terminal, true);
		const component = new TestComponent();
		component.lines = ["Header", "Line 1", `Edit ${CURSOR_MARKER}text`, "Status", "Footer"];
		tui.setTerminalModes({ alternateScreen: true, mouse: false });
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines[1] = "Updated";
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(terminal.getWriteChunks().length, 1);
		const frame = terminal.getWrites();
		const cursor = frame.indexOf("\x1b[3;6H");
		assert.ok(frame.startsWith("\x1b[?2026h"));
		assert.ok(cursor >= 0);
		assert.ok(cursor < frame.indexOf("\x1b[?25h"));
		assert.ok(frame.indexOf("\x1b[?25h") < frame.indexOf("\x1b[?2026l"));
		tui.stop();
	});
});
