import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	MAX_DIFF_HIGHLIGHT_BYTES,
	MAX_DIFF_HIGHLIGHT_LINES,
	shouldHighlightDiffCode,
} from "../src/components/ai-elements/code-block.tsx";
import {
	skillNameFromTool,
	ToolBatch,
	type ToolBatchTool,
	toolBatchSummaryLabel,
	toolRowTitle,
} from "../src/components/ai-elements/tool-batch.tsx";
import { highlightCode } from "../src/lib/code-highlighter.ts";

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
		expect(markup).toContain("收起详情");
		expect(markup.match(/data-transcript-resize-anchor="true"/gu)?.length).toBeGreaterThanOrEqual(2);
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

	it("highlights source syntax inside completed file diffs and keeps active previews plain", async () => {
		const source = "const value: number = 1;\nconst oldValue = 0;";
		await new Promise<void>((resolve) => {
			const result = highlightCode(source, "typescript", () => resolve());
			if (result) resolve();
		});

		const completed: ToolBatchTool = {
			id: "edit-complete",
			name: "edit",
			summary: JSON.stringify({ path: "/tmp/example.ts" }),
			state: "output-available",
			diff: {
				files: [
					{
						path: "/tmp/example.ts",
						additions: 1,
						deletions: 1,
						diff: "+ 1 const value: number = 1;\n- 2 const oldValue = 0;",
					},
				],
			},
		};
		const completedMarkup = renderToStaticMarkup(createElement(ToolBatch, { tools: [completed], initialOpen: true }));

		expect(completedMarkup).toMatch(/>const<\/span>/u);
		expect(completedMarkup).toMatch(/>number<\/span>/u);
		expect(completedMarkup.match(/data-diff-line="added"/gu)).toHaveLength(1);
		expect(completedMarkup.match(/data-diff-line="removed"/gu)).toHaveLength(1);

		const activeMarkup = renderToStaticMarkup(
			createElement(ToolBatch, {
				tools: [{ ...completed, id: "edit-active", state: "input-available" }],
				initialOpen: true,
			}),
		);
		expect(activeMarkup).not.toMatch(/>const<\/span>/u);
		expect(activeMarkup.match(/data-diff-line="added"/gu)).toHaveLength(1);
		expect(activeMarkup.match(/data-diff-line="removed"/gu)).toHaveLength(1);
	});
	it("skips source highlighting for large diffs", () => {
		expect(shouldHighlightDiffCode(`+${"x".repeat(MAX_DIFF_HIGHLIGHT_BYTES)}`)).toBe(false);
		expect(
			shouldHighlightDiffCode(Array.from({ length: MAX_DIFF_HIGHLIGHT_LINES + 1 }, () => "+line").join("\n")),
		).toBe(false);
		expect(shouldHighlightDiffCode("+ 1 const value: number = 1;")).toBe(true);
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
	it("keeps the image generation card visible while running and after completion", () => {
		const running: ToolBatchTool = {
			id: "image-gen-1",
			name: "image_gen",
			summary: JSON.stringify({ prompt: "蓝色纸张上的白色圆形", model: "auto", profile: "standard" }),
			state: "input-available",
			detail: "正在使用 gpt-image-2.5-flare 生成图片",
		};
		const runningMarkup = renderToStaticMarkup(
			createElement(ToolBatch, { tools: [running], open: false, autoCollapseWhenComplete: true }),
		);

		expect(runningMarkup).toContain("正在生成图片 · 蓝色纸张上的白色圆形");
		expect(runningMarkup).toContain("正在使用 gpt-image-2.5-flare 生成图片");
		expect(runningMarkup).toContain("lucide-loader-circle");

		const completed: ToolBatchTool = {
			...running,
			state: "output-available",
			detail: "Generated image saved to /tmp/generated.png.",
			images: [{ contentRef: "generated-image-1", mimeType: "image/png", byteLength: 3 }],
		};
		const completedMarkup = renderToStaticMarkup(
			createElement(ToolBatch, { tools: [completed], open: false, autoCollapseWhenComplete: true }),
		);

		expect(toolBatchSummaryLabel([completed])).toBe("已生成 1 张图片");
		expect(completedMarkup).toContain("已生成 1 张图片");
		expect(completedMarkup).toContain("生成图片 1");
		expect(completedMarkup).toContain("min-h-52");
		expect(completedMarkup).toContain("没有图片内容");
	});

	it("keeps failed image generation visible as an error card", () => {
		const failed: ToolBatchTool = {
			id: "image-gen-error",
			name: "image_gen",
			summary: JSON.stringify({ prompt: "blocked image" }),
			state: "output-error",
			detail: "content_policy_violation",
		};
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools: [failed], open: false }));

		expect(markup).toContain("图片生成失败 · blocked image");
		expect(markup).toContain("content_policy_violation");
		expect(markup).toContain('role="alert"');
	});

	it("allows completed image previews to be collapsed by the result boundary state", () => {
		const tool = {
			...readTool("/tmp/example.png"),
			images: [{ contentRef: "image-1", mimeType: "image/png", byteLength: 3 }],
		};
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool], open: false }));

		expect(markup).toContain("已查看 1 张图像");
		expect(markup).toContain("展开");
		expect(markup).not.toContain("没有图片内容");
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
