import type { ExtensionAPI } from "../../src/runtime-adapter.ts";

export default function dynamicExtension(pi: ExtensionAPI): void {
	pi.registerCommand("dynamic-contract", {
		description: "动态命令契约",
		getArgumentCompletions: (prefix) =>
			["alpha", "beta"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value, description: `参数 ${value}` })),
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("dynamic-command", "handled");
		},
	});

	pi.registerShortcut("ctrl+shift+u", {
		description: "动态快捷键契约",
		handler: async (ctx) => {
			ctx.ui.setStatus("dynamic-shortcut", "handled");
		},
	});
}
