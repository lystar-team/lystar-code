import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { BUILTIN_AGENTS, discoverAgents } from "../src/extensions/subagent/agents.ts";
import subagentExtension from "../src/extensions/subagent/index.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("built-in subagent extension", () => {
	it("is bundled as a hidden extension and registers its tool", async () => {
		expect(builtInExtensions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "subagent", factory: subagentExtension, hidden: true }),
			]),
		);
		const extension = await loadExtensionFromFactory(
			subagentExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:subagent>",
		);
		expect(extension.tools.has("subagent")).toBe(true);
	});

	it("ships three fallback agents without fixed models", () => {
		expect(BUILTIN_AGENTS.map((agent) => agent.name)).toEqual(["research-specialist", "review-specialist", "worker"]);
		expect(BUILTIN_AGENTS.every((agent) => agent.model === undefined)).toBe(true);
	});

	it("lets a project agent override a built-in agent", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-subagent-"));
		tempDirs.push(root);
		const agentsDir = join(root, CONFIG_DIR_NAME, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "worker.md"),
			"---\nname: worker\ndescription: Project worker\ntools: read\n---\n\nProject instructions.\n",
		);

		const result = discoverAgents(root, "project");
		expect(result.agents.find((agent) => agent.name === "worker")).toMatchObject({
			source: "project",
			description: "Project worker",
		});
		expect(result.agents).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "research-specialist", source: "builtin" })]),
		);
	});
});
