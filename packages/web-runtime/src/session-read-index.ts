import { readdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";
import type { SessionInfo } from "@earendil-works/pi-coding-agent/core";
import type { SubagentSnapshot } from "@lystar/code-web-protocol";
import {
	runSessionReadIndexWorker,
	type SessionIndexMetadata,
	type SessionIndexRequest,
	type SessionIndexResponse,
} from "./session-read-index-worker.ts";

export class SessionReadIndex {
	private worker?: Worker;
	private nextId = 0;
	private disposed = false;
	private readonly pending = new Map<
		number,
		{ resolve(value: SessionIndexResponse["result"]): void; reject(error: Error): void }
	>();
	private readonly databasePath: string;

	constructor(agentDir: string) {
		this.databasePath = join(agentDir, "web", "session-read-index.sqlite");
	}

	async inspect(path: string, writerLocked: boolean): Promise<SessionIndexMetadata> {
		return (await this.request("metadata", path, writerLocked)) as SessionIndexMetadata;
	}

	async listSubagents(path: string, writerLocked: boolean): Promise<SubagentSnapshot[]> {
		return (await this.request("subagents", path, writerLocked)) as SubagentSnapshot[];
	}

	async remove(path: string): Promise<void> {
		if (!this.worker) return;
		await this.request("remove", path, false);
	}

	async list(
		directory: string,
		writerLocked: (path: string) => boolean,
		metadataOnly: boolean,
	): Promise<SessionInfo[]> {
		let files: string[];
		try {
			files = await readdir(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const sessions: SessionInfo[] = [];
		// 按目录顺序建立冷索引，避免一次打开该项目的全部历史大文件。
		for (const name of files) {
			if (!name.endsWith(".jsonl")) continue;
			const file = resolvePath(directory, name);
			let info: SessionIndexMetadata;
			try {
				info = await this.inspect(file, writerLocked(file));
			} catch (error) {
				if (["ENOENT", "session_invalid"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
				throw error;
			}
			const header = info.header;
			sessions.push({
				path: file,
				id: header.id,
				cwd: header.cwd,
				name: metadataOnly && info.nameResolved ? (info.name?.trim() ?? "") : info.name?.trim(),
				parentSessionPath: header.parentSession,
				relation: header.relation,
				profile: header.profile,
				...(header.collaborationWorkspace ? { collaborationWorkspace: header.collaborationWorkspace } : {}),
				...(header.collaborationTask ? { collaborationTask: header.collaborationTask } : {}),
				...(info.collaborationResult ? { collaborationResult: info.collaborationResult } : {}),
				created: new Date(header.timestamp),
				modified: new Date(info.modifiedMs || Date.parse(header.timestamp)),
				messageCount: metadataOnly ? 0 : info.messageCount,
				firstMessage: info.firstMessage || "(no messages)",
				allMessagesText: "",
				...(info.lastOutcome ? { lastOutcome: info.lastOutcome } : {}),
			});
		}
		return sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	}

	private request(
		command: SessionIndexRequest["command"],
		path: string,
		writerLocked: boolean,
	): Promise<SessionIndexResponse["result"]> {
		if (this.disposed) return Promise.reject(new Error("会话读取索引已关闭"));
		if (!this.worker) {
			const source = `import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
(${runSessionReadIndexWorker.toString()})(fs, crypto, path, DatabaseSync, parentPort, workerData);`;
			const isBun = Boolean(process.versions.bun);
			// Bun 的 Worker 不接受 blob: 地址，通过 eval 加载内存入口。
			const specifier = isBun ? source : new URL(`data:text/javascript,${encodeURIComponent(source)}`);
			const worker = new Worker(specifier, {
				eval: isBun,
				workerData: { databasePath: this.databasePath },
			});
			this.worker = worker;
			worker.on("message", (response: SessionIndexResponse) => {
				const pending = this.pending.get(response.id);
				if (!pending) return;
				this.pending.delete(response.id);
				if (response.error)
					pending.reject(
						Object.assign(new Error(response.error.message), {
							code: response.error.code,
							retryable: response.error.retryable,
						}),
					);
				else pending.resolve(response.result);
				if (this.pending.size === 0) worker.unref();
			});
			worker.on("error", (error: Error) => this.fail(worker, error));
			worker.on("exit", (code) => this.fail(worker, new Error(`会话读取索引 worker 已退出：${code}`)));
		}
		const id = ++this.nextId;
		const worker = this.worker;
		worker.ref();
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			worker.postMessage({ id, command, path: resolvePath(path), writerLocked } satisfies SessionIndexRequest);
		});
	}

	private fail(worker: Worker, error: Error): void {
		if (this.worker !== worker) return;
		this.worker = undefined;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const worker = this.worker;
		if (!worker) return;
		this.fail(worker, new Error("会话读取索引已关闭"));
		await worker.terminate();
	}
}
