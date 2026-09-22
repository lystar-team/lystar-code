import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	SessionCollaborationResult,
	SessionCollaborationTask,
	SessionCoordinator,
	SessionWorkspaceSnapshot,
} from "@earendil-works/pi-coding-agent/core";
import type { SessionStateSnapshot } from "@lystar/code-web-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebRuntimeService } from "../src/service.ts";
import type {
	RuntimeAdapter,
	RuntimeEvent,
	RuntimeSession,
	SessionSummaryBase,
	UiRequestHandler,
} from "../src/types.ts";

const tempDirs: string[] = [];

function createFakeRuntime(
	base: SessionSummaryBase,
	onResult: (result: SessionCollaborationResult) => void,
	options: {
		blockPromptUntilAbort?: boolean;
		respondToSteer?: boolean;
		respondToFollowUp?: boolean;
		clearAssistantOnDispose?: boolean;
	} = {},
): RuntimeSession {
	const listeners = new Set<(event: RuntimeEvent) => void>();
	let lastAssistantText: string | undefined;
	let aborted = false;
	let releasePrompt: (() => void) | undefined;
	const promptGate = options.blockPromptUntilAbort
		? new Promise<void>((resolve) => {
				releasePrompt = resolve;
			})
		: undefined;
	const snapshot = {
		id: base.id,
		path: base.path,
		cwd: base.cwd,
		createdAt: base.createdAt,
		phase: "idle",
		attached: true,
		writeAccess: "available",
		revision: 0,
		leafId: null,
		queuedSteerCount: 0,
		queuedFollowUpCount: 0,
		thinkingLevel: "off",
		transcriptGeneration: "generation-1",
		transcriptRevision: 0,
	} as SessionStateSnapshot;
	let snapshotActivity: SessionStateSnapshot["activity"] = base.activity;
	let snapshotUpdatedAt = base.updatedAt;
	const emit = (event: RuntimeEvent): void => {
		for (const listener of listeners) listener(event);
	};
	const completeMessage = (text: string): void => {
		lastAssistantText = `已完成：${text}`;
		base.activity = "completed";
		base.messageCount += 2;
		base.firstMessage = text;
		snapshotActivity = "completed";
		snapshotUpdatedAt = Date.now();
		emit({ type: "state_changed", payload: {} });
	};

	return {
		sessionPath: base.path,
		getSnapshot(writeAccess: SessionStateSnapshot["writeAccess"]) {
			return { ...snapshot, activity: snapshotActivity, updatedAt: snapshotUpdatedAt, writeAccess };
		},
		prompt: async (text: string) => {
			if (promptGate) await promptGate;
			if (aborted) return;
			completeMessage(text);
		},
		steer: async (text: string) => {
			if (options.respondToSteer && !aborted) completeMessage(text);
		},
		followUp: async (text: string) => {
			if (options.respondToFollowUp && !aborted) completeMessage(text);
		},
		abort: async () => {
			aborted = true;
			releasePrompt?.();
			base.activity = "aborted";
			snapshotActivity = "aborted";
			emit({ type: "state_changed", payload: {} });
		},
		getLastAssistantText: () => lastAssistantText,
		getLastAssistantTextAsync: async () => lastAssistantText,
		recordCollaborationResult: async (result: SessionCollaborationResult) => {
			base.collaborationResult = result;
			onResult(result);
		},
		getCapabilities: () => [],
		ownsSessionWriter: () => false,
		isConnected: () => true,
		hasExternalClients: () => false,
		onEvent: (listener: (event: RuntimeEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose: async () => {
			aborted = true;
			if (options.clearAssistantOnDispose) lastAssistantText = undefined;
		},
	} as unknown as RuntimeSession;
}

describe("WebRuntimeService session coordination", () => {
	afterEach(() => {
		for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("creates a child task and returns its durable result from wait", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-runtime-coordination-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		let coordinator: SessionCoordinator | undefined;
		let createdOptions:
			| {
					parentSession?: string;
					profileId?: string;
					collaborationTask?: SessionCollaborationTask;
					collaborationWorkspace?: SessionWorkspaceSnapshot;
			  }
			| undefined;
		let current: SessionSummaryBase | undefined;
		let storedResult: SessionCollaborationResult | undefined;
		const adapter = {
			setSessionCoordinator(value: SessionCoordinator) {
				coordinator = value;
			},
			createSession: async (
				projectCwd: string,
				_onUiRequest: UiRequestHandler,
				options?: {
					parentSession?: string;
					profileId?: string;
					collaborationTask?: SessionCollaborationTask;
					collaborationWorkspace?: SessionWorkspaceSnapshot;
				},
			): Promise<RuntimeSession> => {
				createdOptions = options;
				const task = options?.collaborationTask;
				current = {
					path: join(projectCwd, "child-session.jsonl"),
					id: "child-session",
					cwd: projectCwd,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					messageCount: 0,
					firstMessage: "未命名会话",
					activity: "idle",
					...(task ? { taskId: task.id, taskDescription: task.description } : {}),
					...(options?.collaborationWorkspace ? { workspace: options.collaborationWorkspace } : {}),
				};
				return createFakeRuntime(current, (result) => {
					storedResult = result;
				});
			},
			listSessions: async () => (current ? [current] : []),
			isSessionWriterLocked: () => false,
		} as unknown as RuntimeAdapter;

		const service = new WebRuntimeService(adapter, { agentDir });
		try {
			const result = await coordinator?.create({
				cwd,
				parentSessionFile: join(cwd, "parent-session.jsonl"),
				parentSessionId: "parent-session",
				task: "检查子会话结果持久化",
				workspaceMode: "shared",
			});
			expect(result?.accepted).toBe(true);
			expect(result?.taskId).toBe(createdOptions?.collaborationTask?.id);
			expect(createdOptions).toMatchObject({
				parentSession: join(cwd, "parent-session.jsonl"),
				collaborationTask: {
					description: "检查子会话结果持久化",
					parentSessionId: "parent-session",
				},
			});

			const waited = await coordinator?.wait({ cwd, sessionIds: ["child-session"] });
			expect(waited).toHaveLength(1);
			expect(waited?.[0]).toMatchObject({
				id: "child-session",
				activity: "completed",
				result: {
					taskId: result?.taskId,
					outcome: "completed",
					resultText: "已完成：检查子会话结果持久化",
				},
			});
			expect(storedResult).toMatchObject({
				outcome: "completed",
				resultText: "已完成：检查子会话结果持久化",
			});
		} finally {
			await service.dispose();
		}
	});

	it("delivers a Room message into the target session runtime", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-runtime-room-delivery-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		let coordinator: SessionCoordinator | undefined;
		const bases = new Map<string, SessionSummaryBase>();
		const runtimes = new Map<string, RuntimeSession>();
		for (const [id, firstMessage] of [
			["owner", "Owner"],
			["member", "Member"],
			["busy", "Busy"],
		] as const) {
			const base: SessionSummaryBase = {
				path: join(cwd, `${id}.jsonl`),
				id,
				cwd,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				messageCount: 1,
				firstMessage,
				activity: id === "busy" ? "running" : "idle",
			};
			bases.set(id, base);
			runtimes.set(
				id,
				createFakeRuntime(
					base,
					() => {},
					id === "busy"
						? { respondToSteer: true, clearAssistantOnDispose: true }
						: id === "member"
							? { clearAssistantOnDispose: true }
							: undefined,
				),
			);
		}
		const adapter = {
			setSessionCoordinator(value: SessionCoordinator) {
				coordinator = value;
			},
			listSessions: async () => [...bases.values()],
			openSession: async (sessionPath: string) => {
				const runtime = [...runtimes.values()].find((item) => item.sessionPath === sessionPath);
				if (!runtime) throw new Error(`未找到运行时：${sessionPath}`);
				return runtime;
			},
			isSessionWriterLocked: () => false,
		} as unknown as RuntimeAdapter;

		const service = new WebRuntimeService(adapter, { agentDir });
		try {
			const room = await coordinator?.room.create({ cwd, ownerSessionId: "owner", title: "交付 Room" });
			expect(room).toBeDefined();
			await coordinator?.room.join({ cwd, roomId: room!.room.id, sessionId: "member" });
			await coordinator?.room.join({ cwd, roomId: room!.room.id, sessionId: "busy" });
			const sent = await coordinator?.room.send({
				cwd,
				roomId: room!.room.id,
				senderSessionId: "owner",
				route: "direct",
				targetSessionIds: ["member"],
				body: "请处理这个 Room 消息",
				idempotencyKey: "room-delivery-1",
			});
			expect(sent?.deliveredTo).toEqual(["member"]);
			await expect.poll(() => bases.get("member")?.firstMessage).toContain("请处理这个 Room 消息");
			expect(bases.get("owner")?.messageCount).toBe(1);
			const busySent = await coordinator?.room.send({
				cwd,
				roomId: room!.room.id,
				senderSessionId: "owner",
				route: "direct",
				targetSessionIds: ["busy"],
				body: "继续处理这个 Room 消息",
				idempotencyKey: "room-delivery-2",
			});
			expect(busySent?.deliveredTo).toEqual(["busy"]);
			await expect
				.poll(
					async () =>
						(
							await coordinator!.room.read({
								cwd,
								roomId: room!.room.id,
								sessionId: "owner",
								afterSeq: 0,
								markRead: false,
							})
						).messages,
				)
				.toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							senderSessionId: "member",
							targetSessionIds: ["owner"],
							kind: "answer",
							body: expect.stringContaining("请处理这个 Room 消息"),
							replyToMessageId: sent?.message.id,
						}),
						expect.objectContaining({
							senderSessionId: "busy",
							targetSessionIds: ["owner"],
							kind: "answer",
							body: expect.stringContaining("继续处理这个 Room 消息"),
							replyToMessageId: busySent?.message.id,
						}),
					]),
				);
		} finally {
			await service.dispose();
		}
	});

	it("stops a running task and persists an aborted result", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-runtime-stop-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		let coordinator: SessionCoordinator | undefined;
		let current: SessionSummaryBase | undefined;
		let storedResult: SessionCollaborationResult | undefined;
		const adapter = {
			setSessionCoordinator(value: SessionCoordinator) {
				coordinator = value;
			},
			createSession: async (
				projectCwd: string,
				_onUiRequest: UiRequestHandler,
				options?: {
					collaborationTask?: SessionCollaborationTask;
					collaborationWorkspace?: SessionWorkspaceSnapshot;
				},
			): Promise<RuntimeSession> => {
				const task = options?.collaborationTask;
				current = {
					path: join(projectCwd, "child-session.jsonl"),
					id: "child-session",
					cwd: projectCwd,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					messageCount: 0,
					firstMessage: "未命名会话",
					activity: "idle",
					...(task ? { taskId: task.id, taskDescription: task.description } : {}),
					...(options?.collaborationWorkspace ? { workspace: options.collaborationWorkspace } : {}),
				};
				return createFakeRuntime(
					current,
					(result) => {
						storedResult = result;
					},
					{ blockPromptUntilAbort: true },
				);
			},
			listSessions: async () => (current ? [current] : []),
			isSessionWriterLocked: () => false,
		} as unknown as RuntimeAdapter;

		const service = new WebRuntimeService(adapter, { agentDir });
		try {
			await coordinator?.create({
				cwd,
				parentSessionFile: join(cwd, "parent-session.jsonl"),
				task: "停止正在运行的任务",
				workspaceMode: "shared",
			});
			const stopped = await coordinator?.stop({ cwd, sessionId: "child-session" });
			expect(stopped).toMatchObject({
				activity: "aborted",
				result: { outcome: "aborted" },
			});
			expect(storedResult).toMatchObject({ outcome: "aborted" });
		} finally {
			await service.dispose();
		}
	});

	it("persists an interruption before service disposal", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-runtime-dispose-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		let coordinator: SessionCoordinator | undefined;
		let current: SessionSummaryBase | undefined;
		let storedResult: SessionCollaborationResult | undefined;
		const adapter = {
			setSessionCoordinator(value: SessionCoordinator) {
				coordinator = value;
			},
			createSession: async (
				projectCwd: string,
				_onUiRequest: UiRequestHandler,
				options?: { collaborationTask?: SessionCollaborationTask },
			): Promise<RuntimeSession> => {
				const task = options?.collaborationTask;
				current = {
					path: join(projectCwd, "child-session.jsonl"),
					id: "child-session",
					cwd: projectCwd,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					messageCount: 0,
					firstMessage: "未命名会话",
					activity: "idle",
					...(task ? { taskId: task.id, taskDescription: task.description } : {}),
				};
				return createFakeRuntime(
					current,
					(result) => {
						storedResult = result;
					},
					{ blockPromptUntilAbort: true },
				);
			},
			listSessions: async () => (current ? [current] : []),
			isSessionWriterLocked: () => false,
		} as unknown as RuntimeAdapter;

		const service = new WebRuntimeService(adapter, { agentDir });
		try {
			await coordinator?.create({
				cwd,
				parentSessionFile: join(cwd, "parent-session.jsonl"),
				task: "服务关闭前保存结果",
				workspaceMode: "shared",
			});
			await service.dispose();
			expect(storedResult).toMatchObject({ outcome: "aborted" });
		} finally {
			await service.dispose();
		}
	});

	it("recovers a task without a persisted result after a runtime restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-runtime-recovery-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		let coordinator: SessionCoordinator | undefined;
		let storedResult: SessionCollaborationResult | undefined;
		const current: SessionSummaryBase = {
			path: join(cwd, "child-session.jsonl"),
			id: "child-session",
			cwd,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			messageCount: 1,
			firstMessage: "恢复任务",
			activity: "idle",
			taskId: "task-restart",
			taskDescription: "验证 Runtime 重启恢复",
		};
		const runtime = createFakeRuntime(current, (result) => {
			storedResult = result;
		});
		const adapter = {
			setSessionCoordinator(value: SessionCoordinator) {
				coordinator = value;
			},
			openSession: async () => runtime,
			listSessions: async () => [current],
			isSessionWriterLocked: () => false,
		} as unknown as RuntimeAdapter;

		const service = new WebRuntimeService(adapter, { agentDir });
		try {
			const waited = await coordinator?.wait({ cwd, sessionIds: ["child-session"] });
			expect(waited?.[0]).toMatchObject({
				id: "child-session",
				activity: "interrupted",
				result: {
					taskId: "task-restart",
					outcome: "interrupted",
					error: "Runtime 重启后任务未完成",
				},
			});
			expect(storedResult).toMatchObject({ taskId: "task-restart", outcome: "interrupted" });
		} finally {
			await service.dispose();
		}
	});
});
