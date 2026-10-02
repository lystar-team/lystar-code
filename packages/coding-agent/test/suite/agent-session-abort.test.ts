import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { createHarness, getAssistantTexts, getToolResult, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function settles(promise: Promise<unknown>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("取消等待未结束")), 1000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("AgentSession 取消生命周期", () => {
	for (const hook of [
		"input",
		"before_agent_start",
		"context",
		"context_with_system",
		"agent_start",
		"turn_end",
		"tool_call",
		"tool_result",
		"agent_before_settle",
		"agent_settled",
	] as const) {
		it(`取消不等待挂起的 ${hook}，迟到回调不能启动新任务`, async () => {
			const entered = deferred();
			const release = deferred();
			const exited = deferred();
			let first = true;
			let signal: AbortSignal | undefined;
			let rejectedLateInput = false;
			const harness = await createHarness({
				tools: [
					{
						name: "noop",
						label: "noop",
						description: "完成工具",
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: {} }),
					},
				],
				extensionFactories: [
					(pi) => {
						const register = pi.on as (
							event: typeof hook,
							handler: (event: unknown, ctx: ExtensionContext) => Promise<void>,
						) => void;
						register(hook, async (_event, ctx) => {
							if (!first) return;
							first = false;
							signal = ctx.signal;
							entered.resolve();
							await release.promise;
							try {
								pi.sendUserMessage("迟到输入");
							} catch {
								rejectedLateInput = true;
							} finally {
								exited.resolve();
							}
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				hook === "tool_call" || hook === "tool_result"
					? fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" })
					: fauxAssistantMessage("原回复"),
			]);
			const prompt = harness.session.prompt("原任务");
			await entered.promise;
			try {
				await settles(Promise.all([prompt, harness.session.abort()]));
				expect(signal?.aborted).toBe(true);
				expect(harness.session.isIdle).toBe(true);
				expect(
					harness.session.getTurnResult(harness.eventsOfType("agent_settled").at(-1)!.turn.turnId)?.outcome,
				).toBe("aborted");
				harness.setResponses([fauxAssistantMessage("新任务回复")]);
				await harness.session.prompt("新任务");
				release.resolve();
				await exited.promise;
				expect(rejectedLateInput).toBe(true);
				expect(harness.session.getLastAssistantText()).toBe("新任务回复");
				expect(harness.session.pendingMessageCount).toBe(0);
			} finally {
				release.resolve();
			}
		});
	}

	for (const mode of ["parallel", "sequential"] as const) {
		it(`取消不响应信号的 ${mode} 工具后，迟到输出和结果不进入新任务`, async () => {
			const entered = deferred();
			const release = deferred();
			const exited = deferred();
			let signal: AbortSignal | undefined;
			const tool: AgentTool = {
				name: "blocked",
				label: "blocked",
				description: "挂起工具",
				parameters: Type.Object({}),
				execute: async (_id, _args, currentSignal, onUpdate) => {
					signal = currentSignal;
					entered.resolve();
					await release.promise;
					onUpdate?.({ content: [{ type: "text", text: "迟到进度" }], details: {} });
					exited.resolve();
					return { content: [{ type: "text", text: "迟到结果" }], details: {} };
				},
			};
			const harness = await createHarness({ tools: [tool] });
			harnesses.push(harness);
			harness.session.agent.toolExecution = mode;
			harness.setResponses([fauxAssistantMessage(fauxToolCall("blocked", {}), { stopReason: "toolUse" })]);
			const prompt = harness.session.prompt("执行工具");
			await entered.promise;
			try {
				await harness.session.followUp("取消的排队任务");
				harness.session.clearQueue();
				await settles(Promise.all([prompt, harness.session.abort()]));
				expect(signal?.aborted).toBe(true);
				expect(harness.session.isIdle).toBe(true);
				expect(harness.session.getToolActivitySnapshot({ activeOnly: true })).toEqual([]);
				expect(getToolResult(harness, "blocked")).toMatchObject({
					isError: true,
					content: [{ type: "text", text: "Operation aborted" }],
				});
				harness.setResponses([fauxAssistantMessage("新任务回复")]);
				await harness.session.prompt("新任务");
				const eventCount = harness.events.length;
				release.resolve();
				await exited.promise;
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(harness.events).toHaveLength(eventCount);
				expect(JSON.stringify(harness.session.messages)).not.toContain("迟到");
				expect(getAssistantTexts(harness)).toContain("新任务回复");
			} finally {
				release.resolve();
			}
		});
	}

	it("停止扩展工具后，工具的迟到回调不能提交消息", async () => {
		const entered = deferred();
		const release = deferred();
		const exited = deferred();
		let rejectedLateInput = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "extension_blocked",
						label: "extension_blocked",
						description: "挂起扩展工具",
						parameters: Type.Object({}),
						execute: async () => {
							entered.resolve();
							await release.promise;
							try {
								pi.sendUserMessage("迟到扩展工具消息");
							} catch {
								rejectedLateInput = true;
							} finally {
								exited.resolve();
							}
							return { content: [], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("extension_blocked", {}), { stopReason: "toolUse" })]);
		const prompt = harness.session.prompt("扩展工具");
		await entered.promise;
		try {
			await settles(Promise.all([prompt, harness.session.abort()]));
			harness.setResponses([fauxAssistantMessage("新任务回复")]);
			await harness.session.prompt("新任务");
			release.resolve();
			await exited.promise;
			expect(rejectedLateInput).toBe(true);
			expect(harness.session.getLastAssistantText()).toBe("新任务回复");
			expect(harness.session.pendingMessageCount).toBe(0);
		} finally {
			release.resolve();
		}
	});

	it("停止结算回调时撤销已经登记的后续任务", async () => {
		const entered = deferred();
		const release = deferred();
		let first = true;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						if (!first) return;
						first = false;
						pi.sendUserMessage("结算回调登记的任务");
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("原回复"), fauxAssistantMessage("不应启动")]);
		const prompt = harness.session.prompt("原任务");
		await entered.promise;
		try {
			await settles(Promise.all([prompt, harness.session.abort()]));
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(harness.session.isIdle).toBe(true);
		} finally {
			release.resolve();
		}
	});

	it("扩展命令等待空闲时不会等待命令自身", async () => {
		let waitForIdle!: () => Promise<void>;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("wait-idle", {
						description: "等待空闲",
						handler: async () => {
							await waitForIdle();
						},
					});
				},
			],
		});
		harnesses.push(harness);
		waitForIdle = () => harness.session.waitForIdle();
		await settles(harness.session.prompt("/wait-idle"));
		expect(harness.session.isIdle).toBe(true);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("停止扩展命令不等待其预处理，迟到消息不能进入下一轮", async () => {
		const entered = deferred();
		const release = deferred();
		const exited = deferred();
		let rejectedLateInput = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("blocked", {
						description: "挂起命令",
						handler: async () => {
							entered.resolve();
							await release.promise;
							try {
								pi.sendUserMessage("迟到命令消息");
							} catch {
								rejectedLateInput = true;
							} finally {
								exited.resolve();
							}
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const prompt = harness.session.prompt("/blocked");
		const result = prompt.catch((error: unknown) => error);
		await entered.promise;
		try {
			await settles(Promise.all([result, harness.session.abort()]));
			expect(harness.session.isIdle).toBe(true);
			harness.setResponses([fauxAssistantMessage("新任务回复")]);
			await harness.session.prompt("新任务");
			release.resolve();
			await exited.promise;
			expect(rejectedLateInput).toBe(true);
			expect(harness.session.getLastAssistantText()).toBe("新任务回复");
			expect(harness.session.pendingMessageCount).toBe(0);
		} finally {
			release.resolve();
		}
	});

	it("停止不响应取消信号的 Bash 操作后保留已收到的输出，忽略迟到输出", async () => {
		const entered = deferred();
		const release = deferred();
		const exited = deferred();
		const harness = await createHarness();
		harnesses.push(harness);
		const chunks: string[] = [];
		const command = harness.session.executeBash("ignored", (chunk) => chunks.push(chunk), {
			operations: {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from("已有输出"));
					entered.resolve();
					await release.promise;
					options.onData(Buffer.from("迟到输出"));
					exited.resolve();
					return { exitCode: 0 };
				},
			},
		});
		await entered.promise;
		try {
			harness.session.abortBash();
			await settles(command);
			expect(await command).toMatchObject({ output: "已有输出", cancelled: true });
			expect(harness.session.isBashRunning).toBe(false);
			harness.setResponses([fauxAssistantMessage("新任务回复")]);
			await harness.session.prompt("新任务");
			release.resolve();
			await exited.promise;
			expect(chunks).toEqual(["已有输出"]);
			expect(JSON.stringify(harness.session.messages)).not.toContain("迟到输出");
		} finally {
			release.resolve();
		}
	});

	it("停止不等待未完成的模型流，迟到模型输出被丢弃", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const entered = deferred();
		const response = new AssistantMessageEventStream();
		const previousStream = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = () => {
			entered.resolve();
			return response;
		};
		const prompt = harness.session.prompt("原任务");
		await entered.promise;
		await settles(Promise.all([prompt, harness.session.abort()]));
		expect(harness.session.isIdle).toBe(true);
		harness.session.agent.streamFunction = previousStream;
		harness.setResponses([fauxAssistantMessage("新任务回复")]);
		await harness.session.prompt("新任务");
		const eventCount = harness.events.length;
		response.push({ type: "done", reason: "stop", message: fauxAssistantMessage("迟到模型回复") });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(harness.events).toHaveLength(eventCount);
		expect(harness.session.getLastAssistantText()).toBe("新任务回复");
	});

	it("停止取消正在预处理的排队输入，释放后不能重新入队", async () => {
		const toolEntered = deferred();
		const queueEntered = deferred();
		const release = deferred();
		const harness = await createHarness({
			tools: [
				{
					name: "blocked",
					label: "blocked",
					description: "挂起工具",
					parameters: Type.Object({}),
					execute: async () => {
						toolEntered.resolve();
						await release.promise;
						return { content: [], details: {} };
					},
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text !== "排队任务") return;
						queueEntered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("blocked", {}), { stopReason: "toolUse" })]);
		const prompt = harness.session.prompt("原任务");
		await toolEntered.promise;
		const queued = harness.session.followUp("排队任务");
		const queueResult = queued.catch((error: unknown) => error);
		await queueEntered.promise;
		try {
			await settles(Promise.all([prompt, queueResult, harness.session.abort()]));
			expect(harness.session.pendingMessageCount).toBe(0);
			release.resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(harness.session.pendingMessageCount).toBe(0);
		} finally {
			release.resolve();
		}
	});
});
