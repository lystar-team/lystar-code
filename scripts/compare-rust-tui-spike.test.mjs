import assert from "node:assert/strict";
import test from "node:test";
import { evaluate } from "./compare-rust-tui-spike.mjs";

const sizes = [[80, 8], [80, 24], [120, 36], [200, 60]];
const scenarios = [
	["static-idle", 0], ["input300", 300], ["paste5000", 20], ["stream20", 20], ["stream60", 60], ["stream120", 120], ["scroll300", 300], ["resize", 60],
];

function rows(implementation) {
	return sizes.flatMap(([columns, rows]) => scenarios.flatMap(([scenario, events]) => Array.from({ length: 5 }, (_, index) => ({
		implementation, scenario, columns, rows, round: index + 1, events, frames: events,
		workUnits: events, renderedItems: events * Math.max(1, rows - 1),
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

test("workUnits mismatch fails comparison", () => {
	const ts = rows("ts");
	const rust = rows("rust");
	rust[0].workUnits++;
	assert.throws(() => evaluate({ ts, rust, rss: rss() }), /workload workUnits differs/);
});

test("one size regression makes Go false", () => {
	const ts = rows("ts");
	const rust = rows("rust");
	for (const row of rust.filter((row) => row.columns === 200 && row.rows === 60 && row.scenario !== "static-idle")) row.frameP95Ms = 9;
	const result = evaluate({ ts, rust, rss: rss() });
	assert.equal(result.go, false);
	assert(result.failures.some((failure) => failure.includes("200x60")));
});

test("RSS without steady samples fails comparison", () => {
	assert.throws(() => evaluate({ ts: rows("ts"), rust: rows("rust"), rss: rss(99) }), /steady samples/);
});

test("non-idle bytes fields cannot be placeholders", () => {
	const ts = rows("ts");
	ts.find((row) => row.scenario === "scroll300").bytesP95 = 0;
	assert.throws(() => evaluate({ ts, rust: rows("rust"), rss: rss() }), /bytesP95 is a placeholder/);
});
