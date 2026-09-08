import { describe, expect, it } from "vitest";
import { truncateSessionTitle } from "../src/components/workbench/session-button";

describe("会话标题展示", () => {
	it("40 个字符以内保持原文", () => {
		const title = "会".repeat(40);
		expect(truncateSessionTitle(title)).toBe(title);
	});

	it("超过 40 个字符时只保留前 40 个字符并追加省略号", () => {
		const title = "会".repeat(41);
		expect(truncateSessionTitle(title)).toBe(`${"会".repeat(40)}...`);
	});

	it("按 Unicode 字符截断，不拆分代理项", () => {
		const title = "🙂".repeat(41);
		expect(truncateSessionTitle(title)).toBe(`${"🙂".repeat(40)}...`);
	});
});
