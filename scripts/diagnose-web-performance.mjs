#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";

const HELP = `Web 会话与性能诊断（只读 SQLite，不停止服务）

node scripts/diagnose-web-performance.mjs [选项]
  --db <path>             日志数据库；默认 agentDir/web/diagnostics.sqlite
  --profile <name>        选择 diagnostics-<name>.sqlite
  --since <ISO time>      起点，默认过去一小时；建议包含时区
  --until <ISO time>      终点，默认当前时间
  --session <id|path>     筛选会话；保留进程级阻塞证据
  --request <id>          筛选请求及它关联的 HTTP 请求
  --slow-ms <number>      慢请求/慢阶段阈值，默认 1000
  --limit <number>        每类最多返回多少条，默认 30，最大 200
  --browser <path>        合并页面下载的浏览器诊断 JSON
  --cpu-profile <path>    分析指定 .cpuprofile 或 .cpuprofile.gz
  --out <path>            保存完整 JSON 报告
  --json                 标准输出改为 JSON
  --help                 显示帮助

自动分析范围内最多五份 CPU 采样。报告按进程实例区分版本；排队期间的
其他请求仅列为重叠候选，不把重叠直接认定为因果。未结束请求以范围终点
为准，不代表此刻仍在运行。报告不会生成历史日志中不存在的调用栈。`;

