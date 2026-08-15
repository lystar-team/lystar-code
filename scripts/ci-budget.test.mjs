import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aggregateMetrics, evaluateBudget, formatBudgetDiagnostic } from "./ci-budget.mjs";

function metric({ kind = "ci", budgetClass = "normal-ci", wall = 301, runner = 481 } = {}) {
	const prefix = kind === "release" ? "release" : "ci";
	return {
		schemaVersion: 1,
		kind,
		budgetClass,
		metrics: {
			[`${prefix}_wall_seconds`]: wall,
			[`${prefix}_runner_seconds_total`]: runner,
		},
	};
}

test("budget diagnosis waits for three comparable over-budget metrics", () => {
	const current = metric();
	assert.equal(evaluateBudget({ current }).triggered, false);
	assert.equal(evaluateBudget({ current, previous: [metric()] }).triggered, false);
	const result = evaluateBudget({ current, previous: [metric(), metric()] });
	assert.equal(result.triggered, true);
	assert.equal(result.overWall, true);
	assert.match(formatBudgetDiagnostic(result), /three-consecutive-over-budget/);
});

test("runner budget independently triggers after three comparable runs", () => {
	const result = evaluateBudget({
		current: metric({ wall: 299, runner: 481 }),
		previous: [metric({ wall: 299, runner: 481 }), metric({ wall: 299, runner: 481 })],
	});
	assert.equal(result.triggered, true);
	assert.equal(result.overWall, false);
	assert.equal(result.overRunner, true);
});

test("budget class and kind changes break the consecutive history", () => {
	const result = evaluateBudget({
		current: metric(),
		previous: [metric({ budgetClass: "docs-required", wall: 91, runner: 121 }), metric({ kind: "release", budgetClass: "cli-release", wall: 481, runner: 271 })],
	});
	assert.equal(result.triggered, false);
	assert.equal(result.comparableCount, 0);
	assert.match(result.diagnostics.join("\n"), /历史断链/);
});

test("missing and malformed history are fail-open and reported", () => {
	const directory = mkdtempSync(join(tmpdir(), "ci-budget-"));
	try {
		const malformed = join(directory, "malformed.json");
		writeFileSync(malformed, "{");
		const result = evaluateBudget({ current: metric(), previous: [join(directory, "missing.json"), malformed] });
		assert.equal(result.triggered, false);
		assert.equal(result.history.filter((entry) => entry.status === "unavailable").length, 2);
		assert.match(formatBudgetDiagnostic(result), /历史不可用：2 条/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("workflow aggregation preserves documented wall, runner, and timing metrics", () => {
	const result = aggregateMetrics({
		kind: "ci",
		budgetClass: "normal-ci",
		workflowStartedAt: new Date(Date.now() - 3_000).toISOString(),
		metrics: [
			{ schemaVersion: 1, kind: "ci-job", suite: "source", metrics: { ci_wall_seconds: 12, ci_setup_seconds_total: 3, ci_build_seconds_total: 4, ci_test_seconds_total: 5, ci_cache_restore_seconds: 1, test_passed_total: 2, test_skipped_total: 0 } },
			{ schemaVersion: 1, kind: "ci-job", suite: "core", metrics: { ci_wall_seconds: 20, ci_setup_seconds_total: 4, ci_build_seconds_total: 0, ci_test_seconds_total: 16, ci_cache_restore_seconds: 2, test_passed_total: 3, test_skipped_total: 0 } },
		],
	});
	assert.equal(result.metrics.ci_runner_seconds_total, 32);
	assert.equal(result.metrics.ci_setup_seconds_total, 7);
	assert.equal(result.suites.core.passed, 3);
	assert.ok(result.metrics.ci_wall_seconds >= 3);
});
