import assert from "node:assert/strict";
import test from "node:test";
import { createPlan, parseNameStatus } from "./ci-plan.mjs";

const allGates = { source: true, core: true, coding: true, platform: true, gui: true, release: true };
const fixtures = [
	["docs only", ["README.md", "docs/ci.md"], {}],
	["feature plan only", ["features/plan.md"], {}],
	["AI public workspace", ["packages/ai/src/index.ts"], allGates],
	["Agent public workspace", ["packages/agent/src/index.ts"], allGates],
	["TUI public workspace", ["packages/tui/src/tui.ts"], allGates],
	["Protocol public workspace", ["packages/protocol/src/index.ts"], allGates],
	["lockfile", ["package-lock.json"], allGates],
	["shrinkwrap", ["packages/coding-agent/npm-shrinkwrap.json"], allGates],
	["CI workflow", [".github/workflows/ci.yml"], allGates],
	["release workflow", [".github/workflows/release.yml"], allGates],
	["unknown root path", ["LICENSE"], allGates],
	["unknown workspace", ["packages/new-package/src/index.ts"], allGates],
	["Coding Agent source", ["packages/coding-agent/src/core/session-manager.ts"], { source: true, coding: true, gui: true }],
	["Coding Agent Windows test", ["packages/coding-agent/test/bash-close-hang-windows.test.ts"], { source: true, coding: true, platform: true, gui: true }],
	["GUI application", ["packages/gui/src/App.tsx"], { source: true, gui: true }],
	["GUI protocol", ["packages/gui-protocol/src/schemas.ts"], { source: true, gui: true }],
	["GUI host", ["packages/gui-host/src/service.ts"], { source: true, gui: true }],
	["CI script", ["scripts/ci-summary.mjs"], { source: true }],
	["Unix installer", ["scripts/test-install-sh.sh"], allGates],
	["Windows installer", ["scripts/test-install-ps1.ps1"], allGates],
	["release metadata", ["scripts/generate-release-metadata.mjs"], allGates],
	["Windows terminal script", ["scripts/test-windows-terminal.ps1"], allGates],
	["deleted known file fails open", [{ path: "packages/gui/src/App.tsx", status: "D" }], allGates],
	["unparseable path fails open", [{ path: "../outside.ts", status: "M" }], allGates],
];

test("changed-file planner covers representative workspace paths", () => {
	assert.ok(fixtures.length >= 20);
	for (const [name, changes, expected] of fixtures) {
		const plan = createPlan(changes, "enforce");
		assert.deepEqual(plan.wouldRun, { ...Object.fromEntries(Object.keys(allGates).map((gate) => [gate, false])), ...expected }, name);
		assert.deepEqual(plan.execution, plan.wouldRun, `${name} enforce execution`);
	}
});

test("observe keeps every existing required job active", () => {
	const plan = createPlan(["packages/gui/src/App.tsx"], "observe");
	assert.deepEqual(plan.wouldRun, { source: true, core: false, coding: false, platform: false, gui: true, release: false });
	assert.deepEqual(plan.execution, allGates);
});

test("rename parser classifies both paths and malformed records fail", () => {
	assert.deepEqual(parseNameStatus("R100\0packages/coding-agent/src/old.ts\0packages/coding-agent/src/new.ts\0"), [
		{ path: "packages/coding-agent/src/old.ts", status: "R" },
		{ path: "packages/coding-agent/src/new.ts", status: "R" },
	]);
	assert.throws(() => parseNameStatus("R100\0packages/coding-agent/src/old.ts\0"), /Missing renamed path/);
});
