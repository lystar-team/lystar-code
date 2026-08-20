import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configUrl = new URL("../packages/agent/vitest.config.ts", import.meta.url).href;
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

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

test("Windows CI retains the Agent Core and Rust TUI IPC platform reports", () => {
	assert.match(
		workflow,
		/\$env:PI_TEST_SUITE = "platform"\s*\r?\n\s*npm --workspace @earendil-works\/pi-agent-core test -- --reporter=json --outputFile="\$env:RUNNER_TEMP\\ci-windows-agent-platform\.json"/,
	);
	assert.match(
		workflow,
		/npx vitest --run packages\/gui-host\/test\/ipc-process\.test\.ts -t "accepts the Rust TUI handshake through the production IPC Host" --reporter=json --outputFile="\$env:RUNNER_TEMP\\ci-windows-rust-tui-ipc\.json"/,
	);
	assert.match(workflow, /--result "\$env:RUNNER_TEMP\\ci-windows-rust-tui-ipc\.json"/);
	assert.doesNotMatch(workflow, /pi-agent-core test -- test\/harness\/nodejs-env\.windows\.test\.ts/);
});
