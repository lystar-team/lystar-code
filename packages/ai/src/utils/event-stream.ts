import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

type QueuedEventCompactor<T> = (previous: T, event: T) => T | undefined;

const COMPACTION_QUEUE_THRESHOLD = 1;

class FifoQueue<T> {
	private incoming: T[] = [];
	private outgoing: T[] = [];

	get length(): number {
		return this.incoming.length + this.outgoing.length;
	}

	enqueue(value: T): void {
		this.incoming.push(value);
	}

	dequeue(): T | undefined {
		if (this.outgoing.length === 0) {
			while (this.incoming.length > 0) {
				this.outgoing.push(this.incoming.pop()!);
			}
		}
		return this.outgoing.pop();
	}

	peekLast(): T | undefined {
		return this.incoming.length > 0 ? this.incoming[this.incoming.length - 1] : this.outgoing[0];
	}

	replaceLast(value: T): void {
		if (this.incoming.length > 0) {
			this.incoming[this.incoming.length - 1] = value;
		} else if (this.outgoing.length > 0) {
			this.outgoing[0] = value;
		}
	}
}

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue = new FifoQueue<T>();
	private waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;
	private readonly coalesceQueuedEvent?: QueuedEventCompactor<T>;

	constructor(
		isComplete: (event: T) => boolean,
		extractResult: (event: T) => R,
		coalesceQueuedEvent?: QueuedEventCompactor<T>,
	) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.coalesceQueuedEvent = coalesceQueuedEvent;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// 消费者落后时只合并同一内容块的增量，保留边界事件和最终事件，避免累计 partial 快照堆积。
		if (this.coalesceQueuedEvent && this.queue.length >= COMPACTION_QUEUE_THRESHOLD) {
			const previous = this.queue.peekLast();
			const replacement = previous === undefined ? undefined : this.coalesceQueuedEvent(previous, event);
			if (replacement !== undefined) {
				this.queue.replaceLast(replacement);
				return;
			}
		}
		const waiter = this.waiting.dequeue();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.enqueue(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.dequeue()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.dequeue()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.enqueue(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

function assistantMessageEventKey(event: AssistantMessageEvent): string | undefined {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
		case "websearch_update":
			return `${event.type}:${event.contentIndex}`;
		default:
			return undefined;
	}
}

type AssistantMessageDeltaEvent = Extract<AssistantMessageEvent, { type: "text_delta" | "thinking_delta" }>;

function coalesceAssistantMessageEvent(
	previous: AssistantMessageEvent,
	event: AssistantMessageEvent,
): AssistantMessageEvent | undefined {
	if (event.type === "toolcall_delta") return undefined;
	const key = assistantMessageEventKey(event);
	if (!key || assistantMessageEventKey(previous) !== key) return undefined;
	if (event.type === "websearch_update") return event;
	const previousDelta = previous as AssistantMessageDeltaEvent;
	const currentDelta = event as AssistantMessageDeltaEvent;
	return { ...currentDelta, delta: previousDelta.delta + currentDelta.delta };
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
			coalesceAssistantMessageEvent,
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
