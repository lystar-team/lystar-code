import assert from "node:assert/strict";
import test from "node:test";
import { evaluate } from "./compare-rust-tui-spike.mjs";

const sizes = [[80, 24], [120, 36], [200, 60]];
const scenarios = [
	["static-idle", 0], ["input300", 300], ["paste5000", 20], ["stream20", 20], ["stream60", 60], ["stream120", 120], ["scroll300", 300], ["resize", 60],
];

function rows(implementation) {
	return sizes.flatMap(([columns, rows]) => scenarios.flatMap(([scenario, events]) => Array.from({ length: 5 }, (_, index) => ({
		implementation, scenario, columns, rows, round: index + 1, events, frames: events,
		workUnits: events, renderedItems: events * Math.max(1, rows - 1),
		toolRounds: 10_000, toolCallEvents: 10_000, toolResultEvents: 10_000,
		streamingUpdates: scenario.startsWith("stream") ? events : 0,
		cachedToolRounds: implementation === "rust" ? 400 : 10_000,
		bytesP50: events ? implementation === "rust" ? 50 : 100 : 0,
		bytesP95: events ? implementation === "rust" ? 50 : 100 : 0,
		bytesP99: events ? implementation === "rust" ? 50 : 100 : 0,
		bytesMax: events ? implementation === "rust" ? 60 : 120 : 0,
		bytesTotal: events ? (implementation === "rust" ? 50 : 100) * events : 0,
		frameP50Ms: events ? implementation === "rust" ? 4 : 10 : 0,
		frameP95Ms: events ? implementation === "rust" ? 5 : 10 : 0,
		frameP99Ms: events ? implementation === "rust" ? 10 : 15 : 0,
		frameMaxMs: events ? implementation === "rust" ? 12 : 16 : 0,
		frameTotalMs: events ? (implementation === "rust" ? 4 : 10) * events : 0,
		rssBytes: 20 * 1024 * 1024,
		workloadHash: "a".repeat(64),
	}))));
}

function rss(samples = 100) {
	const steady = Array.from({ length: samples }, (_, index) => ({ atMs: index * 10, bytes: 20 * 1024 * 1024 }));
	return {
		ts: { samples: steady, p50Bytes: 30 * 1024 * 1024, p95Bytes: 30 * 1024 * 1024, maxBytes: 31 * 1024 * 1024 },
		rust: { samples: steady, p50Bytes: 20 * 1024 * 1024, p95Bytes: 20 * 1024 * 1024, maxBytes: 21 * 1024 * 1024 },
		combined: { samples: steady, p50Bytes: 32 * 1024 * 1024, p95Bytes: 32 * 1024 * 1024, maxBytes: 33 * 1024 * 1024 },
	};
}

function gate() {
	return {
		toolPageCacheLimit: 400,
		checks: {
			protocolGeneration: true,
			terminalRestore: true,
			headlessBridge: true,
			smallTerminalCompatibility: true,
		},
	};
}

test("workUnits mismatch fails comparison", () => {
	const ts = rows("ts");
	const rust = rows("rust");
	rust[0].workUnits++;
	assert.throws(() => evaluate({ ts, rust, rss: rss(), gate: gate() }), /workload workUnits differs/);
});

test("workloadHash mismatch fails comparison when metadata still matches", () => {
	const ts = rows("ts");
	const rust = rows("rust");
	rust[0].workloadHash = "b".repeat(64);
	assert.throws(() => evaluate({ ts, rust, rss: rss(), gate: gate() }), /workloadHash differs/);
});

test("absolute budget regression makes development stop", () => {
	const ts = rows("ts");
	const rust = rows("rust");
	for (const row of rust.filter((row) => row.columns === 200 && row.rows === 60 && row.scenario !== "static-idle")) row.frameP95Ms = 9;
	const result = evaluate({ ts, rust, rss: rss(), gate: gate() });
	assert.equal(result.developmentDecision, "stop");
	assert.equal(result.releaseDecision, "stop");
});

test("relative release regression does not stop development", () => {
	const ts = rows("ts");
	const rust = rows("rust");
	for (const row of rust.filter((row) => row.scenario === "scroll300")) {
		row.bytesP95 = 100;
		row.frameP95Ms = 8;
	}
	const result = evaluate({ ts, rust, rss: rss(), gate: gate() });
	assert.equal(result.developmentDecision, "go");
	assert.equal(result.releaseDecision, "stop");
});

test("80x8 performance records are rejected", () => {
	const ts = rows("ts");
	const rust = rows("rust");
	for (const implementationRows of [ts, rust]) for (const row of implementationRows.filter((row) => row.columns === 80 && row.rows === 24)) row.rows = 8;
	assert.throws(() => evaluate({ ts, rust, rss: rss(), gate: gate() }), /performance records must contain only/);
});

test("RSS without steady samples fails comparison", () => {
	assert.throws(() => evaluate({ ts: rows("ts"), rust: rows("rust"), rss: rss(99), gate: gate() }), /steady samples/);
});

test("non-idle bytes fields cannot be placeholders", () => {
	const ts = rows("ts");
	ts.find((row) => row.scenario === "scroll300").bytesP95 = 0;
	assert.throws(() => evaluate({ ts, rust: rows("rust"), rss: rss(), gate: gate() }), /bytesP95 is a placeholder/);
});
