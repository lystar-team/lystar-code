import assert from "node:assert/strict";
import test from "node:test";
import { Input } from "../src/components/input.ts";
import { createHeadlessComponentAdapter, createHeadlessTuiFacade } from "../src/headless-adapter.ts";
import { CURSOR_MARKER } from "../src/tui.ts";

class AsyncExtensionFooterFixture {
	private branch = "main";
	private readonly requestRender: () => void;
	disposeCalls = 0;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	render(width: number): string[] {
		return [`extension footer: ${this.branch}${CURSOR_MARKER}`.slice(0, width)];
	}

	handleInput(data: string): void {
		this.branch += data;
		queueMicrotask(this.requestRender);
	}

	invalidate(): void {}

	dispose(): void {
		this.disposeCalls++;
	}
}

test("headless adapter renders a real input and extension-style async component", async () => {
	const input = new Input("> ");
	input.focused = true;
	const inputAdapter = createHeadlessComponentAdapter(input, { width: 20, height: 1 });
	const firstInputFrame = inputAdapter.input("A");
	assert.match(firstInputFrame.lines[0] ?? "", /^> A/);
	assert.deepEqual(firstInputFrame.cursor, { row: 0, column: 3 });
	assert.deepEqual(firstInputFrame.hitRegions, [{ kind: "component", row: 0, column: 0, width: 20 }]);
	const resizedInputFrame = inputAdapter.resize(3, 1);
	assert.equal(resizedInputFrame.hitRegions[0]?.width, 3);

	let invalidated = 0;
	let adapter: ReturnType<typeof createHeadlessComponentAdapter>;
	const component = new AsyncExtensionFooterFixture(() => adapter.requestRender());
	adapter = createHeadlessComponentAdapter(component, {
		width: 64,
		height: 1,
		onInvalidate: () => {
			invalidated++;
		},
	});

	const extensionFrame = adapter.input("A");
	assert.deepEqual(extensionFrame.lines, ["extension footer: mainA"]);
	assert.deepEqual(extensionFrame.cursor, { row: 0, column: 23 });
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	assert.equal(invalidated, 1);
	assert.deepEqual(adapter.resize(8, 1).lines, ["extensio"]);
	adapter.invalidate();
	adapter.dispose();
	adapter.dispose();
	assert.equal(component.disposeCalls, 1);
	assert.deepEqual(adapter.requestRender().lines, []);
});

test("headless facade rejects terminal ownership without writing a terminal", () => {
	const violations: string[] = [];
	const tui = createHeadlessTuiFacade({
		componentId: "ownership-test",
		width: 80,
		height: 24,
		onRequestRender: () => {},
		onTerminalOwnershipViolation: (violation) => violations.push(violation.operation),
	});
	assert.throws(() => tui.terminal.write("\\x1b[2J"), { code: "terminal_ownership_violation" });
	assert.deepEqual(violations, ["write"]);
});
