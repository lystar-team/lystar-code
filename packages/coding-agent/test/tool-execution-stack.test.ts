import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolExecutionStackComponent } from "../src/modes/interactive/components/tool-execution-stack.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createTool(name: "bash" | "read", id: string, args: Record<string, unknown>): ToolExecutionComponent {
	return new ToolExecutionComponent(
		name,
		id,
		args,
		{},
		undefined,
		{ requestRender: vi.fn() } as unknown as TUI,
		process.cwd(),
	);
}

describe("ToolExecutionStackComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("preserves tool order and only groups consecutive bash calls", () => {
		const stack = new ToolExecutionStackComponent();
		const first = createTool("bash", "bash-1", { command: "npm test" });
		const second = createTool("bash", "bash-2", { command: "npm run check" });
		first.markExecutionStarted();
		second.markExecutionStarted();
		stack.addTool(first);
		stack.addTool(second);
		stack.addTool(createTool("read", "read-1", { path: "README.md" }));
		stack.addTool(createTool("bash", "bash-3", { command: "git status" }));

		const lines = stack.render(80).map(stripAnsi);
		const output = lines.join("\n");
		expect(output.indexOf("npm test")).toBeLessThan(output.indexOf("npm run check"));
		expect(output.indexOf("npm run check")).toBeLessThan(output.indexOf("README.md"));
		expect(output.indexOf("README.md")).toBeLessThan(output.indexOf("git status"));
		expect(lines.filter((line) => line.includes("正在执行 2 条命令"))).toHaveLength(1);
	});

	it("keeps divider rows non-clickable at every supported width", () => {
		const stack = new ToolExecutionStackComponent();
		stack.addTool(createTool("read", "read-1", { path: "a/very/long/path/to/README.md" }));
		stack.addTool(createTool("bash", "bash-1", { command: "git status" }));

		for (const width of [40, 80, 120]) {
			const lines = stack.render(width).map(stripAnsi);
			for (const [row, line] of lines.entries()) {
				expect(line.length).toBeGreaterThan(0);
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				if (line.includes("─")) expect(stack.getCardClickActionAtRow(row)).toBeUndefined();
			}
		}
	});
});
