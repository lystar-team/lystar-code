import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const testDir = join(packageDir, "test");
const tests = readdirSync(testDir).filter((name) => name.endsWith(".test.ts"));
const vitestTests = tests.filter((name) => /from ["']vitest["']/u.test(readFileSync(join(testDir, name), "utf8")));
const nodeTests = tests.filter((name) => !vitestTests.includes(name));

function run(args) {
	const result = spawnSync(process.execPath, args, { cwd: packageDir, stdio: "inherit" });
	if (result.error) throw result.error;
	return result.status === 0;
}

const nodePassed = run(["--import", "tsx", "--test", ...nodeTests.map((name) => join("test", name))]);
const vitestCli = join(dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))), "dist", "cli.js");
const vitestPassed = run([vitestCli, "--run", ...vitestTests.map((name) => join("test", name))]);
if (!nodePassed || !vitestPassed) process.exitCode = 1;
