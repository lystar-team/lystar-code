import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component, Terminal, TUI } from "@earendil-works/pi-tui";
import { Container, isViewportTUI, resetCapabilitiesCache, setCapabilities, Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { TuiMode } from "../src/core/settings-manager.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { LystarWorkspace } from "../src/modes/interactive/components/lystar-workspace.ts";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-summary.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import { LystarTUI } from "../src/modes/interactive/lystar-tui.ts";
import { WheelScrollNormalizer } from "../src/modes/interactive/mouse.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	startCount = 0;
	stopCount = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override stop(): void {
		this.stopCount += 1;
		super.stop();
	}
}

class InputSink implements Component {
	readonly inputs: string[] = [];

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(_width: number): string[] {
		return ["editor"];
	}

	invalidate(): void {}
}

describe("createInteractiveTui", () => {
	it("selects the alternate-screen renderer only when requested", async () => {
		const mainTerminal = new RecordingTerminal();
		const mainTui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: mainTerminal,
		});
		expect(mainTui.mode).toBe("regular");
		expect(isViewportTUI(mainTui)).toBe(false);
		mainTui.start();
		await mainTerminal.waitForRender();
		expect(mainTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(false);
		mainTui.stop();

		const altTerminal = new RecordingTerminal();
		const altTui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: altTerminal,
		});
		expect(altTui.mode).toBe("fullscreen");
		expect(isViewportTUI(altTui)).toBe(true);
		altTui.start();
		await altTerminal.waitForRender();
		expect(altTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(true);
		expect(altTerminal.writes.some((write) => write.includes("\x1b[5 q"))).toBe(true);
		altTui.stop();
		expect(altTerminal.writes.some((write) => write.includes("\x1b[0 q"))).toBe(true);
	});

	it("routes LYStar workspace viewport input before the inherited viewport", async () => {
		initTheme("dark");
		const terminal = new RecordingTerminal(40, 8);
		const chat = new Container();
		for (let index = 0; index < 30; index++) chat.addChild(new Text(`line-${index}`, 0, 0));
		const header = new Container();
		header.addChild(new Text("header", 0, 0));
		const workspace = new LystarWorkspace({
			getHeight: () => terminal.rows,
			header,
			scrollContainers: [chat],
			bottomContainers: [new Text("editor", 0, 0)],
			fixedBottomContainers: [],
			fullscreen: true,
			scrollbar: "hidden",
		});
		type WorkspaceInputContext = {
			workspace: LystarWorkspace;
			renderer: ReturnType<typeof createInteractiveTui>;
			ui: TUI;
			keybindings: KeybindingsManager;
			wheelScroll: WheelScrollNormalizer;
			loadPreviousTranscriptPage: () => Promise<void>;
		};
		const handleWorkspaceInput = (
			InteractiveMode.prototype as unknown as {
				handleWorkspaceInput(this: WorkspaceInputContext, data: string): { consume: true } | undefined;
			}
		).handleWorkspaceInput;
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			workspace,
			renderer: undefined as unknown as ReturnType<typeof createInteractiveTui>,
			ui: undefined as unknown as TUI,
			keybindings: new KeybindingsManager({
				"tui.altScreen.halfPageUp": "ctrl+u",
				"tui.altScreen.halfPageDown": "ctrl+d",
			}),
			wheelScroll: new WheelScrollNormalizer(),
			loadPreviousTranscriptPage: async () => {},
		}) as WorkspaceInputContext;
		const renderer = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
			workspaceInputHandler: (data) => handleWorkspaceInput.call(context, data),
		});
		context.renderer = renderer;
		context.ui = renderer;
		renderer.addChild(workspace);

		renderer.start();
		try {
			await terminal.waitForRender();
			expect(terminal.getViewport()[0]).toContain("header");
			expect(terminal.getViewport()[1]).toContain("line-24");

			terminal.sendInput("\x1b[<64;10;4M");
			await terminal.waitForRender();

			expect(terminal.getViewport()[1]).toContain("line-21");
			expect(workspace.isFollowing()).toBe(false);

			terminal.sendInput("\x15");
			expect(workspace.render(terminal.columns)[1]).toContain("line-18");

			terminal.sendInput("\x1b[5~");
			expect(workspace.render(terminal.columns)[1]).toContain("line-14");

			terminal.sendInput("\x04");
			expect(workspace.render(terminal.columns)[1]).toContain("line-17");

			terminal.sendInput("\x1b[6~");
			expect(workspace.render(terminal.columns)[1]).toContain("line-21");

			terminal.sendInput("\x1b[H");
			expect(workspace.render(terminal.columns)[1]).toContain("line-0");

			terminal.sendInput("\x1b[F");
			expect(workspace.render(terminal.columns)[1]).toContain("line-24");
			expect(workspace.isFollowing()).toBe(true);

			terminal.sendInput("\x1b[5;2~");
			expect(workspace.render(terminal.columns)[1]).toContain("line-20");

			terminal.sendInput("\x1b[1;5F");
			expect(workspace.render(terminal.columns)[1]).toContain("line-24");
		} finally {
			renderer.stop();
		}
	});

	it("does not grow completed card dividers after arrow keys or text input", async () => {
		initTheme("dark");
		const terminal = new RecordingTerminal(80, 24);
		const chat = new Container();
		chat.addChild(
			new TurnSummaryComponent({
				startedAt: 0,
				endedAt: 1000,
				outcome: "completed",
				totalTools: 1,
				successfulTools: 1,
				failedTools: 0,
				cancelledTools: 0,
				commandCount: 1,
				successfulCommands: 1,
				files: [],
				tools: [],
				retried: false,
				compacted: false,
				cancelled: false,
			}),
		);
		const input = new InputSink();
		const inputContainer = new Container();
		inputContainer.addChild(input);
		const header = new Container();
		header.addChild(new Text("header", 0, 0));
		const workspace = new LystarWorkspace({
			getHeight: () => terminal.rows,
			header,
			scrollContainers: [chat],
			bottomContainers: [inputContainer],
			fixedBottomContainers: [],
			fullscreen: true,
			scrollbar: "hidden",
		});
		const renderer = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		renderer.addChild(workspace);
		renderer.setFocus(input);
		renderer.start();

		try {
			await terminal.waitForRender();
			const baseline = [...chat.render(80)];
			const inputs = ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "x"];
			for (const data of inputs) {
				terminal.sendInput(data);
				await terminal.waitForRender();
				expect([...chat.render(80)]).toEqual(baseline);
			}
			expect(input.inputs).toEqual(inputs);
		} finally {
			renderer.stop();
		}
	});

	it("expands web search cards independently without intercepting source links", async () => {
		initTheme("dark");
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(80, 14);
		const openedUrls: string[] = [];
		const url = "https://example.com/source";
		const secondUrl = "https://second.example/source";
		const message = {
			role: "assistant",
			content: [
				{
					type: "webSearchCall",
					id: "ws_1",
					status: "completed",
					action: { type: "search", query: "example", sources: [{ type: "url", url }] },
				},
				{
					type: "webSearchCall",
					id: "ws_2",
					status: "completed",
					action: { type: "search", query: "second", sources: [{ type: "url", url: secondUrl }] },
				},
			],
			timestamp: Date.now(),
		} as AssistantMessage;
		const chat = new Container();
		chat.addChild(new AssistantMessageComponent(message));
		const header = new Container();
		header.addChild(new Text("header", 0, 0));
		const workspace = new LystarWorkspace({
			getHeight: () => terminal.rows,
			header,
			scrollContainers: [chat],
			bottomContainers: [new Text("editor", 0, 0)],
			fixedBottomContainers: [],
			fullscreen: true,
			scrollbar: "hidden",
		});
		type WorkspaceInputContext = {
			workspace: LystarWorkspace;
			renderer: LystarTUI;
			ui: TUI;
			keybindings: KeybindingsManager;
			loadPreviousTranscriptPage: () => Promise<void>;
			componentExpansion: WeakMap<Component, boolean>;
			toolOutputExpanded: boolean;
			openSubagentSession: () => void;
			rememberCardExpansion: () => void;
		};
		const handleWorkspaceInput = (
			InteractiveMode.prototype as unknown as {
				handleWorkspaceInput(this: WorkspaceInputContext, data: string): { consume: true } | undefined;
			}
		).handleWorkspaceInput;
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			workspace,
			renderer: undefined as unknown as LystarTUI,
			ui: undefined as unknown as TUI,
			keybindings: new KeybindingsManager(),
			loadPreviousTranscriptPage: async () => {},
			componentExpansion: new WeakMap<Component, boolean>(),
			toolOutputExpanded: false,
			openSubagentSession: () => {},
			rememberCardExpansion: () => {},
		}) as WorkspaceInputContext;
		const renderer = new LystarTUI(terminal, false, undefined, {
			openUrl: (value) => openedUrls.push(value),
			workspaceInputHandler: (data) => handleWorkspaceInput.call(context, data),
		});
		context.renderer = renderer;
		context.ui = renderer;
		renderer.addChild(workspace);

		renderer.start();
		try {
			await terminal.waitForRender();
			const summaryRow = terminal.getViewport().findIndex((line) => line.includes("已搜索网页"));
			expect(summaryRow).toBeGreaterThanOrEqual(0);
			terminal.sendInput(`\x1b[<0;3;${summaryRow + 1}M`);
			terminal.sendInput(`\x1b[<0;3;${summaryRow + 1}m`);
			await terminal.waitForRender();
			expect(terminal.getViewport().some((line) => line.includes("example.com"))).toBe(true);
			expect(terminal.getViewport().some((line) => line.includes("second.example"))).toBe(false);

			const summaryRows = terminal
				.getViewport()
				.map((line, index) => (line.includes("已搜索网页") ? index : -1))
				.filter((index) => index >= 0);
			const secondSummaryRow = summaryRows.at(-1)!;
			terminal.sendInput(`\x1b[<0;3;${secondSummaryRow + 1}M`);
			terminal.sendInput(`\x1b[<0;3;${secondSummaryRow + 1}m`);
			await terminal.waitForRender();
			expect(terminal.getViewport().some((line) => line.includes("example.com"))).toBe(true);
			expect(terminal.getViewport().some((line) => line.includes("second.example"))).toBe(true);

			const sourceRow = terminal.getViewport().findIndex((line) => line.includes("example.com"));
			const sourceColumn = terminal.getViewport()[sourceRow]?.indexOf("example.com") ?? -1;
			expect(sourceRow).toBeGreaterThanOrEqual(0);
			expect(sourceColumn).toBeGreaterThanOrEqual(0);
			terminal.sendInput(`\x1b[<0;${sourceColumn + 1};${sourceRow + 1}M`);
			terminal.sendInput(`\x1b[<0;${sourceColumn + 1};${sourceRow + 1}m`);
			await terminal.waitForRender();
			expect(openedUrls).toEqual([url]);
		} finally {
			renderer.stop();
			resetCapabilitiesCache();
		}
	});

	it("routes viewport input to the focused overlay before the workspace", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const workspaceInputHandler = vi.fn(() => ({ consume: true as const }));
		const received: string[] = [];
		const overlay: Component & { focused: boolean } = {
			focused: false,
			render: () => ["overlay"],
			invalidate: () => {},
			handleInput: (data) => received.push(data),
		};
		const renderer = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
			workspaceInputHandler,
		});

		renderer.start();
		const handle = renderer.showOverlay(overlay, { row: 1, col: 1, width: 20, maxHeight: 4 });
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[5~");
			terminal.sendInput("\x1b[<64;10;4M");

			expect(received).toEqual(["\x1b[5~", "\x1b[<64;10;4M"]);
			expect(workspaceInputHandler).not.toHaveBeenCalled();
		} finally {
			handle.hide();
			renderer.stop();
		}
	});

	it("replaces the renderer while preserving components and focus", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const renderer = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		let stableUi: TUI;
		const invalidatedModes: TuiMode[] = [];
		const component: Component & { focused: boolean } = {
			focused: false,
			render: () => ["content"],
			invalidate: () => invalidatedModes.push(stableUi.mode),
		};
		renderer.addChild(component);
		renderer.setFocus(component);

		type SwitchContext = {
			renderer: ReturnType<typeof createInteractiveTui>;
			ui: TUI;
			composer: { setFullscreen: (fullscreen: boolean) => void };
			workspace: { setFullscreen: (fullscreen: boolean) => void };
			runtimeHost: { session: { settingsManager: { getEditorPaddingX: () => number } } };
			defaultEditor: { setPaddingX: (padding: number) => void };
			editor: { setPaddingX: (padding: number) => void };
			options: { tuiMode?: TuiMode };
			themeController: { rebindTui: () => void };
			handleWorkspaceInput: (data: string) => { consume: true } | undefined;
			extensionTerminalInputSubscriptions: Set<never>;
		};
		const editor = { setPaddingX: vi.fn() };
		const handleWorkspaceInput = vi.fn(() => ({ consume: true as const }));
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			renderer,
			ui: undefined as unknown as TUI,
			composer: { setFullscreen: vi.fn() },
			workspace: { setFullscreen: vi.fn() },
			runtimeHost: { session: { settingsManager: { getEditorPaddingX: () => 1 } } },
			defaultEditor: editor,
			editor,
			options: { tuiMode: "regular" as TuiMode },
			themeController: { rebindTui: () => {} },
			handleWorkspaceInput,
			extensionTerminalInputSubscriptions: new Set<never>(),
		}) as SwitchContext;
		stableUi = createInteractiveTuiReference(() => context.renderer);
		context.ui = stableUi;
		const { stopInteractiveTui, switchTuiMode } = InteractiveMode.prototype as unknown as {
			stopInteractiveTui(this: SwitchContext): void;
			switchTuiMode(this: SwitchContext, mode: TuiMode, restoreProgress?: boolean): boolean;
		};

		renderer.start();
		await terminal.waitForRender();
		expect(switchTuiMode.call(context, "fullscreen", false)).toBe(true);
		await terminal.waitForRender();

		expect(stableUi.mode).toBe("fullscreen");
		expect(context.renderer.children).toEqual([component]);
		expect(context.renderer.getFocusedComponent()).toBe(component);
		expect(component.focused).toBe(true);
		expect(invalidatedModes).toEqual(["fullscreen"]);
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 1]);

		terminal.sendInput("\x1b[<64;10;4M");
		expect(handleWorkspaceInput).toHaveBeenCalledWith("\x1b[<64;10;4M");

		stopInteractiveTui.call(context);

		expect(stableUi.mode).toBe("fullscreen");
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 2]);
	});
});

