import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDocument } from "yaml";

const workflow = readFileSync(new URL("../.github/workflows/extended-quality.yml", import.meta.url), "utf8");
const pinnedAction = /^[\w/-]+@[0-9a-f]{40}$/;

test("extended quality workflow keeps live suites manual, the full suite manual, and stress suites scheduled", () => {
	const document = parseDocument(workflow);
	assert.deepEqual(document.errors, []);
	const parsed = document.toJS();
	assert.deepEqual(parsed.on.workflow_dispatch.inputs.suite.options, ["full", "ai-live", "coding-live", "stress"]);
	assert.equal(parsed.on.schedule.length, 1);
	assert.equal(parsed.permissions.contents, "read");
	assert.equal(parsed.concurrency["cancel-in-progress"], false);

	for (const action of workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) assert.match(action[1], pinnedAction);
	for (const name of ["ai-live", "coding-live"]) {
		const job = parsed.jobs[name];
		assert.match(job.if, /workflow_dispatch/);
		assert.equal(job.environment, "live-provider");
		assert.equal(job.env.PI_LIVE_TEST, "1");
		assert.match(JSON.stringify(job.steps), /No .* credential configured/);
		assert.match(JSON.stringify(job.steps), /test:live/);
	}
	assert.match(parsed.jobs.stress.if, /github\.event_name == 'schedule'/);
	assert.match(JSON.stringify(parsed.jobs.stress.steps), /test:stress/);
	assert.match(parsed.jobs.full.if, /workflow_dispatch/);
	assert.match(JSON.stringify(parsed.jobs.full.steps), /npm test/);
	assert.doesNotMatch(workflow, /ci-summary|ci-budget|json-output|date \+%s%N/);

	for (const name of ["full", "ai-live", "coding-live", "stress"]) {
		const job = parsed.jobs[name];
		const setupNode = job.steps.find((step) => step.name === "Setup Node.js");
		assert.ok(setupNode);
		assert.ok(job.steps.some((step) => typeof step.run === "string" && step.run.includes("npm ci")));
	}
});
