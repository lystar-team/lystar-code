import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collaborationAlias } from "@lystar/code-web-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRoomCoordinator, type SessionRoomDeliveryInput } from "../src/session-room-coordinator.ts";
import { SessionRoomStore } from "../src/session-room-store.ts";

const tempDirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Room 看板任务", () => {
	it("Owner 编辑并指派任务，评论 @提醒，Agent 结果写回任务卡", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lystar-room-task-edit-"));
		tempDirs.push(cwd);
		const path = join(cwd, "rooms.jsonl");
		const delivered: SessionRoomDeliveryInput[] = [];
		const api = new SessionRoomCoordinator({
			store: new SessionRoomStore(path),
			deliver: async (input) => {
				delivered.push(input);
			},
		}).api();
		const room = await api.create({ cwd, ownerSessionId: "owner" });
		await api.join({ cwd, roomId: room.room.id, sessionId: "worker", profileId: "worker", nickname: "小助手" });
		const task = await api.taskCreate({ cwd, roomId: room.room.id, sessionId: "owner", title: "初稿" });
		await expect(
			api.taskEdit({ cwd, roomId: room.room.id, taskId: task.id, sessionId: "worker", title: "越权" }),
		).rejects.toMatchObject({ code: "room_task_owner_required" });
		const assigned = await api.taskEdit({
			cwd,
			roomId: room.room.id,
			taskId: task.id,
			sessionId: "owner",
			title: "核对初稿",
			description: "检查字段",
			assigneeSessionId: "worker",
		});
		expect(assigned).toMatchObject({
			title: "核对初稿",
			description: "检查字段",
			status: "doing",
			assigneeSessionId: "worker",
		});
		const commented = await api.taskComment({
			cwd,
			roomId: room.room.id,
			taskId: task.id,
			sessionId: "owner",
			body: "@小助手 请补结论",
		});
		expect(commented.updates.at(-1)).toMatchObject({ kind: "comment", note: "@小助手 请补结论" });
		await expect
			.poll(() => delivered.some(({ message }) => message.taskId === task.id && message.body.includes("提到了你")))
			.toBe(true);
		const dispatch = delivered.find(({ message }) => message.taskId === task.id && message.body.startsWith("任务："));
		expect(dispatch).toBeDefined();
		const mention = delivered.find(({ message }) => message.taskId === task.id && message.body.includes("提到了你"));
		const answer = await api.send({
			cwd,
			roomId: room.room.id,
			senderSessionId: "worker",
			route: "direct",
			targetSessionIds: ["owner"],
			kind: "answer",
			body: "字段一致",
			taskId: task.id,
			replyToMessageId: dispatch!.message.id,
			basedOnSeq: mention!.message.seq,
		});
		const restored = new SessionRoomStore(path).task(room.room.id, task.id);
		expect(restored).toMatchObject({ resultText: "字段一致", resultMessageId: answer.message.id });
		await api.send({
			cwd,
			roomId: room.room.id,
			senderSessionId: "worker",
			route: "direct",
			targetSessionIds: ["owner"],
			kind: "answer",
			body: "收到提醒",
			taskId: task.id,
			replyToMessageId: mention!.message.id,
			basedOnSeq: mention!.message.seq,
		});
		expect(new SessionRoomStore(path).task(room.room.id, task.id)).toMatchObject({
			resultText: "字段一致",
			resultMessageId: answer.message.id,
		});
		const released = await api.taskEdit({
			cwd,
			roomId: room.room.id,
			taskId: task.id,
			sessionId: "owner",
			assigneeSessionId: null,
		});
		expect(released).toMatchObject({ status: "todo", resultMessageId: undefined, resultText: undefined });
	});

	it("改名后 @新昵称仍能通知原智能体", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lystar-room-renamed-mention-"));
		tempDirs.push(cwd);
		const delivered: SessionRoomDeliveryInput[] = [];
		const api = new SessionRoomCoordinator({
			store: new SessionRoomStore(join(cwd, "rooms.jsonl")),
			deliver: async (input) => {
				delivered.push(input);
			},
		}).api();
		const room = await api.create({ cwd, ownerSessionId: "owner" });
		await api.join({ cwd, roomId: room.room.id, sessionId: "worker", profileId: "worker", nickname: "霜叶" });
		const renamed = await api.rename({ cwd, roomId: room.room.id, sessionId: "worker", nickname: "星河" });
		expect(renamed.members.find((member) => member.sessionId === "worker")).toMatchObject({
			nickname: "星河",
			profileId: "worker",
		});
		const task = await api.taskCreate({ cwd, roomId: room.room.id, sessionId: "owner", title: "核对" });
		await api.taskComment({ cwd, roomId: room.room.id, taskId: task.id, sessionId: "owner", body: "@星河 请核对" });
		await expect.poll(() => delivered.filter(({ message }) => message.kind === "message")).toHaveLength(1);
		expect(delivered.find(({ message }) => message.kind === "message")?.targetSessionId).toBe("worker");
	});

	it("旧 Room 成员没有昵称时，评论 @展示昵称可通知对应 Agent", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lystar-room-task-legacy-mention-"));
		tempDirs.push(cwd);
		const delivered: SessionRoomDeliveryInput[] = [];
		const api = new SessionRoomCoordinator({
			store: new SessionRoomStore(join(cwd, "rooms.jsonl")),
			deliver: async (input) => {
				delivered.push(input);
			},
		}).api();
		const room = await api.create({ cwd, ownerSessionId: "owner" });
		await api.join({ cwd, roomId: room.room.id, sessionId: "legacy-worker", profileId: "worker" });
		const task = await api.taskCreate({ cwd, roomId: room.room.id, sessionId: "owner", title: "旧成员提醒" });
		await api.taskComment({
			cwd,
			roomId: room.room.id,
			taskId: task.id,
			sessionId: "owner",
			body: `@${collaborationAlias("legacy-worker")} 请核对`,
		});
		await expect.poll(() => delivered.filter(({ message }) => message.kind === "message")).toHaveLength(1);
		expect(delivered.find(({ message }) => message.kind === "message")).toMatchObject({
			targetSessionId: "legacy-worker",
			message: { taskId: task.id },
		});
	});

	it("超过阈值且会话中断的任务重新开放，运行中的任务保留负责人", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lystar-room-task-reclaim-"));
		tempDirs.push(cwd);
		let availability: "interrupted" | "running" | "idle" = "running";
		const api = new SessionRoomCoordinator({
			store: new SessionRoomStore(join(cwd, "rooms.jsonl")),
			getAvailability: () => availability,
			deliver: async () => {},
		}).api();
		const room = await api.create({ cwd, ownerSessionId: "owner" });
		await api.join({ cwd, roomId: room.room.id, sessionId: "worker", profileId: "worker" });
		const task = await api.taskCreate({ cwd, roomId: room.room.id, sessionId: "owner", title: "停滞任务" });
		await api.taskClaim({ cwd, roomId: room.room.id, taskId: task.id, sessionId: "worker" });
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + 21 * 60_000);
		expect((await api.taskList({ cwd, roomId: room.room.id, sessionId: "owner" }))[0]?.status).toBe("doing");
		availability = "idle";
		expect((await api.taskList({ cwd, roomId: room.room.id, sessionId: "owner" }))[0]?.status).toBe("doing");
		availability = "interrupted";
		expect((await api.taskList({ cwd, roomId: room.room.id, sessionId: "owner" }))[0]).toMatchObject({
			status: "todo",
			assigneeSessionId: undefined,
		});
		await api.taskClaim({ cwd, roomId: room.room.id, taskId: task.id, sessionId: "worker" });
		availability = "idle";
		vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60_000);
		expect((await api.taskList({ cwd, roomId: room.room.id, sessionId: "owner" }))[0]).toMatchObject({
			status: "todo",
			assigneeSessionId: undefined,
		});
	});
	it("新加入的 Agent 收到 Room 中待认领任务", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lystar-room-task-join-"));
		tempDirs.push(cwd);
		const delivered: SessionRoomDeliveryInput[] = [];
		const api = new SessionRoomCoordinator({
			store: new SessionRoomStore(join(cwd, "rooms.jsonl")),
			deliver: async (input) => {
				delivered.push(input);
			},
		}).api();
		const room = await api.create({ cwd, ownerSessionId: "owner" });
		const task = await api.taskCreate({ cwd, roomId: room.room.id, sessionId: "owner", title: "核对接口" });
		await api.join({ cwd, roomId: room.room.id, sessionId: "worker-a", profileId: "reviewer" });
		await expect.poll(() => delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({
			targetSessionId: "worker-a",
			message: { taskId: task.id, capabilities: { allowedTools: ["room_claim"] } },
		});
	});

	it("多位 Agent 同时认领同一任务时只接受一个，并在重启后保留记录", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lystar-room-tasks-"));
		tempDirs.push(cwd);
		const path = join(cwd, "rooms.jsonl");
		const delivered: SessionRoomDeliveryInput[] = [];
		const api = new SessionRoomCoordinator({
			store: new SessionRoomStore(path),
			deliver: async (input) => {
				delivered.push(input);
			},
		}).api();
		const room = await api.create({ cwd, ownerSessionId: "owner" });
		for (const sessionId of ["worker-a", "worker-b"]) {
			await api.join({ cwd, roomId: room.room.id, sessionId, profileId: sessionId });
		}
		const input = { cwd, roomId: room.room.id, sessionId: "owner" };
		const task = await api.taskCreate({ ...input, title: "检查接口响应", description: "核对返回字段" });
		expect(task.status).toBe("todo");
		await expect
			.poll(() => delivered.filter(({ message }) => message.id && message.taskId === task.id))
			.toHaveLength(2);
		expect(delivered.map(({ message }) => message.capabilities?.allowedTools)).toEqual([
			["room_claim"],
			["room_claim"],
		]);

		const claims = await Promise.allSettled(
			["worker-a", "worker-b"].map((sessionId) =>
				api.taskClaim({
					cwd,
					roomId: room.room.id,
					taskId: task.id,
					sessionId,
				}),
			),
		);
		expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
		expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
		expect((claims.find((claim) => claim.status === "rejected") as PromiseRejectedResult).reason.message).toContain(
			"worker-a",
		);
		const claimed = (claims.find((claim) => claim.status === "fulfilled") as PromiseFulfilledResult<typeof task>)
			.value;
		expect(claimed.status).toBe("doing");
		await expect.poll(() => delivered).toHaveLength(3);
		expect(delivered[2]).toMatchObject({
			targetSessionId: claimed.assigneeSessionId,
			message: {
				taskId: task.id,
				capabilities: { allowedTools: ["read", "grep", "find", "ls", "sessions", "room_tasks"] },
			},
		});
		const restored = new SessionRoomStore(path);
		expect(restored.task(room.room.id, task.id)).toMatchObject({
			status: "doing",
			assigneeSessionId: claimed.assigneeSessionId,
		});
	});

	it("进展由负责人记录，释放后可重新认领，成员退出会释放未完成任务", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lystar-room-task-progress-"));
		tempDirs.push(cwd);
		const store = new SessionRoomStore(join(cwd, "rooms.jsonl"));
		const delivered: SessionRoomDeliveryInput[] = [];
		const api = new SessionRoomCoordinator({
			store,
			deliver: async (input) => {
				delivered.push(input);
			},
		}).api();
		const room = await api.create({ cwd, ownerSessionId: "owner" });
		for (const sessionId of ["worker-a", "worker-b"]) {
			await api.join({ cwd, roomId: room.room.id, sessionId, profileId: sessionId });
		}
		const task = await api.taskCreate({ cwd, roomId: room.room.id, sessionId: "owner", title: "整理变更" });
		await expect(
			api.taskClaim({ cwd: "/wrong", roomId: room.room.id, taskId: task.id, sessionId: "worker-a" }),
		).rejects.toMatchObject({ code: "room_cwd_mismatch" });
		await expect(
			api.taskClaim({ cwd, roomId: room.room.id, taskId: task.id, sessionId: "owner" }),
		).rejects.toMatchObject({ code: "room_task_agent_required" });
		await api.taskClaim({ cwd, roomId: room.room.id, taskId: task.id, sessionId: "worker-a" });
		await expect(
			api.taskUpdate({ cwd, roomId: room.room.id, taskId: task.id, sessionId: "worker-b", status: "done" }),
		).rejects.toMatchObject({ code: "room_task_not_assignee" });
		const blocked = await api.taskUpdate({
			cwd,
			roomId: room.room.id,
			taskId: task.id,
			sessionId: "worker-a",
			status: "blocked",
			note: "等待接口文档",
		});
		expect(blocked.updates.at(-1)?.note).toBe("等待接口文档");
		await api.taskUpdate({ cwd, roomId: room.room.id, taskId: task.id, sessionId: "owner", status: "doing" });
		await expect.poll(() => delivered.filter(({ message }) => message.taskId === task.id)).toHaveLength(4);
		expect(delivered.at(-1)?.targetSessionId).toBe("worker-a");
		await api.leave({ cwd, roomId: room.room.id, sessionId: "worker-a" });
		await expect.poll(() => delivered.filter(({ message }) => message.taskId === task.id)).toHaveLength(5);
		expect(delivered.at(-1)).toMatchObject({
			targetSessionId: "worker-b",
			message: { capabilities: { allowedTools: ["room_claim"] } },
		});
		expect((await api.taskList({ cwd, roomId: room.room.id, sessionId: "owner" }))[0]).toMatchObject({
			status: "todo",
			assigneeSessionId: undefined,
		});
		await api.taskClaim({ cwd, roomId: room.room.id, taskId: task.id, sessionId: "worker-b" });
		const done = await api.taskUpdate({
			cwd,
			roomId: room.room.id,
			taskId: task.id,
			sessionId: "worker-b",
			status: "done",
			note: "变更已核对",
		});
		expect(done.updates.at(-1)?.note).toBe("变更已核对");
		await expect(
			api.taskClaim({ cwd, roomId: room.room.id, taskId: task.id, sessionId: "worker-b" }),
		).rejects.toMatchObject({ code: "room_task_claim_conflict" });
	});
});
