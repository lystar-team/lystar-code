import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/components/ai-elements/resource-preview.tsx", () => ({
	ResourceImage: () => null,
	ResourceImageGallery: () => null,
	ResourceImageViewer: () => null,
	useResourceImageSource: () => ({ source: undefined, loading: false, failed: false }),
}));

import { ToolBatch, toolRowTitle, type ToolBatchTool } from "../src/components/ai-elements/tool-batch.tsx";

function commandTool(command: string, state: ToolBatchTool["state"] = "output-available", detail?: string): ToolBatchTool {
	return { id: command, name: "bash", summary: JSON.stringify({ command }), state, detail };
}

describe("command activity card", () => {
	it("shows the search intent and magnifier while running, then reveals the exact command", () => {
		const command = "find /workspace -maxdepth 3 -name 'tsconfig*'";
		const tool = commandTool(command, "input-available");
		const collapsed = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool] }));
		expect(collapsed).toContain("正在查找 tsconfig* 文件（/workspace）");
		expect(collapsed).toContain("lucide-search");
		expect(collapsed).toContain("lucide-loader-circle");
		expect(collapsed).toContain("flex-1 truncate font-mono text-[13px]");
		expect(collapsed).not.toContain("-maxdepth");
		expect(collapsed).toContain("展开详情");
		const expanded = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool], initialOpen: true }));
		expect(expanded).toContain("tool-command-block");
		expect(expanded).toContain("-maxdepth 3 -name");
		expect(expanded).toContain("复制命令和输出");
	});

	it("keeps every command in a batch traceable, even with empty output", () => {
		const tools = [commandTool("find src -name 'app.ts'", "output-available", "src/app.ts"), commandTool("rg -n renewal src", "output-available", "")];
		const collapsed = renderToStaticMarkup(createElement(ToolBatch, { tools, initialOpen: true }));
		expect(collapsed).toContain("已查找 app.ts 文件（src）");
		expect(collapsed).toContain("已搜索 renewal（src）");
		expect(collapsed).toContain("truncate font-mono text-[13px] leading-5 text-foreground");
		expect(collapsed).not.toContain("rg -n renewal src");
		const expanded = renderToStaticMarkup(
			createElement(ToolBatch, { tools, initialOpen: true, initialToolOpen: new Map([[tools[1].id, true]]) }),
		);
		expect(expanded).toContain("rg -n renewal src");
		expect(expanded).toContain("tool-command-block");
	});

	it("describes the actual program behind npm exec and preserves the command in details", () => {
		const command = "npm exec -- tsgo -p packages/web/tsconfig.json --noEmit";
		const tool = commandTool(command);
		const collapsed = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool] }));
		expect(collapsed).toContain("已检查 TypeScript 类型（packages/web/tsconfig.json）");
		expect(collapsed).toContain("lucide-package");
		expect(collapsed).not.toContain("-- 脚本");
		expect(collapsed).not.toContain(command);
		const expanded = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool], initialOpen: true }));
		expect(expanded).toContain("$ npm exec -- tsgo -p packages/web/tsconfig.json --noEmit");
	});

	it("renders a failed command like other failed tools with traceable details", () => {
		const tool = commandTool("npm run check", "output-error", "error TS2304: Cannot find name 'config'");
		const failedRead: ToolBatchTool = {
			id: "failed-read",
			name: "read",
			summary: "src/config.ts",
			state: "output-error",
			detail: "read failed",
		};
		const collapsed = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool], open: false }));
		const readMarkup = renderToStaticMarkup(createElement(ToolBatch, { tools: [failedRead], open: false }));
		for (const markup of [collapsed, readMarkup]) {
			expect(markup).toContain('data-slot="collapsible" class="min-w-0"');
			expect(markup).toContain('aria-label="出错" class="size-1.5 shrink-0 rounded-full bg-destructive"');
			expect(markup).toContain("出错");
		}
		expect(collapsed).toContain("检查项目代码失败");
		expect(collapsed).toContain("lucide-package");
		expect(collapsed).not.toContain("rounded-xl border border-border bg-muted/20");
		expect(collapsed).not.toContain("command-output-toggle");
		expect(collapsed).not.toContain("error TS2304");
		expect(collapsed).not.toContain("npm run check");
		const expanded = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool], open: true }));
		expect(expanded).toContain("tool-command-block");
		expect(expanded).toContain("tool-command-output");
		expect(expanded).toContain("$ npm run check");
		expect(expanded).toContain("error TS2304");
	});

	it("keeps command echoes and error output in the expandable detail", () => {
		const command = "biome check --error-on-warnings && npm run check:pinned-deps";
		const tool = commandTool(command, "output-error", `> ${command}\nFound 1 error.`);
		const collapsed = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool], open: false }));
		expect(collapsed).toContain("运行 biome 命令失败");
		expect(collapsed).toContain("出错");
		expect(collapsed).not.toContain("Found 1 error.");
		expect(collapsed).not.toContain(command);
		const expanded = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool], open: true }));
		expect(expanded).toContain("$ biome check --error-on-warnings &amp;&amp; npm run check:pinned-deps");
		expect(expanded).toContain("Found 1 error.");
	});

	it("lets a failed command with no output reveal its original input", () => {
		const tool = commandTool("find src -name '*.ts'", "output-error");
		const collapsed = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool] }));
		expect(collapsed).toContain("查找 *.ts 文件（src）失败");
		expect(collapsed).toContain("展开详情");
		const expanded = renderToStaticMarkup(createElement(ToolBatch, { tools: [tool], initialOpen: true }));
		expect(expanded).toContain("tool-command-block");
		expect(expanded).toContain("$ find src -name");
	});

	it("uses the action icon for a homogeneous search batch", () => {
		const tools = [commandTool("find . -name app.ts", "input-available"), commandTool("find . -name index.ts", "input-available")];
		const markup = renderToStaticMarkup(createElement(ToolBatch, { tools }));
		expect(markup).toContain("lucide-search");
		expect(markup).toContain("lucide-loader-circle");
		expect(markup).not.toContain("find . -name");
	});

	it("keeps image results distinct from shell command summaries", () => {
		const imageTool: ToolBatchTool = {
			...commandTool("cat /tmp/preview.png"),
			images: [{ contentRef: "preview-1", mimeType: "image/png", byteLength: 3 }],
		};
		expect(toolRowTitle(imageTool)).toBe("已查看 1 张图像");
	});
});
