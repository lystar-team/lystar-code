import type { ExtensionAPI } from "../../src/runtime-adapter.ts";

const variant = process.env.LYSTAR_WEB_DYNAMIC_EDGE_VARIANT === "after" ? "after" : "before";
const commandName = `edge-${variant}`;
const shortcutKey = variant === "after" ? "ctrl+shift+r" : "ctrl+shift+b";

export default function dynamicEdgeExtension(pi: ExtensionAPI): void {
	pi.registerCommand(commandName, {
		description: `动态重载 ${variant}`,
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("edge-command", commandName);
		},
	});
	pi.registerShortcut(shortcutKey, {
		description: `动态重载快捷键 ${variant}`,
		handler: async (ctx) => {
			ctx.ui.setStatus("edge-shortcut", shortcutKey);
		},
	});
	pi.registerShortcut("ctrl+shift+x", {
		description: "同步异常快捷键",
		handler: () => {
			throw new Error("dynamic shortcut failure");
		},
	});
}
