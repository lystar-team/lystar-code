import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const testDir = join(packageDir, "test");
const integrationTests = new Set(["vertical-loop.test.ts", "resilience-loop.test.ts"]);
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--integration")) {
	throw new Error("Usage: node scripts/run-tests.mjs [--integration]");
}
const integration = args.includes("--integration");
const tests = readdirSync(testDir).filter(
	(name) => name.endsWith(".test.ts") && integrationTests.has(name) === integration,
);
const vitestTests = tests.filter((name) => /from ["']vitest["']/u.test(readFileSync(join(testDir, name), "utf8")));
const nodeTests = tests.filter((name) => !vitestTests.includes(name));

function run(args) {
	const result = spawnSync(process.execPath, args, { cwd: packageDir, stdio: "inherit" });
	if (result.error) throw result.error;
	return result.status === 0;
}

const nodePassed =
	nodeTests.length === 0 || run(["--import", "tsx", "--test", ...nodeTests.map((name) => join("test", name))]);
const vitestCli = join(dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))), "dist", "cli.js");
const vitestPassed =
	vitestTests.length === 0 || run([vitestCli, "--run", ...vitestTests.map((name) => join("test", name))]);
if (!nodePassed || !vitestPassed) process.exitCode = 1;
