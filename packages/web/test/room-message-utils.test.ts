import { describe, expect, it } from "vitest";
import {
	addPendingRoomAgentReplies,
	mergeRoomMessages,
	type PendingRoomAgentReply,
	settlePendingRoomAgentReplies,
} from "../src/components/workbench/room-message-utils.ts";
import type { WebRoomMessage } from "../src/types.ts";

function message(input: Partial<WebRoomMessage> & Pick<WebRoomMessage, "id" | "seq">): WebRoomMessage {
	return {
		roomId: "room-1",
		senderSessionId: "owner",
		senderType: "agent",
		targetSessionIds: ["owner"],
		route: "direct",
		kind: "answer",
		body: input.id,
		idempotencyKey: input.id,
		createdAt: "2026-09-23T00:00:00.000Z",
		...input,
	};
}

describe("Room 消息顺序", () => {
	it("合并轮询和即时发送结果时按 Room 序号排序并去重", () => {
		const first = message({ id: "first", seq: 1 });
		const second = message({ id: "second", seq: 2 });

		expect(mergeRoomMessages([second], [first, second])).toEqual([first, second]);
	});
});

describe("Room Agent 回复状态", () => {
	it("为每个尚未响应的目标添加独立状态并排除失败或已回复的 Agent", () => {
		const request = message({
			id: "prompt",
			seq: 1,
			senderType: "user",
			kind: "message",
			targetSessionIds: ["agent-a", "agent-b", "agent-c"],
		});
		const response = message({
			id: "answer-a",
			seq: 2,
			senderSessionId: "agent-a",
			kind: "answer",
			replyToMessageId: request.id,
		});

		expect(addPendingRoomAgentReplies([], "project-1", request, [response], ["agent-c"])).toEqual([
			{
				projectId: "project-1",
				roomId: "room-1",
				requestMessageId: "prompt",
				sessionId: "agent-b",
				createdAt: request.createdAt,
			},
		]);
	});

	it("只在目标 Agent 返回最终答案或系统错误后清除状态", () => {
		const pending: PendingRoomAgentReply[] = ["agent-a", "agent-b"].map((sessionId) => ({
			projectId: "project-1",
			roomId: "room-1",
			requestMessageId: "prompt",
			sessionId,
			createdAt: "2026-09-23T00:00:00.000Z",
		}));
		const status = message({
			id: "status-a",
			seq: 2,
			senderSessionId: "agent-a",
			kind: "status",
			replyToMessageId: "prompt",
		});
		const answer = message({
			id: "answer-b",
			seq: 3,
			senderSessionId: "agent-b",
			kind: "system",
			replyToMessageId: "prompt",
		});

		expect(settlePendingRoomAgentReplies(pending, [status, answer])).toEqual([pending[0]]);
	});
});
