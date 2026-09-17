import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverHarnessImports, importHarnessResources } from "../src/core/harness-resource-import.ts";

describe("harness resource import", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	it("detects project resources without treating project rules as migration input", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-harness-preview-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".claude", "skills", "review"), { recursive: true });
		mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
		writeFileSync(
			join(cwd, ".claude", "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review code\n---\nUse review.\n",
		);
		writeFileSync(join(cwd, ".claude", "commands", "review.md"), "Review $ARGUMENTS\n");
		writeFileSync(join(cwd, "CLAUDE.md"), "Project root rules\n");
		writeFileSync(join(cwd, ".claude", "CLAUDE.md"), "Project harness rules\n");
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));

		const preview = discoverHarnessImports({ cwd, agentDir });
		const source = preview.sources.find(
			(candidate) => candidate.harness === "claude-code" && candidate.scope === "project",
		);
		const items = preview.items.filter((item) => item.harness === "claude-code" && item.sourceScope === "project");

		expect(source).toMatchObject({ detected: true, resourceCount: 2 });
		expect(source?.resourceTypes.instructions).toBe(0);
		expect(items.map((item) => item.targetRelativePath)).toEqual(
			expect.arrayContaining(["skills/review", "prompts/review.md"]),
		);
		expect(items.some((item) => item.resourceType === "instruction")).toBe(false);
	});

	it("overwrites global resources and the full global AGENTS.md", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-harness-global-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const sourceSkill = join(root, ".claude", "skills", "writer");
		mkdirSync(sourceSkill, { recursive: true });
		mkdirSync(join(root, ".claude", "commands"), { recursive: true });
		mkdirSync(join(agentDir, "skills", "writer"), { recursive: true });
		mkdirSync(join(agentDir, "prompts"), { recursive: true });
		writeFileSync(join(sourceSkill, "SKILL.md"), "---\nname: writer\ndescription: Write\n---\nNew skill.\n");
		writeFileSync(join(sourceSkill, "template.txt"), "new template\n");
		writeFileSync(join(root, ".claude", "commands", "write.md"), "New prompt\n");
		const sourceRules = "# Global rules\nUse the imported rules.\n";
		writeFileSync(join(root, ".claude", "CLAUDE.md"), sourceRules);
		writeFileSync(join(agentDir, "skills", "writer", "SKILL.md"), "Old skill\n");
		writeFileSync(join(agentDir, "skills", "writer", "stale.txt"), "stale\n");
		writeFileSync(join(agentDir, "prompts", "write.md"), "Old prompt\n");
		writeFileSync(join(agentDir, "AGENTS.md"), "Old rules\n");
		const previousHome = process.env.HOME;
		process.env.HOME = root;
		cleanups.push(() => {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
		});

		const preview = discoverHarnessImports({ cwd, agentDir });
		const itemIds = preview.items
			.filter((item) => item.harness === "claude-code" && item.sourceScope === "user")
			.map((item) => item.id);
		const first = importHarnessResources({ cwd, agentDir, itemIds });

		expect(first).toMatchObject({ imported: 3, skipped: 0, failed: 0 });
		expect(first.backupPath).toBeDefined();
		expect(readFileSync(join(first.backupPath!, "user", "AGENTS.md"), "utf8")).toBe("Old rules\n");
		expect(readFileSync(join(first.backupPath!, "user", "skills", "writer", "stale.txt"), "utf8")).toBe("stale\n");
		expect(readFileSync(join(agentDir, "skills", "writer", "template.txt"), "utf8")).toBe("new template\n");
		expect(existsSync(join(agentDir, "skills", "writer", "stale.txt"))).toBe(false);
		expect(readFileSync(join(agentDir, "prompts", "write.md"), "utf8")).toBe("New prompt\n");
		expect(readFileSync(join(agentDir, "AGENTS.md"), "utf8")).toBe(sourceRules);

		const secondPreview = discoverHarnessImports({ cwd, agentDir });
		const second = importHarnessResources({
			cwd,
			agentDir,
			itemIds: secondPreview.items
				.filter((item) => item.harness === "claude-code" && item.sourceScope === "user")
				.map((item) => item.id),
		});
		expect(second).toMatchObject({ imported: 3, skipped: 0, failed: 0 });
	});

	it("replaces project resource directories, rewrites paths, and preserves executable permissions", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-harness-project-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const skillDir = join(cwd, ".codex", "skills", "runner");
		const scriptPath = join(skillDir, "scripts", "run.py");
		mkdirSync(dirname(scriptPath), { recursive: true });
		mkdirSync(join(cwd, ".pi", "skills", "runner"), { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: runner\ndescription: Run\n---\nRun .codex/skills/runner/scripts/run.py.\n",
		);
		writeFileSync(scriptPath, "#!/usr/bin/env python3\nprint('ok')\n");
		chmodSync(scriptPath, 0o755);
		writeFileSync(join(cwd, ".pi", "skills", "runner", "stale.txt"), "stale\n");
		const previousHome = process.env.HOME;
		process.env.HOME = root;
		cleanups.push(() => {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
		});

		const preview = discoverHarnessImports({ cwd, agentDir });
		const item = preview.items.find(
			(candidate) =>
				candidate.harness === "codex" && candidate.sourceScope === "project" && candidate.resourceType === "skill",
		);
		const result = importHarnessResources({ cwd, agentDir, itemIds: item ? [item.id] : [] });

		expect(result).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
		expect(result.backupPath).toBeDefined();
		expect(readFileSync(join(result.backupPath!, "project", "skills", "runner", "stale.txt"), "utf8")).toBe(
			"stale\n",
		);
		const targetSkillDir = join(cwd, ".pi", "skills", "runner");
		expect(existsSync(join(targetSkillDir, "stale.txt"))).toBe(false);
		expect(readFileSync(join(targetSkillDir, "SKILL.md"), "utf8")).toContain(".pi/skills/runner/scripts/run.py");
		expect(statSync(join(targetSkillDir, "scripts", "run.py")).mode & 0o111).toBeGreaterThan(0);
	});

	it("imports files referenced by a global rule and leaves project rules untouched", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-harness-references-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const sourceRoot = join(root, ".codex");
		const guidePath = join(sourceRoot, "docs", "guide.md");
		mkdirSync(dirname(guidePath), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(sourceRoot, "AGENTS.md"), `Read ${guidePath}.\n`);
		writeFileSync(guidePath, "Imported guide.\n");
		writeFileSync(join(cwd, "AGENTS.md"), "Project rules stay here.\n");
		const previousHome = process.env.HOME;
		process.env.HOME = root;
		cleanups.push(() => {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
		});

		const preview = discoverHarnessImports({ cwd, agentDir });
		const instruction = preview.items.find(
			(item) => item.harness === "codex" && item.sourceScope === "user" && item.resourceType === "instruction",
		);
		expect(instruction?.referencedItemIds).toHaveLength(1);
		const result = importHarnessResources({ cwd, agentDir, itemIds: instruction ? [instruction.id] : [] });

		expect(result).toMatchObject({ imported: 2, skipped: 0, failed: 0 });
		expect(readFileSync(join(agentDir, "docs", "guide.md"), "utf8")).toBe("Imported guide.\n");
		expect(readFileSync(join(agentDir, "AGENTS.md"), "utf8")).toContain(join(agentDir, "docs", "guide.md"));
		expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe("Project rules stay here.\n");
	});
});
