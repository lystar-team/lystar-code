import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("returns editor app actions in the current component input response", () => {
		const events: ExtensionUiBridgeEvent[] = [];
		const bridge = new ExtensionUiBridge(
			async () => ({ cancelled: true }),
			(event) => events.push(event),
			() => {},
		);
		let onEscape: (() => void) | undefined;
		bridge.context().setEditorComponent(() => ({
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => {
				if (data === "\u001b") onEscape?.();
			},
			get onEscape() {
				return onEscape;
			},
			set onEscape(handler) {
				onEscape = handler;
			},
		}));
		const mount = events.find((event) => event.type === "component_mount" && event.placement === "editor");
		if (!mount || mount.type !== "component_mount") throw new Error("editor did not mount");

		expect(bridge.dispatchComponentInput(mount.componentId, mount.generation, "\u001b")).toEqual({
			appAction: "app.interrupt",
		});
		expect(events.some((event) => event.type === "editor_app_action")).toBe(false);
	});

	it("records observed editor bytes and hash without retaining input text", () => {
		const events: ExtensionUiBridgeEvent[] = [];
		const bridge = new ExtensionUiBridge(
			async () => ({ cancelled: true }),
			(event) => events.push(event),
			() => {},
		);
		let text = "mounted";
		bridge.context().setEditorComponent(() => ({
			render: () => ["editor"],
			invalidate: () => {},
			getText: () => text,
			handleInput: (data: string) => {
				text = `${text}:${data}`;
			},
		}));
		const mount = events.find((event) => event.type === "component_mount" && event.placement === "editor");
		if (!mount || mount.type !== "component_mount") throw new Error("editor did not mount");
		const mounted = bridge
			.getComponentDiagnostics()
			.components.find((item) => item.componentId === mount.componentId);
		expect(mounted).toMatchObject({
			editorTextBytes: Buffer.byteLength("mounted", "utf8"),
			editorTextHash: createHash("sha256").update("mounted").digest("hex"),
		});

		expect(bridge.dispatchComponentInput(mount.componentId, mount.generation, "secret input")).toEqual({});
		const diagnostic = bridge
			.getComponentDiagnostics()
			.components.find((item) => item.componentId === mount.componentId);
		const observed = "mounted:secret input";
		expect(diagnostic?.inputs).toEqual([
			expect.objectContaining({ revision: expect.any(Number), bytes: Buffer.byteLength("secret input", "utf8") }),
		]);
		expect(diagnostic).toMatchObject({
			editorTextBytes: Buffer.byteLength(observed, "utf8"),
			editorTextHash: createHash("sha256").update(observed).digest("hex"),
		});
		expect(JSON.stringify(bridge.getComponentDiagnostics())).not.toContain("secret input");
	});

	it("mirrors editor text changed by completion input without onChange", () => {
		const events: ExtensionUiBridgeEvent[] = [];
		const bridge = new ExtensionUiBridge(
			async () => ({ cancelled: true }),
			(event) => events.push(event),
			() => {},
		);
		let text = "@provider";
		bridge.context().setEditorComponent(() => ({
			render: () => [text],
			invalidate: () => {},
			getText: () => text,
			handleInput: (data: string) => {
				if (data === "\r") text = "@provider-final";
			},
		}));
		const mount = events.find((event) => event.type === "component_mount" && event.placement === "editor");
		if (!mount || mount.type !== "component_mount") throw new Error("editor did not mount");

		expect(bridge.dispatchComponentInput(mount.componentId, mount.generation, "\r")).toEqual({});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "editor_action",
				action: expect.objectContaining({ text: "@provider-final" }),
			}),
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

	it("invalidates stale editor callbacks and keeps active extension actions", () => {
		const events: ExtensionUiBridgeEvent[] = [];
		const bridge = new ExtensionUiBridge(
			async () => ({ cancelled: true }),
			(event) => events.push(event),
			() => {},
		);
		const editors: Array<EditorFixture> = [];
		let originalActions = 0;
		type EditorFixture = {
			text: string;
			setText(text: string): void;
			getText(): string;
			onChange?: (text: string) => void;
			onSubmit?: (text: string) => void;
			onEscape?: () => void;
			onCtrlD?: () => void;
			onPasteImage?: () => void;
			onExtensionShortcut?: (data: string) => boolean;
			actionHandlers: Map<string, () => void>;
			render(): string[];
			invalidate(): void;
			dispose(): void;
		};
		const factory = () => {
			const editor: EditorFixture = {
				text: "",
				setText(text) {
					this.text = text;
				},
				getText() {
					return this.text;
				},
				actionHandlers: new Map([["app.clear", () => originalActions++]]),
				render: () => [editor.text],
				invalidate: () => {},
				dispose: () => {},
			};
			editors.push(editor);
			return editor;
		};
		const ui = bridge.context();
		ui.setEditorComponent(factory);
		const stale = editors[0]!;
		stale.onChange?.("old draft");
		expect(events.at(-1)).toEqual(expect.objectContaining({ type: "editor_action" }));
		ui.setEditorComponent(factory);
		const current = editors[1]!;
		const eventsBeforeStaleCalls = events.length;
		const currentTextBeforeStaleCalls = current.getText();
		stale.onChange?.("ignored");
		stale.onSubmit?.("ignored");
		stale.onEscape?.();
		stale.onCtrlD?.();
		stale.onPasteImage?.();
		stale.onExtensionShortcut?.("x");
		stale.actionHandlers.get("app.clear")?.();
		expect(current.getText()).toBe(currentTextBeforeStaleCalls);
		expect(events).toHaveLength(eventsBeforeStaleCalls);
		expect(originalActions).toBe(1);
		current.actionHandlers.get("app.clear")?.();
		expect(originalActions).toBe(1);
		expect(current.getText()).toBe("");
		expect(events.at(-2)).toEqual(
			expect.objectContaining({ type: "editor_action", action: expect.objectContaining({ text: "" }) }),
		);
		expect(events.at(-1)).toEqual(expect.objectContaining({ type: "editor_app_action", action: "app.clear" }));
		expect(current.onExtensionShortcut?.("handled")).toBe(false);
		expect(current.onExtensionShortcut?.("unhandled")).toBe(false);
		ui.setEditorComponent(undefined);
		const eventsBeforeDispose = events.length;
		current.onChange?.("ignored after dispose");
		current.onSubmit?.("ignored after dispose");
		current.onEscape?.();
		current.onCtrlD?.();
		current.onPasteImage?.();
		current.onExtensionShortcut?.("x");
		current.actionHandlers.get("app.clear")?.();
		expect(originalActions).toBe(2);
		expect(events).toHaveLength(eventsBeforeDispose);
	});

	it("loads custom app keybindings from the runtime agent directory", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "lystar-keybindings-"));
		writeFileSync(
			join(agentDir, "keybindings.json"),
			JSON.stringify({
				"app.model.cycleForward": "ctrl+shift+p",
				"app.thinking.cycle": "alt+m",
				"app.thinking.toggle": "shift+tab",
			}),
		);
		try {
			const events: ExtensionUiBridgeEvent[] = [];
			const bridge = new ExtensionUiBridge(
				async () => ({ cancelled: true }),
				(event) => events.push(event),
				() => {},
				undefined,
				agentDir,
			);
			bridge.context().setEditorComponent((_tui: unknown, _theme: unknown, keybindings: unknown) => {
				const manager = keybindings as { matches(data: string, action: string): boolean };
				const actionHandlers = new Map<string, () => void>();
				return {
					actionHandlers,
					handleInput(data: string) {
						for (const action of [
							"app.model.cycleForward",
							"app.thinking.cycle",
							"app.thinking.toggle",
						] as const) {
							if (manager.matches(data, action)) actionHandlers.get(action)?.();
						}
					},
					render: () => [""],
					invalidate: () => {},
				};
			});
			const mount = events.find((event) => event.type === "component_mount" && event.placement === "editor");
			if (!mount || mount.type !== "component_mount") throw new Error("editor did not mount");

			for (const sequence of ["\u001b[112;6u", "\u001b[80;6u"]) {
				expect(bridge.dispatchComponentInput(mount.componentId, mount.generation, sequence)).toEqual({
					appAction: "app.model.cycleForward",
				});
			}
			expect(bridge.dispatchComponentInput(mount.componentId, mount.generation, "\u001b[109;3u")).toEqual({
				appAction: "app.thinking.cycle",
			});
			expect(bridge.dispatchComponentInput(mount.componentId, mount.generation, "\u001b[Z")).toEqual({
				appAction: "app.thinking.toggle",
			});
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("keeps raw terminal listener sequences intact while bounding them by UTF-8 bytes", async () => {
		const bridge = new ExtensionUiBridge(
			async () => ({ cancelled: true }),
			() => {},
			() => {},
		);
		let received = "";
		bridge.context().onTerminalInput((data) => {
			received = data;
			return { data: data === "\u001b[A" ? "\u001b[B" : data };
		});
		await expect(bridge.dispatchTerminalInput("\u001b[A")).resolves.toEqual({ consume: false, data: "\u001b[B" });
		await bridge.dispatchTerminalInput(`${"甲".repeat(21_845)}🙂`);
		expect(Buffer.byteLength(received, "utf8")).toBeLessThanOrEqual(64 * 1024);
		expect(received.endsWith("\ud83d")).toBe(false);
		expect(received.endsWith("\ude42")).toBe(false);
	});
});
