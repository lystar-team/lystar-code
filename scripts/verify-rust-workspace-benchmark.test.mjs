import assert from "node:assert/strict";
import test from "node:test";
import { rustWorkspaceWorkbenchManifest } from "./rust-workspace-benchmark-manifest.mjs";
import { verifyRustWorkspaceWorkbench } from "./verify-rust-workspace-benchmark-benchmark.mjs";

function record(scenario, columns, rows, round) {
	const mode = rustWorkspaceWorkbenchManifest.scenarios.find(({ name }) => name === scenario)?.mode ?? "fullscreen";
	return {
		implementation: rustWorkspaceWorkbenchManifest.implementation,
		scenario,
		terminalMode: mode,
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
		activeToolRounds: rustWorkspaceWorkbenchManifest.toolRounds,
		readonlyToolRounds: rustWorkspaceWorkbenchManifest.toolRounds,
		activeCachedRounds: rustWorkspaceWorkbenchManifest.cacheLimits.rounds,
		activeCachedItems: rustWorkspaceWorkbenchManifest.cacheLimits.items,
		activeCachedUtf8Bytes: 1024,
		readonlyCachedRounds: rustWorkspaceWorkbenchManifest.cacheLimits.rounds,
		readonlyCachedItems: rustWorkspaceWorkbenchManifest.cacheLimits.items,
		readonlyCachedUtf8Bytes: 1024,
		transcriptRegroupBefore: "400:active-tool-call-09600:active-tool-result-09999",
		transcriptRegroupAfter: "400:active-tool-call-09600:active-tool-result-09999",
		idleDurationMs: mode === "regular" ? rustWorkspaceWorkbenchManifest.regularIdle.durationSeconds * 1_000 : 0,
		invalidIdleFrames: 0,
	};
}

function validRecords() {
	return rustWorkspaceWorkbenchManifest.scenarios.flatMap(({ name: scenario }) =>
		rustWorkspaceWorkbenchManifest.sizes.flatMap(([columns, rows]) =>
			Array.from({ length: rustWorkspaceWorkbenchManifest.rounds }, (_, index) => record(scenario, columns, rows, index + 1)),
		),
	);
}

test("Workspace workbench verifier accepts the complete manifest matrix", () => {
	const result = verifyRustWorkspaceWorkbench(validRecords());
	assert.equal(
		result.records,
		rustWorkspaceWorkbenchManifest.scenarios.length * rustWorkspaceWorkbenchManifest.sizes.length * rustWorkspaceWorkbenchManifest.rounds,
	);
	assert.equal(result.summaries.length, rustWorkspaceWorkbenchManifest.scenarios.length * rustWorkspaceWorkbenchManifest.sizes.length);
});

test("Workspace workbench verifier rejects incomplete, duplicate, over-budget, regrouped, and leaked attachment records", () => {
	const scenario = rustWorkspaceWorkbenchManifest.scenarios[0].name;
	const [columns, rows] = rustWorkspaceWorkbenchManifest.sizes[0];
	for (const mutate of [
		(records) => records.filter((row) => row.scenario !== scenario),
		(records) => records.filter((row) => !(row.scenario === scenario && row.columns === columns && row.rows === rows && row.round === rustWorkspaceWorkbenchManifest.rounds)),
		(records) => {
			records[1] = { ...records[1], round: records[0].round };
			return records;
		},
		(records) => {
			records[0] = { ...records[0], readonlyCachedRounds: rustWorkspaceWorkbenchManifest.cacheLimits.rounds + 1 };
			return records;
		},
		(records) => {
			records[0] = { ...records[0], transcriptRegroupAfter: "changed" };
			return records;
		},
		(records) => {
			records[0] = { ...records[0], eventToFrameP99Ms: 76 };
			return records;
		},
		(records) => {
			records[0] = { ...records[0], rssP95Bytes: 180 * 1024 * 1024 + 1 };
			return records;
		},
		(records) => {
			const regular = records.find((row) => row.terminalMode === "regular");
			regular.invalidIdleFrames = 1;
			return records;
		},
		(records) => {
			records[0] = { ...records[0], attachment: { base64: "fixture-image-base64" } };
			return records;
		},
	]) {
		assert.throws(() => verifyRustWorkspaceWorkbench(mutate(validRecords())));
	}
});
