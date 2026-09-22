import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRoom, SessionRoomMember } from "@earendil-works/pi-coding-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRoomStore } from "../src/session-room-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createRoom(): { room: SessionRoom; owner: SessionRoomMember } {
	const createdAt = "2026-09-21T00:00:00.000Z";
	const room: SessionRoom = {
		id: "room-1",
		cwd: "/tmp/project",
		title: "测试 Room",
		ownerSessionId: "owner",
		mode: "group",
		createdAt,
		updatedAt: createdAt,
	};
	return {
		room,
		owner: {
			roomId: room.id,
			sessionId: room.ownerSessionId,
			role: "owner",
			joinedAt: createdAt,
			lastReadSeq: 0,
		},
	};
}

describe("SessionRoomStore", () => {
	it("persists rooms, sequences, cursors, and idempotency across reload", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-room-store-"));
		tempDirs.push(root);
		mkdirSync(root, { recursive: true });
		const path = join(root, "rooms.jsonl");
		const first = new SessionRoomStore(path);
		const { room, owner } = createRoom();
		first.createRoom(room, owner);
		first.joinMember({
			roomId: room.id,
			sessionId: "member",
			role: "member",
			joinedAt: "2026-09-21T00:01:00.000Z",
			lastReadSeq: 0,
		});

		const draft = {
			roomId: room.id,
			senderSessionId: "owner",
			targetSessionIds: ["member"],
			route: "direct" as const,
			kind: "message" as const,
			body: "第一条消息",
			idempotencyKey: "request-1",
			createdAt: "2026-09-21T00:02:00.000Z",
		};
		const appended = first.appendMessage(draft);
		const duplicate = first.appendMessage({ ...draft });
		expect(() => first.appendMessage({ ...draft, targetSessionIds: ["owner"], body: "改变了内容" })).toThrowError(
			/幂等键对应的 Room 消息内容不一致/,
		);
		const sameKeyFromAnotherSender = first.appendMessage({
			...draft,
			senderSessionId: "member",
			targetSessionIds: ["owner"],
			body: "另一位成员的消息",
		});
		expect(appended.deduplicated).toBe(false);
		expect(duplicate.deduplicated).toBe(true);
		expect(duplicate.message.id).toBe(appended.message.id);
		expect(sameKeyFromAnotherSender.deduplicated).toBe(false);
		expect(sameKeyFromAnotherSender.message.seq).toBe(2);
		expect(first.readMessages(room.id, "member", 0, 20).messages).toHaveLength(2);
		first.advanceCursor(room.id, "member", appended.message.seq);

		const restored = new SessionRoomStore(path);
		expect(restored.summary(room.id)).toMatchObject({ latestSeq: 2 });
		expect(restored.member(room.id, "member").lastReadSeq).toBe(1);
		expect(restored.appendMessage(draft).deduplicated).toBe(true);
		expect(restored.readMessages(room.id, "member", 0, 20).messages[0]).toMatchObject({
			seq: 1,
			body: "第一条消息",
		});
	});

	it("keeps a left member in history but blocks new messages", () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-room-leave-"));
		tempDirs.push(root);
		const store = new SessionRoomStore(join(root, "rooms.jsonl"));
		const { room, owner } = createRoom();
		store.createRoom(room, owner);
		store.joinMember({
			roomId: room.id,
			sessionId: "member",
			role: "member",
			joinedAt: "2026-09-21T00:01:00.000Z",
			lastReadSeq: 0,
		});
		store.leaveMember(room.id, "member", "2026-09-21T00:02:00.000Z");
		expect(store.member(room.id, "member").leftAt).toBe("2026-09-21T00:02:00.000Z");
		expect(() => store.readMessages(room.id, "member", 0, 20)).toThrowError(/Room 成员已退出/);
		expect(() =>
			store.appendMessage({
				roomId: room.id,
				senderSessionId: "member",
				targetSessionIds: ["owner"],
				route: "direct",
				kind: "message",
				body: "不应发送",
				idempotencyKey: "request-left",
				createdAt: "2026-09-21T00:03:00.000Z",
			}),
		).toThrowError(/不是 Room 活跃成员/);
	});
});
