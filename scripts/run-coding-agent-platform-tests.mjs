import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
	console.error("Coding Agent platform tests require Windows.");
	process.exit(1);
}

const vitestCli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const result = spawnSync(process.execPath, [vitestCli, "--run", ...process.argv.slice(2)], {
	cwd: process.cwd(),
	env: { ...process.env, PI_TEST_SUITE: "platform" },
	stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);