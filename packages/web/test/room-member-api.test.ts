import { afterEach, describe, expect, it, vi } from "vitest";
import { WebApi } from "../src/adapters/host-protocol/api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Room 智能体改名 API", () => {
	it("按成员会话 ID 提交新昵称", async () => {
		vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ room: {}, members: [], latestSeq: 0 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetch);
		await new WebApi().renameRoomMember("project-a", "room-a", "worker-2", "星河");
		expect(fetch).toHaveBeenCalledWith(
			"/api/projects/project-a/rooms/room-a/rename-member",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ sessionId: "worker-2", nickname: "星河" }) }),
		);
	});
});
