import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	closeServiceEventLog,
	configureServiceEventLog,
	logWebServiceEvent,
	ServiceEventLog,
	serviceEventLogPath,
} from "../src/service-event-log.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Web Service event log", () => {
	it("keeps Gateway and Runtime events across process and version changes", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-events-"));
		dirs.push(dir);
		const path = serviceEventLogPath(dir);
		const gateway = new ServiceEventLog(path, "default", "0.87.1");
		const runtime = new ServiceEventLog(path, "default", "0.88.0");
		gateway.record({
			time: "2026-09-27T01:00:00.000Z",
			component: "gateway",
			pid: 101,
			event: "http_request",
			requestId: "http-1",
			parentRequestId: "http-1",
			sessionId: "session-1",
			statusCode: 200,
			elapsedMs: 123,
			method: "GET",
			path: "/api/sessions/session-1",
		});
		runtime.record({
			time: "2026-09-27T01:00:01.000Z",
			component: "runtime",
			pid: 102,
			event: "request_finished",
			requestId: "ipc-1",
			sessionPath: "/sessions/one.jsonl",
			operationId: "op-1",
			queueWaitMs: 42,
			processMs: 97,
			command: "prompt",
		});
		gateway.close();
		runtime.close();

		const db = new DatabaseSync(path, { readOnly: true });
		try {
			expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
			const rows = db
				.prepare(
					"SELECT component, event, service_version, request_id, operation_id, duration_ms, queue_wait_ms, process_ms, fields_json FROM events ORDER BY time_ms",
				)
				.all();
			expect(rows).toHaveLength(2);
			expect(rows[0]).toMatchObject({
				component: "gateway",
				service_version: "0.87.1",
				request_id: "http-1",
				duration_ms: 123,
			});
			expect(rows[1]).toMatchObject({
				component: "runtime",
				service_version: "0.88.0",
				operation_id: "op-1",
				queue_wait_ms: 42,
				process_ms: 97,
			});
			expect(JSON.parse(String(rows[1]!.fields_json))).toMatchObject({
				sessionPath: "/sessions/one.jsonl",
				command: "prompt",
			});
		} finally {
			db.close();
		}

		const upgraded = new ServiceEventLog(path, "default", "0.89.0");
		upgraded.record({ time: "2026-09-27T01:00:02.000Z", component: "service", pid: 103, event: "service_started" });
		upgraded.close();
		const reopened = new DatabaseSync(path, { readOnly: true });
		try {
			expect(reopened.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 3 });
		} finally {
			reopened.close();
		}
	});

	it("stores the emitter PID separately from the managed process PID", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-events-"));
		dirs.push(dir);
		configureServiceEventLog(dir, undefined, "0.88.0");
		logWebServiceEvent("service", "runtime_stopping", { pid: 4321 });
		closeServiceEventLog();
		const db = new DatabaseSync(serviceEventLogPath(dir), { readOnly: true });
		try {
			const row = db.prepare("SELECT pid, fields_json FROM events WHERE event='runtime_stopping'").get();
			expect(row?.pid).toBe(process.pid);
			expect(JSON.parse(String(row?.fields_json)).targetPid).toBe(4321);
		} finally {
			db.close();
		}
	});

	it("drains batched events before a service exits", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-events-"));
		dirs.push(dir);
		const path = serviceEventLogPath(dir);
		const log = new ServiceEventLog(path, "default", "0.88.0");
		for (let index = 0; index < 450; index++) {
			log.record({
				time: new Date().toISOString(),
				component: "runtime",
				pid: 101,
				event: "request_finished",
				requestId: `request-${index}`,
				elapsedMs: index,
			});
		}
		log.close();
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			expect(db.prepare("SELECT COUNT(*) AS count, MAX(duration_ms) AS max_ms FROM events").get()).toEqual({
				count: 450,
				max_ms: 449,
			});
		} finally {
			db.close();
		}
	});

	it("keeps development events apart and does not rewrite a future schema", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-events-"));
		dirs.push(dir);
		expect(serviceEventLogPath(dir, "development")).toBe(join(dir, "web", "diagnostics-development.sqlite"));
		const path = serviceEventLogPath(dir);
		const log = new ServiceEventLog(path, "default", "old");
		log.record({ time: new Date().toISOString(), component: "service", pid: 1, event: "before_upgrade" });
		log.close();
		const db = new DatabaseSync(path);
		db.exec("PRAGMA user_version = 99");
		db.close();
		const older = new ServiceEventLog(path, "default", "old");
		older.record({ time: new Date().toISOString(), component: "service", pid: 2, event: "after_upgrade" });
		older.flush();
		older.close();
		const check = new DatabaseSync(path, { readOnly: true });
		try {
			expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 99 });
			expect(check.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 1 });
		} finally {
			check.close();
		}
	});
});
