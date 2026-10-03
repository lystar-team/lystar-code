import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { toSessionItemViewModel } from "../src/adapters/session-view-model.ts";
import {
	ToolBatch,
	type ToolBatchTool,
	toolBatchSummaryLabel,
	toolRowTitle,
} from "../src/components/ai-elements/tool-batch.tsx";

function tool(
	name: string,
	input: Record<string, unknown>,
	state: ToolBatchTool["state"] = "output-available",
): ToolBatchTool {
	return { id: `${name}:${JSON.stringify(input)}`, name, summary: JSON.stringify(input), state };
}

function markup(tools: ToolBatchTool[], open = false): string {
	return renderToStaticMarkup(createElement(ToolBatch, { tools, open }));
}

describe("compact tool presentation", () => {
	it("keeps the search pattern and scope in the action", () => {
		expect(toolRowTitle(tool("grep", { pattern: "bootstrap|subscribeSession", path: "packages/web" }))).toBe(
			"在 packages/web 搜索 bootstrap|subscribeSession",
		);
		expect(toolRowTitle(tool("find", { pattern: "*.test.ts", path: "packages/web/test" }))).toBe(
			"在 packages/web/test 查找文件 *.test.ts",
		);
	});

	it("distinguishes collaboration actions while keeping the message in details", () => {
		const input = { text: "核对命令摘要", sessionId: "session-1" };
		expect(toolRowTitle(tool("session_send", input))).toBe("向 智能体 发送消息");
		expect(toolRowTitle(tool("session_send", { ...input, mode: "steer" }))).toBe("调整 智能体 的任务");
		expect(toolRowTitle(tool("session_send", { ...input, mode: "follow_up" }))).toBe("向 智能体 追加任务");
		expect(toolRowTitle(tool("session_wait", { sessionIds: ["session-1", "session-2"] }))).toBe(
			"等待 2 个智能体返回结果",
		);
		expect(markup([tool("session_send", input)])).not.toContain("核对命令摘要");
		expect(markup([tool("session_send", input)], true)).toContain("核对命令摘要");
	});

	it("names the MCP tool and moves the arguments into its expandable details", () => {
		const current = tool("mcp", { tool: "server_browser_open", args: { url: "https://example.com/docs" } });
		expect(toolRowTitle(current)).toBe("调用 server_browser_open");
		expect(markup([current])).not.toContain("https://example.com/docs");
		expect(markup([current], true)).toContain("https://example.com/docs");
	});

	it("keeps parallel call parameters available without a second preview row", () => {
		const current = tool("multi_tool_use.parallel", {
			tool_uses: [
				{ recipient_name: "functions.bash", parameters: { command: "npm run check" } },
				{ recipient_name: "functions.read", parameters: { path: "src/app.ts" } },
			],
		});
		expect(toolRowTitle(current)).toContain("functions.bash、functions.read");
		expect(markup([current])).not.toContain("npm run check");
		const expanded = markup([current], true);
		expect(expanded).toContain("npm run check");
		expect(expanded).toContain("src/app.ts");
	});

	it("keeps a file count in a closed group and lists each file when opened", () => {
		const tools = [
			tool("read", { path: "src/api.ts" }),
			tool("read", { path: "src/state.ts" }),
			tool("read", { path: "src/view.tsx" }),
		];
		const closed = markup(tools);
		expect(closed).toContain("读取 3 个文件");
		expect(closed).not.toContain("3 项已完成");
		expect(closed).not.toContain("api.ts");
		const opened = markup(tools, true);
		for (const filename of ["api.ts", "state.ts", "view.tsx"]) expect(opened).toContain(filename);
	});

	it("shows two reads of the same file as two immediate rows with their own line ranges", () => {
		const html = markup([
			tool("read", { path: "src/state/index.ts", offset: 1, limit: 100 }),
			tool("read", { path: "src/state/index.ts", offset: 101, limit: 100 }),
		]);
		expect(html.match(/data-transcript-anchor-key=/gu)).toHaveLength(2);
		expect(html).toContain("第1-100行");
		expect(html).toContain("第101-200行");
		expect(html).not.toContain("次）");
		expect(html).not.toContain("个文件");
	});

	it("retains every read and its directory when repeated reads mix with another file", () => {
		const html = markup([
			tool("read", { path: "src/state/index.ts", offset: 1, limit: 100 }),
			tool("read", { path: "src/state/index.ts", offset: 101, limit: 100 }),
			tool("read", { path: "test/state/index.ts", offset: 1, limit: 100 }),
		]);
		expect(html.match(/data-transcript-anchor-key=/gu)).toHaveLength(3);
		expect(html).toContain("src/state/");
		expect(html).toContain("test/state/");
		expect(html).not.toContain("次）");
	});

	it("uses one short group error status and leaves individual outcomes in the expanded rows", () => {
		const tools = [
			tool("read", { path: "a.ts" }),
			tool("read", { path: "b.ts" }, "output-error"),
			tool("read", { path: "c.ts" }, "output-cancelled"),
			tool("read", { path: "d.ts" }, "output-interrupted"),
		];
		const closed = markup(tools);
		expect(closed).toContain("1 项出错");
		expect(closed).not.toContain("data-batch-exceptions");
		expect(closed).not.toContain("1 项已完成");
		const opened = markup(tools, true);
		for (const state of ["出错", "已取消", "已中断"]) expect(opened).toContain(state);
	});

	it("uses two distinct action labels and a total for a larger command group", () => {
		const tools = [
			tool("bash", { command: "node node_modules/vitest/dist/cli.js --run test/a.test.ts" }),
			tool("bash", { command: "npm run check" }),
			tool("bash", { command: "git diff --check" }),
			tool("bash", { command: "rg -n renewal src" }),
		];
		expect(toolBatchSummaryLabel(tools)).toBe("运行 Vitest 测试、检查 check 脚本等 4 项");
		expect(markup(tools)).not.toContain("搜索 renewal");
		const opened = markup(tools, true);
		for (const action of ["运行 Vitest 测试", "检查 check 脚本", "检查代码差异", "搜索 renewal"])
			expect(opened).toContain(action);
	});

	it("shows a failed command with a stable action and a single error status", () => {
		const current = tool("bash", { command: "npm run check" }, "output-error");
		expect(toolRowTitle(current)).toBe("检查 check 脚本");
		expect(markup([current])).toContain("检查 check 脚本，出错，展开详情");
		expect(markup([current])).not.toContain("未完成");
	});

	it("preserves page-opening and page-search actions through the historical adapter", () => {
		const url = "https://example.com/docs";
		for (const [action, title] of [
			["open_page", `打开网页 ${url}`],
			["find_in_page", `在 ${url} 查找 lifecycle`],
		] as const) {
			const view = toSessionItemViewModel({
				entryId: action,
				parentId: null,
				timestamp: "2026-10-02T00:00:00Z",
				kind: "message",
				renderId: action,
				view: {
					type: "web_search",
					id: action,
					status: "completed",
					sources: [],
					webSearch: { status: "completed", action, url, pattern: "lifecycle", sources: [] },
				},
			});
			if (view.kind !== "tools") throw new Error("Missing web search tool");
			expect(toolRowTitle(view.tools[0])).toBe(title);
		}
	});
});
