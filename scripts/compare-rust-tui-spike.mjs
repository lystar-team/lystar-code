import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PERFORMANCE_SIZES = new Set(["80x24", "120x36", "200x60"]);
const NON_IDLE_KINDS = new Map([
	["input300", "input"], ["paste5000", "input"], ["stream20", "stream"], ["stream60", "stream"],
	["stream120", "stream"], ["scroll300", "scroll"], ["resize", "resize"],
]);
const REQUIRED_METRICS = [
	"events", "frames", "workUnits", "renderedItems", "toolRounds", "toolCallEvents", "toolResultEvents", "streamingUpdates",
	"cachedToolRounds", "bytesP50", "bytesP95", "bytesP99", "bytesMax", "bytesTotal", "frameP50Ms", "frameP95Ms",
	"frameP99Ms", "frameMaxMs", "frameTotalMs", "rssBytes",
];
const WORKLOAD_HASH = /^[a-f0-9]{64}$/;

export function evaluate({ ts, rust, rss, gate }) {
	validateGate(gate);
	validateRows(ts, "ts");
	validateRows(rust, "rust");
	const key = (row) => `${row.scenario}/${row.columns}x${row.rows}/${row.round}`;
	assert.equal(ts.length, rust.length, "two implementations emitted different record counts");
	assert.deepEqual(new Set(ts.map(key)), new Set(rust.map(key)), "scenario/size/round sets differ");
	const rustByKey = new Map(rust.map((row) => [key(row), row]));
	for (const tsRow of ts) {
		const rustRow = rustByKey.get(key(tsRow));
		assert(rustRow, `missing Rust record ${key(tsRow)}`);
		for (const field of [
			"events", "frames", "workUnits", "renderedItems", "toolRounds", "toolCallEvents", "toolResultEvents", "streamingUpdates",
		]) {
			assert.equal(rustRow[field], tsRow[field], `${key(tsRow)} workload ${field} differs`);
		}
		assert.equal(rustRow.workloadHash, tsRow.workloadHash, `${key(tsRow)} workloadHash differs`);
	}
	const scenarios = [...new Set(ts.map((row) => row.scenario))];
	const sizes = [...new Set(ts.map((row) => `${row.columns}x${row.rows}`))];
	assert.deepEqual(new Set(sizes), PERFORMANCE_SIZES, "performance records must contain only 80x24, 120x36, and 200x60");
	for (const rows of [ts, rust]) {
		for (const scenario of scenarios) for (const size of sizes) {
			assert.equal(rows.filter((row) => row.scenario === scenario && `${row.columns}x${row.rows}` === size).length, 5, `${scenario}/${size} lacks five rounds`);
		}
	}
	for (const row of rust) assert(row.cachedToolRounds <= gate.toolPageCacheLimit, `Rust ${key(row)} exceeded page cache limit`);
	validateRss(rss);

	const summaries = new Map();
	const absoluteFailures = [];
	for (const scenario of scenarios) {
		for (const size of sizes) {
			const tsSummary = summarize(ts.filter((row) => row.scenario === scenario && `${row.columns}x${row.rows}` === size));
			const rustSummary = summarize(rust.filter((row) => row.scenario === scenario && `${row.columns}x${row.rows}` === size));
			const entry = { scenario, size, ts: tsSummary, rust: rustSummary, absoluteFailures: [] };
			if (scenario !== "static-idle") {
				if (rustSummary.frameP95Ms > 8) entry.absoluteFailures.push(`frame p95 ${format(rustSummary.frameP95Ms)}ms > 8ms`);
				if (rustSummary.frameP99Ms > 16) entry.absoluteFailures.push(`frame p99 ${format(rustSummary.frameP99Ms)}ms > 16ms`);
				const kind = NON_IDLE_KINDS.get(scenario);
				if (kind === "input" && (rustSummary.frameP95Ms > 16 || rustSummary.frameP99Ms > 33)) entry.absoluteFailures.push("input/paste budget failed");
				if (kind === "stream" && rustSummary.frameP95Ms > 33) entry.absoluteFailures.push("stream visible-update budget failed");
				if (kind === "resize" && rustSummary.frameP95Ms > 50) entry.absoluteFailures.push("resize budget failed");
			}
			if (entry.absoluteFailures.length > 0) absoluteFailures.push(`${scenario}/${size}: ${entry.absoluteFailures.join(", ")}`);
			summaries.set(`${scenario}/${size}`, entry);
		}
	}
	const rustRss = rss.rust;
	const tsRss = rss.ts;
	const combinedRss = rss.combined;
	if (rustRss.p95Bytes > 40 * 1024 * 1024) absoluteFailures.push(`Rust RSS p95 ${miB(rustRss.p95Bytes)} MiB > 40 MiB`);
	if (combinedRss.p95Bytes > tsRss.p95Bytes * 1.1) absoluteFailures.push(`combined RSS p95 ${miB(combinedRss.p95Bytes)} MiB > TS baseline 110% (${miB(tsRss.p95Bytes * 1.1)} MiB)`);

	const categoryPasses = [];
	const releaseFailures = [];
	for (const [category, categoryScenarios] of [["input", ["input300", "paste5000"]], ["scroll", ["scroll300"]], ["stream", ["stream20", "stream60", "stream120"]]]) {
		const categoryFailures = [];
		for (const scenario of categoryScenarios) for (const size of sizes) {
			const entry = summaries.get(`${scenario}/${size}`);
			const faster = entry.rust.frameP95Ms <= entry.ts.frameP95Ms * 0.7;
			const fewerBytes = entry.rust.bytesP95 <= entry.ts.bytesP95 * 0.7;
			if (!faster && !fewerBytes) categoryFailures.push(`${scenario}/${size}`);
		}
		categoryPasses.push({ category, pass: categoryFailures.length === 0, failures: categoryFailures });
		if (categoryFailures.length > 0) releaseFailures.push(`${category} relative frame/write gate: ${categoryFailures.join(", ")}`);
	}
	const cpu = sizes.map((size) => {
		const total = (rows) => rows.filter((row) => row.scenario !== "static-idle" && `${row.columns}x${row.rows}` === size)
			.reduce((sum, row) => sum + row.frameTotalMs, 0);
		const tsTotal = total(ts);
		const rustTotal = total(rust);
		const reduction = tsTotal === 0 ? Number.NEGATIVE_INFINITY : 1 - rustTotal / tsTotal;
		if (reduction < 0.4) releaseFailures.push(`CPU ${size}: ${format(reduction * 100)}% < 40%`);
		return { size, tsTotal, rustTotal, reduction };
	});

	const functionalFailures = Object.entries(gate.checks)
		.filter(([, passed]) => !passed)
		.map(([name]) => `${name} failed`);
	const developmentFailures = [...functionalFailures, ...absoluteFailures];
	const developmentDecision = developmentFailures.length === 0 ? "go" : "stop";
	const releaseDecision = developmentDecision === "go" && releaseFailures.length === 0 ? "go" : "stop";
	return {
		developmentDecision,
		releaseDecision,
		developmentFailures,
		releaseFailures,
		summaries: [...summaries.values()],
		categoryPasses,
		cpu,
		rss,
		gate,
		report: report({ developmentDecision, releaseDecision, developmentFailures, releaseFailures, summaries: [...summaries.values()], categoryPasses, cpu, rss, gate }),
	};
}

