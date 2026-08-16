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

	it("coalesces component invalidations without delaying independent components", async () => {
		const events: ExtensionUiBridgeEvent[] = [];
		const bridge = new ExtensionUiBridge(
			async () => ({ cancelled: true }),
			(event) => events.push(event),
			() => {},
		);
		const ui = bridge.context();
		const renderCounts = new Map<string, number>();
		const tuis = new Map<string, { requestRender(): void }>();
		const factory = (label: string) => (tui: { requestRender(): void }) => {
			tuis.set(label, tui);
			return {
				render: () => {
					renderCounts.set(label, (renderCounts.get(label) ?? 0) + 1);
					return [label];
				},
				invalidate: () => {},
				handleInput: () => tui.requestRender(),
			};
		};
		ui.setHeader(factory("header"));
		ui.setFooter(factory("footer"));
		for (let index = 0; index < 1_000; index++) tuis.get("header")?.requestRender();
		expect(renderCounts.get("header")).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(renderCounts.get("header") ?? 0).toBeLessThanOrEqual(2);
		tuis.get("footer")?.requestRender();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(renderCounts.get("footer")).toBe(2);

		const header = events.find((event) => event.type === "component_mount" && event.componentId === "header");
		if (!header || header.type !== "component_mount") throw new Error("header did not mount");
		const beforeInput = events.filter(
			(event) => event.type === "component_frame" && event.componentId === "header",
		).length;
		bridge.dispatchComponentInput(header.componentId, header.generation, "x");
		expect(events.filter((event) => event.type === "component_frame" && event.componentId === "header").length).toBe(
			beforeInput + 1,
		);
		tuis.get("header")?.requestRender();
		ui.setHeader(undefined);
		const framesBeforeDispose = events.filter(
			(event) => event.type === "component_frame" && event.componentId === "header",
		).length;
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(events.filter((event) => event.type === "component_frame" && event.componentId === "header")).toHaveLength(
			framesBeforeDispose,
		);
	});

	it("mounts custom editors with the mirrored draft and restores native text after unmount", () => {
		const events: ExtensionUiBridgeEvent[] = [];
		const bridge = new ExtensionUiBridge(
			async () => ({ cancelled: true }),
			(event) => events.push(event),
			() => {},
		);
		const ui = bridge.context();
		ui.setEditorText("draft");
		let disposed = 0;
		let editor:
			| {
					text: string;
					setText(text: string): void;
					getText(): string;
					onChange?: (text: string) => void;
					onSubmit?: (text: string) => void;
					render(): string[];
					invalidate(): void;
					dispose(): void;
			  }
			| undefined;
		const factory = () => {
			editor = {
				text: "",
				setText(text) {
					this.text = text;
				},
				getText() {
					return this.text;
				},
				render: () => [editor?.text ?? ""],
				invalidate: () => {},
				dispose: () => {
					disposed++;
				},
			};
			return editor;
		};
		ui.setEditorComponent(factory);
		expect(editor?.text).toBe("draft");
		const mount = events.find((event) => event.type === "component_mount" && event.placement === "editor");
		expect(mount).toBeDefined();
		editor?.onChange?.("two\nlines");
		expect(events.at(-1)).toEqual(
			expect.objectContaining({ type: "editor_action", action: expect.objectContaining({ text: "two\nlines" }) }),
		);
		editor?.onSubmit?.("submit");
		expect(events.at(-1)).toEqual(expect.objectContaining({ type: "editor_submit", text: "submit" }));
		ui.setEditorComponent(undefined);
		expect(disposed).toBe(1);
		expect(events.some((event) => event.type === "component_unmount" && event.reason === "replace")).toBe(true);
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
