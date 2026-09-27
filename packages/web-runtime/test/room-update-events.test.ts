import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRoomStore, type SessionRoomStoreChange } from "../src/session-room-store.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Room 变更通知", () => {
	it("只在房间内容发生变化后通知，读取与重复消息不触发通知", () => {
		const cwd = mkdtempSync(join(tmpdir(), "lystar-room-update-"));
		directories.push(cwd);
		const changes: SessionRoomStoreChange[] = [];
		const store = new SessionRoomStore(join(cwd, "rooms.jsonl"), (change) => changes.push(change));
		const now = new Date().toISOString();
		store.createRoom(
			{ id: "room", cwd, title: "项目协作", mode: "group", ownerSessionId: "owner", createdAt: now, updatedAt: now },
			{ roomId: "room", sessionId: "owner", role: "owner", joinedAt: now, lastReadSeq: 0 },
		);
		expect(changes).toEqual([expect.objectContaining({ roomId: "room", membersChanged: true, latestSeq: 0 })]);
		store.joinMember({ roomId: "room", sessionId: "worker", role: "member", joinedAt: now, lastReadSeq: 0 });
		const draft = {
			roomId: "room",
			senderSessionId: "owner",
			targetSessionIds: ["worker"],
			route: "direct" as const,
			kind: "message" as const,
			body: "请查看任务",
			idempotencyKey: "request-1",
			createdAt: now,
		};
		store.appendMessage(draft);
		expect(changes.at(-1)).toMatchObject({ messagesChanged: true, tasksChanged: false, latestSeq: 1 });
		store.appendMessage(draft);
		store.advanceCursor("room", "owner", 1);
		store.completeDelivery(store.readMessages("room", "owner", 0, 10).messages[0]?.id ?? "", "worker");
		expect(changes).toHaveLength(3);
		store.createTask("room", "owner", "检查进度", "核对现有任务");
		expect(changes.at(-1)).toMatchObject({ tasksChanged: true, messagesChanged: false, latestSeq: 1 });
	});
});
