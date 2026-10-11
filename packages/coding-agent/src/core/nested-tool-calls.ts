/**
 * Tool calls that a tool makes while it runs (`ctx.executeTool()`), for example from codemode
 * scripts. The agent loop does not know about them: the session runs each one through the agent's
 * tool pipeline (`runToolCall`) with its own hooks, emits `tool_execution_*` events with
 * `parentToolCallId`, and records the calls and their usage on the model-issued call's tool result
 * message.
 *
 * Nothing here runs until a tool calls `ctx.executeTool()`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type {
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { JsonObject, NestedToolCallRecord, NestedToolCalls, TextContent, Usage } from "@earendil-works/pi-ai";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { combineUsage } from "./usage-totals.ts";

/**
 * Limits of the nested-call record on a tool result: arguments
 * over the per-call or total size are omitted, calls beyond the count are dropped, and the record
 * is marked incomplete when any of that happens.
 */
export const NESTED_CALL_LIMITS = {
	maxCalls: 256,
	maxArgumentBytesPerCall: 8 * 1024,
	maxArgumentBytesTotal: 32 * 1024,
	maxErrorChars: 500,
} as const;

const encoder = new TextEncoder();

interface ExecutionOwner {
	parent?: ExecutionOwner;
}

interface ExecutionTargetLease {
	owner: ExecutionOwner;
	parent?: ExecutionTargetLease;
	released: boolean;
}

interface ExecutionTargetWaiter {
	owner: ExecutionOwner;
	resolve: (release: () => void) => void;
	cancelled: boolean;
	release?: () => void;
}

interface ExecutionTargetState {
	active?: ExecutionTargetLease;
	waiters: ExecutionTargetWaiter[];
}

/** 按共享目标键串行执行工具；同一调用链可重入，不同调用链按键排队。 */
export class ExecutionTargetLock {
	private readonly owners = new AsyncLocalStorage<ExecutionOwner>();
	private readonly locks = new Map<string, ExecutionTargetState>();

	async run<T>(
		keys: readonly string[] | undefined,
		signal: AbortSignal | undefined,
		operation: () => Promise<T>,
	): Promise<T> {
		const owner: ExecutionOwner = { parent: this.owners.getStore() };
		return this.owners.run(owner, async () => {
			signal?.throwIfAborted();
			const releases: Array<() => void> = [];
			try {
				for (const key of [...new Set(keys ?? [])].sort()) {
					releases.push(await this.acquire(key, owner, signal));
				}
				signal?.throwIfAborted();
				return await operation();
			} finally {
				for (let index = releases.length - 1; index >= 0; index--) releases[index]?.();
			}
		});
	}

	private async acquire(key: string, owner: ExecutionOwner, signal: AbortSignal | undefined): Promise<() => void> {
		signal?.throwIfAborted();
		let state = this.locks.get(key);
		if (!state) {
			state = { waiters: [] };
			const lease: ExecutionTargetLease = { owner, released: false };
			state.active = lease;
			this.locks.set(key, state);
			return this.createRelease(key, state, lease);
		}

		if (state.active && this.isAncestor(state.active.owner, owner)) {
			const lease: ExecutionTargetLease = { owner, parent: state.active, released: false };
			state.active = lease;
			return this.createRelease(key, state, lease);
		}

		let resolveWaiter!: (release: () => void) => void;
		const promise = new Promise<() => void>((resolve) => {
			resolveWaiter = resolve;
		});
		const waiter: ExecutionTargetWaiter = { owner, resolve: resolveWaiter, cancelled: false };
		state.waiters.push(waiter);
		try {
			return await raceWithAbortSignal(promise, signal);
		} catch (error) {
			waiter.cancelled = true;
			waiter.release?.();
			this.grantNext(key, state);
			throw error;
		}
	}

	private createRelease(key: string, state: ExecutionTargetState, lease: ExecutionTargetLease): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			lease.released = true;
			if (state.active !== lease) return;
			while (state.active?.released) state.active = state.active.parent;
			if (state.active) this.grantDescendant(key, state);
			else this.grantNext(key, state);
		};
	}

	private grantDescendant(key: string, state: ExecutionTargetState): void {
		const active = state.active;
		if (!active) return;
		const index = state.waiters.findIndex(
			(waiter) => !waiter.cancelled && this.isAncestor(active.owner, waiter.owner),
		);
		if (index === -1) return;
		const [waiter] = state.waiters.splice(index, 1);
		if (!waiter) return;

		const lease: ExecutionTargetLease = { owner: waiter.owner, parent: active, released: false };
		state.active = lease;
		const release = this.createRelease(key, state, lease);
		waiter.release = release;
		waiter.resolve(release);
	}

	private grantNext(key: string, state: ExecutionTargetState): void {
		if (state.active) return;
		while (state.waiters.length > 0) {
			const waiter = state.waiters.shift();
			if (!waiter || waiter.cancelled) continue;
			const lease: ExecutionTargetLease = { owner: waiter.owner, released: false };
			state.active = lease;
			const release = this.createRelease(key, state, lease);
			waiter.release = release;
			waiter.resolve(release);
			return;
		}
		if (this.locks.get(key) === state) this.locks.delete(key);
	}

	private isAncestor(ancestor: ExecutionOwner, owner: ExecutionOwner): boolean {
		for (let current = owner.parent; current; current = current.parent) {
			if (current === ancestor) return true;
		}
		return false;
	}
}

