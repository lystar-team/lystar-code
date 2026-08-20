import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { summarize, summarizeMetrics } from "./ci-summary.mjs";

function report(passed, skipped, name = "test/example.test.ts") {
	return JSON.stringify({
		numPassedTests: passed,
		numPendingTests: skipped,
		numTodoTests: 0,
		testResults: [{ name, assertionResults: [{ duration: 42 }]}],
	});
}

test("CI summaries also expose documented metrics as JSON", () => {
	const metrics = summarizeMetrics({
		suite: "source",
		timings: { wall: 12, setup: 3, build: 4, test: 5, cache: 1, cacheHits: { npm: "true" } },
		skippedByReason: { credential: 1 },
	});
	assert.equal(metrics.schemaVersion, 1);
	assert.equal(metrics.kind, "ci-job");
	assert.equal(metrics.metrics.ci_wall_seconds, 12);
	assert.equal(metrics.metrics.ci_runner_seconds_total, 12);
	assert.equal(metrics.metrics.ci_setup_seconds_total, 3);
	assert.equal(metrics.metrics.test_skipped_total, 1);
	assert.equal(metrics.skippedByReason.credential, 1);
});

test("CI summary reads planner JSON from an environment variable", () => {
	const output = execFileSync(
		process.execPath,
		["scripts/ci-summary.mjs", "--suite", "platform", "--no-test-report", "--plan-json-env", "CI_TEST_PLAN"],
		{
			encoding: "utf8",
			env: {
				...process.env,
				CI_TEST_PLAN: JSON.stringify({ mode: "observe", wouldRun: { platform: true }, reasons: { platform: [] } }),
			},
		},
	);
	assert.match(output, /planner_mode: observe/);
});

test("positive timing summaries reject placeholder machine metrics", () => {
	assert.throws(
		() => summarize({ suite: "extended", expectReports: false, requirePositiveTimings: true, timings: { wall: 1, setup: 0, test: 1 } }),
		/setup timing must be greater than zero/,
	);
	assert.doesNotThrow(() => summarize({
		suite: "extended",
		expectReports: false,
		requirePositiveTimings: true,
		timings: { wall: 0.001, setup: 0.001, test: 0.001 },
	}));
});

test("CI summary reports Vitest and Node TAP totals, slowest file, and planner reason", () => {
	const directory = mkdtempSync(join(tmpdir(), "ci-summary-"));
	const resultPath = join(directory, "result.json");
	const tapPath = join(directory, "result.tap");
	try {
		writeFileSync(resultPath, report(3, 0));
		writeFileSync(tapPath, "# tests 5\n# pass 5\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n");
		const output = summarize({
			suite: "core",
			resultPaths: [resultPath, tapPath],
			required: true,
			plan: { mode: "observe", wouldRun: { core: true }, reasons: { core: ["public workspace"] } },
		});
		assert.match(output, /test_passed_total\{suite=core\}: 8/);
		assert.match(output, /test_slowest_file_ms\{suite=core,file=test\/example.test.ts\}: 42/);
		assert.match(output, /ci_cache_restore_seconds: unavailable/);
		assert.match(output, /planner_would_run\{gate=core\}: true \(public workspace\)/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("required deterministic summaries reject skipped tests and failed execution gates", () => {
	const directory = mkdtempSync(join(tmpdir(), "ci-summary-"));
	const resultPath = join(directory, "result.json");
	try {
		writeFileSync(resultPath, report(3, 1));
		assert.throws(() => summarize({ suite: "core", resultPaths: [resultPath], required: true }), /skipped 1 tests/);
		writeFileSync(resultPath, report(3, 0));
		assert.throws(
			() => summarize({
				suite: "required",
				resultPaths: [resultPath],
				plan: { mode: "observe", execution: { source: true, core: true, coding: true, platform: true }, wouldRun: { source: true, core: false, coding: false, platform: false }, reasons: {} },
				jobs: [{ name: "coding", result: "failure", gates: ["coding"] }],
			}),
			/required job coding is failure/,
		);
		assert.doesNotThrow(() => summarize({
			suite: "required",
			resultPaths: [resultPath],
			plan: { mode: "enforce", execution: { source: true, core: false, coding: false, platform: false }, wouldRun: { source: true, core: false, coding: false, platform: false }, reasons: {} },
			jobs: [{ name: "coding", result: "skipped", gates: ["coding"] }],
		}));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("required suites reject missing, invalid, malformed, and empty test reports", () => {
	const directory = mkdtempSync(join(tmpdir(), "ci-summary-"));
	const missingPath = join(directory, "missing.json");
	const invalidPath = join(directory, "invalid.json");
	const tapPath = join(directory, "malformed.tap");
	const emptyPath = join(directory, "empty.json");
	try {
		assert.throws(() => summarize({ suite: "core", resultPaths: [missingPath], required: true }), /test report missing/);
		writeFileSync(invalidPath, "{");
		assert.throws(() => summarize({ suite: "core", resultPaths: [invalidPath], required: true }), /test report invalid JSON/);
		writeFileSync(tapPath, "# tests 1\n# pass 1\n");
		assert.throws(() => summarize({ suite: "core", resultPaths: [tapPath], required: true }), /test report invalid TAP summary/);
		writeFileSync(emptyPath, report(0, 0));
		assert.throws(() => summarize({ suite: "core", resultPaths: [emptyPath], required: true }), /reported zero passed tests/);
		assert.doesNotThrow(() => summarize({ suite: "source", required: true, expectReports: false }));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
