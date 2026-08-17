import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	rustCustomEditorBenchmarkConfig,
	scenarioExpectedText,
	textHash,
} from "./rust-custom-editor-manifest.mjs";

function percentile(values, quantile) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function timingSummary(samples) {
	const values = samples.map((sample) => sample.appliedAt - sample.receivedAt);
	return {
		p50Ms: percentile(values, 0.5),
		p95Ms: percentile(values, 0.95),
		p99Ms: percentile(values, 0.99),
		maxMs: Math.max(...values),
	};
}

function assertFiniteNonnegative(value, label) {
	assert(Number.isFinite(value) && value >= 0, `${label} must be finite and nonnegative`);
}

function assertNoRawPayload(value, key, path = "record") {
	if (Array.isArray(value)) {
		for (const [index, child] of value.entries()) assertNoRawPayload(child, key, `${path}[${index}]`);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [field, child] of Object.entries(value)) {
		assert(!/(raw|base64|secret)/i.test(field), `${key} leaks prohibited field ${path}.${field}`);
		assertNoRawPayload(child, key, `${path}.${field}`);
	}
}

export function verifyRustCustomEditorBenchmark(records, config = rustCustomEditorBenchmarkConfig()) {
	const sizes = new Set(config.sizes.map(([columns, rows]) => `${columns}x${rows}`));
	const scenarios = new Map(config.scenarios.map((scenario) => [scenario.name, scenario]));
	assert.equal(
		records.length,
		config.scenarios.length * config.sizes.length * config.rounds,
		"Rust CustomEditor artifact has an unexpected record count",
	);
	const seen = new Set();
	for (const record of records) {
		const key = `${record.scenario}/${record.size}/${record.round}`;
		assert(!seen.has(key), `duplicate Rust CustomEditor benchmark record ${key}`);
		seen.add(key);
		validateRecord(record, key, config, scenarios, sizes);
	}
	for (const scenario of config.scenarios) {
		for (const [columns, rows] of config.sizes) {
			for (let round = 1; round <= config.rounds; round++) {
				assert(seen.has(`${scenario.name}/${columns}x${rows}/${round}`), `missing Rust CustomEditor benchmark ${scenario.name}/${columns}x${rows}/${round}`);
			}
		}
	}
	return {
		records: records.length,
		summaries: config.scenarios.flatMap((scenario) =>
			config.sizes.map(([columns, rows]) => summarize(records, scenario.name, `${columns}x${rows}`)),
		),
	};
}