/** What the nested calls of one model-issued tool call leave on its tool result message. */
export interface NestedCallSummary {
	/** Becomes `nestedCalls`. Undefined when no nested call was made. */
	calls: NestedToolCalls | undefined;
	/** Summed `usage` of the nested results, added to the message's `usage`. */
	usage: Usage | undefined;
}

/**
 * Collects the nested calls of one model-issued tool call, including calls made by nested tools.
 * The snapshot becomes `nestedCalls` on the tool result message.
 */
export class NestedCallRecorder {
	private readonly calls: NestedToolCallRecord[] = [];
	private readonly startedAt = new Map<NestedToolCallRecord, number>();
	private complete = true;
	private argumentBytes = 0;
	/** Summed usage of every nested result, including calls dropped from the record. */
	private usage: Usage | undefined;

	/** Record a call as it starts. Returns undefined when the call is dropped. */
	start(toolCall: AgentToolCall): NestedToolCallRecord | undefined {
		if (this.calls.length >= NESTED_CALL_LIMITS.maxCalls) {
			this.complete = false;
			return undefined;
		}
		const record: NestedToolCallRecord = { id: toolCall.id, name: toolCall.name, status: "unfinished" };
		const json = JSON.stringify(toolCall.arguments ?? {});
		const bytes = encoder.encode(json).length;
		if (
			bytes > NESTED_CALL_LIMITS.maxArgumentBytesPerCall ||
			this.argumentBytes + bytes > NESTED_CALL_LIMITS.maxArgumentBytesTotal
		) {
			record.argumentsBytes = bytes;
			this.complete = false;
		} else {
			record.arguments = JSON.parse(json) as JsonObject;
			this.argumentBytes += bytes;
		}
		this.calls.push(record);
		this.startedAt.set(record, performance.now());
		return record;
	}

	finish(record: NestedToolCallRecord | undefined, isError: boolean, errorText: string): void {
		if (!record) return;
		record.status = isError ? "error" : "ok";
		record.durationMs = Math.round(performance.now() - (this.startedAt.get(record) ?? performance.now()));
		this.startedAt.delete(record);
		if (isError && errorText) record.error = errorText.slice(0, NESTED_CALL_LIMITS.maxErrorChars);
	}

	addUsage(usage: Usage): void {
		this.usage = this.usage ? combineUsage(this.usage, usage) : usage;
	}

	get totalUsage(): Usage | undefined {
		return this.usage;
	}

	/** Copy of the record so far, or undefined when no nested call was made. */
	snapshot(): NestedToolCalls | undefined {
		if (this.calls.length === 0 && this.complete) return undefined;
		const calls = this.calls.map((call) => ({ ...call }));
		return { calls, complete: this.complete && calls.every((call) => call.status !== "unfinished") };
	}
}

export interface NestedToolCallOptions {
	/** Defaults to the calling tool's signal. */
	signal?: AbortSignal;
	/** Receives partial results of the nested tool, in addition to `tool_execution_update` events. */
	onUpdate?: AgentToolUpdateCallback;
}

/** `tool_execution_*` events of nested calls. */
export type NestedToolExecutionEvent =
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; parentToolCallId: string }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: AgentToolResult<unknown>;
			parentToolCallId: string;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
			durationMs?: number;
			parentToolCallId: string;
	  };

export interface NestedToolCallHost {
	/** Tools nested calls resolve against. */
	getTools(): readonly AgentTool[];
	/** Whether every nested call runs exclusively, as when the agent executes tool calls sequentially. */
	isSequential(): boolean;
	/** Run the call through the tool pipeline, with hooks that report `parentToolCallId`. */
	runToolCall(
		toolCall: AgentToolCall,
		parentToolCallId: string,
		signal: AbortSignal | undefined,
		onUpdate: (partialResult: AgentToolResult<unknown>) => Promise<void>,
	): Promise<AgentToolCallOutcome>;
	emit(event: NestedToolExecutionEvent): Promise<void>;
}

/** Calls below one model-issued call share its recorder. */
interface CallScope {
	recorder: NestedCallRecorder;
	nextId: number;
	/** Set inside a call that holds the exclusive queue, so its own nested calls do not wait on it. */
	holdsQueue: boolean;
	/** A running background parent keeps its recorder and call ID sequence across agent_end. */
	retained: boolean;
}

