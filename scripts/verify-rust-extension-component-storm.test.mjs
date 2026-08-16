import assert from "node:assert/strict";
import test from "node:test";
import { verifyExtensionComponentStorm } from "./verify-rust-extension-component-storm.mjs";

function record(columns, rows, round) {
	const invalidations = Array.from({ length: 1_000 }, () => ({
		invalidateRequestedAt: 90,
		publishedAt: 100,
		revision: 2,
	}));
	return {
		schemaVersion: 1,
		scenario: "extension_component_storm",
		columns,
		rows,
		round,
		componentId: "header",
		generation: 1,
		finalState: 1_000,
		elapsedMs: 10,
		activeElapsedMs: 500,
		hostDiagnostics: {
			componentId: "header",
			generation: 1,
			revision: 2,
			renderCount: 2,
			publishCount: 2,
			coalescedCount: 999,
			lastFinalState: 1_000,
			invalidations,
		},
		rustFrames: [{ componentId: "header", revision: 2, appliedAt: 110 }],
		invalidateToPublish: { p50Ms: 10, p95Ms: 10, p99Ms: 10, maxMs: 10 },
		publishToApply: { p50Ms: 10, p95Ms: 10, p99Ms: 10, maxMs: 10 },
		endToEnd: { p50Ms: 20, p95Ms: 20, p99Ms: 20, maxMs: 20 },
		process: {
			pid: 42,
			processTreePids: [42],
			active: { sampleCount: 2, rssP95Bytes: 1, rssMaxBytes: 1, cpuMs: 1 },
			idle: { sampleCount: 2, rssP95Bytes: 1, rssMaxBytes: 1, cpuMs: 0, componentFrames: 0 },
		},
	};
}

function records() {
	return [80, 120, 200].flatMap((columns, index) =>
		Array.from({ length: 5 }, (_, round) => record(columns, [24, 36, 60][index], round + 1)),
	);
}

test("verifies the complete component storm artifact", () => {
	assert.equal(verifyExtensionComponentStorm(records()).records, 15);
});

test("rejects missing final state, budget regressions, and sensitive fields", () => {
	for (const mutate of [
		(rows) => {
			rows[0].finalState = 999;
		},
		(rows) => {
			rows[0].hostDiagnostics.publishCount = 4;
		},
		(rows) => {
			rows[0].publishToApply.p95Ms = 34;
		},
		(rows) => {
			rows[0].hostDiagnostics.invalidations[0].base64 = "forbidden";
		},
	]) {
		const copy = structuredClone(records());
		mutate(copy);
		assert.throws(() => verifyExtensionComponentStorm(copy));
	}
});
