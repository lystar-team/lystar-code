import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../src/runtime-adapter.ts";

export default function customEditorCompanionExtension(pi: ExtensionAPI): void {
	const faux = fauxProvider({
		api: "lystar-custom-editor-faux-api",
		provider: "lystar-custom-editor-faux",
		models: [{ id: "editor-1", name: "Editor Model", reasoning: true }],
		tokensPerSecond: 100,
	});
	faux.setResponses([fauxAssistantMessage("spinner ".repeat(40))]);
	pi.registerProvider(faux.provider);
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorText("预置草稿 中文🙂");
	});
	pi.registerCommand("editor-draft", {
		description: "Set a deterministic custom editor draft",
		handler: async (_args, ctx) => {
			ctx.ui.setEditorText("命令草稿 中文🙂");
			ctx.ui.pasteToEditor("\n第二行");
		},
	});
}
