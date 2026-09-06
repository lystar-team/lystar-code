import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../src/runtime-adapter.ts";

const scenario = process.env.LYSTAR_WEB_CONTRACT_SCENARIO ?? "text";

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
	pi.on("user_bash", (event) => {
		if (event.command !== "extension-bash") return;
		return {
			result: {
				output: `extension:${event.excludeFromContext}`,
				exitCode: 0,
				cancelled: false,
				truncated: false,
			},
		};
	});
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
		description: "Exercise serializable Web and RPC UI primitives",
		handler: async (_args, ctx) => {
			const selected = await ctx.ui.select("Choose", ["alpha", "beta"]);
			const confirmed = await ctx.ui.confirm("Confirm", "Proceed?");
			const input = await ctx.ui.input("Input", "value");
			const edited = await ctx.ui.editor("Editor", "before");
			ctx.ui.notify(JSON.stringify({ selected, confirmed, input, edited }), "info");
		},
	});
}
