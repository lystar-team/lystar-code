import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ServiceEventFields = Record<string, string | number | boolean | undefined>;
type ServiceComponent = "gateway" | "runtime" | "service";
type ServiceEvent = {
	time: string;
	component: ServiceComponent;
	pid: number;
	event: string;
} & ServiceEventFields;

const SCHEMA_VERSION = 1;
const FLUSH_INTERVAL_MS = 250;
const BATCH_SIZE = 200;
const MAX_PENDING = 5_000;

export function serviceEventLogPath(agentDir: string, profile?: string): string {
	const normalized = profile?.replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
	return join(agentDir, "web", `diagnostics${normalized && normalized !== "default" ? `-${normalized}` : ""}.sqlite`);
}

export class ServiceEventLog {
	private readonly pending: ServiceEvent[] = [];
	private readonly processInstanceId = randomUUID();
	private database?: DatabaseSync;
	private insert?: ReturnType<DatabaseSync["prepare"]>;
	private timer?: ReturnType<typeof setTimeout>;
	private dropped = 0;
	private retryAt = 0;
	private disabled = false;
	readonly path: string;
	private readonly profile: string;
	private readonly version: string;

	constructor(path: string, profile: string, version: string) {
		this.path = path;
		this.profile = profile;
		this.version = version;
	}

	record(event: ServiceEvent): void {
		if (this.pending.length === MAX_PENDING) {
			this.pending.shift();
			this.dropped++;
			if (this.dropped === 1 || this.dropped % MAX_PENDING === 0)
				process.stderr.write(
					`${JSON.stringify({ component: "service-log", event: "sqlite_backlog", path: this.path, dropped: this.dropped })}\n`,
				);
		}
		if (this.disabled) return;
		this.pending.push(event);
		this.schedule();
	}

