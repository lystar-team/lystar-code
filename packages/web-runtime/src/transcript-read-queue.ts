type TranscriptRead = {
	controller: AbortController;
	run: (signal: AbortSignal) => Promise<void>;
	finish: () => void;
};

/** 每条连接串行读取历史；取消可直接移除排队任务，不等待前面的文件读取。 */
export class TranscriptReadQueue {
	private readonly reads = new Map<string, TranscriptRead>();
	private readonly idleListeners = new Set<() => void>();
	private active?: TranscriptRead;
	private closed = false;
	private readonly onError: (error: unknown) => void;

	constructor(onError: (error: unknown) => void) {
		this.onError = onError;
	}

	add(id: string, run: TranscriptRead["run"], finish: () => void): void {
		if (this.closed) {
			finish();
			return;
		}
		if (this.reads.has(id)) throw new Error("历史读取请求 ID 重复");
		this.reads.set(id, { controller: new AbortController(), run, finish });
		this.pump();
	}

	cancel(id: string): void {
		const read = this.reads.get(id);
		if (!read) return;
		read.controller.abort();
		if (read === this.active) return;
		this.reads.delete(id);
		read.finish();
		this.notifyIdle();
	}

	close(): void {
		this.closed = true;
		for (const id of this.reads.keys()) this.cancel(id);
	}

	idle(): Promise<void> {
		if (this.reads.size === 0) return Promise.resolve();
		return new Promise((resolve) => this.idleListeners.add(resolve));
	}

	private pump(): void {
		if (this.active || this.closed) return;
		const next = this.reads.entries().next().value;
		if (!next) return;
		const [id, read] = next;
		this.active = read;
		void Promise.resolve()
			.then(async () => {
				if (!read.controller.signal.aborted) await read.run(read.controller.signal);
			})
			.catch((error: unknown) => {
				if (!read.controller.signal.aborted || error !== read.controller.signal.reason) this.onError(error);
			})
			.finally(() => {
				this.reads.delete(id);
				this.active = undefined;
				read.finish();
				this.notifyIdle();
				this.pump();
			});
	}

	private notifyIdle(): void {
		if (this.reads.size !== 0) return;
		for (const resolve of this.idleListeners) resolve();
		this.idleListeners.clear();
	}
}
