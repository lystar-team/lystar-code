import { describe, expect, it } from "vitest";
import { localizeSetting, localizeSettingValue } from "../src/locales/settings-zh-CN.ts";

describe("settings zh-CN display values", () => {
	it("localizes visible values without changing stored values", () => {
		const item = localizeSetting({
			id: "steering-mode",
			label: "Steering mode",
			currentValue: "one-at-a-time",
			values: ["one-at-a-time", "all"],
		});

		expect(item.currentValue).toBe("one-at-a-time");
		expect(item.values).toEqual(["one-at-a-time", "all"]);
		expect(item.formatValue(item.currentValue)).toBe("逐条处理");
		expect(localizeSettingValue("autocompact", "true")).toBe("开启");
		expect(localizeSettingValue("thinking", "high")).toBe("深度");
		expect(localizeSettingValue("default-project-trust", "ask")).toBe("每次询问");
	});
});
