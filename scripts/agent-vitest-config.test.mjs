import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configUrl = new URL("../packages/agent/vitest.config.ts", import.meta.url).href;

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
