import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../src/runtime-adapter.ts";

export default function runtimeContractExtension(pi: ExtensionAPI): void {
	const scenario = process.env.LYSTAR_WEB_CONTRACT_SCENARIO ?? "text";
	const faux = fauxProvider({
		api: "lystar-contract-faux-api",
		provider: "lystar-contract-faux",
		models: [{ id: "contract-1", name: "Contract Model", reasoning: true }],
		tokensPerSecond: scenario === "abort" ? 100 : undefined,
	});

	const isSessionNameRequest = (context: { systemPrompt?: string }): boolean =>
		context.systemPrompt?.includes("会话命名助手") === true;
	if (scenario === "tool") {
		let toolCallReturned = false;
		faux.setResponses([
			(context) => {
				if (isSessionNameRequest(context)) return fauxAssistantMessage("自动标题");
				toolCallReturned = true;
				return fauxAssistantMessage(fauxToolCall("contract_echo", { text: "hello" }), { stopReason: "toolUse" });
			},
			(context) => {
				if (isSessionNameRequest(context)) return fauxAssistantMessage("自动标题");
				if (toolCallReturned) return fauxAssistantMessage("tool complete");
				toolCallReturned = true;
				return fauxAssistantMessage(fauxToolCall("contract_echo", { text: "hello" }), { stopReason: "toolUse" });
			},
			(context) =>
				isSessionNameRequest(context) ? fauxAssistantMessage("自动标题") : fauxAssistantMessage("tool complete"),
		]);
	} else if (scenario === "abort") {
		const response = (context: { systemPrompt?: string }) =>
			isSessionNameRequest(context) ? fauxAssistantMessage("自动标题") : fauxAssistantMessage("x".repeat(20_000));
		faux.setResponses([response, response]);
	} else if (scenario === "resources") {
		const resourceResponses = ["prompt expanded", "skill expanded"];
		const response = (context: { systemPrompt?: string }) =>
			isSessionNameRequest(context)
				? fauxAssistantMessage("自动标题")
				: fauxAssistantMessage(resourceResponses.shift() ?? "skill expanded");
		faux.setResponses([response, response, response, response]);
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
