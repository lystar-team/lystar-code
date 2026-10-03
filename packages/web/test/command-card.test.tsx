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

function render(tools: ToolBatchTool[], open = false, initialToolOpen?: ReadonlyMap<string, boolean>): string {
	return renderToStaticMarkup(createElement(ToolBatch, { tools, open, initialToolOpen }));
}

describe("command activity card", () => {
	it("keeps the action and running status in one row and moves the command into details", () => {
		const command = "find /workspace -maxdepth 3 -name 'tsconfig*'";
		const tool = commandTool(command, "input-available");
		const collapsed = render([tool]);
		expect(collapsed).toContain("查找 tsconfig* 文件（/workspace）");
		expect(collapsed).toContain("lucide-search");
		expect(collapsed).toContain("lucide-loader-circle");
		expect(collapsed).toContain("运行中");
		expect(collapsed).not.toContain('data-command-preview="true"');
		expect(collapsed).not.toContain("-maxdepth 3 -name");
		expect(collapsed).not.toContain("tool-command-output");
		const expanded = render([tool], true);
		expect(expanded).toContain("tool-command-block");
		expect(expanded).toContain("复制命令和输出");
	});

	it("lists the operations when a command batch is collapsed and keeps each original input reachable", () => {
		const tools = [commandTool("find src -name 'app.ts'", "output-available", "src/app.ts"), commandTool("rg -n renewal src", "output-available", "")];
		const collapsed = render(tools);
		expect(collapsed).toContain("查找 app.ts 文件（src）、搜索 renewal（src） 2 项");
		expect(collapsed).toContain("已完成");
		expect(collapsed).not.toContain("2 项已完成");
		const expanded = render(tools, true, new Map([[tools[1].id, true]]));
		expect(expanded).toContain("rg -n renewal src");
		expect(expanded).toContain("tool-command-block");
	});

	it("describes the actual program behind npm exec and retains its project argument", () => {
		const command = "npm exec -- tsgo -p packages/web/tsconfig.json --noEmit";
		const markup = render([commandTool(command)]);
		expect(markup).toContain("检查 TypeScript 类型（packages/web/tsconfig.json）");
		expect(markup).toContain("lucide-package");
		expect(markup).not.toContain(command);
		expect(render([commandTool(command)], true)).toContain("--noEmit");
		expect(markup).not.toContain("-- 脚本");
	});

	it("keeps every operation and the full original compound command", () => {
		const command = `cd /workspace && version="0.87.1-lystar.4" && tag="v\${version}" && git tag -a "$tag" HEAD -m "LYStar Code $tag" && git push origin "$tag" 2>&1 | tail -5 && git ls-remote origin "refs/tags/$tag"`;
		const tool = commandTool(command, "input-available");
		const markup = render([tool]);
		expect(markup).toContain("创建 Git 标签、推送到远端仓库并查询远端标签");
		expect(markup).toContain("lucide-git-branch");
		expect(markup).not.toContain("git tag -a");
		expect(markup).not.toContain("git ls-remote");
		expect(markup).not.toContain("组合命令");
		const expanded = render([tool], true);
		expect(expanded).toContain("tool-command-block");
		expect(expanded).toContain("git tag -a");
		expect(expanded).toContain("git ls-remote");
	});

	it("does not certify a pipeline's push from the shell exit status", () => {
		const tool = commandTool("git push origin main 2>&1 | tail -5", "output-available", "fatal: push failed");
		const collapsed = render([tool]);
		expect(collapsed).toContain("推送到远端仓库，已执行，展开详情");
		expect(collapsed).not.toContain("已推送到远端仓库");
		expect(collapsed).not.toContain(" · ");
		expect(collapsed).not.toContain("fatal: push failed");
		expect(render([tool], true)).toContain("fatal: push failed");
	});

	it("shows Git mutations without declaring that the task succeeded", () => {
		for (const [command, title] of [
			["git tag -f v1 HEAD", "创建或更新 Git 标签"],
			["git push origin --delete obsolete", "删除远端引用"],
		] as const) {
			const markup = render([commandTool(command)]);
			expect(markup).toContain(title);
			expect(markup).toContain("lucide-git-branch");
			expect(markup).not.toContain(command);
			expect(render([commandTool(command)], true)).toContain(command);
		}
	});

	it("keeps failures in one row and shows the command and error after expanding", () => {
		const tool = commandTool("npm run check", "output-error", "error TS2304: Cannot find name 'config'");
		const collapsed = render([tool]);
		expect(collapsed).toContain("检查 check 脚本，出错，展开详情");
		expect(collapsed).not.toContain("未完成");
		expect(collapsed).not.toContain("npm run check");
		expect(collapsed).toContain("lucide-package");
		expect(collapsed).not.toContain("error TS2304");
		const expanded = render([tool], true);
		expect(expanded).toContain("tool-command-output");
		expect(expanded).toContain("error TS2304");
	});

	it("keeps command echoes and error output in the expandable detail", () => {
		const command = "biome check --error-on-warnings && npm run check:pinned-deps";
		const tool = commandTool(command, "output-error", `> ${command}\nFound 1 error.`);
		const collapsed = render([tool]);
		expect(collapsed).not.toContain(command);
		expect(collapsed).not.toContain('data-command-preview="true"');
		expect(collapsed).toContain("check:pinned-deps");
		expect(collapsed).toContain("出错");
		expect(collapsed).not.toContain("Found 1 error.");
		expect(render([tool], true)).toContain("Found 1 error.");
	});

	it("lets a failed command with no output reveal its original input", () => {
		const tool = commandTool("find src -name '*.ts'", "output-error");
		expect(render([tool])).toContain("查找 *.ts 文件（src），出错，展开详情");
		expect(render([tool])).toContain("展开详情");
		expect(render([tool], true)).toContain("tool-command-block");
	});

	it("uses search icons alongside status for an active search batch", () => {
		const tools = [commandTool("find . -name app.ts", "input-available"), commandTool("find . -name index.ts", "input-available")];
		const markup = render(tools, true);
		expect(markup).toContain("运行中");
		expect(markup).not.toContain("2 项运行中");
		expect(markup).not.toContain("find . -name");
	});

	it("keeps image results distinct from shell command summaries", () => {
		const tool: ToolBatchTool = { ...commandTool("cat /tmp/preview.png"), images: [{ contentRef: "preview-1", mimeType: "image/png", byteLength: 3 }] };
		expect(toolRowTitle(tool)).toBe("已查看 1 张图像");
	});
});
