import { describe, expect, it } from "vitest";
import { markRoomAgentSessions } from "../src/room-session-visibility.ts";

describe("Room Agent 会话标记", () => {
	it("标记 Room 成员会话但保留 Room Owner 普通会话", () => {
		const sessions = [{ id: "owner" }, { id: "agent" }, { id: "normal" }];
		const rooms = [
			{
				members: [
					{ sessionId: "owner", role: "owner" as const },
					{ sessionId: "agent", role: "member" as const },
				],
			},
		];

		expect(markRoomAgentSessions(sessions, rooms)).toEqual([
			{ id: "owner" },
			{ id: "agent", roomMember: true },
			{ id: "normal" },
		]);
	});

	it("将退出 Room 的成员会话继续标记为 Room 会话", () => {
		const sessions = [{ id: "agent" }];
		const rooms = [
			{ members: [{ sessionId: "agent", role: "member" as const, leftAt: "2026-09-23T00:00:00.000Z" }] },
		];

		expect(markRoomAgentSessions(sessions, rooms)).toEqual([{ id: "agent", roomMember: true }]);
	});
});
