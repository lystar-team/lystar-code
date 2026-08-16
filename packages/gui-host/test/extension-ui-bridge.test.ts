import { describe, expect, it } from "vitest";
import { ExtensionUiBridge, type ExtensionUiBridgeEvent } from "../src/extension-ui-bridge.ts";

describe("ExtensionUiBridge", () => {
	it("publishes one final empty snapshot before disposal and removes terminal controls", () => {
		const events: ExtensionUiBridgeEvent[] = [];
		const bridge = new ExtensionUiBridge(
			async () => ({ cancelled: true }),
			(event) => events.push(event),
			() => {},
		);
		const ui = bridge.context();
		ui.setStatus("key\u001b]0;bad\u0007", "ready\u001b]0;bad\u0007");
		ui.setWidget("widget", ["line\u001b]8;;https://bad\u0007", "second\tline"]);
		ui.setWorkingMessage("working\u009b1m");
		ui.setTitle("title\u001b]0;bad\u0007");
		ui.onTerminalInput(() => undefined);

		expect(bridge.snapshot()).toMatchObject({
			statuses: [{ key: "key]0;bad", text: "ready]0;bad" }],
			widgets: [{ key: "widget", lines: ["line]8;;https://bad", "secondline"] }],
			workingMessage: "working1m",
			title: "title]0;bad",
			terminalInputListenerCount: 1,
		});

		bridge.dispose();
		const final = events.at(-1);
		expect(final).toEqual({
			type: "snapshot",
			state: expect.objectContaining({
				statuses: [],
				widgets: [],
				workingMessage: null,
				title: null,
				terminalInputListenerCount: 0,
			}),
		});
		bridge.reset();
		expect(events).toHaveLength(6);
	});

	it("unmounts a failing component input without escaping into the terminal bridge", async () => {
		const events: ExtensionUiBridgeEvent[] = [];
		const errors: string[] = [];
		const bridge = new ExtensionUiBridge(
			async () => ({ cancelled: true }),
			(event) => events.push(event),
			(error) => errors.push(error.event),
		);
		void bridge.context().custom(() => ({
			render: () => ["failing component"],
			invalidate: () => {},
			handleInput: () => {
				throw new Error("fixture failure");
			},
		}));
		await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
		const mount = events.find((event) => event.type === "component_mount");
		if (!mount || mount.type !== "component_mount") throw new Error("component did not mount");

		expect(bridge.dispatchComponentInput(mount.componentId, mount.generation, "x")).toBeUndefined();
		expect(events.at(-1)).toEqual({
			type: "component_unmount",
			componentId: mount.componentId,
			generation: mount.generation,
			reason: "error",
		});
		expect(errors).toEqual(["component_input"]);
	});

	it("keeps raw terminal listener sequences intact while bounding them", async () => {
		const bridge = new ExtensionUiBridge(
			async () => ({ cancelled: true }),
			() => {},
			() => {},
		);
		bridge.context().onTerminalInput((data) => ({ data: data === "\u001b[A" ? "\u001b[B" : data }));
		await expect(bridge.dispatchTerminalInput("\u001b[A")).resolves.toEqual({ consume: false, data: "\u001b[B" });
	});
});
