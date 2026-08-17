import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { rustWorkspaceWorkbenchManifest } from "./rust-workspace-benchmark-manifest.mjs";

const SIZES = new Set(rustWorkspaceWorkbenchManifest.sizes.map(([columns, rows]) => `${columns}x${rows}`));
const SCENARIOS = new Set(rustWorkspaceWorkbenchManifest.scenarios.map(({ name }) => name));
const SCENARIO_MODES = new Map(
	rustWorkspaceWorkbenchManifest.scenarios.map(({ name, mode = "fullscreen" }) => [name, mode]),
);
const REGULAR_IDLE = rustWorkspaceWorkbenchManifest.regularIdle;
const ROUNDS = new Set(Array.from({ length: rustWorkspaceWorkbenchManifest.rounds }, (_, index) => index + 1));
const CACHE_LIMITS = rustWorkspaceWorkbenchManifest.cacheLimits;
const RECORD_COUNT = SCENARIOS.size * SIZES.size * ROUNDS.size;
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

export function verifyRustWorkspaceWorkbench(records) {
	assert.equal(
		records.length,
		RECORD_COUNT,
		`Workspace workbench benchmark must emit exactly ${SCENARIOS.size} scenarios x ${SIZES.size} sizes x ${ROUNDS.size} rounds`,
	);
	const seen = new Set();
	for (const row of records) {
		const key = `${row.scenario}/${row.columns}x${row.rows}/${row.round}`;
		assert(!seen.has(key), `duplicate Workspace workbench record ${key}`);
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
	assert.equal(row.implementation, rustWorkspaceWorkbenchManifest.implementation, `${key} has the wrong implementation`);
	assert(SCENARIOS.has(row.scenario), `${key} has an unsupported scenario`);
	assert(SIZES.has(`${row.columns}x${row.rows}`), `${key} has an unsupported size`);
	assert(ROUNDS.has(row.round), `${key} has an invalid round`);
	assert.equal(row.metric, "event_to_frame_ms", `${key} has the wrong frame metric`);
	const terminalMode = SCENARIO_MODES.get(row.scenario);
	assert.equal(row.terminalMode, terminalMode, `${key} has the wrong terminal mode`);
	if (terminalMode === "regular") {
		assert.equal(row.idleDurationMs, REGULAR_IDLE.durationSeconds * 1_000, `${key} did not cover the regular idle window`);
		assert.equal(row.invalidIdleFrames, REGULAR_IDLE.maxInvalidFrames, `${key} rendered during regular idle`);
	} else {
		assert.equal(row.idleDurationMs, 0, `${key} unexpectedly recorded regular idle time`);
		assert.equal(row.invalidIdleFrames, 0, `${key} has invalid idle frames`);
	}
	assert.equal(row.activeToolRounds, rustWorkspaceWorkbenchManifest.toolRounds, `${key} did not build ${rustWorkspaceWorkbenchManifest.toolRounds.toLocaleString()} active Tool rounds`);
	assert.equal(row.readonlyToolRounds, rustWorkspaceWorkbenchManifest.toolRounds, `${key} did not build ${rustWorkspaceWorkbenchManifest.toolRounds.toLocaleString()} readonly Tool rounds`);
	for (const prefix of ["active", "readonly"]) {
		assert(Number.isInteger(row[`${prefix}CachedRounds`]) && row[`${prefix}CachedRounds`] > 0 && row[`${prefix}CachedRounds`] <= CACHE_LIMITS.rounds, `${key} ${prefix} cached rounds is invalid`);
		assert(Number.isInteger(row[`${prefix}CachedItems`]) && row[`${prefix}CachedItems`] > 0 && row[`${prefix}CachedItems`] <= CACHE_LIMITS.items, `${key} ${prefix} cached items is invalid`);
		assert(Number.isInteger(row[`${prefix}CachedUtf8Bytes`]) && row[`${prefix}CachedUtf8Bytes`] > 0 && row[`${prefix}CachedUtf8Bytes`] <= CACHE_LIMITS.bytes, `${key} ${prefix} cached bytes is invalid`);
	}
	assert.equal(row.transcriptRegroupBefore, row.transcriptRegroupAfter, `${key} regrouped the active transcript`);
	assert(typeof row.transcriptRegroupBefore === "string" && row.transcriptRegroupBefore.length > 0, `${key} has no regroup evidence`);
	assertNoAttachmentBase64(row, key);
	for (const field of [...TIMING_FIELDS, ...BYTE_FIELDS, ...RSS_FIELDS]) {
		assert(Number.isFinite(row[field]) && row[field] > 0, `${key} ${field} is null, zero, or invalid`);
	}
	assert(row.eventToFrameP50Ms <= row.eventToFrameP95Ms && row.eventToFrameP95Ms <= row.eventToFrameP99Ms, `${key} event percentiles are unordered`);
	assert(row.frameP50Ms <= row.frameP95Ms && row.frameP95Ms <= row.frameP99Ms, `${key} frame percentiles are unordered`);
	assert(row.bytesP50 <= row.bytesP95 && row.bytesP95 <= row.bytesP99, `${key} byte percentiles are unordered`);
	assert(row.eventToFrameP95Ms <= 50, `${key} event-to-frame p95 exceeds 50ms`);
	assert(row.eventToFrameP99Ms <= 75, `${key} event-to-frame p99 exceeds 75ms`);
	assert(row.rssP95Bytes <= 180 * 1024 * 1024, `${key} RSS p95 exceeds 180MiB`);
}

function assertNoAttachmentBase64(value, key, path = "record") {
	if (Array.isArray(value)) {
		for (const [index, child] of value.entries()) assertNoAttachmentBase64(child, key, `${path}[${index}]`);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [field, child] of Object.entries(value)) {
		const fieldPath = `${path}.${field}`;
		assert(!field.toLowerCase().includes("base64"), `${key} leaks attachment base64 at ${fieldPath}`);
		assertNoAttachmentBase64(child, key, fieldPath);
	}
}

function summarize(records, scenario, size) {
	const rows = records.filter((row) => row.scenario === scenario && `${row.columns}x${row.rows}` === size);
	return {
		scenario,
		size,
		eventToFrameP50Ms: percentile(rows.map((row) => row.eventToFrameP50Ms), 0.5),
		eventToFrameP95Ms: percentile(rows.map((row) => row.eventToFrameP95Ms), 0.95),
		eventToFrameP99Ms: percentile(rows.map((row) => row.eventToFrameP99Ms), 0.99),
		eventToFrameMaxMs: Math.max(...rows.map((row) => row.eventToFrameMaxMs)),
		bytesP95: percentile(rows.map((row) => row.bytesP95), 0.95),
		rssP95Bytes: percentile(rows.map((row) => row.rssP95Bytes), 0.95),
		activeCachedRounds: percentile(rows.map((row) => row.activeCachedRounds), 0.95),
		readonlyCachedRounds: percentile(rows.map((row) => row.readonlyCachedRounds), 0.95),
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
	let artifact = ".artifacts/rust-tui-workspace-benchmark";
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] !== "--artifact") throw new Error(`Unknown argument: ${argv[index]}`);
		artifact = argv[++index];
	}
	const result = verifyRustWorkspaceWorkbench(readJsonLines(resolve(artifact, "benchmark.jsonl")));
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
