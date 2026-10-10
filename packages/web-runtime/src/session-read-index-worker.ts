import type * as Crypto from "node:crypto";
import type * as Fs from "node:fs";
import type * as Path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MessagePort } from "node:worker_threads";
import type {
	SessionCollaborationResult,
	SessionEntry,
	SessionHeader,
	SessionOutcome,
	SubagentDetails,
} from "@earendil-works/pi-coding-agent/core";
import type { SubagentSnapshot } from "@lystar/code-web-protocol";

export interface SessionIndexMetadata {
	header: SessionHeader;
	leafId: string | null;
	name?: string;
	nameResolved?: boolean;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	messageCount: number;
	firstMessage: string;
	lastOutcome?: SessionOutcome;
	modifiedMs: number;
	collaborationResult?: SessionCollaborationResult;
	snapshot: { generation: string; revision: number; updatedAt: number };
}

export interface SessionIndexRequest {
	id: number;
	command: "metadata" | "subagents" | "remove";
	path: string;
	writerLocked: boolean;
}

export interface SessionIndexResponse {
	id: number;
	result?: SessionIndexMetadata | SubagentSnapshot[] | null;
	error?: { message: string; code?: string; retryable?: boolean };
}

// 函数只依赖显式参数和平台全局对象，可作为内存 worker 入口随主程序一起打包。
export function runSessionReadIndexWorker(
	fs: typeof Fs,
	crypto: typeof Crypto,
	path: typeof Path,
	Database: typeof DatabaseSync,
	port: MessagePort,
	data: { databasePath: string },
): void {
	interface FileRow {
		path: string;
		dev: number;
		ino: number;
		birth: number;
		size: number;
		mtime: number;
		ctime: number;
		read_offset: number;
		prefix_hash: string;
		tail_hash: string;
		epoch: string;
		metadata_json: string;
		subagent_offset: number;
	}
	fs.mkdirSync(path.dirname(data.databasePath), { recursive: true });
	const db = new Database(data.databasePath, { timeout: 5000 });
	db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
		CREATE TABLE IF NOT EXISTS session_files (
			path TEXT PRIMARY KEY, dev INTEGER NOT NULL, ino INTEGER NOT NULL, birth REAL NOT NULL,
			size INTEGER NOT NULL, mtime REAL NOT NULL, ctime REAL NOT NULL, read_offset INTEGER NOT NULL,
			prefix_hash TEXT NOT NULL, tail_hash TEXT NOT NULL, epoch TEXT NOT NULL,
			metadata_json TEXT NOT NULL, subagent_offset INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS subagents (
			path TEXT NOT NULL, entry_offset INTEGER NOT NULL, entry_length INTEGER NOT NULL,
			result_index INTEGER NOT NULL, run_id TEXT NOT NULL, agent_id TEXT NOT NULL,
			updated_at REAL NOT NULL, snapshot_json TEXT NOT NULL,
			PRIMARY KEY(path, entry_offset, result_index)
		);
		CREATE INDEX IF NOT EXISTS subagents_order ON subagents(path, updated_at DESC, run_id, agent_id);`);
	const find = db.prepare("SELECT * FROM session_files WHERE path=?");
	const save = db.prepare(`INSERT INTO session_files VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(path) DO UPDATE SET dev=excluded.dev, ino=excluded.ino, birth=excluded.birth,
		size=excluded.size, mtime=excluded.mtime, ctime=excluded.ctime, read_offset=excluded.read_offset,
		prefix_hash=excluded.prefix_hash, tail_hash=excluded.tail_hash, epoch=excluded.epoch,
		metadata_json=excluded.metadata_json, subagent_offset=excluded.subagent_offset`);
	const removeSubagents = db.prepare("DELETE FROM subagents WHERE path=?");
	const saveSubagent = db.prepare("INSERT OR REPLACE INTO subagents VALUES(?,?,?,?,?,?,?,?)");
	const metadataJobs = new Map<string, Promise<FileRow>>();
	const subagentJobs = new Map<string, Promise<void>>();

	function sameIdentity(row: FileRow, stat: Fs.Stats): boolean {
		return row.dev === stat.dev && row.ino === stat.ino && row.birth === stat.birthtimeMs;
	}
	function sameVersion(row: FileRow, stat: Fs.Stats): boolean {
		return (
			sameIdentity(row, stat) && row.size === stat.size && row.mtime === stat.mtimeMs && row.ctime === stat.ctimeMs
		);
	}
	function hashWindow(file: string, offset: number, length: number): string {
		const fd = fs.openSync(file, "r");
		try {
			const bytes = Buffer.allocUnsafe(length);
			let read = 0;
			while (read < length) {
				const count = fs.readSync(fd, bytes, read, length - read, offset + read);
				if (count === 0) break;
				read += count;
			}
			return crypto.createHash("sha256").update(bytes.subarray(0, read)).digest("hex");
		} finally {
			fs.closeSync(fd);
		}
	}
	function checkpointMatches(row: FileRow): boolean {
		const length = Math.min(row.read_offset, 64 * 1024);
		return (
			hashWindow(row.path, 0, length) === row.prefix_hash &&
			hashWindow(row.path, row.read_offset - length, length) === row.tail_hash
		);
	}
	function changed(): Error {
		return Object.assign(new Error("会话文件已重写，请重新读取"), { code: "cursor_stale", retryable: true });
	}

	async function scan(
		file: string,
		start: number,
		end: number,
		kind: "metadata" | "subagents",
		visit: (entry: SessionEntry | SessionHeader | undefined, prefix: string, offset: number, length: number) => void,
	): Promise<number> {
		if (start >= end) return start;
		const input = fs.createReadStream(file, { start, end: end - 1, highWaterMark: 1024 * 1024 });
		let parts: Buffer[] = [];
		let length = 0;
		let prefix = "";
		let offset = start;
		let retain = true;
		try {
			for await (const chunk of input) {
				const bytes = chunk as Buffer;
				let cursor = 0;
				while (cursor < bytes.length) {
					const newline = bytes.indexOf(10, cursor);
					const boundary = newline < 0 ? bytes.length : newline;
					length += boundary - cursor;
					if (prefix.length < 1024)
						prefix += bytes.toString("utf8", cursor, Math.min(boundary, cursor + 1024 - prefix.length));
					const type = /^\{"type":"([A-Za-z_]+)"/u.exec(prefix)?.[1];
					const role = /"message":\{"role":"([^"]+)"/u.exec(prefix)?.[1];
					if (kind === "metadata") {
						const hasId = /^\{"type":"[A-Za-z_]+","id":"([A-Za-z0-9._-]+)"/u.test(prefix);
						if (
							hasId &&
							((type === "message" && role === "toolResult") ||
								type === "compaction" ||
								type === "branch_summary")
						)
							retain = false;
						if (
							hasId &&
							type === "custom" &&
							/"customType":"(?!lystar\.collaboration\.result")[^"]+"/u.test(prefix)
						)
							retain = false;
					} else if (type && type !== "message") retain = false;
					else if (role && role !== "toolResult") retain = false;
					else if (role === "toolResult") {
						const toolName = /"toolName":"([^"]+)"/u.exec(prefix)?.[1];
						if (toolName && toolName !== "subagent") retain = false;
					}
					if (retain) parts.push(bytes.subarray(cursor, boundary));
					else parts = [];
					if (newline < 0) break;
					let entry: SessionEntry | SessionHeader | undefined;
					if (retain) {
						try {
							entry = JSON.parse(
								(parts.length === 1 ? parts[0]! : Buffer.concat(parts, length)).toString("utf8"),
							) as SessionEntry | SessionHeader;
						} catch {
							// 与会话读取器一致：不把损坏的 JSON 行当作已提交条目。
						}
					}
					if (!retain || entry) visit(entry, prefix, offset, length + 1);
					offset += length + 1;
					parts = [];
					length = 0;
					prefix = "";
					retain = true;
					cursor = newline + 1;
				}
			}
			// 未完成的末行留给下一次续读，索引只发布完整 JSONL 前缀。
			return offset;
		} finally {
			input.destroy();
		}
	}

	async function buildMetadata(file: string, writerLocked: boolean): Promise<FileRow> {
		const stat = fs.statSync(file);
		const cached = find.get(file) as FileRow | undefined;
		if (cached && sameVersion(cached, stat)) return cached;
		const append =
			cached && writerLocked && sameIdentity(cached, stat) && stat.size > cached.size && checkpointMatches(cached);
		const metadata: Omit<SessionIndexMetadata, "header" | "snapshot"> & {
			header?: SessionHeader;
			snapshot?: SessionIndexMetadata["snapshot"];
		} = append
			? (JSON.parse(cached.metadata_json) as SessionIndexMetadata)
			: {
					leafId: null,
					messageCount: 0,
					firstMessage: "",
					modifiedMs: 0,
				};
		const readOffset = await scan(file, append ? cached.read_offset : 0, stat.size, "metadata", (entry, prefix) => {
			if (!entry) {
				const id = /^\{"type":"[A-Za-z_]+","id":"([A-Za-z0-9._-]+)"/u.exec(prefix)?.[1];
				if (id) metadata.leafId = id;
				if (/^\{"type":"message",/u.test(prefix)) {
					metadata.messageCount++;
					metadata.lastOutcome = "interrupted";
				}
				return;
			}
			if (entry.type === "session") {
				metadata.header = entry;
				return;
			}
			if (entry.id) metadata.leafId = entry.id;
			if (entry.type === "session_info") {
				metadata.name = entry.name;
				metadata.nameResolved = true;
			} else if (entry.type === "model_change") metadata.model = { provider: entry.provider, id: entry.modelId };
			else if (entry.type === "thinking_level_change") metadata.thinkingLevel = entry.thinkingLevel;
			else if (entry.type === "custom" && entry.customType === "lystar.collaboration.result") {
				const result = entry.data as Partial<SessionCollaborationResult> | undefined;
				if (
					result &&
					typeof result.taskId === "string" &&
					typeof result.completedAt === "string" &&
					["completed", "failed", "aborted", "interrupted"].includes(result.outcome ?? "")
				) {
					metadata.collaborationResult = result as SessionCollaborationResult;
				}
				const time = Date.parse(entry.timestamp);
				if (Number.isFinite(time)) metadata.modifiedMs = Math.max(metadata.modifiedMs, time);
			} else if (entry.type === "message") {
				metadata.messageCount++;
				const message = entry.message;
				if (message.role === "assistant")
					metadata.lastOutcome =
						message.stopReason === "stop"
							? "completed"
							: message.stopReason === "error"
								? "failed"
								: message.stopReason === "aborted"
									? "aborted"
									: "interrupted";
				else if (message.role === "user" || message.role === "toolResult") metadata.lastOutcome = "interrupted";
				else if (message.role === "bashExecution")
					metadata.lastOutcome = message.cancelled
						? "aborted"
						: message.exitCode === null
							? "interrupted"
							: message.exitCode === 0
								? "completed"
								: "failed";
				const time =
					"timestamp" in message && typeof message.timestamp === "number"
						? message.timestamp
						: Date.parse(entry.timestamp);
				if (Number.isFinite(time)) metadata.modifiedMs = Math.max(metadata.modifiedMs, time);
				if (!metadata.firstMessage && message.role === "user") {
					metadata.firstMessage =
						typeof message.content === "string"
							? message.content
							: message.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n");
				}
			}
		});
		if (!metadata.header)
			throw Object.assign(new Error(`Session file is not a valid pi session: ${file}`), { code: "session_invalid" });
		if (metadata.modifiedMs <= 0) {
			const headerTime = Date.parse(metadata.header.timestamp);
			metadata.modifiedMs = Number.isFinite(headerTime) ? headerTime : stat.mtimeMs;
		}
		const current = fs.statSync(file);
		if (
			current.dev !== stat.dev ||
			current.ino !== stat.ino ||
			current.birthtimeMs !== stat.birthtimeMs ||
			((current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) &&
				!(writerLocked && current.size > stat.size))
		)
			throw changed();
		metadata.snapshot = {
			generation: `${metadata.header.id}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
			revision: readOffset,
			updatedAt: stat.mtimeMs,
		};
		const epoch = append ? cached.epoch : crypto.randomUUID();
		const length = Math.min(readOffset, 64 * 1024);
		const row: FileRow = {
			path: file,
			dev: stat.dev,
			ino: stat.ino,
			birth: stat.birthtimeMs,
			size: stat.size,
			mtime: stat.mtimeMs,
			ctime: stat.ctimeMs,
			read_offset: readOffset,
			prefix_hash: hashWindow(file, 0, length),
			tail_hash: hashWindow(file, readOffset - length, length),
			epoch,
			metadata_json: JSON.stringify(metadata),
			subagent_offset: 0,
		};
		db.exec("BEGIN IMMEDIATE");
		try {
			const previous = find.get(file) as FileRow | undefined;
			if (append && previous?.epoch === epoch) row.subagent_offset = previous.subagent_offset;
			else removeSubagents.run(file);
			save.run(
				row.path,
				row.dev,
				row.ino,
				row.birth,
				row.size,
				row.mtime,
				row.ctime,
				row.read_offset,
				row.prefix_hash,
				row.tail_hash,
				row.epoch,
				row.metadata_json,
				row.subagent_offset,
			);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		return row;
	}

	function metadata(file: string, writerLocked: boolean): Promise<FileRow> {
		const pending = metadataJobs.get(file);
		if (pending) return pending;
		const job = buildMetadata(file, writerLocked).finally(() => metadataJobs.delete(file));
		metadataJobs.set(file, job);
		return job;
	}

	async function buildSubagents(row: FileRow): Promise<void> {
		if (row.subagent_offset >= row.read_offset) return;
		const snapshots: Array<{ offset: number; length: number; index: number; snapshot: SubagentSnapshot }> = [];
		await scan(row.path, row.subagent_offset, row.read_offset, "subagents", (entry, _prefix, offset, length) => {
			if (entry?.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "subagent")
				return;
			const details = entry.message.details as Partial<SubagentDetails> | undefined;
			if (!Array.isArray(details?.results)) return;
			for (const [index, result] of details.results.entries()) {
				if (!result?.agentId || !result.agent || !result.runId) continue;
				snapshots.push({
					offset,
					length,
					index,
					snapshot: {
						runId: result.runId,
						agentId: result.agentId,
						agent: result.agent,
						agentSource: result.agentSource ?? "unknown",
						task: result.task,
						state: result.state ?? "succeeded",
						...(result.currentAction ? { currentAction: result.currentAction } : {}),
						startedAt: result.startedAt ?? Date.parse(entry.timestamp),
						updatedAt: result.updatedAt ?? Date.parse(entry.timestamp),
						elapsedMs: result.elapsedMs ?? 0,
						controllable: false,
						...(result.session ? { session: result.session } : {}),
					},
				});
			}
		});
		const stat = fs.statSync(row.path);
		if (!sameIdentity(row, stat) || stat.size < row.size || !checkpointMatches(row)) throw changed();
		db.exec("BEGIN IMMEDIATE");
		try {
			if ((find.get(row.path) as FileRow | undefined)?.epoch !== row.epoch) throw changed();
			for (const item of snapshots)
				saveSubagent.run(
					row.path,
					item.offset,
					item.length,
					item.index,
					item.snapshot.runId,
					item.snapshot.agentId,
					item.snapshot.updatedAt,
					JSON.stringify(item.snapshot),
				);
			db.prepare("UPDATE session_files SET subagent_offset=MAX(subagent_offset,?) WHERE path=?").run(
				row.read_offset,
				row.path,
			);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	async function handle(request: SessionIndexRequest): Promise<SessionIndexResponse> {
		try {
			if (request.command === "remove") {
				db.exec("BEGIN IMMEDIATE");
				try {
					removeSubagents.run(request.path);
					db.prepare("DELETE FROM session_files WHERE path=?").run(request.path);
					db.exec("COMMIT");
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
				return { id: request.id, result: null };
			}
			let row = await metadata(request.path, request.writerLocked);
			if (request.command === "metadata")
				return { id: request.id, result: JSON.parse(row.metadata_json) as SessionIndexMetadata };
			while (row.subagent_offset < row.read_offset) {
				let pending = subagentJobs.get(request.path);
				if (!pending) {
					pending = buildSubagents(row).finally(() => subagentJobs.delete(request.path));
					subagentJobs.set(request.path, pending);
				}
				await pending;
				const latest = find.get(request.path) as FileRow | undefined;
				if (!latest || latest.epoch !== row.epoch) throw changed();
				row = latest;
			}
			const result = db
				.prepare("SELECT snapshot_json FROM subagents WHERE path=? ORDER BY entry_offset, result_index")
				.all(request.path) as Array<{ snapshot_json: string }>;
			const snapshots = result.map((item) => JSON.parse(item.snapshot_json) as SubagentSnapshot);
			snapshots.sort(
				(left, right) =>
					right.updatedAt - left.updatedAt ||
					left.runId.localeCompare(right.runId) ||
					left.agentId.localeCompare(right.agentId),
			);
			return { id: request.id, result: snapshots };
		} catch (error) {
			const reason = error as Error & { code?: string; retryable?: boolean };
			return {
				id: request.id,
				error: {
					message: reason.message,
					...(reason.code ? { code: reason.code } : {}),
					...(reason.retryable === undefined ? {} : { retryable: reason.retryable }),
				},
			};
		}
	}
	port.on("message", (request: SessionIndexRequest) => {
		void handle(request).then((response) => port.postMessage(response));
	});
	port.once("close", () => db.close());
}
