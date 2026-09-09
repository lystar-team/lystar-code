#!/usr/bin/env node
import { DEFAULT_WEB_GATEWAY_PORT, loadWebGatewayConfig } from "./config.ts";
import { runWebGatewayCli } from "./runner.ts";

const tokenOnly = process.argv[2] === "token" || process.argv.includes("--token");
try {
	if (tokenOnly) {
		const config = await loadWebGatewayConfig({ defaultPort: DEFAULT_WEB_GATEWAY_PORT });
		process.stdout.write(`${config.token}\n`);
	} else {
		await runWebGatewayCli({ defaultPort: DEFAULT_WEB_GATEWAY_PORT });
	}
} catch (error) {
	const value = error as Error & { code?: string; status?: unknown };
	process.stderr.write(`${JSON.stringify({ error: value.message, code: value.code, status: value.status })}\n`);
	process.exitCode = 1;
}
