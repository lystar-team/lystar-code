import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SIZES = new Set(["80x24", "120x36", "200x60"]);
const SCENARIOS = new Set(["input300", "paste5000", "palette_open"]);
const ROUNDS = new Set([1, 2, 3, 4, 5]);
const LIMITS = { rounds: 400, items: 800, bytes: 4 * 1024 * 1024 };
const TIMING_FIELDS = [
	"eventToFrameP50Ms",
	"eventToFrameP95Ms",
	"eventToFrameP99Ms",
	"eventToFrameMaxMs",
	"frameP50Ms",
	"frameP95Ms",
	"frameP99Ms",
	"frameMaxMs",
];
const BYTE_FIELDS = ["bytesP50", "bytesP95", "bytesP99", "bytesMax", "bytesTotal"];
const RSS_FIELDS = ["rssP50Bytes", "rssP95Bytes", "rssP99Bytes", "rssMaxBytes"];

export function verifyRustM8(records) {
	assert.equal(records.length, 45, "M8 benchmark must emit exactly 3 scenarios x 3 sizes x 5 rounds");
	const seen = new Set();
	for (const row of records) {
		const key = `${row.scenario}/${row.columns}x${row.rows}/${row.round}`;
		assert(!seen.has(key), `duplicate M8 record ${key}`);
		seen.add(key);
		validateRow(row, key);
	}
	for (const scenario of SCENARIOS) {
		for (const size of SIZES) {
			const rows = records.filter((row) => row.scenario === scenario && `${row.columns}x${row.rows}` === size);
			assert.equal(rows.length, 5, `${scenario}/${size} is missing benchmark rounds`);
			assert.deepEqual(new Set(rows.map((row) => row.round)), ROUNDS, `${scenario}/${size} round set must be 1..5`);
		}
	}
	return {
		records: records.length,
		summaries: [...SCENARIOS]
			.flatMap((scenario) => [...SIZES].map((size) => summarize(records, scenario, size)))
			.sort((left, right) => left.scenario.localeCompare(right.scenario) || left.size.localeCompare(right.size)),
	};
}

function validateRow(row, key) {
	assert.equal(row.implementation, "rust-m8", `${key} has the wrong implementation`);
	assert(SCENARIOS.has(row.scenario), `${key} has an unsupported scenario`);
	assert(SIZES.has(`${row.columns}x${row.rows}`), `${key} has an unsupported size`);
	assert(ROUNDS.has(row.round), `${key} has an invalid round`);
	assert.equal(row.metric, row.scenario === "palette_open" ? "open_to_frame_ms" : "event_to_frame_ms", `${key} has the wrong frame metric`);
	assert.equal(row.toolRounds, 10_000, `${key} did not build 10,000 Tool rounds`);
	assert(Number.isInteger(row.cachedRounds) && row.cachedRounds > 0 && row.cachedRounds <= LIMITS.rounds, `${key} cachedRounds is invalid`);
	assert(Number.isInteger(row.cachedItems) && row.cachedItems > 0 && row.cachedItems <= LIMITS.items, `${key} cachedItems is invalid`);
	assert(Number.isInteger(row.cachedUtf8Bytes) && row.cachedUtf8Bytes > 0 && row.cachedUtf8Bytes <= LIMITS.bytes, `${key} cachedUtf8Bytes is invalid`);
	assert.equal(row.transcriptRegroupBefore, row.transcriptRegroupAfter, `${key} regrouped the transcript during editor input`);
	assert(typeof row.transcriptRegroupBefore === "string" && row.transcriptRegroupBefore.length > 0, `${key} has no regroup evidence`);
	for (const field of [...TIMING_FIELDS, ...BYTE_FIELDS, ...RSS_FIELDS]) {
		assert(Number.isFinite(row[field]) && row[field] > 0, `${key} ${field} is null, zero, or invalid`);
	}
	assert(row.eventToFrameP50Ms <= row.eventToFrameP95Ms && row.eventToFrameP95Ms <= row.eventToFrameP99Ms, `${key} event percentiles are unordered`);
	assert(row.frameP50Ms <= row.frameP95Ms && row.frameP95Ms <= row.frameP99Ms, `${key} frame percentiles are unordered`);
	assert(row.bytesP50 <= row.bytesP95 && row.bytesP95 <= row.bytesP99, `${key} byte percentiles are unordered`);
	assert.equal(row.frames, row.events, `${key} must draw exactly one frame per event`);
	if (row.scenario === "input300") {
		assert.equal(row.events, 300, `${key} input300 must have 300 insert events`);
		assert.equal(row.characters, 300, `${key} input300 must insert 300 characters`);
	} else if (row.scenario === "paste5000") {
		assert.equal(row.events, 1, `${key} paste5000 must be one paste event`);
		assert.equal(row.characters, 5_000, `${key} paste5000 must insert 5,000 characters`);
	} else {
		assert.equal(row.events, 1, `${key} palette_open must have one open event`);
		assert.equal(row.characters, 0, `${key} palette_open must not alter editor text`);
		assert(row.eventToFrameP95Ms <= 16, `${key} palette open-to-frame p95 exceeds 16ms`);
		assert(row.rssP95Bytes <= 180 * 1024 * 1024, `${key} palette RSS p95 exceeds 180MiB`);
	}
	assert(row.eventToFrameP95Ms <= 16, `${key} input event-to-frame p95 exceeds 16ms`);
	assert(row.eventToFrameP99Ms <= 33, `${key} input event-to-frame p99 exceeds 33ms`);
	assert(row.frameP95Ms <= 8, `${key} frame p95 exceeds 8ms`);
	assert(row.frameP99Ms <= 16, `${key} frame p99 exceeds 16ms`);
}

function summarize(records, scenario, size) {
	const rows = records.filter((row) => row.scenario === scenario && `${row.columns}x${row.rows}` === size);
	return {
		scenario,
		size,
		eventToFrameP50Ms: percentile(rows.map((row) => row.eventToFrameP50Ms), 0.5),
		eventToFrameP95Ms: percentile(rows.map((row) => row.eventToFrameP95Ms), 0.95),
		eventToFrameP99Ms: percentile(rows.map((row) => row.eventToFrameP99Ms), 0.99),
		frameP95Ms: percentile(rows.map((row) => row.frameP95Ms), 0.95),
		frameP99Ms: percentile(rows.map((row) => row.frameP99Ms), 0.99),
		bytesP95: percentile(rows.map((row) => row.bytesP95), 0.95),
		rssP95Bytes: percentile(rows.map((row) => row.rssP95Bytes), 0.95),
	};
}

function percentile(values, quantile) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function readJsonLines(path) {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

export function runCli(argv = process.argv.slice(2)) {
	let artifact = ".artifacts/rust-tui-m8";
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] !== "--artifact") throw new Error(`Unknown argument: ${argv[index]}`);
		artifact = argv[++index];
	}
	const result = verifyRustM8(readJsonLines(resolve(artifact, "benchmark.jsonl")));
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
