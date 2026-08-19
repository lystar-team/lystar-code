import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { ExtensionUiState, JsonValue } from "@lystar/code-gui-protocol";
import { KeybindingsManager } from "../../coding-agent/src/core/keybindings.ts";
import type { UiRequestHandler } from "./types.ts";

type Component = {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
	dispose?(): void;
	getFinalState?(): number | undefined;
	width?: number;
};
type EditorComponent = Component & {
	setText?(text: string): void;
	getText?(): string;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	borderColor?: unknown;
	setPaddingX?(padding: number): void;
	getPaddingX?(): number;
	setAutocompleteMaxVisible?(maxVisible: number): void;
	getAutocompleteMaxVisible?(): number;
	setAutocompleteProvider?(provider: unknown): void;
	actionHandlers?: Map<string, () => void>;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
};
type TUI = {
	terminal: { columns: number; rows: number; write(data: string): never };
	requestRender(): void;
	setFocus(component: Component | null): void;
	setShowHardwareCursor(enabled: boolean): void;
	showOverlay(): unknown;
};
type OverlayOptions = Record<string, unknown>;
type HeadlessTerminalOwnershipViolation = {
	type: "terminal_ownership_violation";
	componentId: string;
	operation: string;
};
type HeadlessFrame = {
	componentId: string;
	revision: number;
	width: number;
	height: number;
	lines: string[];
	cursor?: { row: number; column: number };
	hitRegions: Array<{ kind: "component"; row: number; column: number; width: number }>;
	desiredSize?: { width?: number; height?: number };
};
type HeadlessComponentAdapter = {
	input(data: string): HeadlessFrame;
	resize(width: number, height: number): HeadlessFrame;
	requestRender(): void;
	render(): HeadlessFrame;
	dispose(): void;
};

interface WorkingIndicatorOptions {
	frames?: string[];
	intervalMs?: number;
}

type ComponentFactory = (tui: TUI, theme: unknown, footerData?: unknown) => Component & { dispose?(): void };
type CustomFactory = (
	tui: TUI,
	theme: unknown,
	keybindings: unknown,
	done: (result: JsonValue) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

type EditorCompletion = {
	prefixStart: number;
	prefixEnd: number;
	items: Array<{ value: string; label: string; description?: string }>;
};
type EditorAutocompleteProvider = {
	triggerCharacters?: string[];
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<{ items: Array<{ value: string; label: string; description?: string }>; prefix: string } | null>;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: { value: string },
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number };
};
type EditorAutocompleteFactory = (current: EditorAutocompleteProvider) => EditorAutocompleteProvider;
type EditorFactory = (tui: TUI, theme: unknown, keybindings: unknown) => EditorComponent;
type EditorBindings = {
	onChange: EditorComponent["onChange"];
	onSubmit: EditorComponent["onSubmit"];
	onEscape: EditorComponent["onEscape"];
	onCtrlD: EditorComponent["onCtrlD"];
	onPasteImage: EditorComponent["onPasteImage"];
	onExtensionShortcut: EditorComponent["onExtensionShortcut"];
	actionHandlers: Map<string, (() => void) | undefined>;
};

type ComponentPlacement = "widget_above" | "widget_below" | "header" | "footer" | "custom_overlay" | "editor";

interface ComponentMount {
	componentId: string;
	generation: number;
	placement: ComponentPlacement;
	adapter: HeadlessComponentAdapter;
	component: Component;
	width: number;
	height: number;
	visible: boolean;
	overlayOptions?: OverlayOptions;
	customResolve?: (value: JsonValue | undefined) => void;
}

