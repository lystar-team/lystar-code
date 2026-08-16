import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDocument } from "yaml";

const workflow = readFileSync(new URL("../.github/workflows/extended-quality.yml", import.meta.url), "utf8");
const pinnedAction = /^[\w/-]+@[0-9a-f]{40}$/;

test("extended quality workflow keeps live suites manual and non-live suites scheduled", () => {
	const document = parseDocument(workflow);
	assert.deepEqual(document.errors, []);
	const parsed = document.toJS();
	assert.deepEqual(parsed.on.workflow_dispatch.inputs.suite.options, [
		"ai-live",
		"coding-live",
		"stress",
		"rust-benchmark",
		"rust-component-benchmark",
		"non-live-all",
	]);
	assert.equal(parsed.on.schedule.length, 1);
	assert.equal(parsed.permissions.contents, "read");
	assert.equal(parsed.concurrency["cancel-in-progress"], false);

	for (const action of workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) assert.match(action[1], pinnedAction);
	for (const name of ["ai-live", "coding-live"]) {
		const job = parsed.jobs[name];
		assert.match(job.if, /workflow_dispatch/);
		assert.equal(job.environment, "live-provider");
		assert.equal(job.env.PI_LIVE_TEST, "1");
		assert.match(JSON.stringify(job.steps), /--assert-passed/);
		assert.match(JSON.stringify(job.steps), /credential=1/);
	}
	for (const name of ["stress", "rust-benchmark"]) assert.match(parsed.jobs[name].if, /github\.event_name == 'schedule'/);
	assert.match(JSON.stringify(parsed.jobs.stress.steps), /test:stress/);
	assert.doesNotMatch(workflow, /cache-hit \|\| 'false'/);

	for (const name of ["ai-live", "coding-live", "stress", "rust-benchmark"]) {
		const job = parsed.jobs[name];
		const setupNode = job.steps.find((step) => step.name === "Setup Node.js");
		const summary = job.steps.find((step) => step.name.includes("summary"));
		assert.equal(setupNode.id, "setup-node");
		assert.match(summary.run, /scripts\/ci-summary\.mjs/);
		assert.match(summary.run, /--require-positive-timings/);
		for (const timing of ["wall", "setup", "test", "cache"]) assert.match(summary.run, new RegExp(`--timing "${timing}=`));
		assert.match(summary.run, /--json-output/);
		assert.match(summary.run, /--cache-hit "npm=\$\{\{ steps\.setup-node\.outputs\.cache-hit \|\| 'unavailable' \}\}"/);
		assert.ok(job.steps.some((step) => typeof step.run === "string" && step.run.includes("date +%s%N")));
	}

	const rustJob = parsed.jobs["rust-benchmark"];
	const rustSteps = JSON.stringify(rustJob.steps);
	assert.match(rustSteps, /benchmark:rust-spike/);
	assert.match(rustSteps, /benchmark:rust-extension-component-storm/);
	assert.match(rustSteps, /verify-rust-spike-benchmark/);
	assert.match(rustSteps, /verify-rust-extension-component-storm/);
	assert.match(rustJob.if, /rust-component-benchmark/);
	assert.doesNotMatch(rustSteps, /\|\| true/);
	assert.equal(rustJob.steps.find((step) => step.name === "Restore Rust dependencies").id, "cargo-cache");
	assert.match(rustJob.steps.find((step) => step.name.includes("summary")).run, /--cache-hit "cargo=\$\{\{ steps\.cargo-cache\.outputs\.cache-hit \|\| 'unavailable' \}\}"/);
	assert.match(JSON.stringify(rustJob.steps.find((step) => step.name === "Upload Rust benchmark report").with.path), /rust-benchmark-metrics\.json/);
	assert.match(workflow, /RUST_VERSION: 1\.97\.1/);
});