describe("InteractiveMode right-click paste", () => {
	it("feeds clipboard text to the focused component as a bracketed paste", async () => {
		clipboardMocks.readClipboardText.mockResolvedValue("clipboard text");
		const handleInput = vi.fn<(data: string) => void>();
		const target = { render: () => [], invalidate: () => {}, handleInput } satisfies Component;
		const requestRender = vi.fn();
		const context = {
			renderer: { getFocusedComponent: () => target },
			ui: { requestRender },
		};
		const prototype = InteractiveMode.prototype as unknown as {
			handleRightClickPaste(this: typeof context): Promise<void>;
		};

		await prototype.handleRightClickPaste.call(context);

		expect(handleInput).toHaveBeenCalledWith("\x1b[200~clipboard text\x1b[201~");
		expect(requestRender).toHaveBeenCalledOnce();
	});
});

type CopyCommandContext = {
	session: { getLastAssistantText: () => string | undefined };
	ui: ReturnType<typeof createInteractiveTui>;
	renderer: ReturnType<typeof createInteractiveTui>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

type CopyCommandOptions = { flashConfirmation?: boolean };

type CopyCommandPrototype = {
	handleCopyCommand(this: CopyCommandContext, options?: CopyCommandOptions): Promise<void>;
};

const copyCommandPrototype = InteractiveMode.prototype as unknown as CopyCommandPrototype;

describe("InteractiveMode copy confirmation", () => {
	beforeEach(() => {
		clipboardMocks.copyToClipboard.mockReset();
		clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
	});

	it("flashes Copied! for the copy shortcut in fullscreen mode", async () => {
		const terminal = new RecordingTerminal(40, 4);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui,
			renderer: ui,
			showStatus,
			showError,
		};

		ui.start();
		try {
			await terminal.waitForRender();
			await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true });
			await terminal.waitForRender();

			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
			expect(showStatus).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
			expect(terminal.getViewport().some((line) => line.includes("已复制"))).toBe(true);
		} finally {
			ui.stop();
		}
	});

	it("keeps the status-line confirmation for the copy shortcut in regular mode", async () => {
		const ui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui,
			renderer: ui,
			showStatus,
			showError,
		};

		await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true });

		expect(showStatus).toHaveBeenCalledWith("最近一条 Agent 消息已复制到剪贴板");
		expect(showError).not.toHaveBeenCalled();
	});
});

type ClearStatusContext = {
	activeStatusIndicator: { kind: "working"; dispose: () => void } | undefined;
	statusContainer: Container;
	options: { tuiMode?: TuiMode };
	ui: { getClearOnShrink: () => boolean };
	idleStatus: Component;
};

type InteractiveModePrototype = {
	clearStatusIndicator(this: ClearStatusContext, kind?: "working"): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("clear-on-shrink status spacing", () => {
	it("reserves status height only on the main-screen renderer", () => {
		for (const [tuiMode, expectedChildren] of [
			["regular", 1],
			["fullscreen", 0],
		] as const) {
			const dispose = vi.fn();
			const context: ClearStatusContext = {
				activeStatusIndicator: { kind: "working", dispose },
				statusContainer: new Container(),
				options: { tuiMode },
				ui: { getClearOnShrink: () => true },
				idleStatus: new Text("", 0, 0),
			};

			interactiveModePrototype.clearStatusIndicator.call(context);

			expect(dispose).toHaveBeenCalledOnce();
			expect(context.statusContainer.children).toHaveLength(expectedChildren);
		}
	});
});
