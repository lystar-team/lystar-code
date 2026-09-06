import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

type QueuedEventCompactor<T> = (queue: T[], event: T) => boolean;

const COMPACTION_QUEUE_THRESHOLD = 1;

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
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
			if (this.coalesceQueuedEvent(this.queue, event)) return;
		}
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
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

function coalesceAssistantMessageEvent(queue: AssistantMessageEvent[], event: AssistantMessageEvent): boolean {
	const key = assistantMessageEventKey(event);
	if (!key) return false;
	const previous = queue.at(-1);
	if (previous === undefined || assistantMessageEventKey(previous) !== key) return false;
	queue[queue.length - 1] = event;
	return true;
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
