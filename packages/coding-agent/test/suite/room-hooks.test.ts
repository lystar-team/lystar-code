import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

const roomOrigin = {
	type: "room" as const,
	roomId: "room-1",
	messageId: "message-1",
	seq: 1,
	kind: "task" as const,
	senderSessionId: "sender",
};

describe("Room turns skip Extension Hooks", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("defers session lifecycle hooks until normal runtime use", async () => {
		const called: string[] = [];
		const harness = await createHarness({
			deferExtensionLifecycle: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						called.push("session_start");
					});
					pi.on("resources_discover", () => {
						called.push("resources_discover");
						return {};
					});
					pi.on("session_shutdown", () => {
						called.push("session_shutdown");
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(called).toEqual([]);
		await harness.session.emitSessionShutdownEvent({ type: "session_shutdown", reason: "quit" });
		expect(called).toEqual([]);

		await harness.session.activateExtensionLifecycle();
		expect(called).toEqual(["session_start", "resources_discover"]);
		await harness.session.emitSessionShutdownEvent({ type: "session_shutdown", reason: "quit" });
		expect(called).toEqual(["session_start", "resources_discover", "session_shutdown"]);
	});

	it("keeps model replies and tools while skipping input, lifecycle, tool, and provider hooks", async () => {
		const called: string[] = [];
		let toolExecuted = false;
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Return the input",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecuted = true;
				return { content: [{ type: "text", text: "tool reply" }], details: null };
			},
		};
		const harness = await createHarness({
			tools: [echo],
			extensionFactories: [
				(pi) => {
					pi.on("input", () => {
						called.push("input");
					});
					pi.on(
						"input",
						() => {
							called.push("room-scoped");
						},
						{ scope: { origins: ["room"] } },
					);
					pi.on("before_agent_start", () => {
						called.push("before_agent_start");
					});
					pi.on("context", () => {
						called.push("context");
					});
					pi.on("before_provider_request", () => {
						called.push("before_provider_request");
					});
					pi.on("before_provider_headers", (event) => {
						called.push("before_provider_headers");
						event.headers["x-extension"] = "present";
					});
					pi.on("after_provider_response", () => {
						called.push("after_provider_response");
					});
					pi.on("agent_start", () => {
						called.push("agent_start");
					});
					pi.on("agent_settled", () => {
						called.push("agent_settled");
					});
					pi.on("message_end", () => {
						called.push("message_end");
					});
					pi.on("tool_call", () => {
						called.push("tool_call");
					});
					pi.on("tool_result", () => {
						called.push("tool_result");
					});
					pi.registerCommand("room-command", {
						description: "Test command",
						handler: async () => {
							called.push("command");
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				expect(await harness.session.extensionRunner.emitBeforeProviderHeaders({ "x-base": "value" })).toEqual({
					"x-base": "value",
				});
				expect(await harness.session.extensionRunner.emitBeforeProviderRequest({ marker: "room" })).toEqual({
					marker: "room",
				});
				return fauxAssistantMessage([fauxToolCall("echo", { text: "tool reply" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("room reply"),
		]);

		const turn = await harness.session.promptWithOrigin("处理 Room 任务", {
			inputId: roomOrigin.messageId,
			origin: roomOrigin,
			capabilities: { allowedTools: ["echo"] },
		});
		expect(called).toEqual([]);
		expect(toolExecuted).toBe(true);
		expect(getAssistantTexts(harness)).toContain("room reply");
		expect(harness.session.getTurnResult(turn!.turnId)).toMatchObject({
			inputId: roomOrigin.messageId,
			outcome: "completed",
			finalText: "room reply",
		});

		harness.setResponses([
			async () => {
				await harness.session.extensionRunner.emitBeforeProviderRequest({ marker: "user" });
				return fauxAssistantMessage("user reply");
			},
		]);
		await harness.session.prompt("普通消息");
		for (const event of [
			"input",
			"before_agent_start",
			"context",
			"before_provider_request",
			"agent_start",
			"agent_settled",
			"message_end",
		]) {
			expect(called).toContain(event);
		}
		expect(called).not.toContain("room-scoped");
		expect(getAssistantTexts(harness)).toContain("user reply");

		called.length = 0;
		harness.setResponses([fauxAssistantMessage("literal reply")]);
		await harness.session.promptWithOrigin("/room-command", {
			inputId: "message-2",
			origin: { ...roomOrigin, messageId: "message-2", seq: 2 },
		});
		expect(called).toEqual([]);
		expect(getUserTexts(harness)).toContain("/room-command");
		expect(getAssistantTexts(harness)).toContain("literal reply");

		harness.setResponses([fauxAssistantMessage("child reply")]);
		await harness.session.promptWithOrigin("Room child", {
			inputId: "extension-child",
			origin: {
				type: "extension",
				extensionId: "extension-test",
				purpose: "reply",
				parentTurnId: turn!.turnId,
				rootOrigin: "room",
			},
		});
		expect(called).toEqual([]);
		expect(getAssistantTexts(harness)).toContain("child reply");

		await harness.session.prompt("/room-command");
		expect(called).toEqual(["command"]);
	});

	it("keeps ordinary input and steering out of a running Room turn", async () => {
		let signalRoom: () => void = () => {};
		let releaseRoom: () => void = () => {};
		const roomStarted = new Promise<void>((resolve) => {
			signalRoom = resolve;
		});
		const roomReleased = new Promise<void>((resolve) => {
			releaseRoom = resolve;
		});
		const called: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => {
						called.push("input");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				signalRoom();
				await roomReleased;
				return fauxAssistantMessage("Room reply");
			},
		]);
		const roomPrompt = harness.session.promptWithOrigin("Room 消息", { inputId: "message-1", origin: roomOrigin });
		try {
			await roomStarted;
			await expect(harness.session.prompt("用户消息", { streamingBehavior: "followUp" })).rejects.toThrow(
				"当前会话正在处理 Room 消息，请稍后重试",
			);
			await expect(harness.session.steer("用户补充")).rejects.toThrow("当前会话正在处理 Room 消息，请稍后重试");
		} finally {
			releaseRoom();
		}
		await roomPrompt;
		expect(called).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["Room 消息"]);
		harness.setResponses([fauxAssistantMessage("user reply")]);
		await harness.session.prompt("用户消息");
		expect(called).toEqual(["input"]);
	});

	it("rejects Room input during another turn instead of inheriting that turn's hooks", async () => {
		let enterHandler: () => void = () => {};
		let resumeHandler: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			enterHandler = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			resumeHandler = resolve;
		});
		const called: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						called.push("user");
						enterHandler();
						await blocked;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("user reply")]);
		const userPrompt = harness.session.prompt("用户输入");
		try {
			await entered;
			await expect(
				harness.session.promptWithOrigin("房间输入", { inputId: "message-1", origin: roomOrigin }),
			).rejects.toThrow("当前会话仍在处理上一条消息，请稍后重试");
		} finally {
			resumeHandler();
		}
		await userPrompt;
		expect(called).toEqual(["user"]);
		expect(getUserTexts(harness)).toEqual(["用户输入"]);
	});
});
