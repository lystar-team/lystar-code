import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ExtensionUiState, JsonValue } from "@lystar/code-gui-protocol";
import type { UiRequestHandler } from "./types.ts";

type Component = {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
	dispose?(): void;
	getFinalState?(): number | undefined;
	width?: number;
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

type ComponentPlacement = "widget_above" | "widget_below" | "header" | "footer" | "custom_overlay";

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
	getEditorComponent(): undefined;
	theme: unknown;
	getAllThemes(): unknown[];
	getTheme(...args: unknown[]): undefined;
	setTheme(...args: unknown[]): { success: boolean; error: string };
	getToolsExpanded(): boolean;
	setToolsExpanded(expanded: boolean): void;
}

const MAX_EDITOR_BYTES = 64 * 1024;
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

function bounded(value: string, limit = 4096): string {
	return sanitizeTerminalText(value, limit);
}

function boundedRawInput(value: string): string {
	return value.length <= 256 ? value : value.slice(0, 256);
}

function boundedEditor(value: string): string {
	return sanitizeTerminalText(value, MAX_EDITOR_BYTES, { newline: true, tab: true });
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
}

interface ComponentDiagnosticState extends ExtensionComponentDiagnostics {}

const MAX_COMPONENT_DIAGNOSTIC_INVALIDATIONS = 10_000;

function monotonicMilliseconds(): number {
	return Number(process.hrtime.bigint()) / 1_000_000;
}

function numericFinalState(component: Component): number | null {
	try {
		const value = component.getFinalState?.();
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

function componentDiagnostic(mount: ComponentMount): ComponentDiagnosticState {
	return {
		componentId: mount.componentId,
		generation: mount.generation,
		revision: 0,
		renderCount: 0,
		publishCount: 0,
		coalescedCount: 0,
		lastFinalState: null,
		invalidations: [],
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
	private disposed = false;

	constructor(
		onUiRequest: UiRequestHandler,
		publish: (event: ExtensionUiBridgeEvent) => void,
		reportError: (error: { event: string; error: string; stack?: string }) => void,
	) {
		this.onUiRequest = onUiRequest;
		this.publish = publish;
		this.reportError = reportError;
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
			addAutocompleteProvider: () => this.notifyUnsupported("addAutocompleteProvider"),
			setEditorComponent: (factory) => {
				if (factory) this.notifyUnsupported("setEditorComponent");
			},
			getEditorComponent: () => undefined,
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

	dispatchComponentInput(componentId: string, generation: number, data: string): HeadlessFrame | undefined {
		const mount = this.components.get(componentId);
		if (!mount || mount.generation !== generation || !mount.visible) return undefined;
		try {
			const frame = mount.adapter.input(boundedRawInput(data));
			this.publishComponentFrame(mount, frame);
			return frame;
		} catch (error) {
			this.unmount(componentId, "error");
			this.reportException("component_input", error);
			return undefined;
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

	private publishComponentFrame(mount: ComponentMount, frame: HeadlessFrame): void {
		this.recordComponentFrame(mount, frame);
		this.publish({
			type: "component_frame",
			componentId: mount.componentId,
			generation: mount.generation,
			frame,
		});
	}

	private recordComponentFrame(mount: ComponentMount, frame: HeadlessFrame): void {
		this.componentDirty.delete(mount.componentId);
		this.componentFrameAt.set(mount.componentId, performance.now());
		const diagnostic = this.componentDiagnostics.get(mount.componentId);
		if (diagnostic?.generation === mount.generation) {
			const publishedAt = monotonicMilliseconds();
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
	}

	private scheduleComponentFrame(componentId: string, generation: number): void {
		const mount = this.components.get(componentId);
		if (this.disposed || !mount || mount.generation !== generation || !mount.visible) return;
		const diagnostic = this.componentDiagnostics.get(componentId);
		if (diagnostic?.generation === generation) {
			if (this.componentDirty.get(componentId) === generation) diagnostic.coalescedCount++;
			diagnostic.invalidations.push({ invalidateRequestedAt: monotonicMilliseconds() });
			if (diagnostic.invalidations.length > MAX_COMPONENT_DIAGNOSTIC_INVALIDATIONS) diagnostic.invalidations.shift();
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
		this.revision++;
		this.publish({ type: "editor_action", action: { action, text: boundedEditor(text), revision: this.revision } });
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

	private notifyUnsupported(method: string): void {
		void this.onUiRequest({
			id: randomUUID(),
			kind: "notify",
			title: "当前 Rust TUI 未支持该扩展能力",
			payload: { method },
		});
	}

	private reportTerminalViolation(violation: HeadlessTerminalOwnershipViolation): void {
		this.reportError({ event: violation.type, error: violation.operation });
	}

	private reportException(event: string, error: unknown): void {
		const candidate = error instanceof Error ? error : new Error(String(error));
		this.reportError({ event, error: candidate.message, stack: candidate.stack });
	}
}
