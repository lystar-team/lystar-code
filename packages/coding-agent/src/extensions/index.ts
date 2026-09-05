import type { InlineExtension } from "../core/extensions/types.ts";
import imageGenExtension from "./image-gen/index.ts";
import llamaExtension from "./llama/index.ts";
import sessionNameExtension from "./session-name/index.ts";
import skillReferenceExtension from "./skill-reference/index.ts";
import subagentExtension from "./subagent/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "image-gen", factory: imageGenExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "skill-reference", factory: skillReferenceExtension, hidden: true },
	{ name: "session-name", factory: sessionNameExtension, hidden: true },
	{ name: "subagent", factory: subagentExtension, hidden: true },
];
