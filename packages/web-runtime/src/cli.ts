#!/usr/bin/env node
import type { Server } from "node:net";
import { closeIpcRuntime, defaultRuntimeEndpoint, runIpcRelay, serveIpcRuntime } from "./ipc.ts";
import { CodingAgentRuntimeAdapter, getRuntimeAgentDir } from "./runtime-adapter.ts";
import {
	ensureRuntimeService,
	getRuntimeServiceStatus,
	installRuntimeService,
	removeRuntimeService,
	stopRuntimeService,
} from "./runtime-service.ts";
import { WebRuntimeService } from "./service.ts";
import { runStdioRuntime } from "./stdio.ts";

const agentDir = getRuntimeAgentDir();
const command = process.argv[2] ?? "stdio";
const endpoint = process.env.PI_WEB_RUNTIME_ENDPOINT ?? defaultRuntimeEndpoint(agentDir);
const startupSessionPath = process.env.PI_WEB_STARTUP_SESSION_PATH?.trim();
let service: WebRuntimeService | undefined;
let server: Server | undefined;
let shuttingDown = false;

async function closeServer(): Promise<void> {
	const activeServer = server;
	server = undefined;
	if (!activeServer || !activeServer.listening) return;
	await closeIpcRuntime(activeServer);
}

const shutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	await closeServer();
	await service?.dispose();
	process.exit(0);
};

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

function print(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
	if (command === "connect" && process.argv[3] === "--stdio") {
		await ensureRuntimeService(endpoint);
		await runIpcRelay(endpoint, true);
		return;
	}
	if (command === "probe" || command === "status") {
		print(await getRuntimeServiceStatus(endpoint));
		return;
	}
	if (command === "install") {
		print(await installRuntimeService(endpoint, process.argv.includes("--interactive-admin")));
		return;
	}
	if (command === "ensure") {
		print(await ensureRuntimeService(endpoint));
		return;
	}
	if (command === "stop") {
		print(await stopRuntimeService(endpoint, process.argv.includes("--force")));
		return;
	}
	if (command === "uninstall") {
		await stopRuntimeService(endpoint, process.argv.includes("--force"));
		removeRuntimeService();
		print({ removed: true, endpoint });
		return;
	}
	if (command === "stdio" || command === "serve") {
		service = new WebRuntimeService(new CodingAgentRuntimeAdapter(agentDir), {
			agentDir,
			persistent: command === "serve",
			...(startupSessionPath ? { startupSessionPath } : {}),
		});
		try {
			if (command === "stdio") await runStdioRuntime(service);
			else {
				server = await serveIpcRuntime(service, endpoint);
				await new Promise<void>((resolve, reject) => {
					server?.once("close", resolve);
					server?.once("error", reject);
				});
			}
		} finally {
			await closeServer();
			await service.dispose();
			service = undefined;
		}
		return;
	}
	throw new Error(
		"用法：lystar-web-runtime [stdio|serve|probe|status|install [--interactive-admin]|ensure|connect --stdio|stop [--force]|uninstall [--force]]",
	);
}

try {
	await main();
} catch (error) {
	const value = error as Error & { code?: string; status?: unknown };
	process.stderr.write(`${JSON.stringify({ error: value.message, code: value.code, status: value.status })}\n`);
	process.exitCode = 1;
}
