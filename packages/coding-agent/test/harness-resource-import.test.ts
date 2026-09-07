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

	it("detects project Claude Code resources and previews relative targets", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-harness-preview-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".claude", "skills", "review", "references"), { recursive: true });
		mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
		writeFileSync(
			join(cwd, ".claude", "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review code\n---\nUse review.\n",
		);
		writeFileSync(join(cwd, ".claude", "skills", "review", "references", "guide.md"), "guide\n");
		writeFileSync(
			join(cwd, ".claude", "commands", "review.md"),
			"---\ndescription: Review changes\n---\nReview $ARGUMENTS\n",
		);
		writeFileSync(join(cwd, ".claude", "CLAUDE.md"), "Project rules\n");
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));

		const preview = discoverHarnessImports({ cwd, agentDir, targetScope: "project" });
		const claude = preview.sources.filter((source) => source.harness === "claude-code" && source.scope === "project");
		const items = preview.items.filter((item) => item.harness === "claude-code" && item.sourceScope === "project");

		expect(claude).toHaveLength(1);
		expect(claude[0]).toMatchObject({ detected: true, resourceCount: 3 });
		expect(items.map((item) => item.targetRelativePath)).toEqual(
			expect.arrayContaining(["skills/review", "prompts/review.md", "AGENTS.md"]),
		);
		expect(items.every((item) => !item.sourceRelativePath.startsWith("/"))).toBe(true);
	});

	it("imports selected resources and remains idempotent", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-harness-import-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".claude", "skills", "writer"), { recursive: true });
		mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(cwd, ".claude", "skills", "writer", "SKILL.md"),
			"---\nname: writer\ndescription: Write\n---\nWrite.\n",
		);
		writeFileSync(join(cwd, ".claude", "skills", "writer", "template.txt"), "template\n");
		writeFileSync(join(cwd, ".claude", "commands", "write.md"), "Write $ARGUMENTS\n");
		writeFileSync(join(cwd, ".claude", "CLAUDE.md"), "Keep output concise.\n");
		writeFileSync(join(agentDir, "AGENTS.md"), "Existing rules.\n");
		const previousHome = process.env.HOME;
		process.env.HOME = root;
		cleanups.push(() => {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
		});

		const initial = discoverHarnessImports({ cwd, agentDir, targetScope: "user" });
		const selected = initial.items.filter((item) => item.harness === "claude-code" && item.sourceScope === "project");
		const first = importHarnessResources({
			cwd,
			agentDir,
			targetScope: "user",
			itemIds: selected.map((item) => item.id),
		});

		expect(first).toMatchObject({ imported: 3, skipped: 0, failed: 0 });
		expect(existsSync(join(agentDir, "skills", "writer", "template.txt"))).toBe(true);
		expect(readFileSync(join(agentDir, "prompts", "write.md"), "utf8")).toContain("$ARGUMENTS");
		expect(readFileSync(join(agentDir, "AGENTS.md"), "utf8")).toContain("Keep output concise.");

		const secondPreview = discoverHarnessImports({ cwd, agentDir, targetScope: "user" });
		const second = importHarnessResources({
			cwd,
			agentDir,
			targetScope: "user",
			itemIds: secondPreview.items.filter((item) => item.harness === "claude-code").map((item) => item.id),
		});
		expect(second).toMatchObject({ imported: 0, failed: 0 });
		expect(second.skipped).toBeGreaterThanOrEqual(3);
	});

	it("imports Skill scripts, rewrites Harness paths, and preserves executable permissions", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-harness-skill-script-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const skillDir = join(cwd, ".claude", "skills", "runner");
		const scriptPath = join(skillDir, "scripts", "run.py");
		mkdirSync(dirname(scriptPath), { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: runner\ndescription: Run the helper\n---\nRun .claude/skills/runner/scripts/run.py and ${scriptPath}.\n`,
		);
		writeFileSync(scriptPath, `#!/usr/bin/env python3\n# ${scriptPath}\nprint("ok")\n`);
		chmodSync(scriptPath, 0o755);
		const previousHome = process.env.HOME;
		process.env.HOME = root;
		cleanups.push(() => {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
		});

		const preview = discoverHarnessImports({ cwd, agentDir, targetScope: "project" });
		const item = preview.items.find(
			(candidate) =>
				candidate.harness === "claude-code" && candidate.resourceType === "skill" && candidate.name === "runner",
		);
		expect(item?.warnings.join(" ")).toContain("改写");
		const result = importHarnessResources({
			cwd,
			agentDir,
			targetScope: "project",
			itemIds: item ? [item.id] : [],
		});

		expect(result).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
		const targetSkillDir = join(cwd, ".pi", "skills", "runner");
		const targetSkill = readFileSync(join(targetSkillDir, "SKILL.md"), "utf8");
		const targetScript = readFileSync(join(targetSkillDir, "scripts", "run.py"), "utf8");
		expect(targetSkill).toContain(".pi/skills/runner/scripts/run.py");
		expect(targetSkill).not.toContain(".claude/skills/runner/scripts/run.py");
		expect(targetScript).toContain(".pi/skills/runner/scripts/run.py");
		expect(targetScript).not.toContain(".claude/skills/runner/scripts/run.py");
		expect(statSync(join(targetSkillDir, "scripts", "run.py")).mode & 0o111).toBeGreaterThan(0);
	});

	it("merges only the selected instruction hunks", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-harness-rule-hunks-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(cwd, ".claude", "CLAUDE.md"),
			"# Keep\nAlways keep output concise.\n\n# Optional\nUse a table when it helps.\n",
		);
		const previousHome = process.env.HOME;
		process.env.HOME = root;
		cleanups.push(() => {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
		});

		const preview = discoverHarnessImports({ cwd, agentDir, targetScope: "user" });
		const item = preview.items.find(
			(candidate) => candidate.harness === "claude-code" && candidate.sourceScope === "project",
		);
		expect(item?.instructionHunks).toHaveLength(2);
		const selected = item?.instructionHunks?.[0];
		const result = importHarnessResources({
			cwd,
			agentDir,
			targetScope: "user",
			itemIds: item ? [item.id] : [],
			ruleSelections: item && selected ? { [item.id]: [selected.id] } : {},
		});

		expect(result).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
		const target = readFileSync(join(agentDir, "AGENTS.md"), "utf8");
		expect(target).toContain("Always keep output concise.");
		expect(target).not.toContain("Use a table when it helps.");
		const remaining = discoverHarnessImports({ cwd, agentDir, targetScope: "user" }).items.find(
			(candidate) => candidate.harness === "claude-code" && candidate.sourceScope === "project",
		);
		expect(remaining?.instructionHunks).toHaveLength(1);
	});
	it("can replace the target instruction file with the full source", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-harness-rule-replace-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const source = "# Source rules\nUse the source file exactly.\n";
		writeFileSync(join(cwd, ".claude", "CLAUDE.md"), source);
		writeFileSync(join(agentDir, "AGENTS.md"), "# Existing rules\nReplace me.\n");
		const previousHome = process.env.HOME;
		process.env.HOME = root;
		cleanups.push(() => {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
		});

		const preview = discoverHarnessImports({ cwd, agentDir, targetScope: "user" });
		const item = preview.items.find(
			(candidate) => candidate.harness === "claude-code" && candidate.sourceScope === "project",
		);
		const result = importHarnessResources({
			cwd,
			agentDir,
			targetScope: "user",
			itemIds: item ? [item.id] : [],
			replaceItemIds: item ? [item.id] : [],
		});

		expect(result).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
		expect(readFileSync(join(agentDir, "AGENTS.md"), "utf8")).toBe(source);
	});
	it("does not overwrite same-name resources selected from different Harnesses", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-harness-name-conflict-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".codex", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, ".codex", "prompts", "review.md"), "from codex\n");
		writeFileSync(join(cwd, ".claude", "commands", "review.md"), "from claude\n");
		const previousHome = process.env.HOME;
		process.env.HOME = root;
		cleanups.push(() => {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
		});

		const preview = discoverHarnessImports({ cwd, agentDir, targetScope: "user" });
		const selected = preview.items.filter((item) => item.sourceScope === "project" && item.resourceType === "prompt");
		const result = importHarnessResources({
			cwd,
			agentDir,
			targetScope: "user",
			itemIds: selected.map((item) => item.id),
		});

		expect(result).toMatchObject({ imported: 1, skipped: 1, failed: 0 });
		expect(readFileSync(join(agentDir, "prompts", "review.md"), "utf8")).toBe("from codex\n");
	});
	it("skips conflicting prompt files without overwriting them", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-harness-conflict-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
		mkdirSync(join(agentDir, "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".claude", "commands", "review.md"), "source\n");
		writeFileSync(join(agentDir, "prompts", "review.md"), "existing\n");
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));

		const preview = discoverHarnessImports({ cwd, agentDir, targetScope: "user" });
		const item = preview.items.find((candidate) => candidate.targetRelativePath === "prompts/review.md");
		expect(item?.status).toBe("conflict");
		const result = importHarnessResources({ cwd, agentDir, targetScope: "user", itemIds: item ? [item.id] : [] });
		expect(result).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
		expect(readFileSync(join(agentDir, "prompts", "review.md"), "utf8")).toBe("existing\n");
	});
});