	private schedule(): void {
		if (this.timer) return;
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				this.flush();
			},
			Math.max(FLUSH_INTERVAL_MS, this.retryAt - Date.now()),
		);
		this.timer.unref?.();
	}

	private open(): void {
		if (this.database) return;
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(this.path, { timeout: 100 });
		try {
			const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
			if (version > SCHEMA_VERSION) {
				this.disabled = true;
				throw new Error(`不支持的 Web 日志版本：${version}`);
			}
			db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
			if (version === 0) {
				db.exec(`BEGIN IMMEDIATE;
				CREATE TABLE IF NOT EXISTS events (
					id INTEGER PRIMARY KEY,
					time_ms INTEGER NOT NULL,
					time TEXT NOT NULL,
					component TEXT NOT NULL,
					event TEXT NOT NULL,
					profile TEXT NOT NULL,
					service_version TEXT NOT NULL,
					pid INTEGER NOT NULL,
					process_instance_id TEXT NOT NULL,
					client_instance_id TEXT,
					client_request_id TEXT,
					session_id TEXT,
					session_path TEXT,
					operation_id TEXT,
					request_id TEXT,
					parent_request_id TEXT,
					socket_id TEXT,
					command TEXT,
					method TEXT,
					path TEXT,
					status_code INTEGER,
					status TEXT,
					outcome TEXT,
					duration_ms INTEGER,
					queue_wait_ms INTEGER,
					process_ms INTEGER,
					error_code TEXT,
					error TEXT,
					fields_json TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS events_time ON events(time_ms);
				CREATE INDEX IF NOT EXISTS events_session ON events(session_id, time_ms);
				CREATE INDEX IF NOT EXISTS events_session_path ON events(session_path, time_ms);
				CREATE INDEX IF NOT EXISTS events_operation ON events(operation_id, time_ms);
				CREATE INDEX IF NOT EXISTS events_request ON events(request_id, time_ms);
				CREATE INDEX IF NOT EXISTS events_client_request ON events(client_request_id, time_ms);
				CREATE INDEX IF NOT EXISTS events_duration ON events(component, duration_ms) WHERE duration_ms IS NOT NULL;
				PRAGMA user_version = 1;
				COMMIT;`);
			}
			this.insert = db.prepare(`INSERT INTO events (
				time_ms, time, component, event, profile, service_version, pid, process_instance_id,
				client_instance_id, client_request_id, session_id, session_path, operation_id, request_id, parent_request_id,
				socket_id, command, method, path, status_code, status, outcome, duration_ms, queue_wait_ms,
				process_ms, error_code, error, fields_json
			) VALUES (${Array.from({ length: 28 }, () => "?").join(", ")})`);
			this.database = db;
		} catch (error) {
			db.close();
			throw error;
		}
	}

	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.pending.length === 0) return;
		if (this.retryAt > Date.now()) {
			this.schedule();
			return;
		}
		try {
			this.open();
			const batch = this.pending.slice(0, BATCH_SIZE);
			this.database!.exec("BEGIN IMMEDIATE");
			try {
				for (const event of batch) {
					const stringField = (key: string): string | null => {
						const value = event[key];
						return typeof value === "string" ? value : null;
					};
					const numberField = (key: string): number | null => {
						const value = event[key];
						return typeof value === "number" ? value : null;
					};
					this.insert!.run(
						Date.parse(event.time),
						event.time,
						event.component,
						event.event,
						this.profile,
						this.version,
						event.pid,
						this.processInstanceId,
						stringField("clientInstanceId"),
						stringField("clientRequestId"),
						stringField("sessionId"),
						stringField("sessionPath"),
						stringField("operationId"),
						stringField("requestId"),
						stringField("parentRequestId"),
						stringField("socketId"),
						stringField("command"),
						stringField("method"),
						stringField("path"),
						numberField("statusCode"),
						stringField("status"),
						stringField("outcome"),
						numberField("elapsedMs") ?? numberField("durationMs"),
						numberField("queueWaitMs"),
						numberField("processMs"),
						stringField("errorCode"),
						stringField("error"),
						JSON.stringify(event),
					);
				}
				this.database!.exec("COMMIT");
			} catch (error) {
				this.database!.exec("ROLLBACK");
				throw error;
			}
			this.pending.splice(0, batch.length);
			this.retryAt = 0;
		} catch (error) {
			this.retryAt = Date.now() + 5_000;
			if (this.disabled) this.pending.length = 0;
			process.stderr.write(
				`${JSON.stringify({ component: "service-log", event: "sqlite_write_failed", path: this.path, error: error instanceof Error ? error.message : String(error) })}\n`,
			);
		}
		if (this.pending.length > 0) this.schedule();
	}

	close(): void {
		this.retryAt = 0;
		while (this.pending.length > 0) {
			const remaining = this.pending.length;
			this.flush();
			if (this.pending.length === remaining) break;
		}
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.database?.close();
		this.database = undefined;
		this.insert = undefined;
	}
}

let currentLog: ServiceEventLog | undefined;
process.once("exit", () => currentLog?.close());

export function configureServiceEventLog(
	agentDir: string,
	profile?: string,
	version = process.env.LYSTAR_WEB_SERVICE_VERSION ?? "unknown",
): void {
	const path = serviceEventLogPath(agentDir, profile);
	if (currentLog?.path === path) return;
	currentLog?.close();
	currentLog = new ServiceEventLog(path, profile ?? "default", version);
}

export function logWebServiceEvent(component: ServiceComponent, event: string, fields: ServiceEventFields = {}): void {
	const { pid: targetPid, ...details } = fields;
	const record: ServiceEvent = {
		...details,
		...(targetPid !== undefined ? { targetPid } : {}),
		time: new Date().toISOString(),
		component,
		pid: process.pid,
		event,
	};
	process.stderr.write(`${JSON.stringify(record)}\n`);
	currentLog?.record(record);
}

export function flushServiceEventLog(): void {
	currentLog?.flush();
}

export function closeServiceEventLog(): void {
	currentLog?.close();
	currentLog = undefined;
}
