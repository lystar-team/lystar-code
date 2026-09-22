import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRoomCoordinator, type SessionRoomDeliveryInput } from "../src/session-room-coordinator.ts";
import { SessionRoomStore } from "../src/session-room-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SessionRoomCoordinator", () => {
	it("persists and delivers broadcast messages, then deduplicates retries", async () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-room-coordinator-"));
		tempDirs.push(root);
		const deliveries: SessionRoomDeliveryInput[] = [];
		const coordinator = new SessionRoomCoordinator({
			store: new SessionRoomStore(join(root, "rooms.jsonl")),
			getAvailability: (_cwd, sessionId) => (sessionId === "member-b" ? "idle" : "running"),
			deliver: async (input) => {
				deliveries.push(input);
			},
		});
		const api = coordinator.api();
		const created = await api.create({ cwd: root, ownerSessionId: "owner", title: "协作测试" });
		await api.join({ cwd: root, roomId: created.room.id, sessionId: "member-a" });
		await api.join({ cwd: root, roomId: created.room.id, sessionId: "member-b" });

		const sent = await api.send({
			cwd: root,
			roomId: created.room.id,
			senderSessionId: "owner",
			route: "broadcast",
			body: "请同步状态",
			kind: "status",
			idempotencyKey: "status-1",
		});
		const duplicate = await api.send({
			cwd: root,
			roomId: created.room.id,
			senderSessionId: "owner",
			route: "broadcast",
			body: "请同步状态",
			kind: "status",
			idempotencyKey: "status-1",
		});

		expect(sent.message.seq).toBe(1);
		expect(sent.deliveredTo).toEqual(["member-a", "member-b"]);
		expect(duplicate.deduplicated).toBe(true);
		await expect.poll(() => deliveries).toHaveLength(2);

		const read = await api.read({ cwd: root, roomId: created.room.id, sessionId: "member-b" });
		expect(read.messages).toHaveLength(1);
		expect(read.cursor).toEqual({ roomId: created.room.id, sessionId: "member-b", lastReadSeq: 1 });
	});

	it("returns after persisting a message without waiting for Agent completion", async () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-room-async-send-"));
		tempDirs.push(root);
		let releaseDelivery!: () => void;
		let deliveryStarted!: () => void;
		let hasStartedDelivery = false;
		const deliveryFinished = new Promise<void>((resolve) => {
			releaseDelivery = resolve;
		});
		const deliveryStartedPromise = new Promise<void>((resolve) => {
			deliveryStarted = resolve;
		});
		const coordinator = new SessionRoomCoordinator({
			store: new SessionRoomStore(join(root, "rooms.jsonl")),
			deliver: async () => {
				hasStartedDelivery = true;
				deliveryStarted();
				await deliveryFinished;
			},
		});
		const api = coordinator.api();
		const created = await api.create({ cwd: root, ownerSessionId: "owner" });
		await api.join({ cwd: root, roomId: created.room.id, sessionId: "member" });

		const sent = await api.send({
			cwd: root,
			roomId: created.room.id,
			senderSessionId: "owner",
			route: "broadcast",
			body: "异步发送",
		});
		expect(sent).toMatchObject({ deliveredTo: ["member"], errors: [] });
		expect(hasStartedDelivery).toBe(false);
		await deliveryStartedPromise;
		releaseDelivery();
		await deliveryFinished;
	});

	it("rejects broadcast messages when the Room has no other member", async () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-room-no-targets-"));
		tempDirs.push(root);
		const coordinator = new SessionRoomCoordinator({
			store: new SessionRoomStore(join(root, "rooms.jsonl")),
			deliver: async () => {},
		});
		const api = coordinator.api();
		const created = await api.create({ cwd: root, ownerSessionId: "owner" });

		await expect(
			api.send({
				cwd: root,
				roomId: created.room.id,
				senderSessionId: "owner",
				route: "broadcast",
				body: "没有目标成员的消息",
			}),
		).rejects.toMatchObject({ code: "room_no_targets" });
	});

	it("selects one member for one-of-us and reports delivery failures without losing the message", async () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-room-one-of-us-"));
		tempDirs.push(root);
		const coordinator = new SessionRoomCoordinator({
			store: new SessionRoomStore(join(root, "rooms.jsonl")),
			getAvailability: (_cwd, sessionId) => (sessionId === "member-b" ? "idle" : "running"),
			deliver: async ({ targetSessionId }) => {
				if (targetSessionId === "member-b") throw new Error("目标会话不可用");
			},
		});
		const api = coordinator.api();
		const created = await api.create({ cwd: root, ownerSessionId: "owner" });
		await api.join({ cwd: root, roomId: created.room.id, sessionId: "member-a" });
		await api.join({ cwd: root, roomId: created.room.id, sessionId: "member-b" });

		const sent = await api.send({
			cwd: root,
			roomId: created.room.id,
			senderSessionId: "owner",
			route: "one_of_us",
			body: "请认领",
			idempotencyKey: "claim-1",
		});
		expect(sent.message.targetSessionIds).toEqual(["member-b"]);
		expect(sent.deliveredTo).toEqual(["member-b"]);
		expect(sent.errors).toEqual([]);
		await expect
			.poll(
				async () =>
					(
						await api.read({
							cwd: root,
							roomId: created.room.id,
							sessionId: "owner",
							afterSeq: 0,
							markRead: false,
						})
					).messages,
			)
			.toHaveLength(2);
		const read = await api.read({
			cwd: root,
			roomId: created.room.id,
			sessionId: "owner",
			afterSeq: 0,
			markRead: false,
		});
		expect(read.messages[1]).toMatchObject({
			senderSessionId: "member-b",
			targetSessionIds: ["owner"],
			kind: "system",
			body: "智能体未响应：目标会话不可用",
		});
	});
});
