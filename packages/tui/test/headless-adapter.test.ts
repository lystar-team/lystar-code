import assert from "node:assert/strict";
import test from "node:test";
import { createHeadlessComponentAdapter } from "../src/headless-adapter.ts";

class AsyncExtensionComponent {
	private text = "";
	disposed = false;

	private readonly requestRender: () => void;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	render(width: number): string[] {
		return [`extension:${this.text}`.slice(0, width)];
	}

	handleInput(data: string): void {
		this.text += data;
		queueMicrotask(this.requestRender);
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
	}
}

test("headless adapter projects extension-style async invalidate, input, resize, and dispose", async () => {
	let invalidated = 0;
	let adapter: ReturnType<typeof createHeadlessComponentAdapter>;
	const component = new AsyncExtensionComponent(() => adapter.requestRender());
	adapter = createHeadlessComponentAdapter(component, {
		width: 20,
		height: 1,
		onInvalidate: () => {
			invalidated++;
		},
	});

	assert.deepEqual(adapter.input("A").lines, ["extension:A"]);
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	assert.equal(invalidated, 1);
	assert.deepEqual(adapter.resize(8, 1).lines, ["extensio"]);
	adapter.invalidate();
	adapter.dispose();
	assert.equal(component.disposed, true);
	assert.deepEqual(adapter.requestRender().lines, []);
});
