import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	skillNameFromTool,
	ToolBatch,
	type ToolBatchTool,
	toolRowTitle,
} from "../src/components/ai-elements/tool-batch.tsx";

function readTool(path: string, state: ToolBatchTool["state"] = "output-available"): ToolBatchTool {
	return {
		id: path,
		name: "read",
		summary: JSON.stringify({ path }),
		state,
		detail: "技能内容",
	};
}

describe("Skill read tool display", () => {
	it("uses the skill directory name and dedicated loaded label", () => {
		const tool = readTool("/home/yean/.agents/skills/yean-develop-style/SKILL.md");

		expect(skillNameFromTool(tool)).toBe("yean-develop-style");
		expect(toolRowTitle(tool)).toBe("已加载 yean-develop-style 技能");
	});

	it("supports encoded and Windows-style skill paths", () => {
		const tool = readTool("C:\\workspace\\.pi\\skills\\web%2Ddesign\\SKILL.md");

		expect(skillNameFromTool(tool)).toBe("web-design");
		expect(toolRowTitle(tool)).toBe("已加载 web-design 技能");
	});

	it("renders the dedicated icon while keeping SKILL.md details", () => {
		const tool = readTool("/home/yean/.agents/skills/yean-develop-style/SKILL.md");
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool], initialOpen: true }));

		expect(markup).toContain("lucide-sparkles");
		expect(markup).toContain("size-4 shrink-0");
		expect(markup).toContain("已加载 yean-develop-style 技能");
		expect(markup).toContain("SKILL.md");
		expect(markup).toContain("技能内容");
	});

	it("does not relabel ordinary files or nested Skill resources", () => {
		const ordinaryFile = readTool("/home/yean/project/README.md");
		const nestedResource = readTool("/home/yean/.agents/skills/demo/references/SKILL.md");
		const editedSkill = { ...readTool("/home/yean/.agents/skills/demo/SKILL.md"), name: "edit" };

		expect(skillNameFromTool(ordinaryFile)).toBeUndefined();
		expect(toolRowTitle(ordinaryFile)).toBe("已读取 /home/yean/project/README.md");
		expect(skillNameFromTool(nestedResource)).toBeUndefined();
		expect(skillNameFromTool(editedSkill)).toBeUndefined();
	});
});
