import { describe, expect, it } from "vitest";
import {
	buildSessionTurns,
	formatSessionTreeTimestamp,
	sessionTreeNodeKindLabel,
	sessionTreeNodeLabel,
	sessionTurnLabel,
} from "../src/components/workbench/session-tree-utils";

function node(preview: unknown, kind = "message") {
	return {
		id: "entry-1",
		parentId: null,
		kind,
		preview: JSON.stringify(preview),
		timestamp: "2026-09-08T07:00:00.000Z",
		isLeaf: false,
		depth: 0,
	};
}

describe("session turn presentation", () => {
	it("将用户消息转换成可理解的提交摘要", () => {
		const item = node({ role: "user", content: "请检查登录流程" });
		expect(sessionTreeNodeLabel(item)).toBe("用户提交：请检查登录流程");
		expect(sessionTreeNodeKindLabel(item)).toBe("用户消息");
	});

	it("会话树摘要隐藏内部文件引用", () => {
		const item = node({ role: "user", content: '说明\n<file name="/tmp/report.md"></file>' });
		expect(sessionTreeNodeLabel(item)).toBe("用户提交：说明");
	});
	it("将工具调用转换成工具摘要而不是展示原始 JSON", () => {
		const item = node({ role: "assistant", content: [{ type: "toolCall", name: "read" }] });
		expect(sessionTreeNodeLabel(item)).toBe("Agent：调用工具：read");
		expect(sessionTreeNodeKindLabel(item)).toBe("Agent 回复");
	});

	it("无法解析被截断的预览时不展示残缺 JSON", () => {
		const item = { ...node('{"role":"user","content":"未完成'), preview: '{"role":"user","content":"未完成' };
		expect(sessionTreeNodeLabel(item)).toBe("用户消息");
	});

	it("按最新轮次倒序聚合用户提交、回复和工具动作", () => {
		const makeNode = (id: string, timestamp: string, preview: unknown, isLeaf = false) => ({
			...node(preview),
			id,
			timestamp,
			isLeaf,
		});
		const turns = buildSessionTurns([
			{ ...makeNode("session", "2026-09-08T06:00:00.000Z", {}), kind: "session" },
			makeNode("user-old", "2026-09-08T07:00:00.000Z", { role: "user", content: "旧提交" }),
			makeNode("assistant-old", "2026-09-08T07:01:00.000Z", { role: "assistant", content: "旧回复" }),
			makeNode("tool-old", "2026-09-08T07:02:00.000Z", {
				role: "toolResult",
				toolName: "read",
				content: "读取完成",
			}),
			makeNode("user-new", "2026-09-08T08:00:00.000Z", { role: "user", content: "新提交" }),
			makeNode("assistant-new", "2026-09-08T08:01:00.000Z", { role: "assistant", content: "新回复" }, true),
		]);

		expect(turns.map((turn) => turn.id)).toEqual(["user-new", "user-old"]);
		expect(turns[0]?.forkEntryId).toBe("user-new");
		expect(turns[1]?.toolNodes.map((item) => item.id)).toEqual(["tool-old"]);
		expect(sessionTurnLabel(turns[0]!)).toBe("用户提交：新提交");
	});

	it("格式化节点时间", () => {
		expect(formatSessionTreeTimestamp("invalid")).toBe("时间未知");
	});
});
