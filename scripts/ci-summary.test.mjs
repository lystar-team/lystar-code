import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { summarize } from "./ci-summary.mjs";

function report(passed, skipped, name = "test/example.test.ts") {
	return JSON.stringify({
		numPassedTests: passed,
		numPendingTests: skipped,
		numTodoTests: 0,
		testResults: [{ name, assertionResults: [{ duration: 42 }]}],
	});
}

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
		assert.match(output, /planner_would_run\{gate=core\}: true \(public workspace\)/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("required deterministic summaries reject skipped tests and selected failed jobs", () => {
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
				plan: { wouldRun: { core: true }, reasons: {} },
				jobs: [{ name: "core", result: "skipped", gates: ["core"] }],
			}),
			/required job core is skipped/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
