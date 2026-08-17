import assert from "node:assert/strict";
import test from "node:test";
import { rustCustomEditorBenchmarkConfig, scenarioExpectedText, textHash } from "./rust-custom-editor-manifest.mjs";
import { verifyRustCustomEditorBenchmark } from "./verify-rust-custom-editor-benchmark.mjs";

const config = rustCustomEditorBenchmarkConfig();

function record(scenario, size, round) {
	const [columns, rows] = size.split("x").map(Number);
	const samples = Array.from({ length: scenario.eventCount }, (_, index) => ({
		receivedAt: index * 10 + 1,
		publishedAt: index * 10 + 2,
		inputRevision: index + 1,
		frameRevision: index + 1,
		appliedAt: index * 10 + 3,
		hostBytes: 10,
		rustBytes: 10,
	}));
	const expectedText = scenarioExpectedText(scenario);
	return {
		implementation: config.implementation,
		hostRuntime: config.hostRuntime,
		scenario: scenario.name,
		size: `${columns}x${rows}`,
		round,
		eventCount: scenario.eventCount,
		p50Ms: 2,
		p95Ms: 2,
		p99Ms: 2,
		maxMs: 2,
		hostRenderCount: scenario.name === "render_animation" ? 3 : scenario.eventCount,
		hostPublishCount: scenario.name === "render_animation" ? 3 : scenario.eventCount,
		coalescedCount: scenario.name === "render_animation" ? 999 : 0,
		hostBytes: scenario.eventCount * 10,
		rustFrameCount: scenario.name === "render_animation" ? 3 : scenario.eventCount,
		rustBytes: scenario.eventCount * 10,
		hostPeakRssBytes: 1,
		rustPeakRssBytes: 2,
		combinedPeakRssBytes: 3,
		cpuMs: 3,
		hostCpuMs: 1,
		rustCpuMs: 2,
		transcriptRegroupBefore: "stable",
		transcriptRegroupAfter: "stable",
		finalTextLength: expectedText.length,
		finalTextHash: textHash(expectedText),
		duplicateInputCount: 0,
		staleCompletionCount: 0,
		...(scenario.name === "autocomplete" ? { hostInputCount: scenario.eventCount } : {}),
		...(scenario.name === "paste5000"
			? {
					pasteRequestBytes: Buffer.byteLength(`\u001b[200~${expectedText}\u001b[201~`, "utf8"),
					bracketedPasteBytes: Buffer.byteLength(`\u001b[200~${expectedText}\u001b[201~`, "utf8"),
				}
			: {}),
		...(scenario.name === "render_animation" ? { finalAnimation: scenario.animationFrames } : {}),
		samples,
	};
}

function records() {
	return config.scenarios.flatMap((scenario) =>
		config.sizes.flatMap(([columns, rows]) =>
			Array.from({ length: config.rounds }, (_, index) => record(scenario, `${columns}x${rows}`, index + 1)),
		),
	);
}

test("verifies the complete Rust CustomEditor benchmark matrix", () => {
	const result = verifyRustCustomEditorBenchmark(records());
	assert.equal(result.records, 60);
	assert.equal(result.summaries.length, 12);
});

test("rejects missing, duplicate, timing, RSS, regroup, hash, and nonfinite records", () => {
	for (const mutate of [
		(rows) => rows.slice(1),
		(rows) => [...rows, structuredClone(rows[0])],
		(rows) => ({ ...rows[0], hostRuntime: "node-22.21.1" }),
		(rows) => ({ ...rows[0], p95Ms: 17 }),
		(rows) => ({ ...rows[0], p99Ms: 34 }),
		(rows) => ({ ...rows[0], combinedPeakRssBytes: config.rssLimitBytes + 1 }),
		(rows) => ({ ...rows[0], transcriptRegroupAfter: "changed" }),
		(rows) => ({ ...rows[0], finalTextHash: "bad" }),
		(rows) => ({ ...rows[0], cpuMs: Number.NaN }),
	]) {
		const copy = records();
		const changed = mutate(copy);
		assert.throws(() => verifyRustCustomEditorBenchmark(Array.isArray(changed) ? changed : [changed, ...copy.slice(1)]));
	}
});
