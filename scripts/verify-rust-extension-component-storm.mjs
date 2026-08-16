import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_SIZES = ["80x24", "120x36", "200x60"];
const FRAME_INTERVAL_MS = 1_000 / 60;
const RSS_LIMIT_BYTES = 180 * 1024 * 1024;

export function verifyExtensionComponentStorm(records, { smoke = false } = {}) {
	const sizes = smoke ? ["80x24"] : FULL_SIZES;
	const rounds = smoke ? 1 : 5;
	assert.equal(records.length, sizes.length * rounds, "storm artifact has an unexpected record count");
	const seen = new Set();
	for (const record of records) {
		const key = `${record.columns}x${record.rows}/${record.round}`;
		assert(!seen.has(key), `duplicate storm benchmark record ${key}`);
		seen.add(key);
		validateRecord(record, key);
	}
	for (const size of sizes) {
		for (let round = 1; round <= rounds; round++) assert(seen.has(`${size}/${round}`), `missing storm benchmark ${size}/${round}`);
	}
	return { records: records.length, sizes, rounds, summaries: sizes.map((size) => summarize(records, size)) };
}

function validateRecord(record, key) {
	assertNoSensitiveField(record, key);
	assert.equal(record.schemaVersion, 1, `${key} has an unsupported schema version`);
	assert.equal(record.scenario, "extension_component_storm", `${key} has an unsupported scenario`);
	assert(FULL_SIZES.includes(`${record.columns}x${record.rows}`), `${key} has an unsupported terminal size`);
	assert(Number.isInteger(record.round) && record.round >= 1 && record.round <= 5, `${key} has an invalid round`);
	assert.equal(record.componentId, "header", `${key} did not use the storm component`);
	assert(Number.isInteger(record.generation) && record.generation > 0, `${key} has no component generation`);
	assert.equal(record.finalState, 1_000, `${key} final component state is not 1000`);
	assertPositive(record.elapsedMs, `${key} elapsedMs`);
	assertPositive(record.activeElapsedMs, `${key} activeElapsedMs`);

	const diagnostics = record.hostDiagnostics;
	assert(diagnostics && typeof diagnostics === "object", `${key} has no Host diagnostics`);
	assert.equal(diagnostics.componentId, record.componentId, `${key} diagnostics component mismatch`);
	assert.equal(diagnostics.generation, record.generation, `${key} diagnostics generation mismatch`);
	assert.equal(diagnostics.lastFinalState, 1_000, `${key} diagnostics lost final state`);
	assert(Number.isInteger(diagnostics.renderCount) && diagnostics.renderCount > 0, `${key} renderCount is invalid`);
	assert(Number.isInteger(diagnostics.publishCount) && diagnostics.publishCount > 0, `${key} publishCount is invalid`);
	assert(Number.isInteger(diagnostics.coalescedCount) && diagnostics.coalescedCount > 0, `${key} did not coalesce invalidations`);
	assert(Array.isArray(diagnostics.invalidations), `${key} invalidation ring is missing`);
	assert(diagnostics.invalidations.length <= 10_000, `${key} invalidation ring exceeded 10000`);
	assert.equal(diagnostics.invalidations.length, 1_000, `${key} did not record 1000 invalidations`);
	assert.equal(diagnostics.revision, diagnostics.invalidations.at(-1)?.revision, `${key} revision does not end at final publish`);
	const frameBudget = Math.ceil(record.elapsedMs / FRAME_INTERVAL_MS) + 2;
	assert(diagnostics.renderCount <= frameBudget, `${key} render count exceeds ${frameBudget}`);
	assert(diagnostics.publishCount <= frameBudget, `${key} publish count exceeds ${frameBudget}`);

	const frameTimes = new Map();
	assert(Array.isArray(record.rustFrames) && record.rustFrames.length > 0, `${key} has no Rust frame traces`);
	for (const frame of record.rustFrames) {
		assert.equal(frame.componentId, record.componentId, `${key} Rust trace component mismatch`);
		assert(Number.isInteger(frame.revision) && frame.revision > 0, `${key} Rust trace revision is invalid`);
		assertPositive(frame.appliedAt, `${key} Rust trace timestamp`);
		frameTimes.set(frame.revision, frame.appliedAt);
	}

	const hostLatencies = [];
	const rustLatencies = [];
	const endToEndLatencies = [];
	for (const invalidation of diagnostics.invalidations) {
		assertPositive(invalidation.invalidateRequestedAt, `${key} invalidateRequestedAt`);
		assertPositive(invalidation.publishedAt, `${key} publishedAt`);
		assert(Number.isInteger(invalidation.revision) && invalidation.revision > 0, `${key} invalidate revision is invalid`);
		const appliedAt = frameTimes.get(invalidation.revision);
		assert.notEqual(appliedAt, undefined, `${key} has no Rust apply trace for revision ${invalidation.revision}`);
		const host = invalidation.publishedAt - invalidation.invalidateRequestedAt;
		const rust = appliedAt - invalidation.publishedAt;
		const endToEnd = appliedAt - invalidation.invalidateRequestedAt;
		assert(host >= 0, `${key} Host publish predates invalidate`);
		assert(rust >= 0, `${key} Rust apply predates Host publish`);
		assert(endToEnd >= 0, `${key} end-to-end latency is invalid`);
		hostLatencies.push(host);
		rustLatencies.push(rust);
		endToEndLatencies.push(endToEnd);
	}
	assertTiming(record.invalidateToPublish, hostLatencies, `${key} invalidate->publish`, 33, 50);
	assertTiming(record.publishToApply, rustLatencies, `${key} publish->apply`, 16, 33);
	assertTiming(record.endToEnd, endToEndLatencies, `${key} end-to-end`, 50, 75);

	const process = record.process;
	assert(process && typeof process === "object", `${key} process metrics are missing`);
	assert(Number.isInteger(process.pid) && process.pid > 0, `${key} process pid is invalid`);
	assert(Array.isArray(process.processTreePids) && process.processTreePids.length > 0, `${key} process tree is empty`);
	for (const pid of process.processTreePids) assert(Number.isInteger(pid) && pid > 0, `${key} process tree pid is invalid`);
	for (const phase of [process.active, process.idle]) {
		assert(Number.isInteger(phase.sampleCount) && phase.sampleCount > 0, `${key} process sample count is invalid`);
		assertPositive(phase.rssP95Bytes, `${key} process RSS p95`);
		assertPositive(phase.rssMaxBytes, `${key} process RSS max`);
		assert(phase.rssP95Bytes <= RSS_LIMIT_BYTES, `${key} process RSS p95 exceeds 180MiB`);
		assert(phase.rssMaxBytes <= RSS_LIMIT_BYTES, `${key} process RSS max exceeds 180MiB`);
		assert(Number.isFinite(phase.cpuMs) && phase.cpuMs >= 0, `${key} process CPU is invalid`);
	}
	assert.equal(process.idle.componentFrames, 0, `${key} idle control rendered component frames`);
}

