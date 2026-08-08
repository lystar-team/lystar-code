import type { InlineExtension } from "../core/extensions/types.ts";
import applyPatchExtension from "./apply-patch/index.ts";
import llamaExtension from "./llama/index.ts";
import skillReferenceExtension from "./skill-reference/index.ts";
import subagentExtension from "./subagent/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "apply-patch", factory: applyPatchExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "skill-reference", factory: skillReferenceExtension, hidden: true },
	{ name: "subagent", factory: subagentExtension, hidden: true },
];
