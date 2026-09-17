#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldBuildDevelopmentWeb, shouldStartDevelopmentWebStack } from "./lcd-web-dev.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "packages/coding-agent/src/cli.ts");
const tsxLoader = resolve(repoRoot, "node_modules/tsx/dist/loader.mjs");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const args = process.argv.slice(2);
const developmentEnv = { ...process.env, LYSTAR_CLI_MODE: "development" };

function runSync(command, commandArgs, cwd = process.cwd()) {
	const result = spawnSync(command, commandArgs, { cwd, env: developmentEnv, stdio: "inherit" });
	if (result.error) {
		console.error(`启动本地 LYStar Code 失败：${result.error.message}`);
		return 1;
	}
	return result.status ?? 1;
}

function runCliSync(cliArgs) {
	return runSync(process.execPath, ["--import", tsxLoader, cliPath, ...cliArgs]);
}

if (shouldBuildDevelopmentWeb(args)) {
	const status = runSync(npmCommand, ["run", "build:web-dev"], repoRoot);
	if (status !== 0) process.exit(status);
}

if (shouldStartDevelopmentWebStack(args)) process.exit(runCliSync(["web"]));

process.exit(runCliSync(args));
