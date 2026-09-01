#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "packages/coding-agent/src/cli.ts");
const tsxLoader = resolve(repoRoot, "node_modules/tsx/dist/loader.mjs");
const result = spawnSync(process.execPath, ["--import", tsxLoader, cliPath, ...process.argv.slice(2)], {
	cwd: process.cwd(),
	env: process.env,
	stdio: "inherit",
});

if (result.error) {
	console.error(`启动本地 LYStar Code 失败：${result.error.message}`);
	process.exit(1);
}

process.exit(result.status ?? 1);