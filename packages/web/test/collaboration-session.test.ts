import { describe, expect, it } from "vitest";
import {
	collaborationAgentKind,
	collaborationAlias,
	collaborationSessionsForSession,
	collaborationStatus,
	isCollaborationSession,
} from "../src/components/workbench/collaboration-session.tsx";
import type { WebSessionSummary } from "../src/types.ts";

function session(input: Partial<WebSessionSummary> & Pick<WebSessionSummary, "id">): WebSessionSummary {
	return {
		createdAt: 1,
		updatedAt: 1,
		messageCount: 1,
		firstMessage: "任务",
		activity: "idle",
		writeAccess: "available",
		...input,
	};
}

describe("协作会话展示数据", () => {
	it("按父会话返回主会话和协作子会话", () => {
		const root = session({ id: "root" });
		const child = session({
			id: "child",
			parentId: "root",
			relation: "collaboration",
			profileId: "code-review",
			profileName: "代码审阅",
		});
		const unrelated = session({ id: "other" });

		expect(collaborationSessionsForSession([child, unrelated, root], "root").map((item) => item.id)).toEqual([
			"root",
			"child",
		]);
		expect(isCollaborationSession(child)).toBe(true);
		expect(isCollaborationSession(root)).toBe(false);
	});

	it("子会话只显示自己的下级", () => {
		const root = session({ id: "root" });
		const child = session({ id: "child", parentId: "root", relation: "collaboration" });
		const grandchild = session({ id: "grandchild", parentId: "child", relation: "collaboration" });
		expect(collaborationSessionsForSession([root, child, grandchild], "child").map((item) => item.id)).toEqual([
			"child",
			"grandchild",
		]);
		expect(collaborationSessionsForSession([root, child, grandchild], "root").map((item) => item.id)).toEqual([
			"root",
			"child",
		]);
	});

	it("为同一个会话生成稳定别名并识别智能体类型", () => {
		const child = session({ id: "child", profileId: "code-review", profileName: "代码审阅" });
		expect(collaborationAlias(child.id)).toBe(collaborationAlias(child.id));
		expect(collaborationAgentKind(child)).toBe("code");
		expect(collaborationStatus({ ...child, activity: "running" })).toBe("进行中");
	});
});
