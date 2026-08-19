import type { ExtensionAPI } from "../../src/runtime-adapter.ts";

export default function dynamicConflictExtension(pi: ExtensionAPI): void {
	pi.registerShortcut("ctrl+shift+u", {
		description: "Extension 冲突快捷键",
		handler: async (ctx) => {
			ctx.ui.setStatus("conflict-shortcut", "winner");
		},
	});
	pi.registerShortcut("enter", {
		description: "内置提交键冲突",
		handler: async (ctx) => {
			ctx.ui.setStatus("conflict-shortcut", "reserved");
		},
	});
}
