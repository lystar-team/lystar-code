import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const artifact = resolve(root, ".artifacts/rust-tui-spike");
const ts = read(resolve(artifact, "benchmark-ts.jsonl"));
const rust = read(resolve(artifact, "benchmark-rust.jsonl"));
const key = (row) => `${row.scenario}/${row.columns}x${row.rows}/${row.round}`;
assert.equal(ts.length, rust.length, "two implementations emitted different record counts");
assert.deepEqual(new Set(ts.map(key)), new Set(rust.map(key)), "scenario/size/round sets differ");
for (const row of [...ts, ...rust]) {
	for (const field of ["frames", "bytes", "p50Ms", "p95Ms", "p99Ms", "maxMs", "rssBytes"]) assert.notEqual(row[field], null, `${key(row)} ${field} is null`);
	if (row.scenario !== "static-idle") {
		assert(row.frames > 0 && row.bytes > 0 && row.p50Ms > 0 && row.rssBytes > 0, `${key(row)} has hand-filled zero`);
	} else assert.equal(row.frames + row.bytes, 0, `${key(row)} idle rendered`);
}
for (const rows of [ts, rust]) {
	for (const scenario of new Set(rows.map((row) => row.scenario))) for (const size of new Set(rows.map((row) => `${row.columns}x${row.rows}`))) {
		assert.equal(rows.filter((row) => row.scenario === scenario && `${row.columns}x${row.rows}` === size).length, 5, `${scenario}/${size} lacks five rounds`);
	}
}
const rows = [];
const decisions = [];
for (const scenario of new Set(ts.map((row) => row.scenario))) {
	const sizes = [...new Set(ts.map((row) => `${row.columns}x${row.rows}`))];
	const summaries = sizes.map((size) => {
		const a = summary(ts.filter((row) => row.scenario === scenario && `${row.columns}x${row.rows}` === size));
		const b = summary(rust.filter((row) => row.scenario === scenario && `${row.columns}x${row.rows}` === size));
		return { size, ts: a, rust: b, change: scenario === "static-idle" ? null : (b.p50Ms / a.p50Ms - 1) * 100 };
	});
	const at80 = summaries.find((item) => item.size === "80x24");
	const worst = summaries.reduce((current, item) => current.change === null || (item.change !== null && item.change > current.change) ? item : current);
	if (scenario !== "static-idle") decisions.push({ scenario, pass: at80.rust.p50Ms <= 16.7 || at80.change <= -30 });
	rows.push(`| ${scenario} | ${timings(at80.ts)} / ${timings(at80.rust)} | ${at80.change === null ? "n/a" : `${format(at80.change)}%`} | ${worst.size}: ${worst.change === null ? "n/a" : `${format(worst.change)}%`} | ${format(at80.ts.bytes)} / ${format(at80.rust.bytes)} | ${miB(at80.rust.rssBytes)} |`);
}
const inputScrollStreamPasses = decisions.filter((item) => /^(input300|scroll300|stream)/.test(item.scenario) && item.pass).length;
const tsCpu = median(ts.filter((row) => row.scenario !== "static-idle").map((row) => row.p50Ms));
const rustCpu = median(rust.filter((row) => row.scenario !== "static-idle").map((row) => row.p50Ms));
const cpuDrop = (1 - rustCpu / tsCpu) * 100;
const rustRss = Math.max(...rust.map((row) => row.rssBytes));
const tsRss = Math.max(...ts.map((row) => row.rssBytes));
const combined = JSON.parse(readFileSync(resolve(artifact, "combined-rss.json"), "utf8")).combinedRssBytes;
const go = inputScrollStreamPasses >= 2 && cpuDrop >= 40 && rustRss <= 40 * 1024 * 1024 && combined <= tsRss * 1.1;
const report = `# Rust TUI B0 最终评估\n\n日期：2026-08-15\n\n## 口径\n\n- 同一 ${ts.length} 条 JSONL 集合：8 个场景、4 个尺寸、5 轮；TS 使用真实 LystarWorkspace/TuiAltScreen 与内存 terminal，Rust 使用 Ratatui CrosstermBackend 内存 writer。\n- idle 测量窗口不调用 render，frames/bytes 均为 0；其他场景实际 draw、记录 terminal write bytes、批量 frame CPU 样本和 RSS。\n- 组合 RSS 为 orchestrator 同时运行 TS host 和 Rust child 时的进程 RSS 峰值，非两个独立峰值相加。帧绝对预算为 16.7ms。\n\n## 基准表\n\n| 场景 | 80x24 TS / Rust frame ms (p50/p95/p99/max) | 80x24 p50 相对变化 | 跨尺寸最差 p50 变化 | 80x24 bytes (TS / Rust) | Rust RSS MiB |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows.join("\n")}\n\n## 门槛\n\n- input/scroll/stream 满足绝对或 Rust 快至少 30%：${inputScrollStreamPasses}/5。\n- 全场景 p50 frame CPU 相对变化：${format(cpuDrop)}%（要求至少下降 40%）。\n- Rust UI RSS 峰值：${miB(rustRss)} MiB（要求不超过 40 MiB）。\n- 组合 RSS 峰值：${miB(combined)} MiB；TS 基线峰值：${miB(tsRss)} MiB，允许上限：${miB(tsRss * 1.1)} MiB。\n\n## Protocol\n\nDecodedMessage<T> 先保存 CBOR raw map，再由 raw 重编码进入 Typify 生成类型验证。presence API 可区分 missing/null/value；golden 覆盖 ui_response.value、error.details、operation.progress/result 的三态，Rust raw 回写帧由 TS decoder 完整深比较，未知字段与 variant 仍被拒绝。\n\n## B0 结论\n\n**${go ? "Go" : "Stop"}。** ${go ? "满足 B0 性能与协议门槛。" : "协议已无损，但性能门槛未满足，不能迁移默认 TUI 或进入 B1。"}\n`;
writeFileSync(resolve(root, "docs/rust-tui-spike-report.md"), report);
if (!go) process.exitCode = 2;

function read(path) { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
function median(values) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }
function summary(rows) {
	return {
		p50Ms: percentile(rows.map((row) => row.p50Ms), 0.5),
		p95Ms: percentile(rows.map((row) => row.p95Ms), 0.95),
		p99Ms: percentile(rows.map((row) => row.p99Ms), 0.99),
		maxMs: Math.max(...rows.map((row) => row.maxMs)),
		bytes: median(rows.map((row) => row.bytes)),
		rssBytes: Math.max(...rows.map((row) => row.rssBytes)),
	};
}
function percentile(values, q) { return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)]; }
function timings(value) { return [value.p50Ms, value.p95Ms, value.p99Ms, value.maxMs].map(format).join("/"); }
function format(value) { return Number(value).toFixed(3); }
function miB(value) { return (value / 1024 / 1024).toFixed(1); }
