#!/usr/bin/env node
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WEB_GATEWAY_PORT, loadWebGatewayConfig } from "./config.ts";
import { runWebGatewayCli } from "./runner.ts";

const SOURCE_DEV_CONFIG_FILE = "web-dev-config.json";
const SOURCE_DEV_RUNTIME_PORT = 2423;
const moduleDir = dirname(fileURLToPath(import.meta.url));
const runtimeCliIsBuilt = basename(moduleDir) === "dist";
const sourceRuntimeInvocation = {
	command: process.execPath,
	args: runtimeCliIsBuilt
		? [resolve(moduleDir, "../../web-runtime/dist/cli.js"), "serve"]
		: ["--import", import.meta.resolve("tsx"), resolve(moduleDir, "../../web-runtime/src/cli.ts"), "serve"],
	cwd: process.cwd(),
};
const tokenOnly = process.argv[2] === "token" || process.argv.includes("--token");
try {
	if (tokenOnly) {
		const config = await loadWebGatewayConfig({
			defaultPort: DEFAULT_WEB_GATEWAY_PORT,
			defaultRuntimePort: SOURCE_DEV_RUNTIME_PORT,
			configFileName: SOURCE_DEV_CONFIG_FILE,
		});
		process.stdout.write(`${config.token}\n`);
	} else {
		await runWebGatewayCli({
			defaultPort: DEFAULT_WEB_GATEWAY_PORT,
			defaultRuntimePort: SOURCE_DEV_RUNTIME_PORT,
			configFileName: SOURCE_DEV_CONFIG_FILE,
			commandName: "lcd",
			runtimeInvocation: sourceRuntimeInvocation,
			allowRuntimeEndpointOverride: true,
		});
	}
} catch (error) {
	const value = error as Error & { code?: string; status?: unknown };
	process.stderr.write(`${JSON.stringify({ error: value.message, code: value.code, status: value.status })}\n`);
	process.exitCode = 1;
}
