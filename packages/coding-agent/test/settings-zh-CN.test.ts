import { describe, expect, it } from "vitest";
import { localizeSetting } from "../src/locales/settings-zh-CN.ts";

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
	});
});
