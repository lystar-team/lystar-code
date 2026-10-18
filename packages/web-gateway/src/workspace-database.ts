import { Worker } from "node:worker_threads";
import type { SessionResultState } from "@lystar/code-web-protocol";
import { logGatewayConnection } from "./connection-log.ts";
import {
	type GroupState,
	type ProjectState,
	type ResultState,
	type SessionSummaryUpdate,
	WorkspaceDatabaseStorage,
	type WorkspaceWrite,
	type WorkspaceWriteMetrics,
} from "./workspace-database-storage.ts";

export type { ResultState } from "./workspace-database-storage.ts";

const SUMMARY_BATCH_MS = 100;
const SLOW_WRITE_MS = 100;
type WriteResult = { applied: boolean; metrics?: WorkspaceWriteMetrics };
type WriterReply =
	| { id: number; result: WriteResult; error?: never }
	| { id: number; error: string; result?: never }
	| { type: "checkpoint"; durationMs: number; busy?: number; log?: number; checkpointed?: number; error?: string };

export class WorkspaceDatabase {
	readonly path: string;
	private readonly agentDir: string;
	private readonly storage: WorkspaceDatabaseStorage;
	private writer?: Worker;
	private writerError?: Error;
	private requestId = 0;
	private readonly requests = new Map<
		number,
		{ resolve: (result: WriteResult) => void; reject: (error: Error) => void }
	>();
	private writes: Promise<void> = Promise.resolve();
	private queuedWrites = 0;
	private closing?: Promise<void>;
	private summaryBatch?: { updates: Map<string, SessionSummaryUpdate>; promise: Promise<void> };

	constructor(agentDir: string) {
		this.agentDir = agentDir;
		this.storage = new WorkspaceDatabaseStorage(agentDir);
		this.path = this.storage.path;
	}

	load(): void {
		this.storage.load();
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		if (!this.writer && this.queuedWrites === 0) {
			this.storage.close();
			return Promise.resolve();
		}
		this.closing = this.writes
			.then(async () => {
				// 读连接先关闭，最后一个连接的 WAL 收尾留在写线程。
				this.storage.close();
				const writer = this.writer;
				if (writer) {
					try {
						await this.request("close");
					} finally {
						await writer.terminate();
						this.writer = undefined;
					}
				}
			})
			.finally(() => {
				this.closing = undefined;
				this.writerError = undefined;
			});
		return this.closing;
	}

	get revision(): number {
		return this.storage.revision;
	}

	readProjects(projectId?: string): ProjectState {
		return this.storage.readProjects(projectId);
	}

	readGroups(): GroupState {
		return this.storage.readGroups();
	}

	readResults(): ResultState {
		return this.storage.readResults();
	}

	getResult(sessionId: string): SessionResultState | undefined {
		return this.storage.getResult(sessionId);
	}

	getSessionsRevision(projectId: string): number {
		return this.storage.getSessionsRevision(projectId);
	}

	snapshot(): ReturnType<WorkspaceDatabaseStorage["snapshot"]> {
		return this.storage.snapshot();
	}

	updateProjects<T>(mutate: (state: ProjectState) => T): Promise<T> {
		return this.enqueue(async () => {
			for (;;) {
				const snapshot = this.storage.snapshot();
				const state = { projects: structuredClone(snapshot.projects) };
				const result = mutate(state);
				if (JSON.stringify(state.projects) === JSON.stringify(snapshot.projects)) return result;
				if (
					(await this.request({ type: "projects", revision: snapshot.revision, projects: state.projects })).applied
				)
					return result;
			}
		});
	}

	updateGroups<T>(mutate: (state: GroupState) => T): Promise<T> {
		return this.enqueue(async () => {
			for (;;) {
				const snapshot = this.storage.snapshot();
				const state = { groups: structuredClone(snapshot.groups) };
				const result = mutate(state);
				if (JSON.stringify(state.groups) === JSON.stringify(snapshot.groups)) return result;
				if ((await this.request({ type: "groups", revision: snapshot.revision, groups: state.groups })).applied)
					return result;
			}
		});
	}