function assertTiming(summary, samples, label, p95Budget, p99Budget) {
	assert(summary && typeof summary === "object", `${label} summary is missing`);
	const expected = summarizeTiming(samples);
	for (const field of ["p50Ms", "p95Ms", "p99Ms", "maxMs"]) {
		assertPositive(summary[field], `${label} ${field}`);
		assert.equal(summary[field], expected[field], `${label} ${field} does not match raw samples`);
	}
	assert(summary.p50Ms <= summary.p95Ms && summary.p95Ms <= summary.p99Ms && summary.p99Ms <= summary.maxMs, `${label} percentiles are unordered`);
	assert(summary.p95Ms <= p95Budget, `${label} p95 exceeds ${p95Budget}ms`);
	assert(summary.p99Ms <= p99Budget, `${label} p99 exceeds ${p99Budget}ms`);
}

function summarizeTiming(values) {
	return {
		p50Ms: percentile(values, 0.5),
		p95Ms: percentile(values, 0.95),
		p99Ms: percentile(values, 0.99),
		maxMs: Math.max(...values),
	};
}

function summarize(records, size) {
	const rows = records.filter((record) => `${record.columns}x${record.rows}` === size);
	return {
		size,
		invalidateToPublishP95Ms: percentile(rows.map((row) => row.invalidateToPublish.p95Ms), 0.95),
		publishToApplyP95Ms: percentile(rows.map((row) => row.publishToApply.p95Ms), 0.95),
		endToEndP95Ms: percentile(rows.map((row) => row.endToEnd.p95Ms), 0.95),
		coalescedCount: percentile(rows.map((row) => row.hostDiagnostics.coalescedCount), 0.95),
		rssP95Bytes: percentile(rows.map((row) => row.process.active.rssP95Bytes), 0.95),
	};
}

function percentile(values, quantile) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function assertPositive(value, label) {
	assert(Number.isFinite(value) && value > 0, `${label} is null, zero, or invalid`);
}

function assertNoSensitiveField(value, key, path = "record") {
	if (Array.isArray(value)) {
		for (const [index, child] of value.entries()) assertNoSensitiveField(child, key, `${path}[${index}]`);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [field, child] of Object.entries(value)) {
		assert(!/(text|base64|secret)/i.test(field), `${key} leaks prohibited field ${path}.${field}`);
		assertNoSensitiveField(child, key, `${path}.${field}`);
	}
}

function readJsonLines(path) {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

export function runCli(argv = process.argv.slice(2)) {
	let artifact = ".artifacts/rust-tui-extension-component-storm";
	let smoke = false;
	let exitCode = 0;
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--artifact") artifact = argv[++index];
		else if (argv[index] === "--smoke") smoke = true;
		else if (argv[index] === "--exit-code") exitCode = Number(argv[++index]);
		else throw new Error(`Unknown argument: ${argv[index]}`);
	}
	assert.equal(exitCode, 0, `storm benchmark command exited ${exitCode}`);
	const result = verifyExtensionComponentStorm(readJsonLines(resolve(artifact, "benchmark.jsonl")), { smoke });
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
