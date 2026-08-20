#!/usr/bin/env node
import type { Server } from "node:net";
import {
	ensureHostService,
	getHostServiceStatus,
	installHostService,
	removeHostService,
	stopHostService,
} from "./host-service.ts";
import { defaultIpcEndpoint, runIpcRelay, serveIpcHost } from "./ipc.ts";
import { CodingAgentRuntimeAdapter, getGuiAgentDir } from "./runtime-adapter.ts";
import { GuiHostService } from "./service.ts";
import { runStdioHost } from "./stdio.ts";

const agentDir = getGuiAgentDir();
const command = process.argv[2] ?? "stdio";
const endpoint = process.env.PI_GUI_HOST_ENDPOINT ?? defaultIpcEndpoint(agentDir);
let service: GuiHostService | undefined;
let server: Server | undefined;
let shuttingDown = false;

async function closeServer(): Promise<void> {
	const activeServer = server;
	server = undefined;
	if (!activeServer || !activeServer.listening) return;
	await new Promise<void>((resolve, reject) => {
		activeServer.close((error) => (error ? reject(error) : resolve()));
	});
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
		await ensureHostService(endpoint);
		await runIpcRelay(endpoint, true);
		return;
	}
	if (command === "probe" || command === "status") {
		print(await getHostServiceStatus(endpoint));
		return;
	}
	if (command === "install") {
		print(await installHostService(endpoint, process.argv.includes("--interactive-admin")));
		return;
	}
	if (command === "ensure") {
		print(await ensureHostService(endpoint));
		return;
	}
	if (command === "stop") {
		print(await stopHostService(endpoint, process.argv.includes("--force")));
		return;
	}
	if (command === "uninstall") {
		await stopHostService(endpoint, process.argv.includes("--force"));
		removeHostService();
		print({ removed: true, endpoint });
		return;
	}
	if (command === "stdio" || command === "serve") {
		service = new GuiHostService(new CodingAgentRuntimeAdapter(agentDir), {
			agentDir,
			persistent: command === "serve",
		});
		try {
			if (command === "stdio") await runStdioHost(service);
			else {
				server = await serveIpcHost(service, endpoint);
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
		"用法：lystar-gui-host [stdio|serve|probe|status|install [--interactive-admin]|ensure|connect --stdio|stop [--force]|uninstall [--force]]",
	);
}

try {
	await main();
} catch (error) {
	const value = error as Error & { code?: string; status?: unknown };
	process.stderr.write(`${JSON.stringify({ error: value.message, code: value.code, status: value.status })}\n`);
	process.exitCode = 1;
}
