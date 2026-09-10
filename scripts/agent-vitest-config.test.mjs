import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configUrl = new URL("../packages/agent/vitest.config.ts", import.meta.url).href;
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const codingAgentPackage = JSON.parse(
	readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"),
);

function loadAgentTestConfig(suite) {
	const env = { ...process.env };
	if (suite === undefined) delete env.PI_TEST_SUITE;
	else env.PI_TEST_SUITE = suite;

	const output = execFileSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			`import config from ${JSON.stringify(configUrl)}; console.log(JSON.stringify({ include: config.test?.include, exclude: config.test?.exclude }));`,
		],
		{ cwd: projectRoot, encoding: "utf8", env },
	);
	return JSON.parse(output);
}

test("Agent Core Vitest config isolates the Windows platform suite", () => {
	assert.deepEqual(loadAgentTestConfig(), {
		include: ["test/**/*.test.ts"],
		exclude: ["test/**/*.windows.test.ts"],
	});
	assert.deepEqual(loadAgentTestConfig("platform"), {
		include: ["test/**/*.windows.test.ts"],
	});
});

test("Windows CI runs only the platform suites", () => {
	assert.equal(codingAgentPackage.scripts["test:platform"], "node ../../scripts/run-coding-agent-platform-tests.mjs");
	assert.doesNotMatch(workflow, /Build offline|Build Windows standalone|MinGit|test-windows-web|test-windows-terminal/);
	assert.match(workflow, /npm --workspace @earendil-works\/pi-coding-agent run test:platform/);
	assert.match(
		workflow,
		/\$env:PI_TEST_SUITE = "platform"\s*\r?\n\s*npm --workspace @earendil-works\/pi-agent-core test/,
	);
	assert.doesNotMatch(workflow, /--reporter=json|ci-windows-agent-platform/);
});

test("Coding Agent required CI suite is separate from the full deterministic suite", () => {
	assert.equal(codingAgentPackage.scripts["test:ci"], "PI_TEST_SUITE=ci vitest --run");
	assert.match(workflow, /npm --workspace @earendil-works\/pi-coding-agent run test:ci/);
	assert.doesNotMatch(workflow, /npm --workspace @earendil-works\/pi-coding-agent test/);
	assert.match(workflow, /npm run check:web/);
});
