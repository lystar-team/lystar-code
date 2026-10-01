import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import imageGenExtension from "./image-gen/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import sessionNameExtension from "./session-name/index.ts";
import skillReferenceExtension from "./skill-reference/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "image-gen", factory: imageGenExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true, builtin: true },
	{ name: "skill-reference", factory: skillReferenceExtension, hidden: true },
	{ name: "session-name", factory: sessionNameExtension, hidden: true },
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
