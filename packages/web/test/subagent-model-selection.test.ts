import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { thinkingLevelAfterModelChange } from "../src/components/workbench/settings/subagent-model-selection.ts";
import { SubagentSettings } from "../src/components/workbench/settings/subagents.tsx";
import type { WorkbenchActions } from "../src/components/workbench/types.ts";
import type { WorkbenchState } from "../src/state/use-workbench.ts";

describe("智能体切换基础模型", () => {
	it("新模型支持原思考强度时保留选择", () => {
		expect(thinkingLevelAfterModelChange("high", ["off", "medium", "high"])).toBe("high");
	});

	it("新模型不支持原思考强度时继承模型设置", () => {
		expect(thinkingLevelAfterModelChange("high", ["off", "low"])).toBe("");
	});

	it("模型能力未知或改为继承时不清除原选择", () => {
		expect(thinkingLevelAfterModelChange("high", [])).toBe("high");
		expect(thinkingLevelAfterModelChange("high", undefined)).toBe("high");
	});

	it("宽屏四列卡片展示可管理角色，不提供内置角色", () => {
		const state = {
			subagentConfigs: [
				{
					id: "frontend-developer",
					name: "前端开发",
					description: "开发页面",
					content: "",
					scope: "user",
					editable: true,
					contentHash: "first",
				},
				{
					id: "reviewer",
					name: "页面审查",
					description: "检查页面",
					content: "",
					scope: "project",
					editable: true,
					contentHash: "second",
				},
			],
			modelOptions: [],
			modelOptionProviders: [],
			skills: [],
		} as WorkbenchState;
		const html = renderToStaticMarkup(createElement(SubagentSettings, { state, actions: {} as WorkbenchActions }));
		expect(html).toContain("2xl:grid-cols-4");
		expect(html).not.toContain("内置智能体");
		expect(html).toContain("前端开发");
		expect(html.match(/>删除<\/button>/gu)).toHaveLength(2);
	});
});