function textOf(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export class NestedToolCallRunner {
	private readonly host: NestedToolCallHost;
	/** Scopes by the id of the calling tool call. */
	private readonly scopes = new Map<string, CallScope>();
	private readonly retainedCallIds = new Set<string>();
	/** Serializes nested calls that must not run concurrently. */
	private queueTail: Promise<void> = Promise.resolve();

	constructor(host: NestedToolCallHost) {
		this.host = host;
	}

	/**
	 * Run `name` on behalf of the call `callerId`. The nested call gets the id `<callerId>/<n>`.
	 * Never rejects for tool failures: they come back as `isError: true`.
	 */
	async execute(
		callerId: string,
		name: string,
		args: unknown,
		options: NestedToolCallOptions = {},
	): Promise<AgentToolCallOutcome> {
		let scope = this.scopes.get(callerId);
		if (!scope) {
			scope = {
				recorder: new NestedCallRecorder(),
				nextId: 1,
				holdsQueue: false,
				retained: this.retainedCallIds.has(callerId),
			};
			this.scopes.set(callerId, scope);
		}
		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: `${callerId}/${scope.nextId++}`,
			name,
			arguments: (args ?? {}) as AgentToolCall["arguments"],
		};
		const record = scope.recorder.start(toolCall);
		await this.host.emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: name,
			args: toolCall.arguments,
			parentToolCallId: callerId,
		});

		const exclusive =
			!scope.holdsQueue &&
			(this.host.isSequential() ||
				this.host.getTools().find((tool) => tool.name === name)?.executionMode === "sequential");
		let release: (() => void) | undefined;
		if (exclusive) {
			const previous = this.queueTail;
			this.queueTail = new Promise((resolve) => {
				release = resolve;
			});
			await previous;
		}
		this.scopes.set(toolCall.id, {
			recorder: scope.recorder,
			nextId: 1,
			holdsQueue: scope.holdsQueue || exclusive,
			retained: scope.retained,
		});
		let outcome: AgentToolCallOutcome;
		try {
			outcome = await this.host.runToolCall(toolCall, callerId, options.signal, async (partialResult) => {
				options.onUpdate?.(partialResult);
				await this.host.emit({
					type: "tool_execution_update",
					toolCallId: toolCall.id,
					toolName: name,
					args: toolCall.arguments,
					partialResult,
					parentToolCallId: callerId,
				});
			});
		} finally {
			this.scopes.delete(toolCall.id);
			release?.();
		}

		scope.recorder.finish(record, outcome.isError, textOf(outcome.result));
		// Nested results are not persisted, so their usage is only counted through the recorder.
		if (outcome.result.usage) scope.recorder.addUsage(outcome.result.usage);
		await this.host.emit({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: name,
			result: outcome.result,
			isError: outcome.isError,
			...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
			parentToolCallId: callerId,
		});
		return outcome;
	}

	/** 标记后台调用，使其 recorder 和 ID 序列跨普通 agent_end 保留。 */
	retainRecord(toolCallId: string): void {
		this.retainedCallIds.add(toolCallId);
		const scope = this.scopes.get(toolCallId);
		if (!scope) return;
		for (const current of this.scopes.values()) {
			if (current.recorder === scope.recorder) current.retained = true;
		}
	}

	/** 取走当前调用记录；wait 终态可以同时迁移原后台调用的记录。 */
	takeRecord(toolCallId: string, transferFromToolCallId?: string): NestedCallSummary | undefined {
		const toolCallIds = new Set([toolCallId, ...(transferFromToolCallId ? [transferFromToolCallId] : [])]);
		const recorders = new Set<NestedCallRecorder>();
		for (const id of toolCallIds) {
			const scope = this.scopes.get(id);
			if (scope) recorders.add(scope.recorder);
			this.retainedCallIds.delete(id);
		}
		if (recorders.size === 0) {
			for (const id of toolCallIds) this.scopes.delete(id);
			return undefined;
		}

		for (const [id, scope] of this.scopes) {
			if (recorders.has(scope.recorder)) {
				this.scopes.delete(id);
				this.retainedCallIds.delete(id);
			}
		}

		const summaries = [...recorders].map((recorder) => ({
			calls: recorder.snapshot(),
			usage: recorder.totalUsage,
		}));
		const hasCalls = summaries.some((summary) => summary.calls !== undefined);
		const calls: NestedToolCalls | undefined = hasCalls
			? {
					calls: summaries.flatMap((summary) => summary.calls?.calls ?? []),
					complete: summaries.every((summary) => summary.calls?.complete ?? true),
				}
			: undefined;
		let usage: Usage | undefined;
		for (const summary of summaries) {
			if (summary.usage) usage = usage ? combineUsage(usage, summary.usage) : summary.usage;
		}
		return { calls, usage };
	}

	/** 只清理普通已结束调用，保留仍由后台任务持有的 recorder。 */
	clearUnretained(): void {
		for (const [id, scope] of this.scopes) {
			if (!scope.retained) this.scopes.delete(id);
		}
	}

	clear(): void {
		this.scopes.clear();
		this.retainedCallIds.clear();
	}
}
