import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { SlashCommandInfo } from "../src/core/slash-commands.ts";
import {
	createSkillReferenceAutocompleteProvider,
	expandSkillReferences,
	extractSkillQuery,
} from "../src/extensions/skill-reference/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createSkills(): { commands: Array<SlashCommandInfo & { source: "skill" }>; root: string } {
	const root = mkdtempSync(join(tmpdir(), "lystar-skill-reference-"));
	tempDirs.push(root);
	const skills = [
		{ name: "shuorenhua", description: "清理文案里的 AI 套路", body: "按说人话规则检查文本。" },
		{ name: "ui-design", description: "设计和评审可见界面", body: "按 UI 规则检查界面。" },
	];
	const commands = skills.map(({ name, description, body }) => {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "SKILL.md");
		writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`);
		return {
			name: `skill:${name}`,
			description,
			source: "skill" as const,
			sourceInfo: { path, source: "local", scope: "project" as const, origin: "top-level" as const, baseDir: dir },
		};
	});
	return { commands, root };
}

function createProvider(commands: SlashCommandInfo[]): AutocompleteProvider {
	const pi = { getCommands: () => commands } as ExtensionAPI;
	const base: AutocompleteProvider = {
		async getSuggestions(lines, line, col) {
			const prefix = (lines[line] ?? "").slice(0, col);
			return prefix.startsWith("@")
				? { prefix, items: [{ value: "@ui-panel.ts", label: "ui-panel.ts", description: "src/ui-panel.ts" }] }
				: null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const next = [...lines];
			next[cursorLine] = `${(lines[cursorLine] ?? "").slice(0, cursorCol - prefix.length)}${item.value}`;
			return { lines: next, cursorLine, cursorCol: item.value.length };
		},
	};
	return createSkillReferenceAutocompleteProvider(pi, base);
}

describe("skill reference autocomplete", () => {
	it("matches partial names with and without an opening bracket", () => {
		expect(extractSkillQuery("请用$shuo")).toEqual({
			symbol: "$",
			explicitSkill: false,
			query: "shuo",
			prefix: "$shuo",
		});
		expect(extractSkillQuery("请用 @[ui")).toEqual({
			symbol: "@",
			explicitSkill: true,
			query: "ui",
			prefix: "@[ui",
		});
	});

	it("keeps file candidates under @ and marks Skill candidates", async () => {
		const { commands } = createSkills();
		const provider = createProvider(commands);
		const signal = new AbortController().signal;
		const mixed = await provider.getSuggestions(["@ui"], 0, 3, { signal });
		expect(mixed?.items.map((item) => item.value)).toEqual(expect.arrayContaining(["@[ui-design]", "@ui-panel.ts"]));
		const skillItem = mixed?.items.find((item) => item.value === "@[ui-design]");
		expect(skillItem?.description).toContain("[Skill]");

		const skillsOnly = await provider.getSuggestions(["$shuo"], 0, 5, { signal });
		expect(skillsOnly?.items.map((item) => item.value)).toEqual(["$[shuorenhua]"]);
	});

	it("inserts the canonical reference and closing bracket", async () => {
		const { commands } = createSkills();
		const provider = createProvider(commands);
		const signal = new AbortController().signal;
		const suggestions = await provider.getSuggestions(["请用 $shuo 修改"], 0, 8, { signal });
		const result = provider.applyCompletion(["请用 $shuo 修改"], 0, 8, suggestions!.items[0]!, suggestions!.prefix);
		expect(result.lines[0]).toBe("请用 $[shuorenhua] 修改");
	});
});

describe("skill reference expansion", () => {
	it("expands multiple Skills in first-reference order and deduplicates them", () => {
		const { commands } = createSkills();
		const prompt = "请结合 $[shuorenhua]、@[ui-design] 和 $[shuorenhua] 检查页面";
		const expanded = expandSkillReferences(prompt, commands)!;
		expect(expanded).toContain('<skill name="shuorenhua + ui-design" location="multiple">');
		expect(expanded.indexOf("## shuorenhua")).toBeLessThan(expanded.indexOf("## ui-design"));
		expect(expanded.match(/## shuorenhua/g)).toHaveLength(1);
		expect(expanded).toContain("按说人话规则检查文本。");
		expect(expanded).toContain("按 UI 规则检查界面。");
		expect(expanded).toContain(prompt);
	});

	it("keeps the existing single-Skill envelope and supports a leading /skill command", () => {
		const { commands } = createSkills();
		const expanded = expandSkillReferences("/skill:shuorenhua 再结合 @[ui-design] 检查页面", commands)!;
		expect(expanded).toContain('<skill name="shuorenhua + ui-design" location="multiple">');
		expect(expanded).not.toContain("/skill:shuorenhua");
	});

	it("ignores ordinary dollar variables and rejects stale explicit references", () => {
		const { commands } = createSkills();
		expect(expandSkillReferences("检查 $PATH 和 $" + "{HOME}", commands)).toBeUndefined();
		expect(() => expandSkillReferences("使用 $[missing]", commands)).toThrow("当前不可用");
	});
});