function validateGate(gate) {
	assert(gate && typeof gate === "object", "Rust B0 functional gate is missing");
	assert.equal(gate.toolPageCacheLimit, 400, "Rust B0 page cache limit must remain 400 tool rounds");
	for (const key of ["protocolGeneration", "terminalRestore", "headlessBridge", "smallTerminalCompatibility"]) {
		assert.equal(typeof gate.checks?.[key], "boolean", `Rust B0 gate ${key} is missing`);
	}
}

function validateRows(rows, label) {
	assert(rows.length > 0, `${label} emitted no benchmark records`);
	for (const row of rows) {
		for (const field of REQUIRED_METRICS) assert(Number.isFinite(row[field]), `${label} ${row.scenario}/${row.columns}x${row.rows}/${row.round} ${field} is missing or non-numeric`);
		assert.equal(row.toolRounds, 10_000, `${label} ${row.scenario}/${row.columns}x${row.rows}/${row.round} did not create 10,000 tool rounds`);
		assert.equal(row.toolCallEvents, 10_000, `${label} ${row.scenario}/${row.columns}x${row.rows}/${row.round} lacks tool calls`);
		assert.equal(row.toolResultEvents, 10_000, `${label} ${row.scenario}/${row.columns}x${row.rows}/${row.round} lacks tool results`);
		if (row.scenario.startsWith("stream")) assert(row.streamingUpdates > 0, `${label} ${row.scenario} lacks streaming tool-result updates`);
		assert(WORKLOAD_HASH.test(row.workloadHash), `${label} ${row.scenario}/${row.columns}x${row.rows}/${row.round} workloadHash is missing or invalid`);
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
		workloadHash: commonWorkloadHash(rows),
	};
}

function commonWorkloadHash(rows) {
	const hashes = new Set(rows.map((row) => row.workloadHash));
	assert.equal(hashes.size, 1, `${rows[0].scenario}/${rows[0].columns}x${rows[0].rows} workloadHash differs across rounds`);
	return rows[0].workloadHash;
}

