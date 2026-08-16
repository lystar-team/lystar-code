import assert from "node:assert/strict";
import test from "node:test";
import { verifyRustB3Workbench } from "./verify-rust-b3-workbench-benchmark.mjs";

function record(scenario, columns, rows, round) {
	return {
		implementation: "rust-b3-workbench",
		scenario,
		columns,
		rows,
		round,
		metric: "event_to_frame_ms",
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
		activeToolRounds: 10_000,
		readonlyToolRounds: 10_000,
		activeCachedRounds: 400,
		activeCachedItems: 800,
		activeCachedUtf8Bytes: 1024,
		readonlyCachedRounds: 400,
		readonlyCachedItems: 800,
		readonlyCachedUtf8Bytes: 1024,
		transcriptRegroupBefore: "400:active-tool-call-09600:active-tool-result-09999",
		transcriptRegroupAfter: "400:active-tool-call-09600:active-tool-result-09999",
	};
}

function validRecords() {
	return ["readonly_open", "older_scroll", "search", "tree_open", "tree_filter"].flatMap((scenario) =>
		[
			[80, 24],
			[120, 36],
			[200, 60],
		].flatMap(([columns, rows]) => [1, 2, 3, 4, 5].map((round) => record(scenario, columns, rows, round))),
	);
}

test("B3 workbench verifier accepts the complete five-round matrix", () => {
	const result = verifyRustB3Workbench(validRecords());
	assert.equal(result.records, 75);
	assert.equal(result.summaries.length, 15);
});

test("B3 workbench verifier rejects missing rounds, cache growth, regrouping, and budget failures", () => {
	for (const mutate of [
		(records) => records.slice(1),
		(records) => ({ ...records[0], readonlyCachedRounds: 401 }),
		(records) => ({ ...records[0], transcriptRegroupAfter: "changed" }),
		(records) => ({ ...records[0], eventToFrameP99Ms: 76 }),
		(records) => ({ ...records[0], rssP95Bytes: 180 * 1024 * 1024 + 1 }),
	]) {
		const records = validRecords();
		const changed = mutate(records);
		if (Array.isArray(changed)) assert.throws(() => verifyRustB3Workbench(changed));
		else {
			records[0] = changed;
			assert.throws(() => verifyRustB3Workbench(records));
		}
	}
});
