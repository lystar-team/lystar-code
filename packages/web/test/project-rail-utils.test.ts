import { describe, expect, it } from "vitest";
import { reorderIds } from "../src/components/workbench/project-rail-utils.ts";

describe("项目和会话拖拽插入", () => {
	it("拖到目标上方插入", () => {
		expect(reorderIds(["a", "b", "c"], "c", "b", "before")).toEqual(["a", "c", "b"]);
	});

	it("拖到目标下方插入", () => {
		expect(reorderIds(["a", "b", "c"], "a", "b", "after")).toEqual(["b", "a", "c"]);
	});

	it("源和目标无效时保留原顺序", () => {
		expect(reorderIds(["a", "b"], "a", "missing", "after")).toEqual(["a", "b"]);
		expect(reorderIds(["a", "b"], "a", "a", "before")).toEqual(["a", "b"]);
	});
});
