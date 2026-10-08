import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { getMessageText } from "../../coding-agent/test/suite/harness.ts";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import { WebRuntimeService } from "../src/service.ts";
import { SessionRoomStore } from "../src/session-room-store.ts";

it("真实 Session 工具链：B 使用 A 的结论，认领任务并交付隔离文件，Owner 收到结果后验收", async () => {
	const root = mkdtempSync(join(tmpdir(), "room-collaboration-flow-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const faux = registerFauxProvider();
	const model = faux.getModel();
	let service: WebRuntimeService | undefined;
	let roomId = "";
	let taskId = "";
	let bSawA = false;
	let executionCalls = 0;
	let ownerSawArtifact = false;
	let readCalls = 0;
	let failedAfterRead = false;
	let retriedAfterRead = false;
	const errors: string[] = [];
	const respond = (context: TranscriptContext) => {
		const activeTools = new Set<string>();
		for (const message of context.messages) {
			if (message.role !== "system") continue;
			for (const tool of message.toolsAdded ?? []) activeTools.add(tool.name);
			for (const tool of message.toolsRemoved ?? []) activeTools.delete(tool.name);
		}
		const toolNames = [...activeTools];
		const last = context.messages.at(-1);
		if (last?.role === "toolResult" && last.isError) errors.push(getMessageText(last));
		const input = getMessageText(context.messages.findLast((message) => message.role === "user"));
		if (toolNames.includes("write")) {
			if (last?.role === "toolResult" && last.toolName === "write")
				return fauxAssistantMessage("已生成交付文件，并核对字段。验证：文件内容包含 A 的字段结论。");
			executionCalls++;
			return fauxAssistantMessage(
				[fauxToolCall("write", { path: "delivery.txt", content: "使用 A 的接口结论：字段 orderId\n" })],
				{ stopReason: "toolUse" },
			);
		}
		if (last?.role === "toolResult" && last.toolName === "room_task_create") {
			const task = JSON.parse(getMessageText(last)) as { id: string };
			taskId = task.id;
			return fauxAssistantMessage([fauxToolCall("room_claim", { roomId, taskId })], { stopReason: "toolUse" });
		}
		if (last?.role === "toolResult" && last.toolName === "room_claim")
			return fauxAssistantMessage("已认领任务，等待隔离执行结果。");
		if (last?.role === "toolResult" && last.toolName === "room_task_update")
			return fauxAssistantMessage("产物已验收。");
		if (
			input.includes("角色：owner") &&
			input.includes("这是团队结果通知") &&
			input.includes("变更文件：delivery.txt")
		) {
			ownerSawArtifact = true;
			return fauxAssistantMessage(
				[
					fauxToolCall("room_task_update", {
						roomId,
						taskId,
						status: "done",
						note: "已核对交付文件及验证记录，验收通过",
					}),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (
			toolNames.includes("room_task_create") &&
			input.includes("角色：member") &&
			input.includes("本轮输入：\n依据 A 的结论执行交付")
		) {
			bSawA = input.includes("接口结论：字段 orderId");
			return fauxAssistantMessage(
				[
					fauxToolCall("room_task_create", {
						roomId,
						title: "按接口结论生成文件",
						description: "依据 A 的结论生成 delivery.txt，并记录验证结果",
						workspaceMode: "patch",
					}),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (input.includes("本轮输入：\n请给出接口结论")) {
			if (last?.role === "toolResult" && last.toolName === "room_read" && !failedAfterRead) {
				failedAfterRead = true;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "读取后临时 502" });
			}
			if (readCalls === 0) {
				readCalls++;
				return fauxAssistantMessage([fauxToolCall("room_read", { roomId })], { stopReason: "toolUse" });
			}
			retriedAfterRead = failedAfterRead;
			return fauxAssistantMessage("接口结论：字段 orderId");
		}
		return fauxAssistantMessage("等待任务结果。");
	};
	faux.setResponses(Array.from({ length: 80 }, () => respond));
	try {
		for (const directory of [agentDir, cwd, join(agentDir, "agents", "a"), join(agentDir, "agents", "b")])
			mkdirSync(directory, { recursive: true });
		for (const id of ["a", "b"]) {
			writeFileSync(join(agentDir, "agents", id, "profile.json"), JSON.stringify({ name: id }));
			writeFileSync(join(agentDir, "agents", id, "PROMPT.md"), "执行当前任务。禁止创建新的智能体会话。");
		}
		writeFileSync(join(cwd, "input.txt"), "待开发项目\n");
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[model.provider]: {
						baseUrl: model.baseUrl,
						apiKey: "faux-key",
						api: faux.api,
						models: [
							{
								id: model.id,
								name: model.name,
								reasoning: model.reasoning,
								input: model.input,
								cost: model.cost,
								contextWindow: model.contextWindow,
								maxTokens: model.maxTokens,
							},
						],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: model.provider,
				defaultModel: model.id,
				defaultThinkingLevel: "off",
				defaultProjectTrust: "always",
				retry: { enabled: false },
			}),
		);
		const adapter = new CodingAgentRuntimeAdapter(agentDir);
		const capture = vi.spyOn(adapter, "setSessionCoordinator");
		service = new WebRuntimeService(adapter, { agentDir });
		const coordinator = capture.mock.calls[0]![0];
		const owner = await coordinator.create({ cwd, parentSessionFile: "" });
		const a = await coordinator.create({ cwd, parentSessionFile: "", profileId: "a" });
		const b = await coordinator.create({ cwd, parentSessionFile: "", profileId: "b" });
		const { room } = await coordinator.room.create({ cwd, ownerSessionId: owner.session.id });
		roomId = room.id;
		for (const [session, profileId] of [
			[a.session, "a"],
			[b.session, "b"],
		] as const)
			await coordinator.room.join({ cwd, roomId, sessionId: session.id, profileId });
		await coordinator.room.send({
			cwd,
			roomId,
			senderSessionId: owner.session.id,
			senderType: "user",
			route: "direct",
			targetSessionIds: [a.session.id],
			body: "请给出接口结论",
		});
		const store = new SessionRoomStore(join(agentDir, "host", "collaboration-rooms.jsonl"));
		await expect
			.poll(
				() =>
					store
						.readMessages(roomId, b.session.id, 0, 100)
						.messages.some((message) => message.kind === "answer" && message.body === "接口结论：字段 orderId"),
				{ timeout: 15_000 },
			)
			.toBe(true);
		await coordinator.room.send({
			cwd,
			roomId,
			senderSessionId: owner.session.id,
			senderType: "user",
			route: "direct",
			targetSessionIds: [b.session.id],
			body: "依据 A 的结论执行交付",
		});
		await expect.poll(() => store.listTasks(roomId)[0]?.status, { timeout: 30_000 }).toBe("done");
		await expect
			.poll(() => store.listTasks(roomId)[0]?.execution?.result?.workspace?.status, { timeout: 10_000 })
			.toBe("released");
		const task = store.listTasks(roomId)[0]!;
		expect(errors).toEqual([]);
		expect(bSawA).toBe(true);
		expect(readCalls).toBe(1);
		expect(retriedAfterRead).toBe(true);
		expect(ownerSawArtifact).toBe(true);
		expect(executionCalls).toBe(1);
		expect(task).toMatchObject({
			assigneeSessionId: b.session.id,
			execution: {
				result: {
					outcome: "completed",
					changedFiles: ["delivery.txt"],
					workspace: { mode: "patch", projectCwd: cwd },
				},
			},
		});
		const result = task.execution!.result!;
		expect(readFileSync(join(result.workspace!.cwd, "delivery.txt"), "utf8")).toContain("orderId");
		expect(existsSync(join(cwd, "delivery.txt"))).toBe(true);
		expect(task.execution?.result?.workspace?.status).toBe("released");
		expect(readFileSync(result.patchPath!, "utf8")).toContain("orderId");
		expect(task.resultMessageId).toBeTruthy();
		expect(task.updates.at(-1)?.note).toContain("验收通过");
		await expect.poll(() => store.pending().length, { timeout: 10_000 }).toBe(0);
		await service.dispose();
		service = undefined;
		const restoredAdapter = new CodingAgentRuntimeAdapter(agentDir);
		const restoredCapture = vi.spyOn(restoredAdapter, "setSessionCoordinator");
		service = new WebRuntimeService(restoredAdapter, { agentDir });
		const restored = await restoredCapture.mock.calls[0]![0].room.taskList({
			cwd,
			roomId,
			sessionId: owner.session.id,
		});
		expect(restored[0]).toMatchObject({
			status: "done",
			execution: { sessionId: task.execution!.sessionId, result: { changedFiles: ["delivery.txt"] } },
		});
		expect(executionCalls).toBe(1);
	} finally {
		await service?.dispose();
		faux.unregister();
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