function report({ developmentDecision, releaseDecision, developmentFailures, releaseFailures, summaries, categoryPasses, cpu, rss, gate }) {
	const rows = summaries.map((entry) => `| ${entry.scenario} | ${entry.size} | ${timings(entry.ts)} | ${timings(entry.rust)} | ${format(entry.rust.bytesP95)} | ${format(entry.ts.bytesP95)} | ${entry.ts.workloadHash} | ${entry.absoluteFailures.length ? entry.absoluteFailures.join("; ") : "通过"} |`);
	const categoryRows = categoryPasses.map((entry) => `| ${entry.category} | ${entry.pass ? "通过" : `未通过：${entry.failures.join(", ")}`} |`);
	const cpuRows = cpu.map((entry) => `| ${entry.size} | ${format(entry.tsTotal)} | ${format(entry.rustTotal)} | ${format(entry.reduction * 100)}% | ${entry.reduction >= 0.4 ? "通过" : "未通过"} |`);
	const functionalRows = Object.entries(gate.checks).map(([name, passed]) => `| ${name} | ${passed ? "通过" : "失败"} |`);
	return `# Rust TUI B0 评估

日期：2026-08-15

## 决策

- \`developmentDecision: ${developmentDecision}\`：协议生成、终端恢复、headless bridge、80x8 兼容性和绝对预算全部满足时，允许进入 B1。\`80x8\` 只作为兼容性检查，不参与性能比较。
- \`releaseDecision: ${releaseDecision}\`：相对 frame/write 与 CPU 门槛只约束 M10 默认切换；为 \`stop\` 不阻止 Rust 自有可见 TUI 继续迁移。

## 功能前提

| 检查 | 结果 |
| --- | --- |
${functionalRows.join("\n")}

## 可比口径

- 5 轮、3 个性能尺寸：\`80x24\`、\`120x36\`、\`200x60\`。\`80x8\` 另行验证布局、Composer 底部与退出恢复，不写入性能 records。
- 主 fixture 是同一 Session 的 10,000 个 Tool 调用轮次；每轮均含 \`toolCall\` 与 \`toolResult\`，并混入长输出、diff、错误、图片与 \`content_ref\` 摘要。流式场景更新已有 Tool Result。
- TS 使用真实 \`LystarWorkspace\`、\`TuiAltScreen\` 和全量 Tool 行；Rust 用 100 项页、最多 4 页缓存，仅投影可见窗口加 2 倍预取窗口。
- \`workloadHash\` 覆盖 Tool id/name/args、result/status/diff/error、最终 editor、尺寸和 viewport；同一场景、尺寸、轮次的 TS/Rust hash 必须完全一致。
- RSS 先 warmup，再保持至少 1 秒，以不超过 10ms 的间隔采样目标 PID 与其 child tree。TS、Rust、\`GuiHostService\`+完成 typed handshake 的 Rust child 分开报告；不计 orchestrator、npm 或 cargo。

## 绝对预算

| 场景 | 尺寸 | TS frame ms p50/p95/p99/max | Rust frame ms p50/p95/p99/max | Rust bytes p95 | TS bytes p95 | Workload SHA-256 | 结果 |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
${rows.join("\n")}

## M10 相对门槛

| 类别 | 全尺寸相对 frame/write 门槛 |
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

## Development 未达项

${developmentFailures.length === 0 ? "无。" : developmentFailures.map((failure) => `- ${failure}`).join("\n")}

## Release 未达项

${releaseFailures.length === 0 ? "无。" : releaseFailures.map((failure) => `- ${failure}`).join("\n")}

## 历史基线

2026-08-15 的旧 B0 Stop 数据保留为历史性能基线。Yean 于同日调整判定：相对 CPU/写量门槛不再停止 B1-B9 开发，只阻止 M10 默认切换。

## Protocol

公开 \`ClientMessage\` / \`ServerMessage\` 是 opaque wrapper，内部 generated Typify 类型与 decoded holder 均为 crate 私有。公开面只保留受控 decode/new/encode、presence、message kind、protocol version 和只读诊断投影；没有 \`Serialize\`、inner、generated 或 raw 可变引用入口。generated 类型的精确匹配只在 crate 内部 unit tests 中覆盖。
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
		gate: JSON.parse(readFileSync(resolve(artifact, "gate.json"), "utf8")),
	});
	writeFileSync(resolve(root, "docs/rust-tui-spike-report.md"), result.report);
	if (result.developmentDecision === "stop") process.exitCode = 2;
}
