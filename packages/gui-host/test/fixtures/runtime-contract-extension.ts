import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../src/runtime-adapter.ts";

const scenario = process.env.LYSTAR_GUI_CONTRACT_SCENARIO ?? "text";
let componentHandle: { hide(): void; setHidden(hidden: boolean): void } | undefined;

class ContractComponent {
	private value = "ready";
	private readonly tui: { requestRender(): void };
	private readonly label: string;
	private readonly done: ((value: unknown) => void) | undefined;

	constructor(tui: { requestRender(): void }, label: string, done?: (value: unknown) => void) {
		this.tui = tui;
		this.label = label;
		this.done = done;
	}

	render(_width: number): string[] {
		return [`\u001b[1;36m${this.label}\u001b[0m ${this.value}`, "component interactive"];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data === "x") throw new Error("component fixture throw");
		if (data === "h") {
			componentHandle?.hide();
			setTimeout(() => componentHandle?.setHidden(false), 20);
		} else if (data.startsWith("\u001b[<")) this.value = "mouse";
		else if (data === "\r") this.done?.({ value: this.value });
		else this.value = data === "\u001b[A" ? "up" : data;
		this.tui.requestRender();
	}
}

class StormComponent {
	private value = 0;
	private readonly tui: { requestRender(): void };

	constructor(tui: { requestRender(): void }) {
		this.tui = tui;
	}

	render(_width: number): string[] {
		return [`storm final ${this.value}`];
	}

	invalidate(): void {}

	getFinalState(): number {
		return this.value;
	}

	start(onDone: () => void): void {
		for (let index = 1; index <= 1_000; index++) {
			setTimeout(() => {
				this.value = index;
				this.tui.requestRender();
				if (index === 1_000) onDone();
			}, index / 2);
		}
	}
}

export default function runtimeContractExtension(pi: ExtensionAPI): void {
	const faux = fauxProvider({
		api: "lystar-contract-faux-api",
		provider: "lystar-contract-faux",
		models: [{ id: "contract-1", name: "Contract Model", reasoning: true }],
		tokensPerSecond: scenario === "abort" ? 20_000 : undefined,
	});

	if (scenario === "tool") {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("contract_echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("tool complete"),
		]);
	} else if (scenario === "abort") {
		faux.setResponses([fauxAssistantMessage("x".repeat(20_000))]);
	} else if (scenario === "resources") {
		faux.setResponses([fauxAssistantMessage("prompt expanded"), fauxAssistantMessage("skill expanded")]);
	} else {
		faux.setResponses([fauxAssistantMessage("text complete")]);
	}

	pi.registerProvider(faux.provider);
	pi.registerTool({
		name: "contract_echo",
		label: "Contract Echo",
		description: "Echo contract fixture text",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, params) => ({
			content: [{ type: "text", text: `echo:${params.text}` }],
			details: { text: params.text },
		}),
	});
	pi.registerCommand("contract-commands", {
		description: "Report stable command metadata",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				JSON.stringify(
					pi
						.getCommands()
						.filter(
							(command) =>
								(command.source === "prompt" || command.source === "skill") &&
								(command.name.startsWith("contract-project-") ||
									command.name.startsWith("skill:contract-project-")),
						)
						.map((command) => ({
							name: command.name,
							description: command.description,
							source: command.source,
							scope: command.sourceInfo.scope,
						})),
				),
				"info",
			);
		},
	});
	pi.registerCommand("contract-ui", {
		description: "Exercise serializable GUI and RPC UI primitives",
		handler: async (_args, ctx) => {
			const selected = await ctx.ui.select("Choose", ["alpha", "beta"]);
			const confirmed = await ctx.ui.confirm("Confirm", "Proceed?");
			const input = await ctx.ui.input("Input", "value");
			const edited = await ctx.ui.editor("Editor", "before");
			ctx.ui.notify(JSON.stringify({ selected, confirmed, input, edited }), "info");
		},
	});
	pi.registerCommand("contract-rust-ui", {
		description: "Exercise Rust Tier1 Extension UI state and raw input bridge",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("contract", "ready");
			ctx.ui.setWidget("contract", ["extension widget", "second line"], { placement: "belowEditor" });
			ctx.ui.setWorkingMessage("extension working");
			ctx.ui.setWorkingIndicator({ frames: [".", "o"], intervalMs: 40 });
			ctx.ui.setHiddenThinkingLabel("extension thinking");
			ctx.ui.setTitle("Extension Contract");
			ctx.ui.onTerminalInput((data) => {
				if (data === "x") return { consume: true };
				return data === "\u001b[A" ? { data: "up" } : undefined;
			});
			ctx.ui.setEditorText("extension editor");
			ctx.ui.pasteToEditor(" paste");
			const selected = await ctx.ui.select("Extension Select", ["alpha", "beta"]);
			const confirmed = await ctx.ui.confirm("Extension Confirm", "Proceed?");
			const input = await ctx.ui.input("Extension Input", "value");
			const edited = await ctx.ui.editor("Extension Editor", "before");
			ctx.ui.notify(`rust ui ready ${selected}/${confirmed}/${input}/${edited}`, "info");
		},
	});
	pi.registerCommand("contract-components", {
		description: "Exercise Rust Component bridge lifecycle and input",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader((tui) => new ContractComponent(tui, "component header"));
			ctx.ui.setFooter((tui) => new ContractComponent(tui, "component footer"));
			setTimeout(() => ctx.ui.setFooter((tui) => new ContractComponent(tui, "component footer replace")), 30);
			ctx.ui.setWidget("component-above", (tui) => new ContractComponent(tui, "component above"));
			ctx.ui.setWidget("component-below", (tui) => new ContractComponent(tui, "component below"), {
				placement: "belowEditor",
			});
			const result = await ctx.ui.custom(
				(tui, _theme, _keybindings, done) => {
					const component = new ContractComponent(tui, "component overlay", done);
					setTimeout(() => tui.requestRender(), 20);
					return component;
				},
				{
					overlayOptions: { width: "60%", maxHeight: "50%", anchor: "top-left" },
					onHandle: (handle) => {
						componentHandle = handle as unknown as { hide(): void; setHidden(hidden: boolean): void };
					},
				},
			);
			ctx.ui.setStatus("component-result", JSON.stringify(result));
		},
	});
	pi.registerCommand("contract-components-hide", {
		description: "Hide then show the active Rust Component",
		handler: async () => {
			componentHandle?.hide();
			setTimeout(() => componentHandle?.setHidden(false), 20);
		},
	});
	pi.registerCommand("contract-components-storm", {
		description: "Exercise a real 1000-invalidate Extension Component storm",
		handler: async (_args, ctx) => {
			let component: StormComponent | undefined;
			ctx.ui.setHeader((tui) => {
				component = new StormComponent(tui);
				return component;
			});
			component?.start(() => ctx.ui.setStatus("component-storm", "done"));
		},
	});
	pi.registerCommand("contract-rust-ui-malicious", {
		description: "Exercise terminal control sanitization",
		handler: async (_args, ctx) => {
			const control = "\u001b]0;injected\u0007\u009b31m";
			ctx.ui.setStatus(`status${control}`, `value${control}`);
			ctx.ui.setWidget("malicious", [`widget${control}`]);
			ctx.ui.setWorkingMessage(`working${control}`);
			ctx.ui.setTitle(`title${control}`);
			ctx.ui.notify(`notify${control}`, "warning");
		},
	});
}
