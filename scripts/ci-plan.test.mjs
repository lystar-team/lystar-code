import assert from "node:assert/strict";
import test from "node:test";
import { createPlan, parseNameStatus, TEST_PACKAGES } from "./ci-plan.mjs";

const allGates = { validate: true, core: true, coding: true, web: true, platform: true };
const emptyTests = { core: [], coding: [], web: [] };
const allTests = {
	core: [...TEST_PACKAGES.core],
	coding: [...TEST_PACKAGES.coding],
	web: [...TEST_PACKAGES.web],
};

const fixtures = [
	["docs only", ["README.md", "docs/ci.md"], {}, emptyTests],
	["feature plan only", ["features/plan.md"], {}, emptyTests],
	["AI workspace", ["packages/ai/src/index.ts"], { validate: true, core: true }, { ...emptyTests, core: ["@earendil-works/pi-ai"] }],
	["TUI workspace", ["packages/tui/src/tui.ts"], { validate: true, core: true }, { ...emptyTests, core: ["@earendil-works/pi-tui"] }],
	["Coding Agent source", ["packages/coding-agent/src/core/session-manager.ts"], { validate: true, coding: true }, { ...emptyTests, coding: ["@earendil-works/pi-coding-agent"] }],
	["Agent Windows test", ["packages/agent/test/harness/nodejs-env.windows.test.ts"], { validate: true, core: true, platform: true }, { ...emptyTests, core: ["@earendil-works/pi-agent-core"] }],
	["platform test runner", ["scripts/run-coding-agent-platform-tests.mjs"], { validate: true, platform: true }, emptyTests],
	["Web application", ["packages/web/src/App.tsx"], { validate: true, web: true }, { ...emptyTests, web: ["@lystar/code-web"] }],
	["Web gateway", ["packages/web-gateway/src/cli.ts"], { validate: true, web: true }, { ...emptyTests, web: ["@lystar/code-web-gateway"] }],
	["lockfile", ["package-lock.json"], allGates, allTests],
	["CI workflow", [".github/workflows/ci.yml"], { validate: true }, emptyTests],
	["CI planner", ["scripts/ci-plan.mjs"], { validate: true }, emptyTests],
	["release script", ["scripts/build-binaries.sh"], { validate: true, platform: true }, emptyTests],
	["evaluation workspace", ["packages/evals/src/example.eval.ts"], { validate: true }, emptyTests],
	["unknown workspace", ["packages/new-package/src/index.ts"], allGates, allTests],
	["deleted known file fails open", [{ path: "packages/web/src/App.tsx", status: "D" }], allGates, allTests],
	["unparseable path fails open", [{ path: "../outside.ts", status: "M" }], allGates, allTests],
];

test("changed-file planner selects only affected gates and workspaces", () => {
	for (const [name, changes, expectedGates, expectedTests] of fixtures) {
		const plan = createPlan(changes, "enforce");
		assert.deepEqual(plan.wouldRun, { ...Object.fromEntries(Object.keys(allGates).map((gate) => [gate, false])), ...expectedGates }, name);
		assert.deepEqual(plan.execution, plan.wouldRun, `${name} enforce execution`);
		assert.deepEqual(plan.tests, expectedTests, `${name} affected tests`);
	}
});

test("observe mode keeps every gate and full test package list active", () => {
	const plan = createPlan(["packages/web/src/App.tsx"], "observe");
	assert.deepEqual(plan.wouldRun, { validate: true, core: false, coding: false, web: true, platform: false });
	assert.deepEqual(plan.execution, allGates);
	assert.deepEqual(plan.tests, allTests);
});

test("rename parser classifies both paths and rejects malformed token streams", () => {
	assert.deepEqual(parseNameStatus("R100\0packages/coding-agent/src/old.ts\0packages/coding-agent/src/new.ts\0"), [
		{ path: "packages/coding-agent/src/old.ts", status: "R" },
		{ path: "packages/coding-agent/src/new.ts", status: "R" },
	]);
	assert.throws(() => parseNameStatus("R100\0packages/coding-agent/src/old.ts\0"), /Missing renamed path/);
	assert.throws(() => parseNameStatus("M\0README.md\0D"), /Missing path for git diff status: D/);
	assert.throws(() => parseNameStatus("X\0README.md\0"), /Unsupported git diff status/);
	assert.throws(() => parseNameStatus("M\0README.md\0\0"), /Unexpected empty token/);
});
