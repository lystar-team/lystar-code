import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolBatch, type ToolBatchTool } from "../src/components/ai-elements/tool-batch.tsx";

function subagentTool(subagents: NonNullable<ToolBatchTool["subagents"]>): ToolBatchTool {
	return {
		id: "subagent-tool",
		name: "subagent",
		summary: "执行子任务",
		state: "output-available",
		subagents,
	};
}

describe("Historical Subagent tool cards", () => {
	it("renders one Agent task on the clickable tool row", () => {
		const markup = renderToStaticMarkup(
			createElement(ToolBatch, {
				initialOpen: true,
				onOpenSubagent: () => {},
				tools: [
					subagentTool([
						{
							runId: "run-1",
							agentId: "run-1:1",
							agent: "reviewer",
							task: "检查实现",
							state: "succeeded",
						},
					]),
				],
			}),
		);

		expect(markup).toContain("reviewer");
		expect(markup).toContain("检查实现");
		expect(markup).toContain("查看");
	});

	it("renders separate Agent actions for parallel results", () => {
		const markup = renderToStaticMarkup(
			createElement(ToolBatch, {
				initialOpen: true,
				onOpenSubagent: () => {},
				tools: [
					subagentTool([
						{
							runId: "run-2",
							agentId: "run-2:1",
							agent: "reviewer",
							task: "检查实现",
							state: "failed",
						},
						{
							runId: "run-2",
							agentId: "run-2:2",
							agent: "worker",
							task: "编写测试",
							state: "cancelled",
						},
					]),
				],
			}),
		);

		expect(markup).toContain("reviewer");
		expect(markup).toContain("worker");
		expect(markup).toContain("失败");
		expect(markup).toContain("已停止");
	});
});
