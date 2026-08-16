import assert from "node:assert/strict";
import test from "node:test";
import { verifyRustM8 } from "./verify-rust-m8-benchmark.mjs";

function record(scenario, columns, rows, round) {
	return {
		implementation: "rust-m8",
		scenario,
		columns,
		rows,
		round,
		metric: scenario === "palette_open" ? "open_to_frame_ms" : "event_to_frame_ms",
		events: scenario === "input300" ? 300 : 1,
		characters: scenario === "input300" ? 300 : scenario === "paste5000" ? 5_000 : 0,
		frames: scenario === "input300" ? 300 : 1,
		eventToFrameP50Ms: 1,
		eventToFrameP95Ms: 2,
		eventToFrameP99Ms: 3,
		eventToFrameMaxMs: 4,
		frameP50Ms: 1,
		frameP95Ms: 2,
		frameP99Ms: 3,
		frameMaxMs: 4,
		bytesP50: 1,
		bytesP95: 2,
		bytesP99: 3,
		bytesMax: 4,
		bytesTotal: 5,
		rssP50Bytes: 1,
		rssP95Bytes: 2,
		rssP99Bytes: 3,
		rssMaxBytes: 4,
		toolRounds: 10_000,
		cachedRounds: 400,
		cachedItems: 800,
		cachedUtf8Bytes: 1024,
		transcriptRegroupBefore: "400:call:result",
		transcriptRegroupAfter: "400:call:result",
	};
}

function validRecords() {
	return ["input300", "paste5000", "palette_open"].flatMap((scenario) =>
		[
			[80, 24],
			[120, 36],
			[200, 60],
		].flatMap(([columns, rows]) => [1, 2, 3, 4, 5].map((round) => record(scenario, columns, rows, round))),
	);
}

test("M8 verifier accepts the complete five-round benchmark matrix", () => {
	const result = verifyRustM8(validRecords());
	assert.equal(result.records, 45);
	assert.equal(result.summaries.length, 9);
});

test("M8 verifier rejects missing rounds, paste batching errors, regrouping, and zero metrics", () => {
	for (const mutate of [
		(records) => records.slice(1),
		(records) => ({ ...records[0], scenario: "paste5000", events: 2 }),
		(records) => ({ ...records[0], transcriptRegroupAfter: "changed" }),
		(records) => ({ ...records[0], bytesP95: 0 }),
	]) {
		const records = validRecords();
		const changed = mutate(records);
		if (Array.isArray(changed)) assert.throws(() => verifyRustM8(changed));
		else {
			records[0] = changed;
			assert.throws(() => verifyRustM8(records));
		}
	}
});
