#!/usr/bin/env node
import { createWebGatewayServer } from "./server.ts";

const gateway = await createWebGatewayServer();
const command = process.argv[2];
if (command === "token" || process.argv.includes("--token")) {
	process.stdout.write(`${gateway.getToken()}\n`);
	await gateway.close();
	process.exit(0);
}

await gateway.listen();
process.stderr.write(`LYStar Web Gateway listening on ${gateway.config.host}:${gateway.config.port}\n`);
process.stderr.write(`Web Token file: ${gateway.config.tokenPath}\n`);

let closing = false;
const shutdown = async () => {
	if (closing) return;
	closing = true;
	await gateway.close();
	process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
