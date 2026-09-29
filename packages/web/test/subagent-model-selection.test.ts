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

	it("宽屏四列卡片区分内置与个人智能体", () => {
		const state = {
			subagentConfigs: [
				{ name: "worker", description: "内置", content: "", scope: "builtin", editable: false },
				{ name: "custom", description: "个人", content: "", scope: "user", editable: true, contentHash: "hash" },
			],
			modelOptions: [],
			modelOptionProviders: [],
			skills: [],
		} as WorkbenchState;
		const html = renderToStaticMarkup(createElement(SubagentSettings, { state, actions: {} as WorkbenchActions }));
		expect(html).toContain("2xl:grid-cols-4");
		expect(html).toContain("内置智能体不可删除");
		expect(html.match(/>删除<\/button>/gu)).toHaveLength(1);
	});
});