interface ExtensionUiContextBridge {
	select(
		title: string,
		options: string[],
		dialogOptions?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
	confirm(title: string, message: string, options?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
	input(
		title: string,
		placeholder?: string,
		options?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	onTerminalInput(handler: TerminalInputHandler): () => void;
	setStatus(key: string, text: string | undefined): void;
	setWorkingMessage(message?: string): void;
	setWorkingVisible(visible: boolean): void;
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;
	setHiddenThinkingLabel(label?: string): void;
	setWidget(
		key: string,
		content: string[] | ComponentFactory | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	setFooter(factory: ComponentFactory | undefined): void;
	setHeader(factory: ComponentFactory | undefined): void;
	setTitle(title: string): void;
	custom(
		factory: CustomFactory,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: unknown) => void;
		},
	): Promise<JsonValue | undefined>;
	pasteToEditor(text: string): void;
	setEditorText(text: string): void;
	getEditorText(): string;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	addAutocompleteProvider(...args: unknown[]): void;
	setEditorComponent(factory: unknown): void;
	getEditorComponent(): unknown;
	theme: unknown;
	getAllThemes(): unknown[];
	getTheme(...args: unknown[]): undefined;
	setTheme(...args: unknown[]): { success: boolean; error: string };
	getToolsExpanded(): boolean;
	setToolsExpanded(expanded: boolean): void;
}

const MAX_EDITOR_BYTES = 4 * 1024 * 1024;
const MAX_EXTENSION_INPUT_BYTES = 64 * 1024;
const HEADLESS_EDITOR_THEME = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
};
const DEFAULT_INDICATOR = { frames: ["-", "\\", "|", "/"], intervalMs: 120 };
const COMPONENT_WIDTH = 500;
const COMPONENT_HEIGHT = 500;
const FRAME_INTERVAL_MS = 1000 / 60;

type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;
type ExtensionUiDelta = Omit<Partial<ExtensionUiState>, "revision"> & { revision: number };

export type ExtensionUiBridgeEvent =
	| { type: "snapshot"; state: ExtensionUiState }
	| { type: "delta"; delta: ExtensionUiDelta }
	| { type: "editor_action"; action: { action: "paste" | "set"; text: string; revision: number } }
	| { type: "editor_submit"; text: string; revision: number }
	| { type: "editor_app_action"; action: string; data?: string; revision: number }
	| {
			type: "component_mount";
			componentId: string;
			generation: number;
			placement: ComponentPlacement;
			visible: boolean;
			overlayOptions?: JsonValue;
			frame: HeadlessFrame;
	  }
	| { type: "component_frame"; componentId: string; generation: number; frame: HeadlessFrame }
	| { type: "component_invalidate"; componentId: string; generation: number; visible: boolean }
	| {
			type: "component_unmount";
			componentId: string;
			generation: number;
			reason: "replace" | "clear" | "dispose" | "error" | "done" | "cancel";
	  };

function sanitizeComponentFrameLine(value: string, limit = 4096): string {
	let output = "";
	let index = 0;
	while (index < value.length && output.length < limit) {
		const character = value[index]!;
		if (character !== "\x1b") {
			if (character >= " " && character !== "\x7f") output += character;
			index++;
			continue;
		}
		const next = value[index + 1];
		if (next === "[") {
			const end = value.slice(index + 2).search(/[@-~]/);
			if (end >= 0) {
				const finish = index + 2 + end;
				const sequence = value.slice(index, finish + 1);
				if (value[finish] === "m" && /^\x1b\[[0-9;?]*m$/.test(sequence)) output += sequence;
				index = finish + 1;
				continue;
			}
		}
		if (next === "]") {
			const bell = value.indexOf("\x07", index + 2);
			const st = value.indexOf("\x1b\\", index + 2);
			const end = bell >= 0 && (st < 0 || bell < st) ? bell : st;
			if (end >= 0) {
				const content = value.slice(index + 2, end);
				if (
					content === "8;;" ||
					/^8;;(?:https:\/\/|http:\/\/|mailto:|file:\/\/)[^\s\x00-\x1f\x7f-\x9f]+$/.test(content)
				) {
					output += `\x1b]${content}\x1b\\`;
				}
				index = end + (end === st ? 2 : 1);
				continue;
			}
		}
		index++;
	}
	return output;
}

function sanitizeTerminalText(value: string, limit = 4096, allow: { newline?: boolean; tab?: boolean } = {}): string {
	let output = "";
	for (const character of value) {
		if (character === "\n" && allow.newline) output += character;
		else if (character === "\t" && allow.tab) output += character;
		else if (!character.match(/[\u0000-\u001f\u007f-\u009f]/)) output += character;
		if (output.length >= limit) break;
	}
	return output;
}

function bounded(value: string, limit = 256): string {
	return sanitizeTerminalText(value, limit);
}

function boundedRawInput(value: string): string {
	if (Buffer.byteLength(value, "utf8") <= MAX_EXTENSION_INPUT_BYTES) return value;
	let output = "";
	for (const character of value) {
		if (Buffer.byteLength(output, "utf8") + Buffer.byteLength(character, "utf8") > MAX_EXTENSION_INPUT_BYTES) break;
		output += character;
	}
	return output;
}

function boundedEditor(value: string): string {
	return sanitizeTerminalText(value, MAX_EDITOR_BYTES, { newline: true, tab: true });
}

function componentInputText(value: string): string {
	const start = "\u001b[200~";
	const end = "\u001b[201~";
	return value.startsWith(start) && value.endsWith(end) ? value.slice(start.length, -end.length) : value;
}

function boundedDimension(value: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.min(COMPONENT_WIDTH, Math.floor(value))) : 1;
}

function createHeadlessTuiFacade(options: {
	componentId: string;
	width: number;
	height: number;
	onRequestRender: () => void;
	onTerminalOwnershipViolation: (violation: HeadlessTerminalOwnershipViolation) => void;
}): TUI {
	const denyTerminalOwnership = (operation: string): never => {
		options.onTerminalOwnershipViolation({
			type: "terminal_ownership_violation",
			componentId: options.componentId,
			operation,
		});
		throw Object.assign(new Error(`Extension component ${options.componentId} cannot own a terminal`), {
			code: "terminal_ownership_violation",
		});
	};
	return {
		terminal: {
			columns: boundedDimension(options.width),
			rows: boundedDimension(options.height),
			write: () => denyTerminalOwnership("write"),
		},
		requestRender: options.onRequestRender,
		setFocus: options.onRequestRender,
		setShowHardwareCursor: options.onRequestRender,
		showOverlay: () => ({ hide: options.onRequestRender, show: options.onRequestRender }),
	};
}

function createHeadlessComponentAdapter(
	component: Component,
	options: {
		componentId: string;
		generation: number;
		width: number;
		height: number;
		onRequestRender: () => void;
	},
): HeadlessComponentAdapter {
	let width = boundedDimension(options.width);
	let height = boundedDimension(options.height);
	let revision = 0;
	let disposed = false;
	const render = (): HeadlessFrame => {
		if (disposed) return { componentId: options.componentId, revision, width, height, lines: [], hitRegions: [] };
		const lines = component
			.render(width)
			.slice(0, Math.min(height, 500))
			.map((line) => sanitizeComponentFrameLine(String(line), 4096));
		return {
			componentId: options.componentId,
			revision: ++revision,
			width,
			height,
			lines,
			hitRegions: lines.map((_, row) => ({ kind: "component", row, column: 0, width })),
		};
	};
	return {
		render,
		requestRender: () => {
			if (!disposed) options.onRequestRender();
		},
		input: (data) => {
			component.handleInput?.(data);
			return render();
		},
		resize: (nextWidth, nextHeight) => {
			width = boundedDimension(nextWidth);
			height = boundedDimension(nextHeight);
			component.width = width;
			return render();
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			component.dispose?.();
		},
	};
}

export interface ExtensionComponentDiagnostics {
	componentId: string;
	generation: number;
	revision: number;
	renderCount: number;
	publishCount: number;
	coalescedCount: number;
	lastFinalState: number | null;
	invalidations: Array<{ invalidateRequestedAt: number; publishedAt?: number; revision?: number }>;
	inputs: Array<{ receivedAt: number; publishedAt: number; revision: number; bytes: number }>;
	editorTextBytes?: number;
	editorTextHash?: string;
}

interface ComponentDiagnosticState extends ExtensionComponentDiagnostics {}

const MAX_COMPONENT_DIAGNOSTIC_SAMPLES = 1_024;
const bunMonotonicOffsetMs = (() => {
	if (!process.versions.bun || process.platform !== "linux") return 0;
	return (
		Number(readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0]) * 1_000 -
		Number(process.hrtime.bigint()) / 1_000_000
	);
})();

