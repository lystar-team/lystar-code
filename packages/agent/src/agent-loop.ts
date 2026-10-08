/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	EventStream,
	getCurrentTools,
	getToolStateChanges,
	normalizeContext,
	type SystemMessage,
	type ToolResultMessage,
	type ToolStateChanges,
	toToolDeclaration,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { operationSignal, raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type { ToolRecoveryController } from "./tool-recovery/controller.ts";
import {
	createToolRecoveryCall,
	createToolRecoveryObservation,
	type ToolRecoveryAttemptDecision,
	type ToolRecoveryCall,
	type ToolRecoveryObservation,
} from "./tool-recovery/controller.ts";
import { createToolCallFingerprint } from "./tool-recovery/fingerprint.ts";
import { ToolExecutionError } from "./tool-recovery/types.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	PrepareNextTurnContext,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** 在调用前后检查取消，避免迟到的回调结果触发下一步。 */
async function abortable<T>(signal: AbortSignal | undefined, run: () => T | Promise<T>): Promise<T> {
	signal?.throwIfAborted();
	const result = await raceWithAbortSignal(Promise.resolve(run()), operationSignal(signal));
	signal?.throwIfAborted();
	return result;
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const initialMessages = declareToolChanges(context, prompts);
	const newMessages: AgentMessage[] = [...initialMessages];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...initialMessages],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const message of initialMessages) {
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	}

	try {
		await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	} catch (error) {
		await finishAbortedRun(error, newMessages, config, signal, emit);
	}
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	try {
		await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	} catch (error) {
		await finishAbortedRun(error, newMessages, config, signal, emit);
	}
	return newMessages;
}

