import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInteractiveUiTools } from "../../packages/web-runtime/src/interactive-ui-tools.ts";

export default function interactiveUi(pi: ExtensionAPI) {
	for (const tool of createInteractiveUiTools((command, args, options) => pi.exec(command, args, options))) {
		if (tool.name === "inspect_project_ui") pi.registerTool(tool);
	}
}