function monotonicMilliseconds(): number {
	return bunMonotonicOffsetMs + Number(process.hrtime.bigint()) / 1_000_000;
}

function numericFinalState(component: Component): number | null {
	try {
		const value = component.getFinalState?.();
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

function editorTextObservation(component: Component): { bytes: number; hash: string } | undefined {
	const text = (component as EditorComponent).getText?.();
	if (typeof text !== "string") return undefined;
	return {
		bytes: Buffer.byteLength(text, "utf8"),
		hash: createHash("sha256").update(text).digest("hex"),
	};
}

function componentDiagnostic(mount: ComponentMount): ComponentDiagnosticState {
	const editorText = mount.placement === "editor" ? editorTextObservation(mount.component) : undefined;
	return {
		componentId: mount.componentId,
		generation: mount.generation,
		revision: 0,
		renderCount: 0,
		publishCount: 0,
		coalescedCount: 0,
		lastFinalState: null,
		invalidations: [],
		inputs: [],
		...(editorText ? { editorTextBytes: editorText.bytes, editorTextHash: editorText.hash } : {}),
	};
}

/** Rust TUI ExtensionUIContext bridge. Node only renders Components and never owns a terminal. */
export class ExtensionUiBridge {
	private readonly statuses = new Map<string, string>();
	private readonly widgets = new Map<string, { placement: "above" | "below"; lines: string[] }>();
	private readonly terminalInputHandlers = new Set<TerminalInputHandler>();
	private readonly components = new Map<string, ComponentMount>();
	private readonly widgetComponents = new Map<string, string>();
	private readonly componentDirty = new Map<string, number>();
	private readonly componentFrameAt = new Map<string, number>();
	private readonly componentDiagnostics = new Map<string, ComponentDiagnosticState>();
	private componentFrameTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly onUiRequest: UiRequestHandler;
	private readonly editorKeybindings: KeybindingsManager;
	private readonly getCompletions?: (
		text: string,
		cursor: number,
	) => EditorCompletion | Promise<EditorCompletion | undefined> | undefined;
	private readonly getExtensionShortcutCount?: () => number;
	private readonly dispatchExtensionShortcut?: (data: string) => boolean;
	private readonly autocompleteProviderFactories: EditorAutocompleteFactory[] = [];
	private readonly publish: (event: ExtensionUiBridgeEvent) => void;
	private readonly reportError: (error: { event: string; error: string; stack?: string }) => void;
	private revision = 0;
	private componentGeneration = 0;
	private workingMessage: string | null = null;
	private workingVisible = true;
	private workingIndicator = { ...DEFAULT_INDICATOR };
	private hiddenThinkingLabel: string | null = null;
	private title: string | null = null;
	private editorText = "";
	private editorGeneration = 0;
	private componentInputActive = false;
	private componentInputAppAction?: string;
	private componentInputEditorAction?: { action: "paste" | "set"; text: string; revision: number };
	private editorComponentId: string | undefined;
	private editorFactory: EditorFactory | undefined;
	private readonly editorBindings = new WeakMap<EditorComponent, EditorBindings>();
	private disposed = false;

	constructor(
		onUiRequest: UiRequestHandler,
		publish: (event: ExtensionUiBridgeEvent) => void,
		reportError: (error: { event: string; error: string; stack?: string }) => void,
		getCompletions?: (
			text: string,
			cursor: number,
		) => EditorCompletion | Promise<EditorCompletion | undefined> | undefined,
		agentDir?: string,
		getExtensionShortcutCount?: () => number,
		dispatchExtensionShortcut?: (data: string) => boolean,
	) {
		this.onUiRequest = onUiRequest;
		this.publish = publish;
		this.reportError = reportError;
		this.getCompletions = getCompletions;
		this.getExtensionShortcutCount = getExtensionShortcutCount;
		this.dispatchExtensionShortcut = dispatchExtensionShortcut;
		this.editorKeybindings = KeybindingsManager.create(agentDir);
	}

	context(): ExtensionUiContextBridge {
		const request = async (
			kind: "select" | "confirm" | "input" | "secret" | "editor" | "notify",
			title: string,
			payload: JsonValue,
			timeoutMs?: number,
		) => this.onUiRequest({ id: randomUUID(), kind, title: bounded(title), payload, timeoutMs });
		return {
			select: async (title, options, opts) => {
				if (opts?.signal?.aborted) return undefined;
				const result = await request(
					"select",
					title,
					{ options: options.slice(0, 256).map((option) => bounded(option)) },
					opts?.timeout,
				);
				return result.cancelled ? undefined : typeof result.value === "string" ? result.value : undefined;
			},
			confirm: async (title, message, opts) => {
				if (opts?.signal?.aborted) return false;
				const result = await request(
					"confirm",
					title,
					{ message: sanitizeTerminalText(message, 4096, { newline: true }) },
					opts?.timeout,
				);
				return result.cancelled ? false : result.confirmed === true;
			},
			input: async (title, placeholder, opts) => {
				if (opts?.signal?.aborted) return undefined;
				const result = await request("input", title, { placeholder: bounded(placeholder ?? "") }, opts?.timeout);
				return result.cancelled ? undefined : typeof result.value === "string" ? result.value : undefined;
			},
			notify: (message, type = "info") => void request("notify", bounded(message), { method: "notify", type }),
			onTerminalInput: (handler) => this.addTerminalInputHandler(handler),
			setStatus: (key, text) => this.setStatus(key, text),
			setWorkingMessage: (message) =>
				this.update({ workingMessage: message === undefined ? null : bounded(message) }),
			setWorkingVisible: (visible) => this.update({ workingVisible: visible }),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) =>
				this.update({ hiddenThinkingLabel: label === undefined ? null : bounded(label) }),
			setWidget: (key, content, options) => this.setWidget(key, content, options),
			setFooter: (factory) => this.setSingletonComponent("footer", factory, "footer"),
			setHeader: (factory) => this.setSingletonComponent("header", factory, "header"),
			setTitle: (title) => this.update({ title: bounded(title) }),
			custom: (factory, options) => this.showCustom(factory, options),
			pasteToEditor: (text) => this.publishEditorAction("paste", text),
			setEditorText: (text) => this.publishEditorAction("set", text),
			getEditorText: () => this.editorText,
			editor: async (title, prefill) => {
				const result = await request("editor", title, { prefill: boundedEditor(prefill ?? "") });
				return result.cancelled ? undefined : typeof result.value === "string" ? result.value : undefined;
			},
			addAutocompleteProvider: (...args) => this.addAutocompleteProvider(args[0]),
			setEditorComponent: (factory) => this.setEditorComponent(factory),
			getEditorComponent: () => this.editorFactory,
			get theme() {
				return {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
					dim: (text: string) => text,
				};
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "主题切换由宿主管理" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	snapshot(): ExtensionUiState {
		return {
			revision: this.revision,
			statuses: [...this.statuses.entries()].map(([key, text]) => ({ key, text })),
			widgets: this.widgetsSnapshot(),
			workingMessage: this.workingMessage,
			workingVisible: this.workingVisible,
			workingIndicator: { ...this.workingIndicator },
			hiddenThinkingLabel: this.hiddenThinkingLabel,
			title: this.title,
			terminalInputListenerCount: this.terminalInputHandlers.size,
			extensionShortcutCount: Math.min(128, Math.max(0, this.getExtensionShortcutCount?.() ?? 0)),
		};
	}

	publishSnapshot(): void {
		if (!this.disposed) this.publish({ type: "snapshot", state: this.snapshot() });
	}

	getComponentDiagnostics(): { components: ExtensionComponentDiagnostics[] } {
		return {
			components: [...this.componentDiagnostics.values()].map((diagnostic) => ({
				...diagnostic,
				invalidations: diagnostic.invalidations.map((invalidation) => ({ ...invalidation })),
				inputs: diagnostic.inputs.map((input) => ({ ...input })),
			})),
		};
	}

	publishComponentSnapshot(): void {
		for (const mount of this.components.values()) {
			const frame = mount.adapter.render();
			this.recordComponentFrame(mount, frame);
			this.publish({
				type: "component_mount",
				componentId: mount.componentId,
				generation: mount.generation,
				placement: mount.placement,
				visible: mount.visible,
				...(mount.overlayOptions ? { overlayOptions: mount.overlayOptions as unknown as JsonValue } : {}),
				frame,
			});
		}
	}

	updateEditorState(text: string, generation: number): number {
		if (this.disposed || generation < this.editorGeneration) return this.revision;
		this.editorText = boundedEditor(text);
		this.editorGeneration = generation;
		const editor = this.editorComponentId
			? (this.components.get(this.editorComponentId)?.component as EditorComponent | undefined)
			: undefined;
		if (editor?.getText?.() !== this.editorText) editor?.setText?.(this.editorText);
		return this.revision;
	}

	async dispatchTerminalInput(data: string): Promise<{ consume: boolean; data?: string }> {
		let next = boundedRawInput(data);
		for (const handler of this.terminalInputHandlers) {
			try {
				const result = handler(next);
				if (result?.data !== undefined) next = boundedRawInput(result.data);
				if (result?.consume) return { consume: true };
			} catch (error) {
				this.reportException("terminal_input", error);
			}
		}
		return next === data ? { consume: false } : { consume: false, data: next };
	}

	dispatchComponentInput(
		componentId: string,
		generation: number,
		data: string,
	):
		| {
				appAction?: string;
				editorAction?: { action: "paste" | "set"; text: string; revision: number };
		  }
		| undefined {
		const mount = this.components.get(componentId);
		if (!mount || mount.generation !== generation || !mount.visible) return undefined;
		this.componentInputActive = mount.placement === "editor";
		this.componentInputAppAction = undefined;
		this.componentInputEditorAction = undefined;
		const receivedAt = monotonicMilliseconds();
		const input = boundedRawInput(data);
		const componentInput = componentInputText(input);
		try {
			const frame = mount.adapter.input(componentInput);
			if (mount.placement === "editor") {
				const text = this.observeEditorText(mount);
				if (text !== undefined && text !== this.editorText) {
					this.editorText = text;
					this.publishEditorAction("set", text);
				}
			}
			const publishedAt = this.publishComponentFrame(mount, frame);
			this.recordComponentInput(mount, receivedAt, publishedAt, frame.revision, Buffer.byteLength(input, "utf8"));
			const appAction = this.componentInputAppAction;
			const editorAction = this.componentInputEditorAction;
			return {
				...(appAction ? { appAction } : {}),
				...(editorAction ? { editorAction } : {}),
			};
		} catch (error) {
			this.unmount(componentId, "error");
			this.reportException("component_input", error);
			return undefined;
		} finally {
			this.componentInputActive = false;
			this.componentInputAppAction = undefined;
			this.componentInputEditorAction = undefined;
		}
	}

	resizeComponents(width: number, height: number): void {
		width = boundedDimension(width);
		height = boundedDimension(Math.min(height, COMPONENT_HEIGHT));
		for (const mount of this.components.values()) {
			if (mount.width === width && mount.height === height) continue;
			mount.width = width;
			mount.height = height;
			try {
				const frame = mount.adapter.resize(width, height);
				this.publishComponentFrame(mount, frame);
			} catch (error) {
				this.unmount(mount.componentId, "error");
				this.reportException("component_resize", error);
			}
		}
	}

	disposeComponent(componentId: string, generation: number): boolean {
		const mount = this.components.get(componentId);
		if (!mount || mount.generation !== generation) return false;
		this.unmount(componentId, "dispose");
		return true;
	}

	completeCustom(componentId: string, generation: number, result: JsonValue | undefined, cancelled: boolean): boolean {
		const mount = this.components.get(componentId);
		if (!mount || mount.generation !== generation || !mount.customResolve) return false;
		const resolve = mount.customResolve;
		this.unmount(componentId, cancelled ? "cancel" : "done");
		resolve(cancelled ? undefined : result);
		return true;
	}

	reset(): void {
		if (this.disposed) return;
		for (const componentId of [...this.components.keys()]) this.unmount(componentId, "clear");
		this.editorComponentId = undefined;
		this.editorFactory = undefined;
		this.statuses.clear();
		this.widgets.clear();
		this.widgetComponents.clear();
		this.terminalInputHandlers.clear();
		this.workingMessage = null;
		this.workingVisible = true;
		this.workingIndicator = { ...DEFAULT_INDICATOR };
		this.hiddenThinkingLabel = null;
		this.title = null;
		this.editorText = "";
		this.editorGeneration = 0;
		this.revision++;
		this.publish({ type: "snapshot", state: this.snapshot() });
	}

	dispose(): void {
		if (this.disposed) return;
		this.reset();
		this.disposed = true;
	}

	private setEditorComponent(factory: unknown): void {
		const previousId = this.editorComponentId;
		if (previousId) {
			const previous = this.components.get(previousId)?.component as EditorComponent | undefined;
			const text = previous?.getText?.();
			if (typeof text === "string") this.editorText = boundedEditor(text);
			this.unmount(previousId, "replace");
			this.editorComponentId = undefined;
		}
		this.editorFactory = typeof factory === "function" ? (factory as EditorFactory) : undefined;
		if (!this.editorFactory || this.disposed) {
			if (!this.disposed) this.publishEditorAction("set", this.editorText);
			return;
		}
		const componentId = "editor";
		const generation = ++this.componentGeneration;
		let adapter: HeadlessComponentAdapter | undefined;
		const facade = createHeadlessTuiFacade({
			componentId,
			width: 80,
			height: 24,
			onRequestRender: () => adapter?.requestRender(),
			onTerminalOwnershipViolation: (violation) => this.reportTerminalViolation(violation),
		});
		try {
			const editor = this.editorFactory(facade, HEADLESS_EDITOR_THEME, this.editorKeybindings);
			const bindings: EditorBindings = {
				onChange: editor.onChange,
				onSubmit: editor.onSubmit,
				onEscape: editor.onEscape,
				onCtrlD: editor.onCtrlD,
				onPasteImage: editor.onPasteImage,
				onExtensionShortcut: editor.onExtensionShortcut,
				actionHandlers: new Map(),
			};
			this.editorBindings.set(editor, bindings);
			const isCurrent = () => this.isCurrentEditor(editor, generation);
			const onChange = bindings.onChange;
			editor.onChange = (text) => {
				if (!isCurrent()) return;
				onChange?.(text);
				if (!isCurrent()) return;
				this.editorText = boundedEditor(text);
				const mount = this.components.get("editor");
				if (mount?.component === editor) this.observeEditorText(mount);
				this.publishEditorAction("set", this.editorText);
			};
			const onSubmit = bindings.onSubmit;
			editor.onSubmit = (text) => {
				if (!isCurrent()) return;
				onSubmit?.(text);
				if (!isCurrent()) return;
				this.editorText = "";
				this.revision++;
				this.publish({ type: "editor_submit", text: boundedEditor(text), revision: this.revision });
			};
			const onEscape = bindings.onEscape;
			editor.onEscape = () => {
				if (!isCurrent()) return;
				onEscape?.();
				if (isCurrent()) this.publishEditorAppAction("app.interrupt");
			};
			const onCtrlD = bindings.onCtrlD;
			editor.onCtrlD = () => {
				if (!isCurrent()) return;
				onCtrlD?.();
				if (isCurrent()) this.publishEditorAppAction("app.exit");
			};
			const onPasteImage = bindings.onPasteImage;
			editor.onPasteImage = () => {
				if (!isCurrent()) return;
				onPasteImage?.();
				if (isCurrent()) this.publishEditorAppAction("app.clipboard.pasteImage");
			};
			const onExtensionShortcut = bindings.onExtensionShortcut;
			editor.onExtensionShortcut = (data) => {
				if (!isCurrent()) return false;
				if (this.dispatchExtensionShortcut?.(data)) return true;
				return onExtensionShortcut?.(data) ?? false;
			};
			editor.setText?.(this.editorText);
			if (editor.setPaddingX) editor.setPaddingX(1);
			if (editor.setAutocompleteProvider) editor.setAutocompleteProvider(this.editorAutocompleteProvider());
			if (editor.actionHandlers instanceof Map) {
				for (const action of [
					"app.clear",
					"app.suspend",
					"app.thinking.cycle",
					"app.model.cycleForward",
					"app.model.cycleBackward",
					"app.model.select",
					"app.tools.expand",
					"app.thinking.toggle",
					"app.editor.external",
					"app.message.copy",
					"app.message.followUp",
					"app.message.dequeue",
					"app.session.new",
					"app.session.tree",
					"app.session.fork",
					"app.session.resume",
				]) {
					const original = editor.actionHandlers.get(action);
					bindings.actionHandlers.set(action, original);
					editor.actionHandlers.set(action, () => {
						if (!isCurrent()) return;
						if (action === "app.clear") {
							editor.setText?.("");
							this.editorText = "";
							this.publishEditorAction("set", "");
						}
						this.publishEditorAppAction(action);
					});
				}
			}
			adapter = createHeadlessComponentAdapter(editor, {
				componentId,
				generation,
				width: 80,
				height: 24,
				onRequestRender: () => this.scheduleComponentFrame(componentId, generation),
			});
			const mount: ComponentMount = {
				componentId,
				generation,
				placement: "editor",
				adapter,
				component: editor,
				width: 80,
				height: 24,
				visible: true,
			};
			this.components.set(componentId, mount);
			this.componentDiagnostics.set(componentId, componentDiagnostic(mount));
			this.observeEditorText(mount);
			this.editorComponentId = componentId;
			const frame = adapter.render();
			this.recordComponentFrame(mount, frame);
			this.publish({ type: "component_mount", componentId, generation, placement: "editor", visible: true, frame });
		} catch (error) {
			this.editorFactory = undefined;
			this.reportException("editor_factory", error);
			this.publishEditorAction("set", this.editorText);
		}
	}

	private observeEditorText(mount: ComponentMount): string | undefined {
		const observation = editorTextObservation(mount.component);
		if (!observation) return undefined;
		const diagnostic = this.componentDiagnostics.get(mount.componentId);
		if (diagnostic?.generation === mount.generation) {
			diagnostic.editorTextBytes = observation.bytes;
			diagnostic.editorTextHash = observation.hash;
		}
		return boundedEditor((mount.component as EditorComponent).getText?.() ?? "");
	}

	private isCurrentEditor(editor: EditorComponent, generation: number): boolean {
		return (
			!this.disposed &&
			this.editorComponentId === "editor" &&
			this.components.get("editor")?.component === editor &&
			this.components.get("editor")?.generation === generation
		);
	}

	private detachEditorBindings(editor: EditorComponent): void {
		const bindings = this.editorBindings.get(editor);
		if (!bindings) return;
		editor.onChange = bindings.onChange;
		editor.onSubmit = bindings.onSubmit;
		editor.onEscape = bindings.onEscape;
		editor.onCtrlD = bindings.onCtrlD;
		editor.onPasteImage = bindings.onPasteImage;
		editor.onExtensionShortcut = bindings.onExtensionShortcut;
		if (editor.actionHandlers instanceof Map) {
			for (const [action, original] of bindings.actionHandlers) {
				if (original) editor.actionHandlers.set(action, original);
				else editor.actionHandlers.delete(action);
			}
		}
		this.editorBindings.delete(editor);
	}

	private addAutocompleteProvider(factory: unknown): void {
		if (typeof factory !== "function") return;
		this.autocompleteProviderFactories.push(factory as EditorAutocompleteFactory);
		const editor = this.editorComponentId
			? (this.components.get(this.editorComponentId)?.component as EditorComponent | undefined)
			: undefined;
		editor?.setAutocompleteProvider?.(this.editorAutocompleteProvider());
	}

	private editorAutocompleteProvider(): EditorAutocompleteProvider {
		const base: EditorAutocompleteProvider = {
			triggerCharacters: ["@", "$", "/"],
			getSuggestions: async (lines, cursorLine, cursorCol, options) => {
				if (options.signal.aborted || !this.getCompletions) return null;
				const prefixLines = lines.slice(0, cursorLine);
				const text = [...prefixLines, lines[cursorLine] ?? "", ...lines.slice(cursorLine + 1)].join("\n");
				const cursor = prefixLines.reduce((length, line) => length + line.length + 1, 0) + cursorCol;
				const result = await this.getCompletions(text, cursor);
				if (options.signal.aborted || !result) return null;
				return {
					items: result.items,
					prefix: text.slice(result.prefixStart, result.prefixEnd),
				};
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				const current = lines[cursorLine] ?? "";
				const start = Math.max(0, cursorCol - prefix.length);
				const next = [...lines];
				next[cursorLine] = `${current.slice(0, start)}${item.value}${current.slice(cursorCol)}`;
				return { lines: next, cursorLine, cursorCol: start + item.value.length };
			},
		};
		return this.autocompleteProviderFactories.reduce((provider, factory) => factory(provider), base);
	}

	private publishEditorAppAction(action: string, data?: string): void {
		if (this.disposed) return;
		if (this.componentInputActive) {
			this.componentInputAppAction = action;
			return;
		}
		this.revision++;
		this.publish({
			type: "editor_app_action",
			action: bounded(action, 128),
			...(data ? { data: boundedRawInput(data) } : {}),
			revision: this.revision,
		});
	}

	private setWidget(
		key: string,
		content: string[] | ComponentFactory | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void {
		const normalizedKey = bounded(key);
		const existing = this.widgetComponents.get(normalizedKey);
		if (existing) this.unmount(existing, "replace");
		this.widgetComponents.delete(normalizedKey);
		if (content === undefined) {
			this.widgets.delete(normalizedKey);
			this.update({ widgets: this.widgetsSnapshot() });
			return;
		}
		if (Array.isArray(content)) {
			this.widgets.set(normalizedKey, {
				placement: options?.placement === "belowEditor" ? "below" : "above",
				lines: content.slice(0, 32).map((line) => bounded(line)),
			});
			this.update({ widgets: this.widgetsSnapshot() });
			return;
		}
		this.widgets.delete(normalizedKey);
		this.update({ widgets: this.widgetsSnapshot() });
		const placement: ComponentPlacement = options?.placement === "belowEditor" ? "widget_below" : "widget_above";
		const componentId = this.mountFactory(placement, content, undefined, (id) =>
			this.widgetComponents.set(normalizedKey, id),
		);
		if (!componentId) this.widgetComponents.delete(normalizedKey);
	}

	private setSingletonComponent(
		componentId: "header" | "footer",
		factory: ComponentFactory | undefined,
		placement: "header" | "footer",
	): void {
		if (this.components.has(componentId)) this.unmount(componentId, "replace");
		if (factory) this.mountFactory(placement, factory, componentId);
	}

	private mountFactory(
		placement: ComponentPlacement,
		factory: ComponentFactory,
		fixedId?: string,
		afterMount?: (id: string) => void,
	): string | undefined {
		if (this.disposed) return undefined;
		const componentId = fixedId ?? `component-${++this.componentGeneration}`;
		const generation = ++this.componentGeneration;
		let adapter: HeadlessComponentAdapter | undefined;
		const facade = createHeadlessTuiFacade({
			componentId,
			width: 80,
			height: 24,
			onRequestRender: () => adapter?.requestRender(),
			onTerminalOwnershipViolation: (violation) => this.reportTerminalViolation(violation),
		});
		try {
			const component = factory(facade, this.context().theme, { getExtensionStatuses: () => this.statuses });
			adapter = createHeadlessComponentAdapter(component, {
				componentId,
				generation,
				width: 80,
				height: 24,
				onRequestRender: () => this.scheduleComponentFrame(componentId, generation),
			});
			const mount: ComponentMount = {
				componentId,
				generation,
				placement,
				adapter,
				component,
				width: 80,
				height: 24,
				visible: true,
			};
			this.components.set(componentId, mount);
			this.componentDiagnostics.set(componentId, componentDiagnostic(mount));
			afterMount?.(componentId);
			const frame = adapter.render();
			this.recordComponentFrame(mount, frame);
			this.publish({
				type: "component_mount",
				componentId,
				generation,
				placement,
				visible: true,
				frame,
			});
			return componentId;
		} catch (error) {
			this.reportException("component_factory", error);
			void this.onUiRequest({
				id: randomUUID(),
				kind: "notify",
				title: "Extension 组件失败",
				payload: { method: "component", message: "组件创建失败，已卸载" },
			});
			return undefined;
		}
	}

	private showCustom(
		factory: CustomFactory,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: unknown) => void;
		},
	): Promise<JsonValue | undefined> {
		return new Promise((resolve) => {
			const componentId = `custom-${++this.componentGeneration}`;
			const generation = ++this.componentGeneration;
			let adapter: HeadlessComponentAdapter | undefined;
			const facade = createHeadlessTuiFacade({
				componentId,
				width: 80,
				height: 24,
				onRequestRender: () => adapter?.requestRender(),
				onTerminalOwnershipViolation: (violation) => this.reportTerminalViolation(violation),
			});
			const done = (result: JsonValue) => this.completeCustom(componentId, generation, result, false);
			const overlayOptions =
				typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
			Promise.resolve(factory(facade, this.context().theme, {}, done))
				.then((component) => {
					if (this.disposed) {
						component.dispose?.();
						resolve(undefined);
						return;
					}
					adapter = createHeadlessComponentAdapter(component, {
						componentId,
						generation,
						width: 80,
						height: 24,
						onRequestRender: () => this.scheduleComponentFrame(componentId, generation),
					});
					const componentOverlayOptions = { ...overlayOptions, overlay: options?.overlay !== false };
					const mount: ComponentMount = {
						componentId,
						generation,
						placement: "custom_overlay",
						adapter,
						component,
						width: 80,
						height: 24,
						visible: true,
						...(Object.keys(componentOverlayOptions).length > 0
							? { overlayOptions: componentOverlayOptions }
							: {}),
						customResolve: resolve,
					};
					this.components.set(componentId, mount);
					this.componentDiagnostics.set(componentId, componentDiagnostic(mount));
					const handle = {
						hide: () => {
							mount.visible = false;
							this.publish({ type: "component_invalidate", componentId, generation, visible: false });
						},
						show: () => {
							mount.visible = true;
							this.publish({ type: "component_invalidate", componentId, generation, visible: true });
							this.publishComponentFrame(mount, adapter!.render());
						},
						setHidden: (hidden: boolean) => (hidden ? handle.hide() : handle.show()),
						isHidden: () => !mount.visible,
						focus: () => {},
						unfocus: () => {},
						isFocused: () => mount.visible,
					};
					try {
						options?.onHandle?.(handle);
					} catch (error) {
						this.reportException("component_handle", error);
					}
					const frame = adapter.render();
					this.recordComponentFrame(mount, frame);
					this.publish({
						type: "component_mount",
						componentId,
						generation,
						placement: mount.placement,
						visible: true,
						...(mount.overlayOptions ? { overlayOptions: mount.overlayOptions as unknown as JsonValue } : {}),
						frame,
					});
				})
				.catch((error) => {
					this.reportException("component_factory", error);
					resolve(undefined);
				});
		});
	}

	private publishComponentFrame(mount: ComponentMount, frame: HeadlessFrame): number {
		const publishedAt = this.recordComponentFrame(mount, frame);
		this.publish({
			type: "component_frame",
			componentId: mount.componentId,
			generation: mount.generation,
			frame,
		});
		return publishedAt;
	}

	private recordComponentFrame(mount: ComponentMount, frame: HeadlessFrame): number {
		this.componentDirty.delete(mount.componentId);
		this.componentFrameAt.set(mount.componentId, performance.now());
		const diagnostic = this.componentDiagnostics.get(mount.componentId);
		const publishedAt = monotonicMilliseconds();
		if (diagnostic?.generation === mount.generation) {
			diagnostic.revision = frame.revision;
			diagnostic.renderCount++;
			diagnostic.publishCount++;
			diagnostic.lastFinalState = numericFinalState(mount.component);
			for (const invalidation of diagnostic.invalidations) {
				if (invalidation.publishedAt === undefined) {
					invalidation.publishedAt = publishedAt;
					invalidation.revision = frame.revision;
				}
			}
		}
		this.rescheduleComponentFrames();
		return publishedAt;
	}

	private recordComponentInput(
		mount: ComponentMount,
		receivedAt: number,
		publishedAt: number,
		revision: number,
		bytes: number,
	): void {
		const diagnostic = this.componentDiagnostics.get(mount.componentId);
		if (diagnostic?.generation !== mount.generation) return;
		diagnostic.inputs.push({ receivedAt, publishedAt, revision, bytes });
		if (diagnostic.inputs.length > MAX_COMPONENT_DIAGNOSTIC_SAMPLES) diagnostic.inputs.shift();
	}

	private scheduleComponentFrame(componentId: string, generation: number): void {
		const mount = this.components.get(componentId);
		if (this.disposed || !mount || mount.generation !== generation || !mount.visible) return;
		const diagnostic = this.componentDiagnostics.get(componentId);
		if (diagnostic?.generation === generation) {
			if (this.componentDirty.get(componentId) === generation) diagnostic.coalescedCount++;
			diagnostic.invalidations.push({ invalidateRequestedAt: monotonicMilliseconds() });
			if (diagnostic.invalidations.length > MAX_COMPONENT_DIAGNOSTIC_SAMPLES) diagnostic.invalidations.shift();
		}
		this.componentDirty.set(componentId, generation);
		this.rescheduleComponentFrames();
	}

	private rescheduleComponentFrames(): void {
		if (this.componentFrameTimer || this.componentDirty.size === 0 || this.disposed) return;
		const now = performance.now();
		let delay = FRAME_INTERVAL_MS;
		for (const componentId of this.componentDirty.keys()) {
			const elapsed = now - (this.componentFrameAt.get(componentId) ?? 0);
			delay = Math.min(delay, Math.max(0, FRAME_INTERVAL_MS - elapsed));
		}
		this.componentFrameTimer = setTimeout(() => this.flushComponentFrames(), delay);
		this.componentFrameTimer.unref?.();
	}

	private flushComponentFrames(): void {
		this.componentFrameTimer = undefined;
		if (this.disposed) return;
		const now = performance.now();
		for (const [componentId, generation] of [...this.componentDirty]) {
			const mount = this.components.get(componentId);
			if (!mount || mount.generation !== generation || !mount.visible) {
				this.componentDirty.delete(componentId);
				continue;
			}
			if (now - (this.componentFrameAt.get(componentId) ?? 0) < FRAME_INTERVAL_MS) continue;
			this.publishComponentFrame(mount, mount.adapter.render());
		}
		this.rescheduleComponentFrames();
	}

	private clearComponentFrame(componentId: string): void {
		this.componentDirty.delete(componentId);
		this.componentFrameAt.delete(componentId);
		if (this.componentDirty.size === 0 && this.componentFrameTimer) {
			clearTimeout(this.componentFrameTimer);
			this.componentFrameTimer = undefined;
		}
	}

	private unmount(
		componentId: string,
		reason: Extract<ExtensionUiBridgeEvent, { type: "component_unmount" }>["reason"],
	): void {
		const mount = this.components.get(componentId);
		if (!mount) return;
		this.components.delete(componentId);
		if (mount.placement === "editor") this.detachEditorBindings(mount.component as EditorComponent);
		this.clearComponentFrame(componentId);
		for (const [key, value] of this.widgetComponents) if (value === componentId) this.widgetComponents.delete(key);
		try {
			mount.adapter.dispose();
		} catch (error) {
			this.reportException("component_dispose", error);
		}
		this.publish({ type: "component_unmount", componentId, generation: mount.generation, reason });
	}

	private addTerminalInputHandler(handler: TerminalInputHandler): () => void {
		if (this.disposed || this.terminalInputHandlers.size >= 128) return () => {};
		this.terminalInputHandlers.add(handler);
		this.update({ terminalInputListenerCount: this.terminalInputHandlers.size });
		return () => {
			if (this.terminalInputHandlers.delete(handler))
				this.update({ terminalInputListenerCount: this.terminalInputHandlers.size });
		};
	}

	private setStatus(key: string, text: string | undefined): void {
		key = bounded(key);
		if (text === undefined) this.statuses.delete(key);
		else this.statuses.set(key, bounded(text));
		this.update({
			statuses: [...this.statuses.entries()].map(([statusKey, value]) => ({ key: statusKey, text: value })),
		});
	}

	private setWorkingIndicator(options?: WorkingIndicatorOptions): void {
		const indicator = {
			frames: (options?.frames ?? DEFAULT_INDICATOR.frames).slice(0, 32).map((frame) => bounded(frame, 256)),
			intervalMs: Math.max(16, Math.min(60_000, options?.intervalMs ?? DEFAULT_INDICATOR.intervalMs)),
		};
		this.workingIndicator = indicator;
		this.update({ workingIndicator: indicator });
	}

	private publishEditorAction(action: "paste" | "set", text: string): void {
		if (this.disposed) return;
		const value = boundedEditor(text);
		this.editorText = action === "paste" ? boundedEditor(`${this.editorText}${value}`) : value;
		this.revision++;
		const editorAction = { action, text: value, revision: this.revision };
		if (this.componentInputActive) this.componentInputEditorAction = editorAction;
		this.publish({ type: "editor_action", action: editorAction });
	}

	private widgetsSnapshot(): ExtensionUiState["widgets"] {
		return [...this.widgets.entries()].map(([key, widget]) => ({ key, ...widget }));
	}

	private update(delta: Omit<ExtensionUiDelta, "revision">): void {
		if (this.disposed || Object.keys(delta).length === 0) return;
		if ("workingMessage" in delta) this.workingMessage = delta.workingMessage ?? null;
		if ("workingVisible" in delta) this.workingVisible = delta.workingVisible ?? true;
		if ("workingIndicator" in delta && delta.workingIndicator) this.workingIndicator = { ...delta.workingIndicator };
		if ("hiddenThinkingLabel" in delta) this.hiddenThinkingLabel = delta.hiddenThinkingLabel ?? null;
		if ("title" in delta) this.title = delta.title ?? null;
		this.revision++;
		this.publish({ type: "delta", delta: { revision: this.revision, ...delta } });
	}

	private reportTerminalViolation(violation: HeadlessTerminalOwnershipViolation): void {
		this.reportError({ event: violation.type, error: violation.operation });
	}

	private reportException(event: string, error: unknown): void {
		const candidate = error instanceof Error ? error : new Error(String(error));
		this.reportError({ event, error: candidate.message, stack: candidate.stack });
	}
}