async function finishAbortedRun(
	error: unknown,
	messages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<void> {
	if (!signal?.aborted) throw error;
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		errorMessage: "Operation aborted",
		timestamp: Date.now(),
	};
	await emit({ type: "message_start", message });
	await emit({ type: "message_end", message });
	messages.push(message);
	await emit({ type: "turn_end", message, toolResults: [] });
	await emit({ type: "agent_end", messages });
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	let explicitContinuation = false;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			let preparedMessages: AgentMessage[] = [];
			if (lastCompletedTurn) {
				const nextTurnSnapshot = await abortable(signal, () => config.prepareNextTurn?.(lastCompletedTurn!));
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					preparedMessages = nextTurnSnapshot.messages ?? [];
					config = {
						...config,
						model: nextTurnSnapshot.model ?? config.model,
						reasoning:
							nextTurnSnapshot.thinkingLevel === undefined
								? config.reasoning
								: nextTurnSnapshot.thinkingLevel === "off"
									? undefined
									: nextTurnSnapshot.thinkingLevel,
					};
				}
				// Preparation can be long-running (for example, compaction). Pick up steering
				// queued while it ran. Only poll again if the earlier poll returned nothing;
				// otherwise one-at-a-time mode would deliver two messages in this turn.
				if (pendingMessages.length === 0) {
					pendingMessages = (await config.getSteeringMessages?.()) || [];
				}
				await emit({ type: "turn_start" });
			}

			// Process prepared and queued messages before the next assistant response.
			for (const message of declareToolChanges(currentContext, [...preparedMessages, ...pendingMessages])) {
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				currentContext.messages.push(message);
				newMessages.push(message);
			}
			pendingMessages = [];

			const requestUpdate = await abortable(signal, () =>
				config.prepareRequest?.(
					{
						context: currentContext,
						model: config.model,
						thinkingLevel: config.reasoning ?? "off",
					},
					signal,
				),
			);
			if (requestUpdate) {
				currentContext = requestUpdate.context ?? currentContext;
				config = {
					...config,
					model: requestUpdate.model ?? config.model,
					reasoning:
						requestUpdate.thinkingLevel === undefined
							? config.reasoning
							: requestUpdate.thinkingLevel === "off"
								? undefined
								: requestUpdate.thinkingLevel,
				};
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				lastCompletedTurn = {
					message,
					toolResults: [],
					context: currentContext,
					newMessages,
				};
				if (!signal?.aborted) await abortable(signal, () => config.finishTurn?.(lastCompletedTurn!, signal));
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			lastCompletedTurn = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			if (signal?.aborted) {
				await emit({ type: "turn_end", message, toolResults });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
			const decision = await abortable(signal, () => config.finishTurn?.(lastCompletedTurn!, signal));
			await emit({ type: "turn_end", message, toolResults });

			if (decision?.action === "end") {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			explicitContinuation = decision?.action === "continue";
			pendingMessages = (await config.getSteeringMessages?.()) || [];
			if (hasMoreToolCalls || pendingMessages.length > 0) {
				explicitContinuation = false;
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			explicitContinuation = false;
			pendingMessages = followUpMessages;
			continue;
		}

		// No natural request was selected, so fulfill the continuation decision with one context-only turn.
		if (explicitContinuation) {
			explicitContinuation = false;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Declare tool loadout changes to the model.
 *
 * `context.tools` is what the runtime can execute; the transcript's system messages declare
 * what the model may call. Before each request the difference becomes `toolsAdded` and
 * `toolsRemoved` on a system message. When a pending system message exists, its tool fields
 * are treated as intent and replaced with the delta between the committed transcript and
 * the executable set, so replay always yields exactly `context.tools`. Otherwise a new
 * system message is inserted before the first non-system pending message.
 */
function declareToolChanges(context: AgentContext, pendingMessages: AgentMessage[]): AgentMessage[] {
	let systemIndex = -1;
	for (let i = pendingMessages.length - 1; i >= 0; i--) {
		if (pendingMessages[i].role === "system") {
			systemIndex = i;
			break;
		}
	}
	const pending = pendingMessages[systemIndex] as SystemMessage | undefined;
	const baseline = pending
		? pendingMessages.map((message, index) =>
				index === systemIndex ? withToolChanges(pending, NO_CHANGES) : message,
			)
		: pendingMessages;
	const changes = getToolStateChanges(
		getCurrentTools([...context.messages, ...baseline]),
		(context.tools ?? []).map(toToolDeclaration),
	);
	const unchanged = changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;

	if (pending) {
		// Keep the caller's message object when it already declares no tool changes.
		if (unchanged && !pending.toolsAdded?.length && !pending.toolsRemoved?.length) return pendingMessages;
		return baseline.map((message, index) => (index === systemIndex ? withToolChanges(pending, changes) : message));
	}
	if (unchanged) return pendingMessages;
	const update = withToolChanges({ role: "system", content: "", timestamp: Date.now() }, changes);
	const insertIndex = pendingMessages.findIndex((message) => message.role !== "system");
	const index = insertIndex === -1 ? pendingMessages.length : insertIndex;
	return [...pendingMessages.slice(0, index), update, ...pendingMessages.slice(index)];
}

const NO_CHANGES: ToolStateChanges = { toolsAdded: [], toolsRemoved: [] };

/** Copy a system message with its tool fields replaced by `changes`; empty lists omit the field. */
function withToolChanges(message: SystemMessage, { toolsAdded, toolsRemoved }: ToolStateChanges): SystemMessage {
	const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
	return {
		...rest,
		...(toolsAdded.length > 0 ? { toolsAdded } : {}),
		...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
	};
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await abortable(signal, () => config.transformContext!(messages, signal));
	}
	if (config.validateRequest) {
		await abortable(signal, () => config.validateRequest!({ ...context, messages }, signal));
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await abortable(signal, () => config.convertToLlm(messages));

	const llmContext = normalizeContext({ messages: llmMessages });

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await abortable(signal, () => config.getApiKey!(config.model.provider)) : undefined) ||
		config.apiKey;

	const response = await abortable(signal, () =>
		streamFunction(config.model, llmContext, {
			...config,
			apiKey: resolvedApiKey,
			signal,
		}),
	);
	// Record the requested level, whichever stream function answered.
	const result = async () =>
		Object.assign(await abortable(signal, () => response.result()), { thinkingLevel: config.reasoning ?? "off" });

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	const iterator = response[Symbol.asyncIterator]();
	for (;;) {
		const next = await abortable(signal, () => iterator.next());
		if (next.done) break;
		const event = next.value;
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
			case "websearch_start":
			case "websearch_update":
			case "websearch_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];
	const preparedEntries = await prepareToolCallBatch(
		currentContext,
		assistantMessage,
		toolCalls,
		config,
		signal,
		false,
	);

	for (const entry of preparedEntries) {
		const { toolCall, preparation } = entry;
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			await emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else if (entry.duplicate) {
			await emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			finalized = {
				toolCall,
				result: createErrorToolResult("已跳过重复 Tool 调用：相同调用正在执行。"),
				isError: true,
			};
		} else if (entry.conflictKey) {
			await emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			finalized = {
				toolCall,
				result: createExecutionKeyConflictResult(entry.conflictKey),
				isError: true,
			};
		} else {
			const beforeResult = await runBeforeToolCallHook(
				currentContext,
				assistantMessage,
				preparation.toolCall,
				preparation.args,
				config,
				signal,
			);
			if (beforeResult) {
				await emit({
					type: "tool_execution_start",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args: toolCall.arguments,
				});
				finalized = {
					toolCall,
					result: beforeResult.result,
					isError: beforeResult.isError,
				};
			} else {
				const executed = await executePreparedToolCall(preparation, signal, emit, config.toolRecoveryController);
				finalized = await finalizeExecutedToolCall(
					currentContext,
					assistantMessage,
					preparation,
					executed,
					config,
					signal,
					emit,
				);
			}
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function prepareToolCallBatch(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	runBeforeToolCall = true,
): Promise<PreparedToolCallBatchEntry[]> {
	const entries: Array<Omit<PreparedToolCallBatchEntry, "conflictKey">> = [];
	const inBatchCallSignatures = new Set<string>();
	const executionKeyCallIds = new Map<string, Set<string>>();

	for (const toolCall of toolCalls) {
		const preparation = await prepareToolCall(
			currentContext,
			assistantMessage,
			toolCall,
			config,
			signal,
			runBeforeToolCall,
		);
		let duplicate = false;
		if (preparation.kind === "prepared") {
			const fingerprint = await createToolCallFingerprint(preparation.toolCall.name, preparation.args);
			duplicate = inBatchCallSignatures.has(fingerprint.callSignature);
			if (!duplicate) {
				inBatchCallSignatures.add(fingerprint.callSignature);
				for (const executionKey of preparation.executionKeys) {
					const callIds = executionKeyCallIds.get(executionKey) ?? new Set<string>();
					callIds.add(toolCall.id);
					executionKeyCallIds.set(executionKey, callIds);
				}
			}
		}
		entries.push({ toolCall, preparation, duplicate });
		if (signal?.aborted) break;
	}

	const conflictingExecutionKeys = new Set<string>();
	for (const [executionKey, callIds] of executionKeyCallIds) {
		if (callIds.size > 1) conflictingExecutionKeys.add(executionKey);
	}

	return entries.map((entry) => {
		if (entry.preparation.kind === "immediate" || entry.duplicate) return entry;
		const conflictKey = entry.preparation.executionKeys.find((key) => conflictingExecutionKeys.has(key));
		return conflictKey === undefined ? entry : { ...entry, conflictKey };
	});
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];
	const preparedEntries = await prepareToolCallBatch(currentContext, assistantMessage, toolCalls, config, signal);

	for (const entry of preparedEntries) {
		const { toolCall, preparation } = entry;
		if (preparation.kind === "immediate") {
			finalizedCalls.push(async () => {
				await emit({
					type: "tool_execution_start",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args: toolCall.arguments,
				});
				const finalized = {
					toolCall,
					result: preparation.result,
					isError: preparation.isError,
				} satisfies FinalizedToolCallOutcome;
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			});
			continue;
		}

		if (entry.duplicate) {
			await emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			const finalized = {
				toolCall,
				result: createErrorToolResult("已跳过重复 Tool 调用：相同调用正在执行。"),
				isError: true,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			continue;
		}

		if (entry.conflictKey) {
			await emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			const finalized = {
				toolCall,
				result: createExecutionKeyConflictResult(entry.conflictKey),
				isError: true,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			continue;
		}

		finalizedCalls.push(async () => {
			if (signal?.aborted) {
				await emit({
					type: "tool_execution_start",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args: toolCall.arguments,
				});
				const finalized = {
					toolCall,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				} satisfies FinalizedToolCallOutcome;
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			}
			const executed = await executePreparedToolCall(preparation, signal, emit, config.toolRecoveryController);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
				emit,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
	executionKeys: readonly string[];
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
	error?: unknown;
	recovery?: ToolRecoveryCall;
	/** failure 已由 assist policy 记账时，最终 observe 不能重复写入。 */
	recoveryFinalized?: boolean;
};

type FinalizedToolCallOutcome = AgentToolCallOutcome;

/** The `beforeToolCall` and `afterToolCall` hooks of {@link AgentLoopConfig}. */
export type ToolCallHooks = Pick<AgentLoopConfig, "beforeToolCall" | "afterToolCall" | "toolRecoveryController">;

type ToolUpdateSink = (partialResult: AgentToolResult<any>) => Promise<void> | void;

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);
type PreparedToolCallBatchEntry = {
	toolCall: AgentToolCall;
	preparation: PreparedToolCall | ImmediateToolCallOutcome;
	duplicate: boolean;
	conflictKey?: string;
};

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function runBeforeToolCallHook(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	args: unknown,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
): Promise<ImmediateToolCallOutcome | undefined> {
	if (!config.beforeToolCall) return undefined;
	try {
		const beforeResult = await abortable(signal, () =>
			config.beforeToolCall!(
				{
					assistantMessage,
					toolCall,
					args,
					context: currentContext,
				},
				signal,
			),
		);
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		if (beforeResult?.block) {
			const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
			if (beforeResult.terminate === true) result.terminate = true;
			return { kind: "immediate", result, isError: true };
		}
		return undefined;
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(
				signal?.aborted ? "Operation aborted" : error instanceof Error ? error.message : String(error),
			),
			isError: true,
		};
	}
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
	runBeforeToolCall = true,
	tools: readonly AgentTool<any>[] = currentContext.tools ?? [],
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (runBeforeToolCall) {
			const beforeResult = await runBeforeToolCallHook(
				currentContext,
				assistantMessage,
				toolCall,
				validatedArgs,
				config,
				signal,
			);
			if (beforeResult) return beforeResult;
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		const executionKeys = tool.getExecutionKeys
			? [...new Set(await abortable(signal, () => tool.getExecutionKeys!(validatedArgs)))]
			: [];
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
			executionKeys,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(
				signal?.aborted ? "Operation aborted" : error instanceof Error ? error.message : String(error),
			),
			isError: true,
		};
	}
}

/** Options for {@link runToolCall}. */
export interface RunToolCallOptions extends ToolCallHooks {
	/** Tools the call resolves against. */
	tools: readonly AgentTool<any>[];
	/** Passed to the hooks as the message that issued the call. */
	assistantMessage: AssistantMessage;
	/** Passed to the hooks as the current agent context. */
	context: AgentContext;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateSink;
}

/**
 * Run one tool call through the same steps as a model-issued call: argument preparation, schema
 * validation, `beforeToolCall`, execution, and `afterToolCall`. Emits no events and adds no
 * messages. Tools that call other tools use this so the hooks (for example permission checks)
 * apply to those calls too.
 *
 * Never rejects for tool failures: unknown tools, validation errors, blocked calls, and thrown
 * errors come back as `isError: true`.
 */
export async function runToolCall(toolCall: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome> {
	const { assistantMessage, context, signal } = options;
	const preparation = await prepareToolCall(context, assistantMessage, toolCall, options, signal, true, options.tools);
	if (preparation.kind === "immediate") {
		return { toolCall, result: preparation.result, isError: preparation.isError };
	}
	const executed = await executePreparedToolCall(
		preparation,
		signal,
		async () => {},
		options.toolRecoveryController,
		options.onUpdate ?? (() => {}),
	);
	return finalizeExecutedToolCall(context, assistantMessage, preparation, executed, options, signal, async () => {});
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	toolRecoveryController: ToolRecoveryController | undefined,
	onUpdate: ToolUpdateSink = () => {},
): Promise<ExecutedToolCallOutcome> {
	const controller = toolRecoveryController;
	const now = controller?.now ? () => controller.now!() : Date.now;
	const recovery = controller
		? await createToolRecoveryCall(
				prepared.toolCall.id,
				prepared.toolCall.name,
				prepared.args,
				"unknown",
				prepared.tool.runtimeContext,
				now,
			)
		: undefined;

	if (recovery && controller) {
		try {
			const preflight = await abortable(signal, () => controller.preflight(recovery, signal));
			if (preflight?.blocked) {
				const observation: ToolRecoveryObservation = {
					...recovery,
					action: "stop",
					outcome: "blocked",
					durationMs: Math.max(0, now() - recovery.startedAt),
					failure: preflight.failure,
				};
				await emitRecoveryObservation(observation, emit);
				await emit({
					type: "tool_execution_start",
					toolCallId: prepared.toolCall.id,
					toolName: prepared.toolCall.name,
					args: prepared.toolCall.arguments,
				});
				return {
					result: createErrorToolResult(preflight.message),
					isError: true,
					error: new ToolExecutionError(preflight.message, {
						code: preflight.failure.code,
						category: preflight.failure.category,
						retryable: false,
					}),
					recovery,
					recoveryFinalized: true,
				};
			}
		} catch {
			// M3 observe controller 和第三方 controller 的 preflight 不能改变逻辑 Tool Call。
		}
	}

	await emit({
		type: "tool_execution_start",
		toolCallId: prepared.toolCall.id,
		toolName: prepared.toolCall.name,
		args: prepared.toolCall.arguments,
	});

	for (;;) {
		if (signal?.aborted) {
			return cancelledToolCallOutcome(recovery);
		}
		const updateEvents: Promise<void>[] = [];
		let acceptingUpdates = true;
		try {
			const result = await abortable(signal, () =>
				prepared.tool.execute(prepared.toolCall.id, prepared.args as never, signal, (partialResult) => {
					if (!acceptingUpdates || signal?.aborted) return;
					updateEvents.push(Promise.resolve(onUpdate(partialResult)));
					updateEvents.push(
						Promise.resolve(
							emit({
								type: "tool_execution_update",
								toolCallId: prepared.toolCall.id,
								toolName: prepared.toolCall.name,
								args: prepared.toolCall.arguments,
								partialResult,
							}),
						),
					);
				}),
			);
			acceptingUpdates = false;
			await Promise.all(updateEvents);
			return { result, isError: result.isError === true, recovery };
		} catch (error) {
			acceptingUpdates = false;
			await Promise.all(updateEvents);
			if (signal?.aborted) return cancelledToolCallOutcome(recovery);
			if (!recovery || !controller?.decideAttempt) {
				return {
					result: createErrorToolResult(error),
					isError: true,
					error,
					recovery,
				};
			}

			const observation = await createToolRecoveryObservation({
				call: recovery,
				isError: true,
				error,
				now,
			});
			let decision: ToolRecoveryAttemptDecision | undefined;
			try {
				decision = await abortable(signal, () => controller.decideAttempt!(observation, signal, error));
			} catch {
				decision = undefined;
			}
			if (!decision) {
				return {
					result: createErrorToolResult(error),
					isError: true,
					error,
					recovery,
				};
			}
			await emitRecoveryObservation(decision.observation, emit);
			if (decision.action.type !== "retry_same_args") {
				const replacementResult = decision.action.replacementResult;
				return {
					result: replacementResult ?? createErrorToolResult(error),
					isError: decision.action.type !== "accept_as_success",
					error: decision.action.type === "accept_as_success" ? undefined : error,
					recovery,
					recoveryFinalized: true,
				};
			}
			const retryDelay = decision.action.delayMs;
			const shouldContinue = controller.waitForRetry
				? await abortable(signal, () => controller.waitForRetry!(retryDelay, signal))
				: !signal?.aborted;
			if (!shouldContinue || signal?.aborted) return cancelledToolCallOutcome(recovery);
		}
	}
}

function cancelledToolCallOutcome(recovery: ToolRecoveryCall | undefined): ExecutedToolCallOutcome {
	const error = new ToolExecutionError("Operation aborted", {
		code: "CANCELLED",
		category: "cancelled",
		retryable: false,
	});
	return { result: createErrorToolResult(error.message), isError: true, error, recovery };
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;
	let recoveryError = executed.error;
	let recoveryPhase: "execution" | "post_hook" = "execution";

	if (config.afterToolCall && !signal?.aborted) {
		try {
			const afterResult = await abortable(signal, () =>
				config.afterToolCall!(
					{
						assistantMessage,
						toolCall: prepared.toolCall,
						args: prepared.args,
						result,
						isError,
						context: currentContext,
					},
					signal,
				),
			);
			if (afterResult) {
				// Structured content not replaced along with the content may no longer match it.
				const structuredContent =
					afterResult.structuredContent ?? (afterResult.content ? undefined : result.structuredContent);
				const afterMarkedError = afterResult.isError === true && !isError;
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				if (structuredContent === undefined) delete result.structuredContent;
				else result.structuredContent = structuredContent;
				isError = afterResult.isError ?? isError;
				if (afterMarkedError) {
					recoveryError = undefined;
					recoveryPhase = "post_hook";
				}
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
			recoveryError = error;
			recoveryPhase = "post_hook";
		}
	}

	const finalized = {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
	await observeFinalizedToolCall(
		finalized,
		executed.recovery,
		recoveryError,
		recoveryPhase,
		config.toolRecoveryController,
		signal,
		emit,
		executed.recoveryFinalized === true,
	);
	return finalized;
}

async function observeFinalizedToolCall(
	finalized: FinalizedToolCallOutcome,
	recovery: ToolRecoveryCall | undefined,
	error: unknown,
	phase: "execution" | "post_hook",
	toolRecoveryController: ToolRecoveryController | undefined,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	alreadyRecorded: boolean,
): Promise<void> {
	if (!toolRecoveryController || !recovery || (alreadyRecorded && phase === "execution")) return;
	const observation = await createToolRecoveryObservation({
		call: recovery,
		isError: finalized.isError,
		error,
		phase,
		now: toolRecoveryController.now ? () => toolRecoveryController.now!() : undefined,
	});
	try {
		await abortable(signal, () => toolRecoveryController.observe(observation, signal, error));
	} catch {
		// M3 observe controller 不能改变逻辑 Tool Call。
	}
	await emitRecoveryObservation(observation, emit);
}

async function emitRecoveryObservation(observation: ToolRecoveryObservation, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_recovery_observe",
		toolCallId: observation.toolCallId,
		toolName: observation.toolName,
		...(observation.failure ? { failureCode: observation.failure.code } : {}),
		action: observation.action,
		outcome: observation.outcome,
		durationMs: observation.durationMs,
		callSignature: observation.callSignature,
		...(observation.failure ? { failureFingerprint: observation.failure.fingerprint } : {}),
		...(observation.warning ? { warning: true } : {}),
		...(observation.targetHash ? { targetHash: observation.targetHash } : {}),
	});
}

function createErrorToolResult(error: unknown): AgentToolResult<Record<string, unknown>> {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text", text: message }],
		...(error instanceof ToolExecutionError && error.terminate ? { terminate: true } : {}),
		details:
			error instanceof ToolExecutionError
				? { ...error.details, code: error.code, category: error.category, retryable: error.retryable }
				: {},
	};
}

function createExecutionKeyConflictResult(conflictKey: string): AgentToolResult<any> {
	return createErrorToolResult(
		`同一条助手回复中不能同时修改同一个目标：${conflictKey}。请把同一文件的多个修改合并到一个 edit 或 apply_patch 调用中；本批次没有执行这些冲突修改。`,
	);
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
