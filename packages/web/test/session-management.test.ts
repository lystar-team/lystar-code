import { describe, expect, it } from "vitest";
import { formatSessionTimestamp, sortSessionSummaries } from "../src/components/workbench/session-management.ts";
import type { WebSessionSummary } from "../src/types.ts";

function session(id: string, name: string, createdAt: number, updatedAt: number): WebSessionSummary {
	return {
		id,
		name,
		createdAt,
		updatedAt,
		messageCount: 1,
		firstMessage: name,
		activity: "idle",
		writeAccess: "available",
	};
}

describe("会话管理排序", () => {
	const sessions = [session("a", "Beta", 100, 400), session("b", "Alpha", 300, 200), session("c", "Gamma", 200, 500)];

	it("按最后回复时间倒序且不修改原数组", () => {
		expect(sortSessionSummaries(sessions, "last-reply").map((item) => item.id)).toEqual(["c", "a", "b"]);
		expect(sessions.map((item) => item.id)).toEqual(["a", "b", "c"]);
	});

	it("支持创建时间和标题排序", () => {
		expect(sortSessionSummaries(sessions, "created").map((item) => item.id)).toEqual(["b", "c", "a"]);
		expect(sortSessionSummaries(sessions, "title").map((item) => item.id)).toEqual(["b", "a", "c"]);
	});

	it("当前顺序只复制数组", () => {
		const result = sortSessionSummaries(sessions, "manual");
		expect(result).toEqual(sessions);
		expect(result).not.toBe(sessions);
	});

	it("输出可读的中文时间", () => {
		expect(formatSessionTimestamp(Date.UTC(2025, 0, 2, 3, 4))).toContain("2025");
	});
});
