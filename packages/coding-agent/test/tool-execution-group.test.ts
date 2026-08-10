import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolExecutionGroupComponent } from "../src/modes/interactive/components/tool-execution-group.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { uiGlyphs } from "../src/modes/interactive/ui-glyphs.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createTool(id: string, command: string): ToolExecutionComponent {
	return new ToolExecutionComponent(
		"bash",
		id,
		{ command },
		{},
		undefined,
		{ requestRender: vi.fn() } as unknown as TUI,
		process.cwd(),
	);
}

describe("ToolExecutionGroupComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("renders one bash call without a group header", () => {
		const group = new ToolExecutionGroupComponent();
		const tool = createTool("tool-1", "git status");
		group.addTool(tool);

		const lines = group.render(100).map(stripAnsi);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("正在运行");
		expect(lines[0]).toContain(uiGlyphs.collapsed);
		expect(lines[1]).toContain("git status");
		expect(lines.join("\n")).not.toContain("条命令");
		expect(group.getExpansionTargetAtRow(0)).toEqual({ component: tool, row: 0 });
		expect(group.getExpansionTargetAtRow(1)).toEqual({ component: tool, row: 1 });
	});

	it("keeps parallel commands ordered and separated by a non-clickable divider", () => {
		const group = new ToolExecutionGroupComponent();
		const first = createTool("tool-1", "npm test");
		const second = createTool("tool-2", "git status");
		group.addTool(first);
		group.addTool(second);
		first.markExecutionStarted();
		second.markExecutionStarted();

		let lines = group.render(100).map(stripAnsi);
		expect(lines[0]).toContain(uiGlyphs.list);
		expect(lines[0]).toContain(uiGlyphs.expanded);
		expect(lines[0]).toContain("正在执行 2 条命令 · 已完成 0/2");
		expect(lines[2]).toContain("npm test");
		expect(lines[3]).toContain("─");
		expect(lines[5]).toContain("git status");
		expect(lines.every((line) => line.trim().length > 0)).toBe(true);

		first.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		lines = group.render(100).map(stripAnsi);
		expect(lines[0]).toContain("已完成 1/2");
		expect(lines[2]).toContain("npm test");
		expect(lines[5]).toContain("git status");

		second.updateResult({ content: [{ type: "text", text: "failed" }], isError: true });
		lines = group.render(100).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("2 条命令执行完成 · 1 条失败");
		expect(lines[0]).toContain(uiGlyphs.collapsed);
		expect(group.isExpanded()).toBe(false);

		group.setExpanded(true);
		const expandedLines = group.render(100);
		expect(expandedLines.length).toBeGreaterThan(1);
		expect(group.render(100)).toHaveLength(expandedLines.length);
	});

	it("reports cancelled commands separately from failures", () => {
		const group = new ToolExecutionGroupComponent();
		const first = createTool("tool-1", "sleep 10");
		const second = createTool("tool-2", "git status");
		group.addTool(first);
		group.addTool(second);
		first.markCancelled("请求已取消");
		second.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });

		const lines = group.render(100).map(stripAnsi);
		expect(first.getExecutionStatus()).toBe("cancelled");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("2 条命令执行结束 · 1 条取消");
		expect(lines[0]).not.toContain("失败");
		expect(group.isExpanded()).toBe(false);
	});

	it("resolves header and child expansion targets without treating spacing as clickable", () => {
		const group = new ToolExecutionGroupComponent();
		const first = createTool("tool-1", "npm test");
		const second = createTool("tool-2", "git status");
		group.addTool(first);
		group.addTool(second);
		group.render(100);

		expect(group.getExpansionTargetAtRow(0)).toEqual({ component: group, row: 0 });
		expect(group.getExpansionTargetAtRow(1)).toEqual({ component: first, row: 0 });
		expect(group.getExpansionTargetAtRow(2)).toEqual({ component: first, row: 1 });
		expect(group.getExpansionTargetAtRow(3)).toBeUndefined();
		expect(group.getExpansionTargetAtRow(4)).toEqual({ component: second, row: 0 });
		expect(group.getExpansionTargetAtRow(5)).toEqual({ component: second, row: 1 });
		expect(group.getCardClickActionAtRow(0)).toEqual({ type: "toggle", component: group });
		expect(group.getCardClickActionAtRow(1)).toEqual({ type: "toggle", component: first });
		expect(group.getCardClickActionAtRow(2)).toEqual({ type: "toggle", component: first });
		expect(group.getCardClickActionAtRow(3)).toBeUndefined();
		expect(group.getCardClickActionAtRow(4)).toEqual({ type: "toggle", component: second });

		group.setExpanded(false);
		expect(group.isExpanded()).toBe(false);
		group.setToolOutputsExpanded(true);
		expect(group.isExpanded()).toBe(false);
		expect(group.render(100)).toHaveLength(1);
		expect(group.getExpansionTargetAtRow(1)).toBeUndefined();
	});
});
