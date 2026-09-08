#!/usr/bin/env node
import { spawn } from "node:child_process";
import { loadWebGatewayConfig } from "./config.ts";
import { GatewayAlreadyRunningError, GatewayInstanceLock } from "./instance-lock.ts";
import { WebGatewayServer } from "./server.ts";

const command = process.argv[2];
const config = await loadWebGatewayConfig();
if (command === "token" || process.argv.includes("--token")) {
	process.stdout.write(`${config.token}\n`);
	process.exit(0);
}

let instanceLock: GatewayInstanceLock;
try {
	instanceLock = await GatewayInstanceLock.acquire(config.agentDir);
} catch (error) {
	if (error instanceof GatewayAlreadyRunningError) {
		process.stderr.write(`${error.message}\n`);
		process.exit(1);
	}
	throw error;
}
const gateway = new WebGatewayServer(config);
let closing = false;
const shutdown = async () => {
	if (closing) return;
	closing = true;
	await gateway.close();
	await instanceLock.release();
	process.exit(0);
};
const restart = () => {
	setTimeout(() => {
		if (closing) return;
		closing = true;
		void gateway
			.close()
			.then(() => instanceLock.release())
			.then(() => {
				const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
					detached: true,
					stdio: "ignore",
					env: process.env,
				});
				child.unref();
				process.exit(0);
			})
			.catch((error) => {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				process.exit(1);
			});
	}, 50).unref?.();
};
gateway.setRestartHandler(restart);
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
	await gateway.listen();
	process.stderr.write(`LYStar Web Gateway listening on ${gateway.config.host}:${gateway.config.port}\n`);
	process.stderr.write(`Web Token file: ${gateway.config.tokenPath}\n`);
} catch (error) {
	await gateway.close().catch(() => {});
	await instanceLock.release().catch(() => {});
	throw error;
}
