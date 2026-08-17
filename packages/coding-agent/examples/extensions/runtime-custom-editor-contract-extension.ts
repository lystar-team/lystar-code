import * as ai from "@earendil-works/pi-ai";
import {
	type AutocompleteProviderFactory,
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

const INITIAL_DRAFT = "预置草稿 中文🙂";
type ControlAction =
	| "replace"
	| "stale"
	| "fail-next"
	| "arm-error"
	| "arm-success"
	| "release"
	| "animate"
	| "interrupt";

type DeferredResponse = {
	kind: "error" | "success";
	release: () => void;
	promise: Promise<void>;
};

type ContractState = {
	active?: ContractEditor;
	stale?: ContractEditor;
	mounts: number;
	disposals: number;
	failNext: boolean;
	completeNext: boolean;
	completionCalls: number;
	deferred?: DeferredResponse;
	animationFrames: number;
};

class ContractEditor extends CustomEditor {
	private readonly hostTui: TUI;
	private readonly onControl: (action: ControlAction) => void;
	private readonly onAnimation: (frame: number) => void;
	private animationTimer: ReturnType<typeof setInterval> | undefined;
	private animationFrame = 0;

	constructor(
		hostTui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		onControl: (action: ControlAction) => void,
		onAnimation: (frame: number) => void,
	) {
		super(hostTui, theme, keybindings);
		this.hostTui = hostTui;
		this.onControl = onControl;
		this.onAnimation = onAnimation;
	}

	handleInput(data: string): void {
		if (data === "\u0019") {
			this.onControl("interrupt");
			return;
		}
		if (data === "\u0007") {
			this.onControl("replace");
			return;
		}
		if (data === "\u0018") {
			this.onControl("stale");
			return;
		}
		if (data === "\u000b") {
			this.onControl("fail-next");
			return;
		}
		if (data === "\u0001") {
			this.onControl("arm-error");
			return;
		}
		if (data === "\u0013") {
			this.onControl("arm-success");
			return;
		}
		if (data === "\u000c") {
			this.onControl("release");
			return;
		}
		if (data === "\u0014") {
			this.onControl("interrupt");
			return;
		}
		super.handleInput(data);
	}

	startAnimation(frames: number): void {
		if (this.animationTimer) clearInterval(this.animationTimer);
		this.animationFrame = 0;
		this.animationTimer = setInterval(() => {
			this.animationFrame++;
			this.onAnimation(this.animationFrame);
			this.hostTui.requestRender();
			if (this.animationFrame >= frames && this.animationTimer) {
				clearInterval(this.animationTimer);
				this.animationTimer = undefined;
			}
		}, 1);
		this.animationTimer.unref?.();
	}

	render(width: number): string[] {
		return [`contract-animation=${this.animationFrame}`, ...super.render(width)];
	}

	dispose(): void {
		if (this.animationTimer) clearInterval(this.animationTimer);
	}
}

export default function customEditorContractExtension(pi: ExtensionAPI): void {
	const faux = ai.fauxProvider({
		api: "lystar-custom-editor-contract-faux-api",
		provider: "lystar-custom-editor-contract-faux",
		models: [{ id: "contract-1", name: "Custom Editor Contract Model", reasoning: true }],
		tokensPerSecond: 100,
	});
	const state: ContractState = {
		mounts: 0,
		disposals: 0,
		failNext: false,
		completeNext: false,
		completionCalls: 0,
		animationFrames: 0,
	};
	faux.setResponses(
		Array.from({ length: 128 }, () => async (_context, options) => {
			const deferred = state.deferred;
			if (deferred) {
				state.deferred = undefined;
				await Promise.race([
					deferred.promise,
					new Promise<void>((resolve) => {
						if (options?.signal?.aborted) {
							resolve();
							return;
						}
						options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					}),
				]);
				if (options?.signal?.aborted) return ai.fauxAssistantMessage("", { stopReason: "aborted" });
				if (deferred.kind === "error") throw new Error("controlled custom editor faux error");
			}
			return ai.fauxAssistantMessage("contract response");
		}),
	);
	pi.registerProvider(faux.provider);

	let context: ExtensionContext | undefined;
	const publish = () => {
		context?.ui.setStatus(
			"custom-editor-contract",
			`mounts=${state.mounts};disposals=${state.disposals};completionCalls=${state.completionCalls};animation=${state.animationFrames};deferred=${state.deferred?.kind ?? "none"}`,
		);
	};
	const armDeferred = (kind: DeferredResponse["kind"]) => {
		let release!: () => void;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		state.deferred = { kind, promise, release };
		publish();
	};
	const autocomplete: AutocompleteProviderFactory = (current) => ({
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@", "/"])],
		getSuggestions: async (lines, cursorLine, cursorCol, options) => {
			state.completionCalls++;
			const text = lines.join("\n");
			if (text.includes("@stale-old")) await new Promise((resolve) => setTimeout(resolve, 75));
			if (options.signal.aborted) return null;
			if (state.completeNext) {
				state.completeNext = false;
				publish();
				return { items: [{ value: "@contract-complete", label: "contract completion" }], prefix: "@" };
			}
			const result = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			publish();
			return result;
		},
		applyCompletion: (...args) => current.applyCompletion(...args),
	});
	const mount = (ctx: ExtensionContext, migrateDraft = true) => {
		context = ctx;
		if (migrateDraft && !state.active) ctx.ui.setEditorText(INITIAL_DRAFT);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			if (state.failNext) {
				state.failNext = false;
				throw new Error("custom editor fixture failure");
			}
			const editor = new ContractEditor(
				tui,
				theme,
				keybindings,
				(action) => {
					if (action === "replace") {
						mount(ctx, false);
					} else if (action === "stale") {
						state.stale?.onChange?.("stale callback draft");
						state.stale?.onSubmit?.("stale callback submit");
						publish();
					} else if (action === "fail-next") {
						state.failNext = true;
						publish();
					} else if (action === "arm-error") {
						armDeferred("error");
					} else if (action === "arm-success") {
						armDeferred("success");
					} else if (action === "release") {
						state.deferred?.release();
						publish();
					} else if (action === "interrupt") {
						editor.onEscape?.();
					} else {
						editor.startAnimation(Number(process.env.LYSTAR_CUSTOM_EDITOR_ANIMATION_INVALIDATES ?? 1_000));
					}
				},
				(frame) => {
					state.animationFrames = frame;
					if (frame === 1 || frame === Number(process.env.LYSTAR_CUSTOM_EDITOR_ANIMATION_INVALIDATES ?? 1_000))
						publish();
				},
			);
			state.stale = state.active;
			state.active = editor;
			state.mounts++;
			publish();
			return editor;
		});
	};
	const unmount = (ctx: ExtensionContext) => {
		context = ctx;
		ctx.ui.setEditorComponent(undefined);
		state.stale = state.active;
		state.active = undefined;
		state.disposals++;
		publish();
	};

	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		ctx.ui.addAutocompleteProvider(autocomplete);
		mount(ctx);
	});
	pi.on("agent_start", () => {
		if (context && !state.active) mount(context);
	});
	pi.on("session_shutdown", () => {
		state.active = undefined;
		context = undefined;
	});

	pi.registerCommand("editor-contract-mount", {
		description: "Mount the CustomEditor contract fixture",
		handler: async (_args, ctx) => mount(ctx),
	});
	pi.registerCommand("editor-contract-unmount", {
		description: "Unmount the CustomEditor contract fixture",
		handler: async (_args, ctx) => unmount(ctx),
	});
	pi.registerCommand("editor-contract-replace", {
		description: "Replace the CustomEditor contract fixture",
		handler: async (_args, ctx) => mount(ctx),
	});
	pi.registerCommand("editor-contract-stale", {
		description: "Invoke a detached editor callback",
		handler: async (_args, ctx) => {
			context = ctx;
			state.stale?.onChange?.("stale callback draft");
			state.stale?.onSubmit?.("stale callback submit");
			publish();
		},
	});
	pi.registerCommand("editor-contract-fail-next", {
		description: "Fail the next CustomEditor mount",
		handler: async (_args, ctx) => {
			context = ctx;
			state.failNext = true;
			publish();
		},
	});
	pi.registerCommand("editor-contract-complete-next", {
		description: "Complete the next CustomEditor input",
		handler: async (_args, ctx) => {
			context = ctx;
			state.completeNext = true;
			publish();
		},
	});
}
