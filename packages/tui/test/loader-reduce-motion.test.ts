import assert from "node:assert/strict";
import test from "node:test";
import { Loader } from "../src/components/loader.ts";
import type { TUI } from "../src/tui.ts";

test("loader does not schedule animation when reduced motion is enabled", async () => {
	let renderRequests = 0;
	const ui = {
		reduceMotion: true,
		requestRender: () => {
			renderRequests++;
		},
	} as unknown as TUI;
	const loader = new Loader(ui, String, String, "working", { frames: ["a", "b"], intervalMs: 5 });
	const initialRequests = renderRequests;

	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	loader.stop();

	assert.equal(renderRequests, initialRequests);
});
