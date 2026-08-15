import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop, agentLoopContinue } from "../src/agent-loop.ts";
import {
	canonicalJson,
	createFailureFingerprint,
	createToolCallFingerprint,
	ObserveToolRecoveryController,
	setDefaultStreamFn,
	ToolExecutionError,
	type ToolRecoveryObservation,
} from "../src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

// Mock stream for testing - mimics MockAssistantStream
class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

// Simple identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("default stream function compatibility", () => {
	it("uses the configured default when a legacy caller omits streamFn", async () => {
		let calls = 0;
		setDefaultStreamFn(() => {
			calls++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "fallback" }]),
				});
			});
			return stream;
		});

		try {
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
			const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
			const stream = Reflect.apply(agentLoop, undefined, [
				[createUserMessage("Hello")],
				context,
				config,
				undefined,
			]) as ReturnType<typeof agentLoop>;

			await stream.result();
			expect(calls).toBe(1);
		} finally {
			setDefaultStreamFn(undefined);
		}
	});
});

describe("agentLoop with AgentMessage", () => {
	it("should emit events with AgentMessage types", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("Hello");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Hi there!" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should have user message and assistant message
		expect(messages.length).toBe(2);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("assistant");

		// Verify event sequence
		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("turn_start");
		expect(eventTypes).toContain("message_start");
		expect(eventTypes).toContain("message_end");
		expect(eventTypes).toContain("turn_end");
		expect(eventTypes).toContain("agent_end");
	});

	it("should handle custom message types via convertToLlm", async () => {
		// Create a custom message type
		interface CustomNotification {
			role: "notification";
			text: string;
			timestamp: number;
		}

		const notification: CustomNotification = {
			role: "notification",
			text: "This is a notification",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [notification as unknown as AgentMessage], // Custom message in context
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("Hello");

		let convertedMessages: Message[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				// Filter out notifications, convert rest
				convertedMessages = messages
					.filter((m) => (m as { role: string }).role !== "notification")
					.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// The notification should have been filtered out in convertToLlm
		expect(convertedMessages.length).toBe(1); // Only user message
		expect(convertedMessages[0].role).toBe("user");
	});

	it("should apply transformContext before convertToLlm", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [
				createUserMessage("old message 1"),
				createAssistantMessage([{ type: "text", text: "old response 1" }]),
				createUserMessage("old message 2"),
				createAssistantMessage([{ type: "text", text: "old response 2" }]),
			],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("new message");

		let transformedMessages: AgentMessage[] = [];
		let convertedMessages: Message[] = [];

		const config: AgentLoopConfig = {
			model: createModel(),
			transformContext: async (messages) => {
				// Keep only last 2 messages (prune old ones)
				transformedMessages = messages.slice(-2);
				return transformedMessages;
			},
			convertToLlm: (messages) => {
				convertedMessages = messages.filter(
					(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
				) as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const _ of stream) {
			// consume
		}

		// transformContext should have been called first, keeping only last 2
		expect(transformedMessages.length).toBe(2);
		// Then convertToLlm receives the pruned messages
		expect(convertedMessages.length).toBe(2);
	});

	it("should handle tool calls and results", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const toolUsage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const patchedToolUsage = {
			input: 5,
			output: 6,
			cacheRead: 7,
			cacheWrite: 8,
			totalTokens: 26,
			cost: { input: 0.5, output: 0.6, cacheRead: 0.7, cacheWrite: 0.8, total: 2.6 },
		};
		let observedToolUsage: typeof toolUsage | undefined;
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					usage: toolUsage,
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			afterToolCall: async ({ result }) => {
				observedToolUsage = result.usage;
				return { usage: patchedToolUsage };
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return tool call
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					// Second call: return final response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// Tool should have been executed
		expect(executed).toEqual(["hello"]);

		// Should have tool execution events
		const toolStart = events.find((e) => e.type === "tool_execution_start");
		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolStart).toBeDefined();
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(false);
		}
		expect(observedToolUsage).toEqual(toolUsage);
		const messages = await stream.result();
		const toolResult = messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role === "toolResult" ? toolResult.usage : undefined).toEqual(patchedToolUsage);
	});

	it("should not execute tool calls from a length-truncated assistant message", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// Output hit the token limit mid tool call. The salvage parser can
					// produce arguments that validate but are silently truncated, so
					// nothing in this message may execute.
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hel" } }],
						"length",
					);
					stream.push({ type: "done", reason: "length", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		// The tool must never execute with potentially truncated arguments.
		expect(executed).toEqual([]);

		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(true);
			const text = toolEnd.result.content.find((c: { type: string }) => c.type === "text");
			expect(text && "text" in text ? text.text : "").toContain("output token limit");
		}

		// The loop continues so the model can re-issue the tool call.
		expect(callIndex).toBe(2);
		const messages = await stream.result();
		expect(messages[messages.length - 1].role).toBe("assistant");
	});

	it("should execute mutated beforeToolCall args without revalidation", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: Array<string | number> = [];
		const tool: AgentTool<typeof toolSchema, { value: string | number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value as string | number);
				return {
					content: [{ type: "text", text: `echoed: ${String(params.value)}` }],
					details: { value: params.value as string | number },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async ({ args }) => {
				const mutableArgs = args as { value: string | number };
				mutableArgs.value = 123;
				return undefined;
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual([123]);
	});

	it("should prepare tool arguments for validation", async () => {
		const replaceSchema = Type.Object({ oldText: Type.String(), newText: Type.String() });
		const toolSchema = Type.Object({ edits: Type.Array(replaceSchema) });
		const executed: Array<Array<{ oldText: string; newText: string }>> = [];
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "edit",
			label: "Edit",
			description: "Edit tool",
			parameters: toolSchema,
			prepareArguments(args) {
				if (!args || typeof args !== "object") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				const input = args as {
					edits?: Array<{ oldText: string; newText: string }>;
					oldText?: string;
					newText?: string;
				};
				if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				return {
					edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
				};
			},
			async execute(_toolCallId, params) {
				executed.push(params.edits);
				return {
					content: [{ type: "text", text: `edited ${params.edits.length}` }],
					details: { count: params.edits.length },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("edit something");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "edit",
								arguments: { oldText: "before", newText: "after" },
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual([[{ oldText: "before", newText: "after" }]]);
	});

	it("should emit tool_execution_end in completion order but persist tool results in source order", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const toolExecutionEndIds = events.flatMap((event) => {
			if (event.type !== "tool_execution_end") {
				return [];
			}
			return [event.toolCallId];
		});
		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		const turnToolResultIds = events.flatMap((event) => {
			if (event.type !== "turn_end") {
				return [];
			}
			return event.toolResults.map((toolResult) => toolResult.toolCallId);
		});

		expect(parallelObserved).toBe(true);
		expect(toolExecutionEndIds).toEqual(["tool-2", "tool-1"]);
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
		expect(turnToolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should inject queued messages after all tool calls complete", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("start");
		const queuedUserMessage: AgentMessage = createUserMessage("interrupt");

		let queuedDelivered = false;
		let callIndex = 0;
		let sawInterruptInContext = false;

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
			getSteeringMessages: async () => {
				// Return steering message after tool execution has started.
				if (executed.length >= 1 && !queuedDelivered) {
					queuedDelivered = true;
					return [queuedUserMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, (_model, ctx, _options) => {
			// Check if interrupt message is in context on second call
			if (callIndex === 1) {
				sawInterruptInContext = ctx.messages.some(
					(m) => m.role === "user" && typeof m.content === "string" && m.content === "interrupt",
				);
			}

			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return two tool calls
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					// Second call: return final response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const event of stream) {
			events.push(event);
		}

		// Both tools should execute before steering is injected
		expect(executed).toEqual(["first", "second"]);

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(2);
		expect(toolEnds[0].isError).toBe(false);
		expect(toolEnds[1].isError).toBe(false);

		// Queued message should appear in events after both tool result messages
		const eventSequence = events.flatMap((event) => {
			if (event.type !== "message_start") return [];
			if (event.message.role === "toolResult") return [`tool:${event.message.toolCallId}`];
			if (event.message.role === "user" && typeof event.message.content === "string") {
				return [event.message.content];
			}
			return [];
		});
		expect(eventSequence).toContain("interrupt");
		expect(eventSequence.indexOf("tool:tool-1")).toBeLessThan(eventSequence.indexOf("interrupt"));
		expect(eventSequence.indexOf("tool:tool-2")).toBeLessThan(eventSequence.indexOf("interrupt"));

		// Interrupt message should be in context when second LLM call is made
		expect(sawInterruptInContext).toBe(true);
	});

	it("should force sequential execution when a tool has executionMode=sequential even with default parallel config", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run both");
		// config is parallel (default), but tool forces sequential
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "slow", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With sequential execution, second tool should NOT start before first finishes
		expect(parallelObserved).toBe(false);

		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should force sequential execution when one of multiple tools has executionMode=sequential", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executionOrder: string[] = [];
		let releaseSlow: (() => void) | undefined;
		const slowDone = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});

		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				executionOrder.push(`slow:${params.value}`);
				if (params.value === "a") {
					await slowDone;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const fastTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "fast",
			label: "Fast",
			description: "Fast tool",
			parameters: toolSchema,
			// no executionMode = defaults to parallel
			async execute(_toolCallId, params) {
				executionOrder.push(`fast:${params.value}`);
				return {
					content: [{ type: "text", text: `fast: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool, fastTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			// parallel by default, but slowTool forces sequential
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "a" } },
							{ type: "toolCall", id: "tool-2", name: "fast", arguments: { value: "b" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseSlow?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// Fast tool should NOT run before slow tool finishes
		expect(executionOrder[0]).toBe("slow:a");
		expect(executionOrder).toContain("fast:b");
	});

	it("should allow parallel execution when all tools have executionMode=parallel", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With executionMode=parallel, second tool should start before first finishes
		expect(parallelObserved).toBe(true);
	});

	it("should use prepareNextTurn snapshot before continuing", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "first prompt",
			messages: [],
			tools: [tool],
		};
		let convertedSecondTurnSystemPrompt = "";
		let prepared = false;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prepareNextTurn: async ({ context: currentContext }) => {
				if (prepared) return undefined;
				prepared = true;
				return {
					context: {
						systemPrompt: "second prompt",
						messages: currentContext.messages.slice(),
						tools: currentContext.tools,
					},
				};
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, (_model, ctx) => {
			llmCalls++;
			if (llmCalls === 2) {
				convertedSecondTurnSystemPrompt = ctx.systemPrompt ?? "";
			}
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(2);
		expect(convertedSecondTurnSystemPrompt).toBe("second prompt");
	});

	it("prepares each request after queued steering messages are injected", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		let steeringPolls = 0;
		const preparedRoles: string[][] = [];
		const validatedRoles: string[][] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getSteeringMessages: async () => {
				steeringPolls++;
				return steeringPolls === 2 ? [createUserMessage("queued steering")] : [];
			},
			prepareRequest: async (requestContext) => {
				preparedRoles.push(requestContext.messages.map((message) => message.role));
				return requestContext;
			},
			transformContext: async (messages) => [...messages, createUserMessage("transformed")],
			validateRequest: async (requestContext) => {
				validatedRoles.push(requestContext.messages.map((message) => message.role));
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("first")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				mockStream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: `response ${llmCalls}` }]),
				});
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(2);
		expect(preparedRoles).toEqual([["user"], ["user", "assistant", "user"]]);
		expect(validatedRoles).toEqual([
			["user", "user"],
			["user", "assistant", "user", "user"],
		]);
	});

	it("should stop after the current turn when shouldStopAfterTurn returns true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		let steeringPolls = 0;
		let followUpPolls = 0;
		let callbackToolResultIds: string[] = [];
		let callbackContextRoles: string[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getSteeringMessages: async () => {
				steeringPolls++;
				return [];
			},
			getFollowUpMessages: async () => {
				followUpPolls++;
				return [createUserMessage("follow up should stay queued")];
			},
			shouldStopAfterTurn: async ({ message, toolResults, context }) => {
				expect(message.role).toBe("assistant");
				callbackToolResultIds = toolResults.map((toolResult) => toolResult.toolCallId);
				callbackContextRoles = context.messages.map((contextMessage) => contextMessage.role);
				return true;
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "should not run" }]),
					});
				}
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(executed).toEqual(["hello"]);
		expect(steeringPolls).toBe(1);
		expect(followUpPolls).toBe(0);
		expect(callbackToolResultIds).toEqual(["tool-1"]);
		expect(callbackContextRoles).toEqual(["user", "assistant", "toolResult"]);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("should stop after a tool batch when every tool result sets terminate=true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					terminate: true,
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
	});

	it("should stop after a blocked tool call when beforeToolCall sets terminate=true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let executed = false;
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute() {
				executed = true;
				return {
					content: [{ type: "text", text: "should not execute" }],
					details: { value: "unexpected" },
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async () => ({ block: true, reason: "Blocked by policy", terminate: true }),
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message =
					llmCalls === 1
						? createAssistantMessage(
								[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
								"toolUse",
							)
						: createAssistantMessage([{ type: "text", text: "should not run" }]);
				mockStream.push({ type: "done", reason: llmCalls === 1 ? "toolUse" : "stop", message });
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		const toolResult = messages.find((message) => message.role === "toolResult");
		expect(executed).toBe(false);
		expect(llmCalls).toBe(1);
		expect(toolResult?.role === "toolResult" ? toolResult.isError : false).toBe(true);
		expect(toolResult?.role === "toolResult" ? toolResult.content : []).toContainEqual({
			type: "text",
			text: "Blocked by policy",
		});
	});

	it("should continue after a mixed batch with one terminating blocked call", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
			beforeToolCall: async ({ args }) => {
				const { value } = args as { value: string };
				return value === "first" ? { block: true, reason: "Blocked first", terminate: true } : undefined;
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo both")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message =
					llmCalls === 1
						? createAssistantMessage(
								[
									{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
									{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
								],
								"toolUse",
							)
						: createAssistantMessage([{ type: "text", text: "done" }]);
				mockStream.push({ type: "done", reason: llmCalls === 1 ? "toolUse" : "stop", message });
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual(["second"]);
		expect(llmCalls).toBe(2);
	});

	it("should continue after parallel tool calls when not all tool results terminate", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					terminate: params.value === "first",
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("echo both")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		expect(callIndex).toBe(2);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
	});

	it("should allow afterToolCall to mark a tool batch as terminating", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			afterToolCall: async () => ({ terminate: true }),
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(1);
	});
});

describe("agentLoopContinue with AgentMessage", () => {
	it("should throw when context has no messages", () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		expect(() =>
			agentLoopContinue(context, config, undefined, () => {
				throw new Error("Unexpected stream call");
			}),
		).toThrow("Cannot continue: no messages in context");
	});

	it("should continue from existing context without emitting user message events", async () => {
		const userMessage: AgentMessage = createUserMessage("Hello");

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [userMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should only return the new assistant message (not the existing user message)
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");

		// Should NOT have user message events (that's the key difference from agentLoop)
		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBe(1);
		expect((messageEndEvents[0] as any).message.role).toBe("assistant");
	});

	it("should allow custom message types as last message (caller responsibility)", async () => {
		// Custom message that will be converted to user message by convertToLlm
		interface CustomMessage {
			role: "custom";
			text: string;
			timestamp: number;
		}

		const customMessage: CustomMessage = {
			role: "custom",
			text: "Hook content",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [customMessage as unknown as AgentMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				// Convert custom to user message
				return messages
					.map((m) => {
						if ((m as any).role === "custom") {
							return {
								role: "user" as const,
								content: (m as any).text,
								timestamp: m.timestamp,
							};
						}
						return m;
					})
					.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response to custom message" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		// Should not throw - the custom message will be converted to user message
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");
	});
});

function createToolCallThenStopStream(toolCalls: Extract<AssistantMessage["content"][number], { type: "toolCall" }>[]) {
	let calls = 0;
	return {
		streamFn: () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				calls++;
				stream.push({
					type: "done",
					reason: calls === 1 ? "toolUse" : "stop",
					message:
						calls === 1
							? createAssistantMessage(toolCalls, "toolUse")
							: createAssistantMessage([{ type: "text", text: "done" }]),
				});
			});
			return stream;
		},
		getCalls: () => calls,
	};
}

describe("Tool recovery observation", () => {
	it("uses canonical key order", () => {
		expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, a: 0 })).toBe(
			canonicalJson({ a: 0, nested: { a: 1, b: 2 }, z: 1 }),
		);
	});

	it("ignores volatile PID, time, random id, URL query, absolute paths, and secrets", async () => {
		const first = {
			path: "/tmp/agent/target.ts",
			pid: 100,
			timestamp: "2026-08-15T10:00:00Z",
			requestId: "1e6b4de2-ef2d-4f95-b771-62744f082778",
			url: "https://example.invalid/api?token=first",
			apiKey: "first-secret",
		};
		const second = {
			path: "/tmp/agent/target.ts",
			pid: 200,
			timestamp: "2026-08-15T10:01:00Z",
			requestId: "10f4be6e-1d6e-4cc4-8e45-87f39c790324",
			url: "https://example.invalid/api?token=second",
			apiKey: "second-secret",
		};
		const firstFingerprint = await createToolCallFingerprint("read", first);
		const secondFingerprint = await createToolCallFingerprint("read", second);
		expect(firstFingerprint.callSignature).toBe(secondFingerprint.callSignature);
		const canonical = canonicalJson(first);
		expect(canonical).not.toContain("first-secret");
		expect(canonical).not.toContain("/tmp/agent");
		expect(canonical).not.toContain("token=first");
	});

	it("removes URL credentials while retaining absolute target distinctions only in target hashes", async () => {
		const privateUrl = await createToolCallFingerprint("read", {
			url: "https://alice:password@example.invalid/a?token=first#fragment",
		});
		const scrubbedUrl = await createToolCallFingerprint("read", {
			url: "https://bob:other@example.invalid/a?token=second#other",
		});
		const firstPath = await createToolCallFingerprint("read", { path: "/private/one.ts" });
		const secondPath = await createToolCallFingerprint("read", { path: "/private/two.ts" });
		expect(privateUrl.targetHash).toBe(scrubbedUrl.targetHash);
		expect(firstPath.targetHash).not.toBe(secondPath.targetHash);
		const canonical = canonicalJson({
			path: "/private/one.ts",
			url: "https://alice:password@example.invalid/a?token=x",
		});
		expect(canonical).not.toContain("/private/one.ts");
		expect(canonical).not.toContain("alice");
		expect(canonical).not.toContain("password");
		expect(canonical).not.toContain("token=x");
	});

	it("changes target and failure fingerprints when the target changes", async () => {
		const first = await createToolCallFingerprint("read", { path: "src/first.ts" });
		const second = await createToolCallFingerprint("read", { path: "src/second.ts" });
		expect(first.targetHash).not.toBe(second.targetHash);
		expect(
			await createFailureFingerprint({ toolName: "read", code: "TARGET_NOT_FOUND", targetHash: first.targetHash }),
		).not.toBe(
			await createFailureFingerprint({ toolName: "read", code: "TARGET_NOT_FOUND", targetHash: second.targetHash }),
		);
	});

	it("keeps ToolExecutionError fields available to recovery", () => {
		const error = new ToolExecutionError("Timed out", {
			code: "TIMEOUT",
			category: "transient",
			retryable: true,
			details: { retryAfterMs: 10 },
		});
		expect(error.name).toBe("ToolExecutionError");
		expect(error.code).toBe("TIMEOUT");
		expect(error.category).toBe("transient");
		expect(error.retryable).toBe(true);
		expect(error.details).toEqual({ retryAfterMs: 10 });
	});

	it("classifies ordinary Tool errors as UNCLASSIFIED without retrying", async () => {
		const schema = Type.Object({ value: Type.String() });
		let executions = 0;
		const observations: ToolRecoveryObservation[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "failing",
			label: "Failing",
			description: "Failing tool",
			parameters: schema,
			async execute() {
				executions++;
				throw new Error("ordinary failure");
			},
		};
		const response = createToolCallThenStopStream([
			{ type: "toolCall", id: "call-1", name: "failing", arguments: { value: "x" } },
		]);
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolRecoveryController: new ObserveToolRecoveryController((observation) => {
					observations.push(observation);
				}),
			},
			undefined,
			response.streamFn,
		);
		for await (const _event of stream) {
			// consume
		}
		expect(executions).toBe(1);
		expect(response.getCalls()).toBe(2);
		expect(observations).toHaveLength(1);
		expect(observations[0]?.failure).toMatchObject({ code: "UNCLASSIFIED", category: "unknown", retryable: false });
	});

	it("calls hooks once and observes one finalized result", async () => {
		const schema = Type.Object({ value: Type.String() });
		let beforeCalls = 0;
		let afterCalls = 0;
		let executions = 0;
		let preflights = 0;
		const observations: ToolRecoveryObservation[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: schema,
			async execute() {
				executions++;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const response = createToolCallThenStopStream([
			{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "x" } },
		]);
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				beforeToolCall: async () => {
					beforeCalls++;
					return undefined;
				},
				afterToolCall: async () => {
					afterCalls++;
					return undefined;
				},
				toolRecoveryController: {
					preflight: () => {
						preflights++;
						return undefined;
					},
					observe: (observation) => {
						observations.push(observation);
					},
				},
			},
			undefined,
			response.streamFn,
		);
		for await (const event of stream) {
			events.push(event);
		}
		expect({ beforeCalls, afterCalls, executions, preflights }).toEqual({
			beforeCalls: 1,
			afterCalls: 1,
			executions: 1,
			preflights: 1,
		});
		expect(observations).toHaveLength(1);
		expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1);
		const recoveryEvent = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_recovery_observe" }> =>
				event.type === "tool_recovery_observe",
		);
		expect(recoveryEvent).toMatchObject({
			toolCallId: "call-1",
			toolName: "echo",
			action: "observe",
			outcome: "success",
		});
		expect(recoveryEvent).not.toHaveProperty("args");
		expect(recoveryEvent).not.toHaveProperty("result");
	});

	it("keeps schema, before-blocked, and unavailable calls on the immediate path", async () => {
		const schema = Type.Object({ value: Type.String() });
		let beforeCalls = 0;
		let afterCalls = 0;
		let executions = 0;
		let recoveryCalls = 0;
		const tool: AgentTool<typeof schema> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: schema,
			async execute() {
				executions++;
				return { content: [{ type: "text", text: "unexpected" }], details: {} };
			},
		};
		const response = createToolCallThenStopStream([
			{ type: "toolCall", id: "schema", name: "echo", arguments: {} },
			{ type: "toolCall", id: "blocked", name: "echo", arguments: { value: "blocked" } },
			{ type: "toolCall", id: "unavailable", name: "missing", arguments: {} },
		]);
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				beforeToolCall: async () => {
					beforeCalls++;
					return { block: true };
				},
				afterToolCall: async () => {
					afterCalls++;
					return undefined;
				},
				toolRecoveryController: {
					preflight: () => {
						recoveryCalls++;
						return undefined;
					},
					observe: () => {
						recoveryCalls++;
					},
				},
			},
			undefined,
			response.streamFn,
		);
		for await (const event of stream) {
			events.push(event);
		}
		expect({ beforeCalls, afterCalls, executions, recoveryCalls }).toEqual({
			beforeCalls: 1,
			afterCalls: 0,
			executions: 0,
			recoveryCalls: 0,
		});
		expect(events.filter((event) => event.type === "tool_recovery_observe")).toHaveLength(0);
	});

	it("records a post-hook failure without re-running the Tool", async () => {
		const schema = Type.Object({ value: Type.String() });
		let executions = 0;
		const observations: ToolRecoveryObservation[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: schema,
			async execute() {
				executions++;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const response = createToolCallThenStopStream([
			{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "x" } },
		]);
		const messages = await agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				afterToolCall: async () => {
					throw new ToolExecutionError("Command timed out after 1 seconds", {
						code: "TIMEOUT",
						category: "transient",
						retryable: true,
					});
				},
				toolRecoveryController: new ObserveToolRecoveryController((observation) => {
					observations.push(observation);
				}),
			},
			undefined,
			response.streamFn,
		).result();
		expect(executions).toBe(1);
		expect(observations[0]?.failure?.code).toBe("POST_HOOK_FAILURE");
		expect(observations[0]?.failure?.retryable).toBe(false);
		const toolResult = messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role === "toolResult" ? toolResult.content : []).toContainEqual({
			type: "text",
			text: "Command timed out after 1 seconds",
		});
	});

	it("retries a bounded assist decision without duplicating hooks or logical Tool events", async () => {
		const schema = Type.Object({ value: Type.String() });
		let executions = 0;
		let beforeCalls = 0;
		let afterCalls = 0;
		const delays: number[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "read",
			label: "Read",
			description: "Fault injection read",
			parameters: schema,
			async execute() {
				executions++;
				if (executions < 3) {
					throw new ToolExecutionError("timed out", {
						code: "TIMEOUT",
						category: "transient",
						retryable: true,
					});
				}
				return { content: [{ type: "text", text: "recovered" }], details: {} };
			},
		};
		const recoveryEvents: Array<Extract<AgentEvent, { type: "tool_recovery_observe" }>> = [];
		const response = createToolCallThenStopStream([
			{ type: "toolCall", id: "retry-call", name: "read", arguments: { value: "x" } },
		]);
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				beforeToolCall: async () => {
					beforeCalls++;
					return undefined;
				},
				afterToolCall: async () => {
					afterCalls++;
					return undefined;
				},
				toolRecoveryController: {
					preflight: () => undefined,
					decideAttempt: (observation) => {
						const retry = executions < 3;
						observation.action = retry ? "retry_same_args" : "stop";
						observation.warning = executions === 2;
						return {
							action: retry
								? { type: "retry_same_args", delayMs: executions * 10 }
								: { type: "stop", reason: "budget" },
							observation,
						};
					},
					waitForRetry: async (delayMs) => {
						delays.push(delayMs);
						return true;
					},
					observe: (observation) => {
						if (observation.outcome === "success") {
							observation.action = "retry_same_args";
							observation.outcome = "recovered";
						}
					},
				},
			},
			undefined,
			response.streamFn,
		);
		for await (const event of stream) {
			if (event.type === "tool_recovery_observe") recoveryEvents.push(event);
		}
		expect({ executions, beforeCalls, afterCalls, delays }).toEqual({
			executions: 3,
			beforeCalls: 1,
			afterCalls: 1,
			delays: [10, 20],
		});
		expect(recoveryEvents.map((event) => [event.action, event.outcome, event.warning ?? false])).toEqual([
			["retry_same_args", "failure", false],
			["retry_same_args", "failure", true],
			["retry_same_args", "recovered", false],
		]);
		expect(response.getCalls()).toBe(2);
	});

	it("cancels a retry during backoff without starting another Tool attempt", async () => {
		const schema = Type.Object({ value: Type.String() });
		const abortController = new AbortController();
		let executions = 0;
		let beforeCalls = 0;
		let afterCalls = 0;
		const observations: ToolRecoveryObservation[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "read",
			label: "Read",
			description: "Abort fault injection read",
			parameters: schema,
			async execute() {
				executions++;
				throw new ToolExecutionError("timed out", {
					code: "TIMEOUT",
					category: "transient",
					retryable: true,
				});
			},
		};
		const response = createToolCallThenStopStream([
			{ type: "toolCall", id: "abort-call", name: "read", arguments: { value: "x" } },
		]);
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				beforeToolCall: async () => {
					beforeCalls++;
					return undefined;
				},
				afterToolCall: async () => {
					afterCalls++;
					return undefined;
				},
				toolRecoveryController: {
					preflight: () => undefined,
					decideAttempt: (observation) => ({
						action: { type: "retry_same_args", delayMs: 10 },
						observation: { ...observation, action: "retry_same_args" },
					}),
					waitForRetry: async (_delayMs, signal) => {
						abortController.abort();
						return signal?.aborted !== true;
					},
					observe: (observation) => {
						observations.push(observation);
					},
				},
			},
			abortController.signal,
			response.streamFn,
		);
		for await (const event of stream) events.push(event);
		expect({ executions, beforeCalls, afterCalls }).toEqual({ executions: 1, beforeCalls: 1, afterCalls: 1 });
		expect(observations.at(-1)?.failure?.code).toBe("CANCELLED");
		expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1);
	});

	it("keeps parallel observations isolated by tool call", async () => {
		const schema = Type.Object({ value: Type.String() });
		let releaseFirst: (() => void) | undefined;
		let firstStarted: (() => void) | undefined;
		const firstStartedPromise = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const observations: ToolRecoveryObservation[] = [];
		const tool: AgentTool<typeof schema> = {
			name: "parallel",
			label: "Parallel",
			description: "Parallel tool",
			parameters: schema,
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					firstStarted?.();
					await firstDone;
					return { content: [{ type: "text", text: "first" }], details: {} };
				}
				await firstStartedPromise;
				releaseFirst?.();
				throw new Error("second failed");
			},
		};
		const response = createToolCallThenStopStream([
			{ type: "toolCall", id: "call-1", name: "parallel", arguments: { value: "first" } },
			{ type: "toolCall", id: "call-2", name: "parallel", arguments: { value: "second" } },
		]);
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolRecoveryController: new ObserveToolRecoveryController((observation) => {
					observations.push(observation);
				}),
			},
			undefined,
			response.streamFn,
		);
		for await (const _event of stream) {
			// consume
		}
		expect(observations.map((observation) => observation.toolCallId).sort()).toEqual(["call-1", "call-2"]);
		expect(observations.find((observation) => observation.toolCallId === "call-1")?.outcome).toBe("success");
		expect(observations.find((observation) => observation.toolCallId === "call-2")?.failure?.code).toBe(
			"UNCLASSIFIED",
		);
	});

	it("awaits aborted observations without leaving background recovery work", async () => {
		const schema = Type.Object({ value: Type.String() });
		const abortController = new AbortController();
		let pendingObservations = 0;
		let observedAbort = false;
		const tool: AgentTool<typeof schema> = {
			name: "abort",
			label: "Abort",
			description: "Abort tool",
			parameters: schema,
			async execute() {
				abortController.abort();
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const response = createToolCallThenStopStream([
			{ type: "toolCall", id: "call-1", name: "abort", arguments: { value: "x" } },
		]);
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolRecoveryController: new ObserveToolRecoveryController(async (_observation, signal) => {
					pendingObservations++;
					await Promise.resolve();
					observedAbort = signal?.aborted === true;
					pendingObservations--;
				}),
			},
			abortController.signal,
			response.streamFn,
		);
		for await (const _event of stream) {
			// consume
		}
		expect(observedAbort).toBe(true);
		expect(pendingObservations).toBe(0);
	});
});
