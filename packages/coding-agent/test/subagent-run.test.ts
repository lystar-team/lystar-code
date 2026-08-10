import { describe, expect, it } from "vitest";
import { SubagentRunComponent } from "../src/modes/interactive/components/subagent-run.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

initTheme("dark");

describe("SubagentRunComponent", () => {
	it("separates row expansion from the dedicated session action", () => {
		const row = new SubagentRunComponent({
			runId: "run-1",
			agentId: "agent-1",
			agent: "worker",
			agentSource: "builtin",
			agentScope: "user",
			task: "修复登录流程\n并补测试",
			state: "succeeded",
			currentAction: "正在整理结果",
			finalOutput: "已完成修改",
			session: {
				version: 1,
				sessionId: "child-session",
				sessionFile: "/tmp/child.jsonl",
				cwd: "/tmp",
				createdAt: 1,
			},
		});

		expect(row.getCardStateKey()).toBe("subagent-run:run-1:agent-1");
		expect(row.getCardClickActionAtRow(0)).toEqual({ type: "toggle", component: row });
		expect(row.render(80).map(stripAnsi)).toHaveLength(1);

		row.setExpanded(true);
		const lines = row.render(80).map(stripAnsi);
		const openRow = lines.findIndex((line) => line.includes("打开 Agent 会话"));
		expect(lines.join("\n")).toContain("任务：修复登录流程");
		expect(lines.join("\n")).toContain("结果：已完成修改");
		expect(openRow).toBeGreaterThan(0);
		expect(row.getCardClickActionAtRow(openRow)).toMatchObject({
			type: "openSubagent",
			target: { runId: "run-1", agentId: "agent-1" },
		});
	});
});
