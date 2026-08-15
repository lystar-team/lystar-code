import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const NON_IDLE_KINDS = new Map([
	["input300", "input"], ["paste5000", "input"], ["stream20", "stream"], ["stream60", "stream"],
	["stream120", "stream"], ["scroll300", "scroll"], ["resize", "resize"],
]);
const REQUIRED_METRICS = [
	"events", "frames", "workUnits", "renderedItems", "bytesP50", "bytesP95", "bytesP99", "bytesMax", "bytesTotal",
	"frameP50Ms", "frameP95Ms", "frameP99Ms", "frameMaxMs", "frameTotalMs", "rssBytes",
];

export function evaluate({ ts, rust, rss }) {
	validateRows(ts, "ts");
	validateRows(rust, "rust");
	const key = (row) => `${row.scenario}/${row.columns}x${row.rows}/${row.round}`;
	assert.equal(ts.length, rust.length, "two implementations emitted different record counts");
	assert.deepEqual(new Set(ts.map(key)), new Set(rust.map(key)), "scenario/size/round sets differ");
	const rustByKey = new Map(rust.map((row) => [key(row), row]));
	for (const tsRow of ts) {
		const rustRow = rustByKey.get(key(tsRow));
		assert(rustRow, `missing Rust record ${key(tsRow)}`);
		for (const field of ["events", "frames", "workUnits", "renderedItems"]) {
			assert.equal(rustRow[field], tsRow[field], `${key(tsRow)} workload ${field} differs`);
		}
	}
	const scenarios = [...new Set(ts.map((row) => row.scenario))];
	const sizes = [...new Set(ts.map((row) => `${row.columns}x${row.rows}`))];
	for (const rows of [ts, rust]) {
		for (const scenario of scenarios) for (const size of sizes) {
			assert.equal(rows.filter((row) => row.scenario === scenario && `${row.columns}x${row.rows}` === size).length, 5, `${scenario}/${size} lacks five rounds`);
		}
	}
	validateRss(rss);
	const summaries = new Map();
	const failures = [];
	for (const scenario of scenarios) {
		for (const size of sizes) {
			const tsSummary = summarize(ts.filter((row) => row.scenario === scenario && `${row.columns}x${row.rows}` === size));
			const rustSummary = summarize(rust.filter((row) => row.scenario === scenario && `${row.columns}x${row.rows}` === size));
			const entry = { scenario, size, ts: tsSummary, rust: rustSummary, failures: [] };
			if (scenario !== "static-idle") {
				if (rustSummary.frameP95Ms > 8) entry.failures.push(`frame p95 ${format(rustSummary.frameP95Ms)}ms > 8ms`);
				if (rustSummary.frameP99Ms > 16) entry.failures.push(`frame p99 ${format(rustSummary.frameP99Ms)}ms > 16ms`);
				const kind = NON_IDLE_KINDS.get(scenario);
				if (kind === "input" && (rustSummary.frameP95Ms > 16 || rustSummary.frameP99Ms > 33)) entry.failures.push("input/paste budget failed");
				if (kind === "stream" && rustSummary.frameP95Ms > 33) entry.failures.push("stream visible-update budget failed");
				if (kind === "resize" && rustSummary.frameP95Ms > 50) entry.failures.push("resize budget failed");
			}
			if (entry.failures.length > 0) failures.push(`${scenario}/${size}: ${entry.failures.join(", ")}`);
			summaries.set(`${scenario}/${size}`, entry);
		}
	}
	const categoryPasses = [];
	for (const [category, categoryScenarios] of [["input", ["input300", "paste5000"]], ["scroll", ["scroll300"]], ["stream", ["stream20", "stream60", "stream120"]]]) {
		const categoryFailures = [];
		for (const scenario of categoryScenarios) for (const size of sizes) {
			const entry = summaries.get(`${scenario}/${size}`);
			const faster = entry.rust.frameP95Ms <= entry.ts.frameP95Ms * 0.7;
			const fewerBytes = entry.rust.bytesP95 <= entry.ts.bytesP95 * 0.7;
			if (entry.failures.length > 0 || (!faster && !fewerBytes)) categoryFailures.push(`${scenario}/${size}`);
		}
		categoryPasses.push({ category, pass: categoryFailures.length === 0, failures: categoryFailures });
		if (categoryFailures.length > 0) failures.push(`${category} relative gate: ${categoryFailures.join(", ")}`);
	}
	const cpu = sizes.map((size) => {
		const total = (rows) => rows.filter((row) => row.scenario !== "static-idle" && `${row.columns}x${row.rows}` === size)
			.reduce((sum, row) => sum + row.frameTotalMs, 0);
		const tsTotal = total(ts);
		const rustTotal = total(rust);
		const reduction = tsTotal === 0 ? Number.NEGATIVE_INFINITY : 1 - rustTotal / tsTotal;
		if (reduction < 0.4) failures.push(`CPU ${size}: ${format(reduction * 100)}% < 40%`);
		return { size, tsTotal, rustTotal, reduction };
	});
	const rustRss = rss.rust;
	const tsRss = rss.ts;
	const combinedRss = rss.combined;
	if (rustRss.p95Bytes > 40 * 1024 * 1024) failures.push(`Rust RSS p95 ${miB(rustRss.p95Bytes)} MiB > 40 MiB`);
	if (combinedRss.p95Bytes > tsRss.p95Bytes * 1.1) failures.push(`combined RSS p95 ${miB(combinedRss.p95Bytes)} MiB > TS baseline 110% (${miB(tsRss.p95Bytes * 1.1)} MiB)`);
	const passedCategories = categoryPasses.filter((entry) => entry.pass).length;
	if (passedCategories < 2) failures.push(`relative gate only ${passedCategories}/3 categories pass`);
	const go = failures.length === 0;
	return { go, failures, summaries: [...summaries.values()], categoryPasses, cpu, rss, report: report({ go, failures, summaries: [...summaries.values()], categoryPasses, cpu, rss }) };
}

