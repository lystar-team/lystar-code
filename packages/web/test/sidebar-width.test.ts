import { describe, expect, it } from "vitest";
import {
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
	sidebarWidthFromPointer,
} from "../src/components/workbench/constants.ts";

describe("项目栏宽度", () => {
	it("以项目栏实际左边缘计算拖拽宽度，限制最小和最大值", () => {
		expect(sidebarWidthFromPointer(0, 64)).toBe(SIDEBAR_MIN_WIDTH);
		expect(sidebarWidthFromPointer(64 + SIDEBAR_MIN_WIDTH, 64)).toBe(SIDEBAR_MIN_WIDTH);
		expect(sidebarWidthFromPointer(64 + SIDEBAR_MAX_WIDTH + 100, 64)).toBe(SIDEBAR_MAX_WIDTH);
		expect(sidebarWidthFromPointer(600, 200)).toBe(400);
	});

	it("从最小宽度向右拖拽仍能增大宽度", () => {
		expect(sidebarWidthFromPointer(64 + SIDEBAR_MIN_WIDTH, 64)).toBe(SIDEBAR_MIN_WIDTH);
		expect(sidebarWidthFromPointer(64 + 392, 64)).toBe(392);
	});
});
