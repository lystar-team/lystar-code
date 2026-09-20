import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverHarnessImports, importHarnessResources } from "../src/core/harness-resource-import.ts";
import { parseSubagentMarkdown } from "../src/core/subagent-config.ts";
import { discoverAgents } from "../src/extensions/subagent/agents.ts";

describe("harness agent import", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	function workspace(prefix: string): { root: string; cwd: string; agentDir: string } {
		const root = mkdtempSync(join(tmpdir(), prefix));
		const cwd = join(root, "project");
		const agentDir = join(root, "lystar-agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const previousHome = process.env.HOME;
		process.env.HOME = root;
		cleanups.push(() => {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
		});
		return { root, cwd, agentDir };
	}

	it("converts Codex TOML, migrates referenced skills, and loads the result", () => {
		const { root, cwd, agentDir } = workspace("lystar-codex-agent-");
		const skillDir = join(root, ".codex", "skills", "review");
		const agentPath = join(root, ".codex", "agents", "reviewer.toml");
		mkdirSync(skillDir, { recursive: true });
		mkdirSync(join(root, ".codex", "agents"), { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: review\ndescription: Review\n---\nReview code.\n");
		writeFileSync(
			agentPath,
			[
				'name = "reviewer"',
				'description = "Review changed code"',
				'model = "openai/gpt-5"',
				'model_reasoning_effort = "high"',
				'sandbox_mode = "read-only"',
				'developer_instructions = "Read the linked skill before reviewing."',
				"",
				"[skills]",
				`config = [{ path = ${JSON.stringify(join(skillDir, "SKILL.md"))}, enabled = true }]`,
			].join("\n"),
		);

		const preview = discoverHarnessImports({ cwd, agentDir });
		const agent = preview.items.find(
			(item) => item.harness === "codex" && item.sourceScope === "user" && item.resourceType === "agent",
		);
		const skill = preview.items.find(
			(item) => item.harness === "codex" && item.sourceScope === "user" && item.resourceType === "skill",
		);
		expect(agent).toMatchObject({ name: "reviewer", targetRelativePath: "agents/reviewer.md" });
		expect(agent?.referencedItemIds).toEqual(skill ? [skill.id] : []);

		const result = importHarnessResources({ cwd, agentDir, itemIds: agent ? [agent.id] : [] });
		expect(result).toMatchObject({ imported: 2, failed: 0 });
		const targetPath = join(agentDir, "agents", "reviewer.md");
		const raw = readFileSync(targetPath, "utf8");
		const parsed = parseSubagentMarkdown(raw, "reviewer");
		expect(parsed).toMatchObject({
			name: "reviewer",
			description: "Review changed code",
			provider: "openai",
			model: "gpt-5",
			thinkingLevel: "high",
			tools: ["read", "grep", "find", "ls"],
		});
		expect(parsed?.content).toContain(join(agentDir, "skills", "review", "SKILL.md"));
		expect(existsSync(join(agentDir, "skills", "review", "SKILL.md"))).toBe(true);
		expect(
			discoverAgents(cwd, "user", agentDir).agents.find((candidate) => candidate.name === "reviewer"),
		).toMatchObject({
			model: "openai/gpt-5:high",
			source: "user",
		});
	});

	it("normalizes Claude Code and OpenCode agents into LYStar Markdown", () => {
		const { root, cwd, agentDir } = workspace("lystar-other-agents-");
		mkdirSync(join(root, ".claude", "agents"), { recursive: true });
		mkdirSync(join(root, ".config", "opencode"), { recursive: true });
		writeFileSync(
			join(root, ".claude", "agents", "research.md"),
			"---\nname: research\ndescription: Find evidence\nmodel: sonnet\ntools: Read, Grep\npermissionMode: plan\n---\nInvestigate without editing.\n",
		);
		writeFileSync(
			join(root, ".config", "opencode", "opencode.jsonc"),
			`{
				// Inline SubAgent
				"agent": {
					"planner": {
						"description": "Plan implementation",
						"mode": "subagent",
						"model": "anthropic/claude-sonnet-4",
						"prompt": "Produce a concrete plan.",
						"tools": ["read", "glob"]
					},
					"reviewer": {
						"description": "Review implementation",
						"mode": "subagent",
						"prompt": "Review the result."
					}
				}
			}`,
		);

		const preview = discoverHarnessImports({ cwd, agentDir });
		const claude = preview.items.find((item) => item.harness === "claude-code" && item.resourceType === "agent");
		const openCodeAgents = preview.items.filter(
			(item) => item.harness === "opencode" && item.resourceType === "agent",
		);
		const planner = openCodeAgents.find((item) => item.name === "planner");
		expect(claude).toMatchObject({ name: "research", targetRelativePath: "agents/research.md" });
		expect(openCodeAgents.map((item) => item.targetRelativePath)).toEqual([
			"agents/planner.md",
			"agents/reviewer.md",
		]);
		expect(new Set(openCodeAgents.map((item) => item.id)).size).toBe(2);
		const result = importHarnessResources({
			cwd,
			agentDir,
			itemIds: [claude?.id, ...openCodeAgents.map((item) => item.id)].filter((id): id is string => id !== undefined),
		});
		expect(result).toMatchObject({ imported: 3, failed: 0 });
		expect(
			parseSubagentMarkdown(readFileSync(join(agentDir, "agents", "research.md"), "utf8"), "research"),
		).toMatchObject({
			model: "sonnet",
			tools: ["read", "grep", "find", "ls"],
		});
		expect(
			parseSubagentMarkdown(
				readFileSync(join(agentDir, "agents", "planner.md"), "utf8"),
				planner?.name ?? "planner",
			),
		).toMatchObject({
			provider: "anthropic",
			model: "claude-sonnet-4",
			tools: ["read", "find"],
			content: "Produce a concrete plan.",
		});
	});
});
