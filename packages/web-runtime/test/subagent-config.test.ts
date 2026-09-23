import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSubagentMarkdown } from "../../coding-agent/src/core/subagent-config.ts";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";

describe("subagent config adapter", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	it("saves, renames, protects, and deletes user Markdown configs", async () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-subagent-crud-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const ui = async () => ({ cancelled: true });

		let configs = await adapter.saveSubagentConfig(
			cwd,
			{
				scope: "user",
				name: "reviewer",
				description: "Review code",
				icon: "code",
				provider: "openai",
				model: "gpt-5",
				thinkingLevel: "high",
				tools: ["read", "grep"],
				skills: ["review", "codegraph"],
				tags: ["审查", "回归", "安全"],
				content: "Review the requested changes.",
			},
			ui,
		);
		const saved = configs.find((config) => config.scope === "user" && config.name === "reviewer");
		expect(saved?.contentHash).toBeDefined();
		expect(
			parseSubagentMarkdown(readFileSync(join(agentDir, "agents", "reviewer.md"), "utf8"), "reviewer"),
		).toMatchObject({
			icon: "code",
			provider: "openai",
			model: "gpt-5",
			thinkingLevel: "high",
			tools: ["read", "grep"],
			skills: ["review", "codegraph"],
			tags: ["审查", "回归", "安全"],
			content: "Review the requested changes.",
		});

		configs = await adapter.saveSubagentConfig(
			cwd,
			{
				scope: "user",
				originalName: "reviewer",
				name: "review-specialist",
				description: "Review code",
				content: "Review the requested changes.",
				expectedHash: saved?.contentHash,
			},
			ui,
		);
		const renamed = configs.find((config) => config.scope === "user" && config.name === "review-specialist");
		expect(renamed?.contentHash).toBeDefined();
		expect(configs.some((config) => config.scope === "user" && config.name === "reviewer")).toBe(false);

		await expect(
			adapter.saveSubagentConfig(
				cwd,
				{
					scope: "user",
					name: "review-specialist",
					description: "Stale update",
					content: "Do not save.",
					expectedHash: "stale",
				},
				ui,
			),
		).rejects.toMatchObject({ code: "subagent_conflict" });

		configs = await adapter.deleteSubagentConfig(
			cwd,
			{ scope: "user", name: "review-specialist", expectedHash: renamed?.contentHash ?? "" },
			ui,
		);
		expect(configs.some((config) => config.scope === "user" && config.name === "review-specialist")).toBe(false);
	});
});
