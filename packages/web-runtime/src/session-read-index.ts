import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { Socket } from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { getSessionIndexBinaryPath, type SessionInfo } from "@earendil-works/pi-coding-agent/core";
import type { ContentChunk, ReadImageContentResult, SubagentSnapshot, TranscriptItem } from "@lystar/code-web-protocol";
import type {
	SessionIndexMetadata,
	SessionIndexRequest,
	SessionIndexResponse,
	SessionIndexTranscriptPage,
	SessionTranscriptOptions,
} from "./session-read-index-protocol.ts";

export class SessionReadIndex {
	private worker?: ChildProcessWithoutNullStreams;
	private nextId = 0;
	private disposed = false;
	private readonly pending = new Map<
		number,
		{
			resolve(value: SessionIndexResponse["result"]): void;
			reject(error: Error): void;
			transcript?: { items: TranscriptItem[]; stepItems: TranscriptItem[]; contextCalls: TranscriptItem[] };
		}
	>();
	private readonly databasePath: string;

	constructor(agentDir?: string) {
		this.databasePath = agentDir ? join(agentDir, "web", "session-read-index.sqlite") : ":memory:";
	}

	async inspect(path: string, writerLocked: boolean): Promise<SessionIndexMetadata> {
		return (await this.request("metadata", path, writerLocked)) as SessionIndexMetadata;
	}

	async listSubagents(path: string, writerLocked: boolean): Promise<SubagentSnapshot[]> {
		const snapshots = (await this.request("subagents", path, writerLocked)) as SubagentSnapshot[];
		return snapshots.sort(
			(left, right) =>
				right.updatedAt - left.updatedAt ||
				left.runId.localeCompare(right.runId) ||
				left.agentId.localeCompare(right.agentId),
		);
	}

	async readTranscript(
		path: string,
		options: SessionTranscriptOptions,
		maxJsonlLineBytes: number,
	): Promise<SessionIndexTranscriptPage> {
		return (await this.request("history", path, false, {
			transcript: { ...options, maxJsonlLineBytes },
		})) as SessionIndexTranscriptPage;
	}

	async readContent(path: string, contentRef: string, offset: number, limit: number): Promise<ContentChunk> {
		return (await this.request("history_content", path, false, { contentRef, offset, limit })) as ContentChunk;
	}

	async readImage(path: string, contentRef: string): Promise<ReadImageContentResult> {
		return (await this.request("history_image", path, false, { contentRef })) as ReadImageContentResult;
	}

	async resolveJoinedText<T extends Pick<TranscriptItem, "view">>(
		path: string,
		items: readonly T[],
	): Promise<readonly T[]> {
		const joins = new Set<string>();
		for (const { view } of items) {
			if (view && "contentRef" in view && view.contentRef?.startsWith("native:join:")) joins.add(view.contentRef);
		}
		if (joins.size === 0) return items;
		const resolved = (await this.request("history_join", path, false, { joins: [...joins] })) as Record<
			string,
			string
		>;
		return items.map((item) => {
			const view = item.view;
			if (!view || !("contentRef" in view) || !view.contentRef?.startsWith("native:join:")) return item;
			const contentRef = resolved[view.contentRef];
			if (!contentRef) throw new Error("Go history backend did not resolve a joined text reference");
			return { ...item, view: { ...view, contentRef } };
		});
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
		fields: Pick<SessionIndexRequest, "transcript" | "contentRef" | "offset" | "limit" | "joins"> = {},
	): Promise<SessionIndexResponse["result"]> {
		if (this.disposed) return Promise.reject(new Error("会话读取索引已关闭"));
		if (!this.worker) {
			const worker = spawn(getSessionIndexBinaryPath(), ["--database", this.databasePath], {
				stdio: "pipe",
				windowsHide: true,
			});
			this.worker = worker;
			let responseChunks: Buffer[] = [];
			let responseBytes = 0;
			worker.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
			worker.stdout.on("data", (chunk: Buffer) => {
				let offset = 0;
				while (offset < chunk.length) {
					const newline = chunk.indexOf(10, offset);
					if (newline < 0) {
						responseChunks.push(chunk.subarray(offset));
						responseBytes += chunk.length - offset;
						break;
					}
					const tail = chunk.subarray(offset, newline);
					const line = responseChunks.length
						? Buffer.concat([...responseChunks, tail], responseBytes + tail.length).toString("utf8")
						: tail.toString("utf8");
					responseChunks = [];
					responseBytes = 0;
					offset = newline + 1;
					let response: SessionIndexResponse;
					try {
						response = JSON.parse(line) as SessionIndexResponse;
					} catch (error) {
						this.fail(worker, error instanceof Error ? error : new Error(String(error)));
						return;
					}
					const pending = this.pending.get(response.id);
					if (!pending) continue;
					if (response.transcriptPart && response.item && pending.transcript) {
						pending.transcript[response.transcriptPart].push(response.item);
						continue;
					}
					this.pending.delete(response.id);
					if (response.error)
						pending.reject(
							Object.assign(new Error(response.error.message), {
								code: response.error.code,
								retryable: response.error.retryable,
							}),
						);
					else if (pending.transcript) {
						const { items, stepItems, contextCalls } = pending.transcript;
						pending.resolve({
							...(response.result as SessionIndexTranscriptPage),
							items,
							stepItems,
							...(contextCalls.length ? { contextCalls } : {}),
						});
					} else pending.resolve(response.result);
					if (this.pending.size === 0) {
						worker.unref();
						for (const stream of [worker.stdin, worker.stdout, worker.stderr]) {
							if (stream instanceof Socket) stream.unref();
						}
					}
				}
			});
			for (const stream of [worker.stdin, worker.stdout, worker.stderr]) {
				stream.on("error", (error: Error) => this.fail(worker, error));
			}
			worker.on("error", (error: Error) => this.fail(worker, error));
			worker.on("exit", (code, signal) => this.fail(worker, new Error(`会话读取索引进程已退出：${signal ?? code}`)));
		}
		const id = ++this.nextId;
		const worker = this.worker;
		worker.ref();
		for (const stream of [worker.stdin, worker.stdout, worker.stderr]) {
			if (stream instanceof Socket) stream.ref();
		}
		return new Promise((resolve, reject) => {
			this.pending.set(id, {
				resolve,
				reject,
				...(command === "history" ? { transcript: { items: [], stepItems: [], contextCalls: [] } } : {}),
			});
			worker.stdin.write(
				`${JSON.stringify({ id, command, path: resolvePath(path), writerLocked, ...fields } satisfies SessionIndexRequest)}\n`,
				(error) => {
					if (error) this.fail(worker, error);
				},
			);
		});
	}

	private fail(worker: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.worker !== worker) return;
		this.worker = undefined;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		worker.stdin.destroy();
		worker.stdout.destroy();
		worker.stderr.destroy();
		worker.kill();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const worker = this.worker;
		if (!worker) return;
		const closed = new Promise<void>((resolve) => worker.once("close", () => resolve()));
		worker.ref();
		for (const stream of [worker.stdin, worker.stdout, worker.stderr]) {
			if (stream instanceof Socket) stream.ref();
		}
		for (const pending of this.pending.values()) pending.reject(new Error("会话读取索引已关闭"));
		this.pending.clear();
		// EOF lets Go finish in-flight work and remove its temporary content files.
		worker.stdin.end();
		await closed;
	}
}
