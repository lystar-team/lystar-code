import * as ai from "@earendil-works/pi-ai";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

const INITIAL_DRAFT = "预置草稿 中文🙂";
type ControlAction = "replace" | "stale" | "fail-next";

type ContractState = {
	active?: ContractEditor;
	stale?: ContractEditor;
	mounts: number;
	disposals: number;
	failNext: boolean;
	completeNext: boolean;
};

class ContractEditor extends CustomEditor {
	private readonly onControl: (action: ControlAction) => void;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		onControl: (action: ControlAction) => void,
	) {
		super(tui, theme, keybindings);
		this.onControl = onControl;
	}

	handleInput(data: string): void {
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
		super.handleInput(data);
	}
}

export default function customEditorContractExtension(pi: ExtensionAPI): void {
	const faux = ai.fauxProvider({
		api: "lystar-custom-editor-contract-faux-api",
		provider: "lystar-custom-editor-contract-faux",
		models: [{ id: "contract-1", name: "Custom Editor Contract Model", reasoning: true }],
		tokensPerSecond: 100,
	});
	faux.setResponses([
		ai.fauxAssistantMessage("first response"),
		ai.fauxAssistantMessage("second response"),
		ai.fauxAssistantMessage("third response"),
	]);
	pi.registerProvider(faux.provider);

	const state: ContractState = { mounts: 0, disposals: 0, failNext: false, completeNext: false };
	let context: ExtensionContext | undefined;
	const publish = () => {
		context?.ui.setStatus("custom-editor-contract", `mounts=${state.mounts};disposals=${state.disposals}`);
	};
	const mount = (ctx: ExtensionContext, migrateDraft = true) => {
		context = ctx;
		if (migrateDraft && !state.active) ctx.ui.setEditorText(INITIAL_DRAFT);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			if (state.failNext) {
				state.failNext = false;
				throw new Error("custom editor fixture failure");
			}
			const editor = new ContractEditor(tui, theme, keybindings, (action) => {
				if (action === "replace") {
					mount(ctx, false);
				} else if (action === "stale") {
					state.stale?.onChange?.("stale callback draft");
					state.stale?.onSubmit?.("stale callback submit");
					publish();
				} else {
					state.failNext = true;
					publish();
				}
			});
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
		publish();
	};

	pi.on("session_start", (_event, ctx) => {
		context = ctx;
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
		description: "Complete the next CustomEditor Enter input",
		handler: async (_args, ctx) => {
			context = ctx;
			state.completeNext = true;
			publish();
		},
	});
}
