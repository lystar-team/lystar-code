import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	SessionRoomCoordinator,
	type SessionRoomCoordinatorOptions,
	type SessionRoomDeliveryInput,
} from "../src/session-room-coordinator.ts";
import { SessionRoomStore } from "../src/session-room-store.ts";

const roots: string[] = [];
const coordinators: SessionRoomCoordinator[] = [];
function fixture(deliver: SessionRoomCoordinatorOptions["deliver"] = async () => {}) {
	const cwd = mkdtempSync(join(tmpdir(), "room-collaboration-regression-"));
	roots.push(cwd);
	const path = join(cwd, "rooms.jsonl");
	const store = new SessionRoomStore(path);
	const coordinator = new SessionRoomCoordinator({ store, deliver });
	coordinators.push(coordinator);
	return { cwd, path, store, coordinator, api: coordinator.api() };
}

afterEach(() => {
	for (const coordinator of coordinators.splice(0)) coordinator.dispose();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("协作协议断点回归", () => {
	it("共享可见性不受唤醒目标限制，答案和结果能投递给负责人", async () => {
		const { cwd, api, store, coordinator } = fixture();
		const { room } = await api.create({ cwd, ownerSessionId: "owner" });
		for (const sessionId of ["a", "b"]) await api.join({ cwd, roomId: room.id, sessionId, profileId: sessionId });
		const reply = await api.send({
			cwd,
			roomId: room.id,
			senderSessionId: "a",
			route: "direct",
			targetSessionIds: ["owner"],
			kind: "answer",
			body: "A 的接口结论",
		});
		const result = await api.send({
			cwd,
			roomId: room.id,
			senderSessionId: "a",
			route: "direct",
			targetSessionIds: ["owner"],
			kind: "result",
			body: "A 的实际产物",
		});
		expect(store.hasPendingDelivery(reply.message.id, "owner")).toBe(true);
		expect(store.hasPendingDelivery(result.message.id, "owner")).toBe(true);
		expect(store.hasPendingDelivery(reply.message.id, "b")).toBe(false);
		const read = await api.read({ cwd, roomId: room.id, sessionId: "b", markRead: false });
		expect(read.messages.map((message) => message.body)).toEqual(["A 的接口结论", "A 的实际产物"]);
		expect(coordinator.contextForSession(room.id, "b").text).toContain("A 的接口结论");
		expect(read.cursor.lastReadSeq).toBe(0);
	});

	it("历史读取不消费模型游标，相同游标不重复落日志", async () => {
		const { cwd, api, store, path } = fixture();
		const { room } = await api.create({ cwd, ownerSessionId: "owner" });
		await api.join({ cwd, roomId: room.id, sessionId: "a", profileId: "a" });
		await api.send({
			cwd,
			roomId: room.id,
			senderSessionId: "a",
			route: "direct",
			targetSessionIds: ["owner"],
			body: "历史消息",
		});
		const input = { cwd, roomId: room.id, sessionId: "owner", afterSeq: 0, markRead: false };
		expect((await api.read(input)).cursor.lastReadSeq).toBe(0);
		expect((await api.read(input)).messages).toHaveLength(1);
		await api.read({ ...input, markRead: true });
		const before = readFileSync(path, "utf8");
		await api.read({ ...input, markRead: true });
		store.advanceCursor(room.id, "owner", 1);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect((await api.read(input)).messages).toHaveLength(1);
		expect((await api.read({ cwd, roomId: room.id, sessionId: "owner" })).messages).toHaveLength(0);
		expect(() => store.advanceCursor(room.id, "owner", 100)).toThrow("读取游标超出消息范围");
	});

	it("合并同一成员的近期输入，并在成功后确认消费", async () => {
		const deliveries: SessionRoomDeliveryInput[] = [];
		const { cwd, api, store } = fixture(async (input) => {
			deliveries.push(input);
			return input.message.seq;
		});
		const { room } = await api.create({ cwd, ownerSessionId: "owner" });
		await api.join({ cwd, roomId: room.id, sessionId: "a", profileId: "a" });
		for (const body of ["第一条", "补充要求"])
			await api.send({
				cwd,
				roomId: room.id,
				senderSessionId: "owner",
				senderType: "user",
				route: "direct",
				targetSessionIds: ["a"],
				body,
			});
		await expect.poll(() => deliveries.length).toBe(1);
		expect(deliveries[0]?.messages?.map((message) => message.body)).toEqual(["第一条", "补充要求"]);
		await expect.poll(() => store.pending().length).toBe(0);
		expect(store.cursor(room.id, "a").lastReadSeq).toBe(2);
	});

	it("临时失败不确认消费，重启后保留退避并完成恢复", async () => {
		const { cwd, api, store, path, coordinator } = fixture(async () => {
			throw Object.assign(new Error("临时 502"), { retryable: true });
		});
		const { room } = await api.create({ cwd, ownerSessionId: "owner" });
		await api.join({ cwd, roomId: room.id, sessionId: "a", profileId: "a" });
		const sent = await api.send({
			cwd,
			roomId: room.id,
			senderSessionId: "owner",
			route: "direct",
			targetSessionIds: ["a"],
			body: "恢复输入",
		});
		await expect.poll(() => store.pending()[0]?.attempts).toBe(1);
		expect(store.cursor(room.id, "a").lastReadSeq).toBe(0);
		coordinator.dispose();
		const reloaded = new SessionRoomStore(path);
		const pending = reloaded.pending()[0]!;
		expect(pending).toMatchObject({ message: { id: sent.message.id }, attempts: 1 });
		vi.spyOn(Date, "now").mockReturnValue(pending.nextAttemptAt + 1);
		const deliver = vi.fn(async () => sent.message.seq);
		const restored = new SessionRoomCoordinator({ store: reloaded, deliver });
		coordinators.push(restored);
		await expect.poll(() => reloaded.pending().length).toBe(0);
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(reloaded.cursor(room.id, "a").lastReadSeq).toBe(sent.message.seq);
	});

	it("关闭 Coordinator 不确认仍在运行的输入", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = vi.fn();
		const { cwd, api, store, coordinator } = fixture(async () => {
			started();
			await gate;
		});
		const { room } = await api.create({ cwd, ownerSessionId: "owner" });
		await api.join({ cwd, roomId: room.id, sessionId: "a", profileId: "a" });
		await api.send({
			cwd,
			roomId: room.id,
			senderSessionId: "owner",
			route: "direct",
			targetSessionIds: ["a"],
			body: "未完成输入",
		});
		await expect.poll(() => started.mock.calls.length).toBe(1);
		coordinator.dispose();
		release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(store.pending()).toHaveLength(1);
		expect(store.cursor(room.id, "a").lastReadSeq).toBe(0);
	});

	it("两份 Store 不会重复认领任务或生成重复消息序号", async () => {
		const { cwd, api, store, path, coordinator } = fixture();
		const { room } = await api.create({ cwd, ownerSessionId: "owner" });
		for (const sessionId of ["a", "b"]) await api.join({ cwd, roomId: room.id, sessionId, profileId: sessionId });
		const task = store.createTask(room.id, "owner", "唯一负责人", "");
		coordinator.dispose();
		const other = new SessionRoomStore(path);
		store.claimTask(room.id, task.id, "a");
		expect(() => other.claimTask(room.id, task.id, "b")).toThrow("认领");
		const draft = {
			roomId: room.id,
			senderSessionId: "owner",
			targetSessionIds: ["a"],
			route: "direct" as const,
			kind: "message" as const,
			body: "消息",
			createdAt: new Date().toISOString(),
		};
		const first = store.appendMessage({ ...draft, idempotencyKey: "first" });
		const second = other.appendMessage({ ...draft, idempotencyKey: "second" });
		expect(second.message.seq).toBe(first.message.seq + 1);
		expect(store.readMessages(room.id, "b", 0, 10).messages).toHaveLength(2);
	});

	it("两份 Store 只能建立一个执行租约，租约记录可恢复到同一任务", async () => {
		const { cwd, api, store, path, coordinator } = fixture();
		const { room } = await api.create({ cwd, ownerSessionId: "owner" });
		await api.join({ cwd, roomId: room.id, sessionId: "a", profileId: "a" });
		const task = store.createTask(room.id, "owner", "执行租约", "");
		store.claimTask(room.id, task.id, "a");
		const other = new SessionRoomStore(path);
		const first = store.claimTaskExecution(room.id, task.id, "a", "dispatch-1", "runtime-a");
		expect(first.execution).toMatchObject({ ownerId: "runtime-a", state: "starting", attempt: 1 });
		const bound = store.bindTaskExecution(
			room.id,
			task.id,
			"a",
			{ ...first.execution!, sessionId: "executor", taskId: "execution-task" },
			"runtime-a",
		);
		const previousExpiry = bound.execution!.leaseExpiresAt!;
		expect(store.renewTaskExecution(room.id, task.id, "executor", "runtime-a", bound.execution!.leaseId!)).toBe(true);
		expect(store.task(room.id, task.id).execution!.leaseExpiresAt).toBeGreaterThanOrEqual(previousExpiry);
		const takeover = other.claimTaskExecution(room.id, task.id, "a", "dispatch-2", "runtime-b", true);
		expect(takeover.execution).toMatchObject({ ownerId: "runtime-b", messageId: "dispatch-2", attempt: 2 });
		expect(
			store.recordTaskExecution(
				room.id,
				task.id,
				"executor",
				{ taskId: "execution-task", outcome: "completed", completedAt: new Date().toISOString() },
				"runtime-a",
				bound.execution!.leaseId,
			),
		).toBe(false);
		coordinator.dispose();
		const restored = new SessionRoomStore(path);
		expect(restored.task(room.id, task.id).execution).toMatchObject({
			ownerId: "runtime-b",
			messageId: "dispatch-2",
		});
	});
	it("无结果不能完成任务，执行结果需要验收，失败不能伪装完成", async () => {
		const { cwd, api, store } = fixture();
		const { room } = await api.create({ cwd, ownerSessionId: "owner" });
		await api.join({ cwd, roomId: room.id, sessionId: "a", profileId: "a" });
		const task = store.createTask(room.id, "owner", "提交结果", "");
		store.claimTask(room.id, task.id, "a");
		expect(() => store.updateTask(room.id, task.id, "a", "done")).toThrow("提交结果");
		store.bindTaskExecution(room.id, task.id, "a", {
			sessionId: "executor",
			taskId: "execution-task",
			messageId: "dispatch",
		});
		expect(() => store.updateTask(room.id, task.id, "a", "done", "声称完成")).toThrow("尚未结束");
		store.recordTaskExecution(room.id, task.id, "executor", {
			taskId: "execution-task",
			outcome: "failed",
			error: "检查失败",
			completedAt: new Date().toISOString(),
		});
		expect(store.task(room.id, task.id).status).toBe("blocked");
		expect(() => store.updateTask(room.id, task.id, "owner", "done", "验收")).toThrow("未成功");
	});
});
