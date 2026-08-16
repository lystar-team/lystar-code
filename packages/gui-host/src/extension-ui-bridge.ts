import { randomUUID } from "node:crypto";
import type { ExtensionUiState, JsonValue } from "@lystar/code-gui-protocol";
import type { UiRequestHandler } from "./types.ts";

interface WorkingIndicatorOptions {
	frames?: string[];
	intervalMs?: number;
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
		content: string[] | ((...args: never[]) => unknown) | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	setFooter(factory: unknown): void;
	setHeader(factory: unknown): void;
	setTitle(title: string): void;
	custom(...args: unknown[]): Promise<never>;
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

type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

type ExtensionUiDelta = Omit<Partial<ExtensionUiState>, "revision"> & { revision: number };

export type ExtensionUiBridgeEvent =
	| { type: "snapshot"; state: ExtensionUiState }
	| { type: "delta"; delta: ExtensionUiDelta }
	| { type: "editor_action"; action: { action: "paste" | "set"; text: string; revision: number } };

function bounded(value: string, limit = 4096): string {
	return value.length <= limit ? value : value.slice(0, limit);
}

function boundedEditor(value: string): string {
	return value.length <= MAX_EDITOR_BYTES ? value : value.slice(0, MAX_EDITOR_BYTES);
}

/**
 * Rust TUI 的 ExtensionUIContext 适配层。只投影 Tier0/1 文本状态，不接收 TUI Component。
 */
export class ExtensionUiBridge {
	private readonly onUiRequest: UiRequestHandler;
	private readonly publish: (event: ExtensionUiBridgeEvent) => void;
	private readonly reportError: (error: { event: string; error: string; stack?: string }) => void;
	private readonly statuses = new Map<string, string>();
	private readonly widgets = new Map<string, { placement: "above" | "below"; lines: string[] }>();
	private readonly terminalInputHandlers = new Set<TerminalInputHandler>();
	private revision = 0;
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
		const tier3 = (method: string) => {
			void request("notify", "Tier3 bridge pending", { method, message: "Tier3 bridge pending" });
		};
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
				const result = await request("confirm", title, { message: bounded(message) }, opts?.timeout);
				return result.cancelled ? false : result.confirmed === true;
			},
			input: async (title, placeholder, opts) => {
				if (opts?.signal?.aborted) return undefined;
				const result = await request("input", title, { placeholder: bounded(placeholder ?? "") }, opts?.timeout);
				return result.cancelled ? undefined : typeof result.value === "string" ? result.value : undefined;
			},
			notify: (message, type = "info") => {
				void request("notify", bounded(message), { method: "notify", type });
			},
			onTerminalInput: (handler) => this.addTerminalInputHandler(handler),
			setStatus: (key, text) => this.setStatus(key, text),
			setWorkingMessage: (message) =>
				this.update({ workingMessage: message === undefined ? null : bounded(message) }),
			setWorkingVisible: (visible) => this.update({ workingVisible: visible }),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) =>
				this.update({ hiddenThinkingLabel: label === undefined ? null : bounded(label) }),
			setWidget: (key, content, options) => {
				if (content === undefined) {
					this.widgets.delete(key);
					this.update({ widgets: this.widgetsSnapshot() });
					return;
				}
				if (!Array.isArray(content)) {
					tier3("setWidget(component)");
					return;
				}
				this.widgets.set(bounded(key), {
					placement: options?.placement === "belowEditor" ? "below" : "above",
					lines: content.slice(0, 32).map((line) => bounded(line)),
				});
				this.update({ widgets: this.widgetsSnapshot() });
			},
			setFooter: (factory) => {
				if (factory) tier3("setFooter");
			},
			setHeader: (factory) => {
				if (factory) tier3("setHeader");
			},
			setTitle: (title) => this.update({ title: bounded(title) }),
			custom: async () => {
				tier3("custom");
				return undefined as never;
			},
			pasteToEditor: (text) => this.publishEditorAction("paste", text),
			setEditorText: (text) => this.publishEditorAction("set", text),
			getEditorText: () => this.editorText,
			editor: async (title, prefill) => {
				const result = await request("editor", title, { prefill: boundedEditor(prefill ?? "") });
				return result.cancelled ? undefined : typeof result.value === "string" ? result.value : undefined;
			},
			addAutocompleteProvider: () => tier3("addAutocompleteProvider"),
			setEditorComponent: (factory) => {
				if (factory) tier3("setEditorComponent");
			},
			getEditorComponent: () => undefined,
			get theme() {
				return undefined as never;
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

	updateEditorState(text: string, generation: number): number {
		if (this.disposed || generation < this.editorGeneration) return this.revision;
		this.editorText = boundedEditor(text);
		this.editorGeneration = generation;
		return this.revision;
	}

	async dispatchTerminalInput(data: string): Promise<{ consume: boolean; data?: string }> {
		let next = bounded(data, 256);
		for (const handler of this.terminalInputHandlers) {
			try {
				const result = handler(next);
				if (result?.data !== undefined) next = bounded(result.data, 256);
				if (result?.consume) return { consume: true };
			} catch (error) {
				const candidate = error instanceof Error ? error : new Error(String(error));
				this.reportError({ event: "terminal_input", error: candidate.message, stack: candidate.stack });
			}
		}
		return next === data ? { consume: false } : { consume: false, data: next };
	}

	reset(): void {
		this.statuses.clear();
		this.widgets.clear();
		this.terminalInputHandlers.clear();
		this.workingMessage = null;
		this.workingVisible = true;
		this.workingIndicator = { ...DEFAULT_INDICATOR };
		this.hiddenThinkingLabel = null;
		this.title = null;
		this.editorText = "";
		this.editorGeneration = 0;
		if (!this.disposed) {
			this.revision++;
			this.publish({ type: "snapshot", state: this.snapshot() });
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.reset();
	}

	private addTerminalInputHandler(handler: TerminalInputHandler): () => void {
		if (this.disposed || this.terminalInputHandlers.size >= 128) return () => {};
		this.terminalInputHandlers.add(handler);
		this.update({ terminalInputListenerCount: this.terminalInputHandlers.size });
		return () => {
			if (!this.terminalInputHandlers.delete(handler)) return;
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
		this.revision++;
		this.publish({ type: "delta", delta: { revision: this.revision, ...delta } });
	}
}
