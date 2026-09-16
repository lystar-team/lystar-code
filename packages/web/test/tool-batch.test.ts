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

	it("renders consecutive reads as one real tool activity group", () => {
		const tools: ToolBatchTool[] = [
			readTool("src/services/lease-service.ts", "output-available"),
			readTool("src/pages/lease/renewal-form.tsx", "input-available"),
		];
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools }));

		expect(markup).toContain("正在读取文件");
		expect(markup).toContain("lease-service.ts");
		expect(markup).toContain("src/services/");
		expect(markup).toContain('data-activity-directory="true"');
		expect(markup).toContain('data-activity-filename="true"');
		expect(markup.indexOf("src/services/")).toBeLessThan(markup.indexOf("lease-service.ts"));
		expect(markup).toContain("renewal-form.tsx");
		expect(markup).toContain("运行中");
		expect(markup.match(/animate-spin text-primary/gu)).toHaveLength(2);
		expect(markup).toContain("text-xs text-brand");
		expect(markup).not.toContain("核对续租条件");
	});

	it("keeps every tool row on the same full transcript width", () => {
		const groupMarkup = renderToStaticMarkup(
			createElement(ToolBatch, { tools: [readTool("src/a.ts"), readTool("src/b.ts")] }),
		);
		expect(groupMarkup).toContain("min-w-0 w-full");
		expect(groupMarkup).not.toContain("max-w-3xl");

		const failedMarkup = renderToStaticMarkup(
			createElement(ToolBatch, {
				tools: [
					{
						id: "bash-failed-width",
						name: "bash",
						summary: "npm run check",
						state: "output-error",
						detail: "error TS2304",
					},
				],
				open: false,
			}),
		);
		expect(failedMarkup).toContain("命令执行失败");
		expect(failedMarkup).not.toContain("max-w-3xl");

		const imageMarkup = renderToStaticMarkup(
			createElement(ToolBatch, {
				tools: [
					{
						id: "image-gen-width",
						name: "image_gen",
						summary: JSON.stringify({ prompt: "蓝色圆形", model: "gpt-image-2.5-flare" }),
						state: "output-available",
						images: [{ contentRef: "generated-image-width", mimeType: "image/png", byteLength: 3 }],
					},
				],
			}),
		);
		expect(imageMarkup).toContain("已生成 1 张图片");
		expect(imageMarkup).not.toContain("max-w-3xl");
	});

	it("shows the actual line range for repeated segmented reads", () => {
		const tools: ToolBatchTool[] = [
			{
				...readTool("packages/web/src/state/use-workbench.ts"),
				id: "read-range-1",
				summary: JSON.stringify({ path: "packages/web/src/state/use-workbench.ts", offset: 1, limit: 200 }),
				detail: "first line\nsecond line",
			},
			{
				...readTool("packages/web/src/state/use-workbench.ts"),
				id: "read-range-2",
				summary: JSON.stringify({ path: "packages/web/src/state/use-workbench.ts", offset: 201, limit: 200 }),
				detail: "third line\nfourth line\nfifth line",
			},
		];
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools, initialOpen: true }));

		expect(markup).toContain("第1-2行");
		expect(markup).toContain("第201-203行");
	});

	it("keeps the filename visible and shows the range for a standalone read", () => {
		const path = "/home/yean/projectWorkspace/liteasy-pi-agent/packages/web-runtime/src/service-manager.ts";
		const tool: ToolBatchTool = {
			...readTool(path),
			summary: JSON.stringify({ path, offset: 1, limit: 200 }),
			detail: "content\n[Showing lines 1-200 of 480]",
		};
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool] }));

		expect(markup).toContain("已读取");
		expect(markup).toContain("/home/yean/projectWorkspace/liteasy-pi-agent/packages/web-runtime/src/");
		expect(markup).toContain("service-manager.ts");
		expect(markup).toContain("第1-200行");
		expect(markup.indexOf("service-manager.ts")).toBeLessThan(markup.indexOf("第1-200行"));
	});

	it("keeps the filename visible for standalone completed and active edits", () => {
		const path = "/home/yean/projectWorkspace/liteasy-pi-agent/packages/web/src/components/tool-batch.tsx";
		const completed: ToolBatchTool = {
			id: "edit-standalone-complete",
			name: "edit",
			summary: JSON.stringify({ path }),
			state: "output-available",
			diff: { files: [{ path, additions: 4, deletions: 2, diff: "+new\n-old" }] },
		};
		const active: ToolBatchTool = {
			...completed,
			id: "edit-standalone-active",
			state: "input-available",
		};
		const completedMarkup = renderToStaticMarkup(createElement(ToolBatch, { tools: [completed] }));
		const activeMarkup = renderToStaticMarkup(createElement(ToolBatch, { tools: [active] }));

		expect(completedMarkup).toContain("已编辑");
		expect(completedMarkup).toContain("/home/yean/projectWorkspace/liteasy-pi-agent/packages/web/src/components/");
		expect(completedMarkup).toContain("tool-batch.tsx");
		expect(completedMarkup).toContain("+4");
		expect(completedMarkup).toContain("-2");
		expect(activeMarkup).toContain("正在编辑");
		expect(activeMarkup).toContain("tool-batch.tsx");
	});

	it("renders command batches with the same compact activity structure", () => {
		const tools: ToolBatchTool[] = [
			{
				id: "bash-1",
				name: "bash",
				summary: JSON.stringify({ command: "npm run check" }),
				state: "output-available",
				detail: "Checked files",
			},
			{
				id: "bash-2",
				name: "bash",
				summary: JSON.stringify({ command: "git diff --check" }),
				state: "output-available",
				detail: "",
			},
		];
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools, initialOpen: true }));

		expect(markup).toContain("运行了 2 条命令");
		expect(markup).toContain("npm run check");
		expect(markup).toContain("git diff --check");
		expect(markup).not.toContain("2 条命令执行完成");
	});

	it("keeps collapsed command text in the full flexible column", () => {
		const command = "npm run check --workspace=@lystar/code-web -- --reporter=verbose";
		const tools: ToolBatchTool[] = [
			{
				id: "bash-long-1",
				name: "bash",
				summary: JSON.stringify({ command }),
				state: "output-available",
				detail: "Checked files",
			},
			{
				id: "bash-long-2",
				name: "bash",
				summary: JSON.stringify({ command: "git diff --check" }),
				state: "output-available",
				detail: "",
			},
		];
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools, initialOpen: true }));

		expect(markup).toContain('data-command-title="true"');
		expect(markup).toContain(`title="${command}"`);
	});

	it("renders command syntax and ANSI output at the compact tool size", () => {
		const tool: ToolBatchTool = {
			id: "bash-output",
			name: "bash",
			summary: JSON.stringify({ command: "npm run check" }),
			state: "output-available",
			detail: "\u001b[31merror TS2304\u001b[0m\nChecked files",
		};
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool], initialOpen: true }));

		expect(markup).toContain("tool-command-block");
		expect(markup).toContain("tool-command-output");
		expect(markup).toContain("ansi-red-fg");
		expect(markup).toContain("text-[13px]");
		expect(markup).toContain("复制命令和输出");
	});

	it("renders edit and write batches as compact file activity while preserving diffs", () => {
		const tools: ToolBatchTool[] = [
			{
				id: "edit-1",
				name: "edit",
				summary: JSON.stringify({ path: "packages/web/src/app.tsx" }),
				state: "output-available",
				diff: { files: [{ path: "packages/web/src/app.tsx", additions: 2, deletions: 1, diff: "+new\n-old" }] },
			},
			{
				id: "write-1",
				name: "write",
				summary: JSON.stringify({ path: "packages/web/src/new-file.ts" }),
				state: "output-available",
				detail: "Wrote file",
			},
		];
		const markup = renderToStaticMarkup(
			createElement(ToolBatch, {
				tools,
				initialOpen: true,
				toolOpen: new Map([
					["edit-1", true],
					["write-1", true],
				]),
			}),
		);

		expect(markup).toContain("已修改 2 个文件");
		expect(markup).toContain("app.tsx");
		expect(markup).toContain("new-file.ts");
		expect(markup.indexOf("packages/web/src/")).toBeLessThan(markup.indexOf("app.tsx"));
		expect(markup).toContain('data-activity-filename="true"');
		expect(markup).toContain("+2");
		expect(markup).toContain("-1");
	});

	it("renders command failures with a visible raw error excerpt and collapsible output", () => {
		const tool: ToolBatchTool = {
			id: "bash-error",
			name: "bash",
			summary: "npm run check",
			state: "output-error",
			detail:
				"src/components/image-result.tsx:42:18\nerror TS2304: Cannot find name 'previewModel'.\nProcess exited with code 2",
		};
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool], open: false }));

		expect(markup).toContain("命令执行失败");
		expect(markup).toContain("$ npm run check");
		expect(markup).toContain("error TS2304: Cannot find name &#x27;previewModel&#x27;.");
		expect(markup).toContain("查看输出");
		expect(markup.indexOf("查看输出")).toBeLessThan(markup.indexOf("$ npm run check"));
		expect(markup).toContain("font-mono text-[13px]");
		expect(markup).toContain("size-3.5 transition-transform");
		expect(markup).not.toContain("缺少验收环境配置");
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

		expect(completedMarkup).toContain('data-diff="true"');
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
			summary: JSON.stringify({
				prompt: "蓝色纸张上的白色圆形",
				model: "gpt-image-2.5-flare",
				requestedModel: "auto",
				profile: "standard",
				filename: "generated.png",
			}),
			state: "output-available",
			detail: "Generated image saved to /tmp/generated.png.",
			images: [{ contentRef: "generated-image-1", mimeType: "image/png", byteLength: 3 }],
		};
		const completedMarkup = renderToStaticMarkup(
			createElement(ToolBatch, { tools: [completed], open: false, autoCollapseWhenComplete: true }),
		);

		expect(toolBatchSummaryLabel([completed])).toBe("已生成 1 张图片");
		expect(completedMarkup).toContain("已生成 1 张图片");
		expect(completedMarkup).toContain("generated.png");
		expect(completedMarkup).toMatch(
			/<span class="min-w-0 truncate text-sm" title="gpt-image-2\.5-flare">gpt-image-2\.5-flare<\/span>/u,
		);
		expect(completedMarkup).toMatch(/<button[^>]*text-\[13px\]![^>]*leading-5![^>]*>.*?查看大图/su);
		expect(completedMarkup).toContain("查看大图");
		expect(completedMarkup).toContain("gpt-image-2.5-flare");
		expect(completedMarkup).toContain("蓝色纸张上的白色圆形");
		expect(completedMarkup).toContain("没有图片内容");
	});

	it("places prompt actions below the full-width prompt", () => {
		const prompt =
			"请保留提示词正文的完整可用宽度，并把展开按钮放在操作行左侧，把复制提示词按钮放在操作行右侧。".repeat(6);
		const markup = renderToStaticMarkup(
			createElement(ToolBatch, {
				tools: [
					{
						id: "image-prompt-actions",
						name: "image_gen",
						summary: JSON.stringify({ prompt, model: "gpt-image-2.5-flare", filename: "generated.png" }),
						state: "output-available",
						images: [{ contentRef: "generated-image-prompt-actions", mimeType: "image/png", byteLength: 3 }],
					},
				],
			}),
		);

		expect(markup).toMatch(
			/<p class="min-w-0 whitespace-pre-wrap break-words line-clamp-4">.*?<\/p><div class="flex min-h-8 items-center justify-between gap-3"><button[^>]*>展开提示词<\/button><button[^>]*ml-auto[^>]*>.*?复制提示词<\/button><\/div>/su,
		);
	});

	it("does not present the requested auto selector as the actual image model", () => {
		const markup = renderToStaticMarkup(
			createElement(ToolBatch, {
				tools: [
					{
						id: "image-auto",
						name: "image_gen",
						summary: JSON.stringify({ prompt: "蓝色圆形", model: "auto", profile: "standard" }),
						state: "output-available",
						images: [{ contentRef: "generated-image-auto", mimeType: "image/png", byteLength: 3 }],
					},
				],
			}),
		);

		expect(markup).toContain("蓝色圆形");
		expect(markup).not.toContain("生成模型");
		expect(markup).not.toContain(">auto<");
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
