import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	skillNameFromTool,
	ToolBatch,
	type ToolBatchTool,
	toolBatchSummaryLabel,
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

	it("summarizes mixed tool actions in execution order", () => {
		expect(toolBatchSummaryLabel([{ name: "edit" }, { name: "bash" }, { name: "bash" }, { name: "read" }])).toBe(
			"编辑了文件并运行了命令并读取了文件",
		);
		expect(toolBatchSummaryLabel([])).toBe("执行了工具");
	});
	it("does not repeat aggregate diff stats inside details", () => {
		const tool: ToolBatchTool = {
			id: "edit-1",
			name: "edit",
			summary: JSON.stringify({ path: "/tmp/example.ts" }),
			state: "output-available",
			diff: { files: [{ path: "/tmp/example.ts", additions: 11, deletions: 0, diff: "+new" }] },
		};
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool], initialOpen: true }));

		expect(markup.match(/\+11/gu)).toHaveLength(1);
	});
	it("does not render the input preview hint while editing", () => {
		const tool: ToolBatchTool = {
			id: "edit-1",
			name: "edit",
			summary: JSON.stringify({ path: "/tmp/example.ts" }),
			state: "input-available",
			inputPreview: true,
			diff: { files: [{ path: "/tmp/example.ts", additions: 49, deletions: 28, diff: "+new" }] },
		};
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool], initialOpen: true }));

		expect(markup).not.toContain("参数预览，终态以工具真实结果为准");
	});
	it("renders image reads as an inline preview without text content", () => {
		const tool = {
			...readTool("/tmp/example.png"),
			images: [{ contentRef: "image-1", mimeType: "image/png", byteLength: 3 }],
		};
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool] }));

		expect(markup).toContain("lucide-images");
		expect(markup).toContain("已查看 1 张图像");
		expect(markup).toContain("没有图片内容");
		expect(markup).not.toContain("技能内容");
	});
	it("merges consecutive image reads into one gallery", () => {
		const tools = [
			{
				...readTool("/tmp/first.png"),
				images: [{ contentRef: "image-1", mimeType: "image/png", byteLength: 3 }],
			},
			{
				...readTool("/tmp/second.png"),
				images: [{ contentRef: "image-2", mimeType: "image/png", byteLength: 3 }],
			},
		];
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools }));

		expect(markup).toContain("已查看 2 张图像");
		expect(markup.match(/没有图片内容/g)).toHaveLength(2);
	});
	it("keeps incomplete multi-tool batches as individual rows", () => {
		const tools: ToolBatchTool[] = [
			{
				id: "bash-1",
				name: "bash",
				summary: JSON.stringify({ command: "npm test" }),
				state: "input-available",
			},
			{
				id: "edit-1",
				name: "edit",
				summary: JSON.stringify({ path: "/tmp/example.ts" }),
				state: "output-available",
			},
		];
		const markup = renderToStaticMarkup(
			createElement(ToolBatch, {
				tools,
				summaryLabel: "运行了命令并编辑了文件",
			}),
		);

		expect(markup).not.toContain("运行了命令并编辑了文件");
		expect(markup).toContain("npm test");
		expect(markup).toContain("/tmp/example.ts");
	});
	it("uses tool-specific labels while arguments are changing", () => {
		const tool: ToolBatchTool = {
			id: "edit-1",
			name: "edit",
			summary: JSON.stringify({ path: "packages/web/src/app.ts" }),
			state: "input-available",
		};

		expect(toolRowTitle(tool)).toBe("正在编辑 packages/web/src/app.ts");
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