function validateRows(rows, label) {
	assert(rows.length > 0, `${label} emitted no benchmark records`);
	for (const row of rows) {
		for (const field of REQUIRED_METRICS) assert(Number.isFinite(row[field]), `${label} ${row.scenario}/${row.columns}x${row.rows}/${row.round} ${field} is missing or non-numeric`);
		if (row.scenario === "static-idle") {
			assert.equal(row.events + row.frames + row.bytesTotal, 0, `${label} idle rendered or wrote bytes`);
			continue;
		}
		assert(row.events > 0 && row.frames === row.events, `${label} ${row.scenario} did not emit one frame per event`);
		assert(row.workUnits >= 0 && row.renderedItems > 0, `${label} ${row.scenario} has placeholder workload metrics`);
		for (const field of ["bytesP50", "bytesP95", "bytesP99", "bytesMax", "bytesTotal"]) assert(row[field] > 0, `${label} ${row.scenario} ${field} is a placeholder`);
	}
}

function validateRss(rss) {
	for (const name of ["ts", "rust", "combined"]) {
		const value = rss?.[name];
		assert(value && Array.isArray(value.samples) && value.samples.length >= 100, `${name} RSS lacks one-second steady samples`);
		for (const field of ["p50Bytes", "p95Bytes", "maxBytes"]) assert(Number.isFinite(value[field]) && value[field] > 0, `${name} RSS ${field} is missing`);
	}
}

function summarize(rows) {
	return {
		bytesP50: percentile(rows.map((row) => row.bytesP50), 0.5), bytesP95: percentile(rows.map((row) => row.bytesP95), 0.95),
		bytesP99: percentile(rows.map((row) => row.bytesP99), 0.99), bytesMax: Math.max(...rows.map((row) => row.bytesMax)),
		bytesTotal: rows.reduce((total, row) => total + row.bytesTotal, 0),
		frameP50Ms: percentile(rows.map((row) => row.frameP50Ms), 0.5), frameP95Ms: percentile(rows.map((row) => row.frameP95Ms), 0.95),
		frameP99Ms: percentile(rows.map((row) => row.frameP99Ms), 0.99), frameMaxMs: Math.max(...rows.map((row) => row.frameMaxMs)),
		frameTotalMs: rows.reduce((total, row) => total + row.frameTotalMs, 0),
	};
}

