import { describe, expect, it } from "vitest";
import {
	hasUnreadProjectSessions,
	hasUnreadSessions,
	reorderIds,
} from "../src/components/workbench/project-rail-utils.ts";

describe("项目和会话拖拽插入", () => {
	it("按会话状态聚合项目和项目组的未读提示", () => {
		const unreadSessionIds = { "session-1": true } as const;
		const unreadProject = [{ id: "session-1", activity: "idle" as const }];
		const runningProject = [{ id: "session-1", activity: "running" as const }];

		expect(hasUnreadSessions(unreadProject, unreadSessionIds)).toBe(true);
		expect(hasUnreadSessions(runningProject, unreadSessionIds)).toBe(false);
		expect(hasUnreadProjectSessions([{ sessions: unreadProject }], unreadSessionIds)).toBe(true);
		expect(
			hasUnreadProjectSessions([{ sessions: [{ id: "session-2", activity: "idle" as const }] }], unreadSessionIds),
		).toBe(false);
	});

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