	updateResults<T>(mutate: (state: ResultState) => T): Promise<T> {
		return this.enqueue(async () => {
			for (;;) {
				const snapshot = this.storage.snapshot();
				const state = {
					initializedAt: this.storage.readResults().initializedAt,
					results: structuredClone(snapshot.results),
				};
				const result = mutate(state);
				if (JSON.stringify(state.results) === JSON.stringify(snapshot.results)) return result;
				if ((await this.request({ type: "results", revision: snapshot.revision, results: state.results })).applied)
					return result;
			}
		});
	}

	updateSessionSummary(projectId: string, sessionId: string, update: SessionSummaryUpdate["update"]): Promise<void> {
		if (Object.keys(update).length === 0) return Promise.resolve();
		let batch = this.summaryBatch;
		if (!batch) {
			const updates = new Map<string, SessionSummaryUpdate>();
			const collect = new Promise<void>((resolve) => setTimeout(resolve, SUMMARY_BATCH_MS));
			const promise = this.enqueue(async () => {
				await collect;
				if (this.summaryBatch?.updates === updates) this.summaryBatch = undefined;
				await this.request({ type: "summaries", updates: [...updates.values()] });
			});
			batch = { updates, promise };
			this.summaryBatch = batch;
		}
		const key = JSON.stringify([projectId, sessionId]);
		const previous = batch.updates.get(key);
		if (
			previous?.update.updatedAt !== undefined &&
			update.updatedAt !== undefined &&
			update.updatedAt < previous.update.updatedAt
		)
			return batch.promise;
		batch.updates.set(key, { projectId, sessionId, update: { ...previous?.update, ...update } });
		return batch.promise;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing) return Promise.reject(new Error("工作区数据库正在关闭"));
		this.queuedWrites++;
		const pending = this.writes.then(operation).finally(() => {
			this.queuedWrites--;
		});
		this.writes = pending.then(
			() => {},
			() => {},
		);
		return pending;
	}

	private request(write: WorkspaceWrite | "close"): Promise<WriteResult> {
		if (this.writerError) return Promise.reject(this.writerError);
		if (!this.writer) {
			this.storage.load();
			const worker = new Worker(
				/\$bunfs|~BUN|%7EBUN/u.test(import.meta.url)
					? "./src/bun/workspace-database-worker.ts"
					: new URL(
							import.meta.url.endsWith(".ts")
								? "./workspace-database-worker.ts"
								: "./workspace-database-worker.js",
							import.meta.url,
						),
				{ workerData: { agentDir: this.agentDir } },
			);
			this.writer = worker;
			const fail = (error: Error) => {
				if (this.writerError) return;
				this.writerError = error;
				logGatewayConnection("workspace_writer_failed", { error: error.message });
				for (const pending of this.requests.values()) pending.reject(error);
				this.requests.clear();
				worker.unref();
			};
			worker.on("error", fail);
			worker.on("exit", (code) => {
				if (this.writer !== worker) return;
				if (this.requests.size > 0 || !this.closing) fail(new Error(`工作区写线程已退出：${code}`));
				this.writer = undefined;
				this.writerError = undefined;
			});
			worker.on("message", (reply: WriterReply) => {
				if ("type" in reply) {
					if (reply.error || reply.durationMs >= SLOW_WRITE_MS)
						logGatewayConnection("workspace_checkpoint", reply);
					return;
				}
				const pending = this.requests.get(reply.id);
				if (!pending) return;
				this.requests.delete(reply.id);
				if (reply.error !== undefined) pending.reject(new Error(reply.error));
				else {
					const metrics = reply.result.metrics;
					if (metrics && metrics.beginMs + metrics.writeMs + metrics.commitMs >= SLOW_WRITE_MS)
						logGatewayConnection("workspace_write_slow", {
							...metrics,
							durationMs: metrics.beginMs + metrics.writeMs + metrics.commitMs,
						});
					pending.resolve(reply.result);
				}
				if (this.requests.size === 0) worker.unref();
			});
			worker.unref();
		}
		const worker = this.writer;
		worker.ref();
		return new Promise((resolve, reject) => {
			const id = ++this.requestId;
			this.requests.set(id, { resolve, reject });
			try {
				worker.postMessage({ id, write });
			} catch (error) {
				this.requests.delete(id);
				if (this.requests.size === 0) worker.unref();
				reject(error);
			}
		});
	}
}
