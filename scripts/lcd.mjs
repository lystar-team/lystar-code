#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEVELOPMENT_WEB_FRONTEND_PORT,
	shouldBuildDevelopmentWeb,
	shouldRunDevelopmentWebFrontend,
} from "./lcd-web-dev.mjs";

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

if (shouldRunDevelopmentWebFrontend(args)) {
	const backendStatus = runCliSync(["web"]);
	if (backendStatus !== 0) process.exit(backendStatus);
	console.log(`\n开发 Web（Vite HMR）：http://127.0.0.1:${DEVELOPMENT_WEB_FRONTEND_PORT}`);
	console.log("Gateway API：http://127.0.0.1:2422\n");
	const frontend = spawn(npmCommand, ["run", "dev", "--workspace=@lystar/code-web"], {
		cwd: repoRoot,
		env: developmentEnv,
		stdio: "inherit",
	});
	const status = await new Promise((resolveStatus) => {
		let settled = false;
		const finish = (code) => {
			if (settled) return;
			settled = true;
			resolveStatus(code);
		};
		frontend.once("error", (error) => {
			console.error(`启动 Web 热更新服务失败：${error.message}`);
			finish(1);
		});
		frontend.once("exit", (code, signal) => finish(code ?? (signal ? 1 : 0)));
	});
	process.exit(status);
}

process.exit(runCliSync(args));
