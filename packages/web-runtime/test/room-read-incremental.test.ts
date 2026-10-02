import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRoomCoordinator } from "../src/session-room-coordinator.ts";
import { SessionRoomStore } from "../src/session-room-store.ts";

const fixtures: Array<{ cwd: string; coordinator: SessionRoomCoordinator }> = [];

async function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "room-read-incremental-"));
	const store = new SessionRoomStore(join(cwd, "rooms.jsonl"));
	const coordinator = new SessionRoomCoordinator({ store, deliver: async () => {} });
	fixtures.push({ cwd, coordinator });
	const api = coordinator.api();
	const { room } = await api.create({ cwd, ownerSessionId: "owner" });
	await api.join({ cwd, roomId: room.id, sessionId: "member", profileId: "developer" });
	const input = { cwd, roomId: room.id, sessionId: "owner" };
	for (const body of ["接口字段已确认", "补充订单状态映射"]) {
		await api.send({
			cwd,
			roomId: room.id,
			senderSessionId: "owner",
			route: "direct",
			targetSessionIds: ["member"],
			body,
		});
	}
	return { api, input, store };
}

afterEach(() => {
	for (const { cwd, coordinator } of fixtures.splice(0)) {
		coordinator.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

describe("协作消息增量读取", () => {
	it("默认从已读游标继续，分页读取后不重复旧消息", async () => {
		const { api, input } = await fixture();
		const first = await api.read({ ...input, limit: 1 });
		expect(first.messages.map((message) => message.body)).toEqual(["接口字段已确认"]);
		expect(first.cursor.lastReadSeq).toBe(1);

		const second = await api.read({ ...input, limit: 1 });
		expect(second.messages.map((message) => message.body)).toEqual(["补充订单状态映射"]);
		expect(second.cursor.lastReadSeq).toBe(2);
		expect((await api.read(input)).messages).toEqual([]);

		await api.send({
			cwd: input.cwd,
			roomId: input.roomId,
			senderSessionId: input.sessionId,
			route: "direct",
			targetSessionIds: ["member"],
			body: "交付文件已核对",
		});
		const latest = await api.read(input);
		expect(latest.messages.map((message) => message.body)).toEqual(["交付文件已核对"]);
		expect(latest.cursor.lastReadSeq).toBe(3);
	});

	it("显式回看历史不消费游标，也不改变下一次增量读取", async () => {
		const { api, input, store } = await fixture();
		await api.read({ ...input, limit: 1, markRead: true });
		expect(store.cursor(input.roomId, input.sessionId).lastReadSeq).toBe(1);

		const historyInput = { ...input, afterSeq: 0, markRead: false };
		const first = await api.read(historyInput);
		const repeated = await api.read(historyInput);
		expect(first.messages.map((message) => message.body)).toEqual(["接口字段已确认", "补充订单状态映射"]);
		expect(repeated.messages).toEqual(first.messages);
		expect(repeated.cursor.lastReadSeq).toBe(1);

		const next = await api.read(input);
		expect(next.messages.map((message) => message.body)).toEqual(["补充订单状态映射"]);
		expect(next.cursor.lastReadSeq).toBe(2);
	});
});