function report({ go, failures, summaries, categoryPasses, cpu, rss }) {
	const rows = summaries.map((entry) => `| ${entry.scenario} | ${entry.size} | ${timings(entry.ts)} | ${timings(entry.rust)} | ${format(entry.rust.bytesP95)} | ${format(entry.ts.bytesP95)} | ${entry.failures.length ? entry.failures.join("; ") : "通过"} |`);
	const categoryRows = categoryPasses.map((entry) => `| ${entry.category} | ${entry.pass ? "通过" : `未通过：${entry.failures.join(", ")}`} |`);
	const cpuRows = cpu.map((entry) => `| ${entry.size} | ${format(entry.tsTotal)} | ${format(entry.rustTotal)} | ${format(entry.reduction * 100)}% | ${entry.reduction >= 0.4 ? "通过" : "未通过"} |`);
	return `# Rust TUI B0 最终评估

日期：2026-08-15

## 可比口径

- 5 轮、4 个尺寸、8 个场景。TS 使用真实 \`LystarWorkspace\`、\`TuiAltScreen\` 和 10,000 项 transcript；Rust 使用相同场景 JSON、相同 10,000 项、相同视口加 2 倍视口预取窗口。
- 每个事件各自触发一次 backend render/write；JSONL 记录单帧 frame 与 bytes 的 p50/p95/p99/max/total，以及实际事件数、workUnits、renderedItems。idle 不调用 render，frame/bytes 均为 0。
- RSS 先 warmup，再保持至少 1 秒，以不超过 10ms 的间隔采样目标 PID 与其 child tree。TS、Rust、\`GuiHostService\`+完成 typed handshake 的 Rust child 分开报告；不计 orchestrator、npm 或 cargo。

## 全尺寸门槛

| 场景 | 尺寸 | TS frame ms p50/p95/p99/max | Rust frame ms p50/p95/p99/max | Rust bytes p95 | TS bytes p95 | 绝对预算 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
${rows.join("\n")}

## 相对与 CPU 门槛

| 类别 | 全尺寸相对门槛 |
| --- | --- |
${categoryRows.join("\n")}

| 尺寸 | TS 非 idle 总 frame CPU ms | Rust 非 idle 总 frame CPU ms | 降低 | 40% 门槛 |
| --- | ---: | ---: | ---: | --- |
${cpuRows.join("\n")}

## RSS

| 目标 | steady p50 MiB | steady p95 MiB | steady max MiB |
| --- | ---: | ---: | ---: |
| TS baseline | ${miB(rss.ts.p50Bytes)} | ${miB(rss.ts.p95Bytes)} | ${miB(rss.ts.maxBytes)} |
| Rust child | ${miB(rss.rust.p50Bytes)} | ${miB(rss.rust.p95Bytes)} | ${miB(rss.rust.maxBytes)} |
| GuiHostService + Rust child | ${miB(rss.combined.p50Bytes)} | ${miB(rss.combined.p95Bytes)} | ${miB(rss.combined.maxBytes)} |

## 未达项

${failures.length === 0 ? "无。" : failures.map((failure) => `- ${failure}`).join("\n")}

## Protocol

公开编码只接受 \`DecodedMessage<ClientMessage>\` 或 \`DecodedMessage<ServerMessage>\`；通用 \`encode_frame<T>\` 与 generated module 都不再从 crate 根导出。\`new_client_message\` / \`new_server_message\` 仍是构造原始 CBOR 后的验证入口，FrameDecoder 的低层测试保留在模块内部。

## B0 结论

**${go ? "Go" : "Stop"}。** ${go ? "所有尺寸的等价性、绝对预算、相对门槛、总 frame CPU 和 RSS 均满足。" : "存在未达项；不调整阈值、不删场景，也不进入 B1。"}
`;
}

function read(path) {
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}
function percentile(values, q) { return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)]; }
function timings(value) { return [value.frameP50Ms, value.frameP95Ms, value.frameP99Ms, value.frameMaxMs].map(format).join("/"); }
function format(value) { return Number(value).toFixed(3); }
function miB(value) { return (value / 1024 / 1024).toFixed(1); }

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const root = process.cwd();
	const artifact = resolve(process.env.RUST_TUI_SPIKE_ARTIFACT ?? resolve(root, ".artifacts/rust-tui-spike"));
	const result = evaluate({
		ts: read(resolve(artifact, "benchmark-ts.jsonl")),
		rust: read(resolve(artifact, "benchmark-rust.jsonl")),
		rss: JSON.parse(readFileSync(resolve(artifact, "rss.json"), "utf8")),
	});
	writeFileSync(resolve(root, "docs/rust-tui-spike-report.md"), result.report);
	if (!result.go) process.exitCode = 2;
}
