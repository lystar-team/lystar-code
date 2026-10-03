import { describe, expect, it } from "vitest";
import { thinkingLevelAfterModelChange } from "../src/components/workbench/settings/subagent-model-selection.ts";

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

});