function options(argv) {
	const result = { slowMs: 1000, limit: 30, until: Date.now(), json: false };
	const values = new Map([
		["--db", "db"], ["--profile", "profile"], ["--since", "since"], ["--until", "until"],
		["--session", "session"], ["--request", "request"], ["--browser", "browser"],
		["--cpu-profile", "cpuProfile"], ["--out", "out"], ["--slow-ms", "slowMs"], ["--limit", "limit"],
	]);
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help") return { help: true };
		if (arg === "--json") { result.json = true; continue; }
		const key = values.get(arg);
		if (!key) throw new Error(`未知参数：${arg}`);
		const value = argv[++index];
		if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少值`);
		if (key === "slowMs" || key === "limit") {
			const number = Number(value);
			if (!Number.isSafeInteger(number) || number < 1 || (key === "limit" && number > 200))
				throw new Error(`${arg} 必须是正整数${key === "limit" ? "，且不超过 200" : ""}`);
			result[key] = number;
		} else if (key === "since" || key === "until") {
			const time = Date.parse(value);
			if (!Number.isFinite(time)) throw new Error(`${arg} 不是有效时间：${value}`);
			result[key] = time;
		} else result[key] = value;
	}
	result.since ??= result.until - 3_600_000;
	if (result.since >= result.until) throw new Error("--since 必须早于 --until");
	if (result.db && result.profile) throw new Error("--db 与 --profile 只能选择一个");
	if (result.profile && !/^[A-Za-z0-9_.-]+$/u.test(result.profile)) throw new Error("--profile 只能包含字母、数字、点、下划线和横线");
	const suffix = result.profile && result.profile !== "default" ? `-${result.profile}` : "";
	result.db = resolve(result.db ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "web", `diagnostics${suffix}.sqlite`));
	return result;
}

function cpuSummary(path) {
	const bytes = readFileSync(path);
	const profile = JSON.parse((path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
	if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples) || !Array.isArray(profile.timeDeltas) || profile.samples.length !== profile.timeDeltas.length)
		throw new Error("CPU 采样缺少 nodes/samples/timeDeltas，或样本长度不一致");
	const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
	const parents = new Map();
	for (const node of profile.nodes) {
		if (!node.callFrame || typeof node.callFrame.functionName !== "string") throw new Error("CPU 采样的 callFrame 无效");
		for (const child of node.children ?? []) parents.set(child, node.id);
	}
	const self = new Map();
	const inclusive = new Map();
	let sampledUs = 0;
	let idleUs = 0;
	for (let index = 0; index < profile.samples.length; index++) {
		const id = profile.samples[index];
		const elapsed = profile.timeDeltas[index];
		if (!nodes.has(id) || !Number.isFinite(elapsed) || elapsed < 0) throw new Error("CPU 采样包含未知节点或无效时间差");
		sampledUs += elapsed;
		if (nodes.get(id).callFrame.functionName === "(idle)") idleUs += elapsed;
		self.set(id, (self.get(id) ?? 0) + elapsed);
		const seen = new Set();
		for (let current = id; current !== undefined; current = parents.get(current)) {
			if (seen.has(current)) throw new Error("CPU 采样节点出现循环");
			seen.add(current);
			inclusive.set(current, (inclusive.get(current) ?? 0) + elapsed);
		}
	}
	const topFrames = [...nodes.values()]
		.filter((node) => !["(root)", "(idle)", "(program)"].includes(node.callFrame.functionName) && (self.get(node.id) ?? 0) > 0)
		.sort((a, b) => (self.get(b.id) ?? 0) - (self.get(a.id) ?? 0)).slice(0, 20)
		.map((node) => ({
			function: node.callFrame.functionName || "(anonymous)", url: node.callFrame.url,
			line: node.callFrame.lineNumber + 1,
			selfSampleMs: Math.round((self.get(node.id) ?? 0) / 1000),
			inclusiveSampleMs: Math.round((inclusive.get(node.id) ?? 0) / 1000),
		}));
	return { path, samples: profile.samples.length, sampledMs: Math.round(sampledUs / 1000), idleSampleMs: Math.round(idleUs / 1000), topFrames };
}

function diagnose(opts) {
	const warnings = [];
	const db = new DatabaseSync(opts.db, { readOnly: true, timeout: 1000 });
	try {
		const schema = db.prepare("PRAGMA user_version").get().user_version;
		if (schema !== 1) throw new Error(`不支持的日志结构版本：${schema}`);
		db.exec("BEGIN");
		const bindings = [opts.since, opts.until];
		let filter = "time_ms BETWEEN ? AND ?";
		if (opts.session) {
			filter += " AND (session_id = ? OR session_path = ? OR substr(session_path, -length(?)) = ? OR event IN ('event_loop_delay','cpu_profile_saved','cpu_recorder_unavailable','cpu_recorder_failed'))";
			const suffix = `_${opts.session}.jsonl`;
			bindings.push(opts.session, opts.session, suffix, suffix);
		}
		if (opts.request) {
			const related = db.prepare(`SELECT request_id, parent_request_id FROM events
				WHERE time_ms BETWEEN ? AND ? AND (request_id = ? OR parent_request_id = ?)`)
				.all(opts.since, opts.until, opts.request, opts.request);
			const ids = [...new Set([opts.request, ...related.flatMap((event) => [event.request_id, event.parent_request_id]).filter(Boolean)])];
			const placeholders = ids.map(() => "?").join(",");
			filter += ` AND (request_id IN (${placeholders}) OR parent_request_id IN (${placeholders}) OR event IN ('event_loop_delay','cpu_profile_saved','cpu_recorder_unavailable','cpu_recorder_failed'))`;
			bindings.push(...ids, ...ids);
		}
		const query = (predicate, order = "time_ms DESC", limit = opts.limit, extraBindings = []) => db.prepare(
			`SELECT * FROM events WHERE ${filter} AND (${predicate}) ORDER BY ${order} LIMIT ?`,
		).all(...bindings, ...extraBindings, limit).map((row) => {
			const { fields_json, ...event } = row;
			try { return { ...event, fields: JSON.parse(fields_json) }; }
			catch { warnings.push(`事件 ${row.id} 的 fields_json 无法解析`); return { ...event, fields: {} }; }
		});
		const processes = db.prepare(`SELECT profile, service_version, component, pid, process_instance_id,
			count(*) AS events, min(time) AS first, max(time) AS last FROM events
			WHERE ${filter} GROUP BY profile, service_version, component, pid, process_instance_id ORDER BY first`).all(...bindings);
		const slowRequests = query(`event IN ('request_finished','runtime_request','http_request') AND
			(duration_ms >= ${opts.slowMs} OR outcome IN ('timeout','disconnected'))`, "COALESCE(duration_ms, 0) DESC");
		const overlaps = db.prepare(`SELECT request_id, command, session_path, time,
			queue_wait_ms, process_ms, duration_ms FROM events WHERE component = 'runtime'
			AND event = 'request_finished' AND process_instance_id = ? AND client_instance_id IS ?
			AND request_id != ? AND time_ms BETWEEN ? AND ? AND time_ms - process_ms < ?
			AND process_ms >= ? ORDER BY process_ms DESC LIMIT 5`);
		for (const request of slowRequests) {
			if (request.component !== "runtime" || !(request.queue_wait_ms >= opts.slowMs)) continue;
			const receivedAt = request.time_ms - request.duration_ms;
			const startedAt = request.time_ms - request.process_ms;
			request.queueOverlapCandidates = overlaps.all(request.process_instance_id, request.client_instance_id,
				request.request_id, receivedAt, request.time_ms, startedAt, opts.slowMs);
			request.queueOverlapNote = "这些请求与排队时间重叠；未记录队列依赖时不能认定因果";
		}
		const delays = query(`event = 'event_loop_delay' AND json_extract(fields_json, '$.maxMs') >= ${opts.slowMs}`, "json_extract(fields_json, '$.maxMs') DESC");
		const phases = query(`event = 'runtime_phase_finished' AND duration_ms >= ${opts.slowMs}`, "duration_ms DESC");
		const gaps = query("event = 'session_subscription_sent' AND json_extract(fields_json, '$.gap') = 1");
		const failures = query("error_code IS NOT NULL OR outcome IN ('timeout','disconnected','failed') OR event IN ('cpu_recorder_failed','cpu_recorder_unavailable')");
		const unfinished = db.prepare(`SELECT queued.time, queued.command, queued.request_id, queued.session_path,
			queued.pid, queued.process_instance_id, (SELECT min(start.time) FROM events start
			WHERE start.process_instance_id = queued.process_instance_id AND start.request_id = queued.request_id
			AND start.event = 'request_started' AND start.time_ms <= ?) AS started_at
			FROM events queued WHERE ${filter} AND queued.event = 'request_queued'
			AND NOT EXISTS (SELECT 1 FROM events done WHERE done.process_instance_id = queued.process_instance_id
			AND done.request_id = queued.request_id AND done.event IN ('request_finished','request_skipped')
			AND done.time_ms <= ?) ORDER BY queued.time_ms DESC LIMIT ?`).all(opts.until, ...bindings, opts.until, opts.limit);
		const profileEvents = query("event = 'cpu_profile_saved'", "json_extract(fields_json, '$.maxDelayMs') DESC", 5);
		const profilePaths = opts.cpuProfile ? [resolve(opts.cpuProfile)] : [...new Set(profileEvents.map((event) => event.fields.path).filter((path) => typeof path === "string"))];
		const cpuProfiles = profilePaths.map((path) => {
			try { return cpuSummary(path); }
			catch (error) { warnings.push(`CPU 采样 ${path}：${error.message}`); return { path, unavailable: error.message }; }
		});
		let browserEntries = [];
		if (opts.browser) {
			const browser = JSON.parse(readFileSync(resolve(opts.browser), "utf8"));
			if (!Array.isArray(browser.entries)) throw new Error("浏览器诊断 JSON 缺少 entries");
			browserEntries = browser.entries.filter((entry) => {
				const time = Date.parse(entry.timestamp);
				if (!(time >= opts.since && time <= opts.until)) return false;
				const sessionId = opts.session?.match(/_([a-f0-9-]{36})\.jsonl$/iu)?.[1] ?? opts.session;
				if (sessionId && entry.details?.sessionId !== sessionId) return false;
				return true;
			}).slice(-opts.limit);
		}
		const requestIds = [...new Set(slowRequests.map((event) => event.request_id).filter(Boolean))];
		const requestPredicate = requestIds.length ? ` OR request_id IN (${requestIds.map(() => "?").join(",")})` : "";
		const timeline = query(`event IN ('session_subscription_sent','runtime_phase_started','runtime_phase_finished','event_loop_delay','cpu_profile_saved','runtime_disconnected','websocket_close') OR error_code IS NOT NULL${requestPredicate}`, "time_ms DESC", opts.limit, requestIds)
			.map((event) => ({ time: event.time, component: event.component, event: event.event, sessionId: event.session_id,
				sessionPath: event.session_path, requestId: event.request_id, pid: event.pid, version: event.service_version,
				durationMs: event.duration_ms, fields: event.fields }));
		for (const entry of browserEntries) timeline.push({ time: entry.timestamp, component: "browser", event: entry.scope, details: entry.details, message: entry.message });
		timeline.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
		const report = {
			generatedAt: new Date().toISOString(), database: opts.db, readOnly: true,
			window: { since: new Date(opts.since).toISOString(), until: new Date(opts.until).toISOString() },
			filters: { session: opts.session, request: opts.request, slowMs: opts.slowMs, limitPerCategory: opts.limit },
			processes, slowRequests, delays, phases, gaps, failures, unfinished, cpuProfiles, browserEntries, timeline, warnings,
			notes: [
				"queue_wait_ms 高表示排队；process_ms 高表示处理慢，但异步处理时间不等于 CPU 时间。",
				"event_loop_delay 与慢同步阶段、CPU 采样共同用于定位主线程阻塞。CPU 采样时长是估算，不等同于精确 CPU 计时。",
				"unfinished 仅表示范围终点前没有结束记录；日志缺失、进程退出和请求仍在运行需另行区分。",
				"各类别按 limit 截取；timeline 是证据摘录，不是完整事件流。没有 CPU 采样的历史故障无法恢复调用栈。",
			],
		};
		db.exec("COMMIT");
		return report;
	} finally { db.close(); }
}

function printReport(report) {
	console.log(`数据库：${report.database}\n时间范围：${report.window.since} — ${report.window.until}`);
	console.table(report.processes.map((process) => ({ version: process.service_version, component: process.component, pid: process.pid, events: process.events })));
	console.log(`慢请求 ${report.slowRequests.length}；事件循环阻塞 ${report.delays.length}；慢阶段 ${report.phases.length}；订阅断档 ${report.gaps.length}；未结束 ${report.unfinished.length}`);
	console.table(report.slowRequests.map((request) => ({ time: request.time, command: request.command ?? request.path,
		component: request.component, queueMs: request.queue_wait_ms, processMs: request.process_ms,
		totalMs: request.duration_ms, requestId: request.request_id })));
	for (const request of report.slowRequests) {
		if (request.queueOverlapCandidates?.length) {
			console.log(`请求 ${request.request_id} 的排队重叠候选（不是因果证明）：`);
			console.table(request.queueOverlapCandidates);
		}
	}
	if (report.delays.length) console.table(report.delays.map((event) => ({ time: event.time, pid: event.pid,
		maxDelayMs: event.fields.maxMs, windowMs: event.fields.windowMs, cpuMs: event.fields.cpuMs })));
	if (report.phases.length) console.table(report.phases.map((event) => ({ time: event.time, phase: event.fields.phase,
		kind: event.fields.kind, totalMs: event.duration_ms, cpuMs: event.fields.cpuMs, requestId: event.request_id })));
	if (report.failures.length) console.table(report.failures.map((event) => ({ time: event.time, event: event.event,
		error: event.error ?? event.fields.reason, requestId: event.request_id })));
	if (report.unfinished.length) console.table(report.unfinished);
	for (const profile of report.cpuProfiles) {
		console.log(`CPU 采样：${profile.path}${profile.unavailable ? `（不可用：${profile.unavailable}）` : ""}`);
		if (profile.topFrames) console.table(profile.topFrames);
	}
	for (const note of report.notes) console.log(note);
	for (const warning of report.warnings) console.error(`证据缺口：${warning}`);
}

try {
	const opts = options(process.argv.slice(2));
	if (opts.help) console.log(HELP);
	else {
		if (opts.out) {
			const output = resolve(opts.out);
			const sources = [opts.db, opts.browser, opts.cpuProfile].filter(Boolean).map((path) => resolve(path));
			const outputStat = existsSync(output) ? statSync(output) : undefined;
			for (const source of [...sources, `${opts.db}-wal`, `${opts.db}-shm`]) {
				const sourceStat = outputStat && existsSync(source) ? statSync(source) : undefined;
				if (output === source || (sourceStat && outputStat.ino === sourceStat.ino && outputStat.dev === sourceStat.dev))
					throw new Error("报告输出不能覆盖诊断证据文件");
			}
		}
		const report = diagnose(opts);
		const json = `${JSON.stringify(report, null, 2)}\n`;
		if (opts.out) { mkdirSync(dirname(resolve(opts.out)), { recursive: true }); writeFileSync(resolve(opts.out), json); }
		if (opts.json) process.stdout.write(json);
		else { printReport(report); if (opts.out) console.log(`完整报告：${resolve(opts.out)}`); }
	}
} catch (error) {
	console.error(`诊断失败：${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