function validateRecord(record, key, config, scenarios, sizes) {
	assertNoRawPayload(record, key);
	assert.equal(record.implementation, config.implementation, `${key} has the wrong implementation`);
	assert.equal(record.hostRuntime, config.hostRuntime, `${key} did not use the required Bun Host runtime`);
	assert.match(record.hostRuntime, /^bun-1\.3\.9$/, `${key} has an unsupported Host runtime`);
	const scenario = scenarios.get(record.scenario);
	assert(scenario, `${key} has an unsupported scenario`);
	assert(sizes.has(record.size), `${key} has an unsupported terminal size`);
	assert(Number.isInteger(record.round) && record.round >= 1 && record.round <= config.rounds, `${key} has an invalid round`);
	assert.equal(record.eventCount, scenario.eventCount, `${key} has the wrong event count`);
	for (const field of [
		"p50Ms",
		"p95Ms",
		"p99Ms",
		"maxMs",
		"hostRenderCount",
		"hostPublishCount",
		"coalescedCount",
		"hostBytes",
		"rustFrameCount",
		"rustBytes",
		"hostPeakRssBytes",
		"rustPeakRssBytes",
		"combinedPeakRssBytes",
		"cpuMs",
		"hostCpuMs",
		"rustCpuMs",
		"finalTextLength",
		"duplicateInputCount",
		"staleCompletionCount",
	])
		assertFiniteNonnegative(record[field], `${key} ${field}`);
	assert.equal(record.combinedPeakRssBytes, record.hostPeakRssBytes + record.rustPeakRssBytes, `${key} combined RSS is inconsistent`);
	assert.equal(record.cpuMs, record.hostCpuMs + record.rustCpuMs, `${key} combined CPU is inconsistent`);
	assert(record.combinedPeakRssBytes <= config.rssLimitBytes, `${key} combined RSS exceeds 180MiB`);
	assert(record.rustFrameCount > 0 && record.rustBytes > 0 && record.hostBytes > 0, `${key} has empty frame metrics`);
	assert(record.hostRenderCount > 0 && record.hostPublishCount > 0, `${key} has no Host rendering`);
	assert.equal(record.transcriptRegroupBefore, record.transcriptRegroupAfter, `${key} regrouped the transcript`);
	assert(typeof record.transcriptRegroupBefore === "string" && record.transcriptRegroupBefore.length > 0, `${key} has no regroup evidence`);
	assert.equal(record.duplicateInputCount, 0, `${key} has duplicate component input`);
	assert.equal(record.staleCompletionCount, 0, `${key} applied a stale completion`);
	assert(Array.isArray(record.samples) && record.samples.length === scenario.eventCount, `${key} has the wrong sample count`);
	for (const [index, sample] of record.samples.entries()) {
		for (const field of ["receivedAt", "publishedAt", "inputRevision", "frameRevision", "appliedAt", "hostBytes", "rustBytes"])
			assertFiniteNonnegative(sample[field], `${key} samples[${index}].${field}`);
		assert(sample.inputRevision > 0 && sample.frameRevision > 0, `${key} has an invalid frame revision`);
		assert(sample.publishedAt >= sample.receivedAt, `${key} Host published before input/invalidate`);
		assert(sample.appliedAt >= sample.publishedAt, `${key} Rust applied before Host publish`);
		assert(sample.hostBytes > 0 && sample.rustBytes > 0, `${key} sample bytes are invalid`);
		if (scenario.name === "custom_editor_input300" || scenario.name === "paste5000")
			assert.equal(sample.inputRevision, sample.frameRevision, `${key} did not apply the input revision`);
	}
	if (scenario.name === "autocomplete") {
		assert.equal(record.hostInputCount, scenario.eventCount, `${key} Host input delta does not match completion roundtrips`);
	}
	const expectedSummary = timingSummary(record.samples);
	for (const field of ["p50Ms", "p95Ms", "p99Ms", "maxMs"])
		assert.equal(record[field], expectedSummary[field], `${key} ${field} does not match raw samples`);
	assert(record.p50Ms <= record.p95Ms && record.p95Ms <= record.p99Ms && record.p99Ms <= record.maxMs, `${key} percentiles are unordered`);
	assert(record.p95Ms <= scenario.thresholds.p95Ms, `${key} p95 exceeds ${scenario.thresholds.p95Ms}ms`);
	assert(record.p99Ms <= scenario.thresholds.p99Ms, `${key} p99 exceeds ${scenario.thresholds.p99Ms}ms`);

	const expectedText = scenarioExpectedText(scenario);
	assert.equal(record.finalTextLength, Buffer.byteLength(expectedText, "utf8"), `${key} final text length is incorrect`);
	assert.equal(record.finalTextHash, textHash(expectedText), `${key} final text hash is incorrect`);
	if (scenario.name === "paste5000") {
		assert.equal(record.samples.length, 1, `${key} paste did not stay as one component input`);
		const bracketedBytes = Buffer.byteLength(`\u001b[200~${expectedText}\u001b[201~`, "utf8");
		assert.equal(record.pasteRequestBytes, bracketedBytes, `${key} paste request bytes are incorrect`);
		assert.equal(record.bracketedPasteBytes, bracketedBytes, `${key} bracketed paste framing bytes are incorrect`);
	}
	if (scenario.name === "render_animation") {
		assert.equal(record.finalAnimation, scenario.animationFrames, `${key} final animation state is incorrect`);
		assert(record.coalescedCount > 0, `${key} animation did not coalesce frames`);
		const durationMs = Math.max(...record.samples.map((sample) => sample.appliedAt)) - Math.min(...record.samples.map((sample) => sample.receivedAt));
		const frameBudget = Math.ceil(durationMs / (1_000 / 60)) + 2;
		assert(record.hostRenderCount <= frameBudget, `${key} Host render count exceeds 60fps budget`);
		assert(record.hostPublishCount <= frameBudget, `${key} Host publish count exceeds 60fps budget`);
	}
}

function summarize(records, scenario, size) {
	const rows = records.filter((record) => record.scenario === scenario && record.size === size);
	return {
		scenario,
		size,
		p95Ms: percentile(rows.map((row) => row.p95Ms), 0.95),
		p99Ms: percentile(rows.map((row) => row.p99Ms), 0.95),
		maxMs: Math.max(...rows.map((row) => row.maxMs)),
		rssP95Bytes: percentile(rows.map((row) => row.combinedPeakRssBytes), 0.95),
		rssMaxBytes: Math.max(...rows.map((row) => row.combinedPeakRssBytes)),
		hostRenderCount: Math.max(...rows.map((row) => row.hostRenderCount)),
		hostPublishCount: Math.max(...rows.map((row) => row.hostPublishCount)),
		hostBytes: Math.max(...rows.map((row) => row.hostBytes)),
		rustFrameCount: Math.max(...rows.map((row) => row.rustFrameCount)),
		rustBytes: Math.max(...rows.map((row) => row.rustBytes)),
		cpuMs: Math.max(...rows.map((row) => row.cpuMs)),
	};
}

function parseSize(value) {
	const match = /^(\d+)x(\d+)$/.exec(value);
	if (!match) throw new Error(`Invalid Rust CustomEditor benchmark size: ${value}`);
	return [Number(match[1]), Number(match[2])];
}

function readJsonLines(path) {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

export function runCli(argv = process.argv.slice(2)) {
	let artifact = ".artifacts/rust-tui-custom-editor";
	let smoke = false;
	let scenarios;
	let sizes;
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--artifact") artifact = argv[++index];
		else if (argv[index] === "--smoke") smoke = true;
		else if (argv[index] === "--scenarios") scenarios = argv[++index].split(",").filter(Boolean);
		else if (argv[index] === "--sizes") sizes = argv[++index].split(",").filter(Boolean).map(parseSize);
		else throw new Error(`Unknown argument: ${argv[index]}`);
	}
	const result = verifyRustCustomEditorBenchmark(readJsonLines(resolve(artifact, "benchmark.jsonl")),
		rustCustomEditorBenchmarkConfig({ smoke, scenarios, sizes }),
	);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
