import type { Server } from "node:net";
import { join } from "node:path";
import { closeIpcRuntime, defaultRuntimeEndpoint, runIpcRelay, serveIpcRuntime } from "./ipc.ts";
import { CodingAgentRuntimeAdapter, getRuntimeAgentDir } from "./runtime-adapter.ts";
import {
	clearRuntimePid,
	ensureRuntimeService,
	getRuntimeServiceStatus,
	installRuntimeService,
	removeRuntimeService,
	stopRuntimeService,
	writeRuntimePid,
} from "./runtime-service.ts";
import { WebRuntimeService } from "./service.ts";
import { runStdioRuntime } from "./stdio.ts";
import { restoreUserCommandEnvironment } from "./user-execution-environment.ts";

function endpointFromArgs(args: readonly string[]): string | undefined {
	for (let index = 1; index < args.length; index += 1) {
		const value = args[index];
		if (value === "--endpoint") {
			const endpoint = args[index + 1]?.trim();
			if (!endpoint) throw new Error("--endpoint 后需要填写 Runtime 连接地址");
			return endpoint;
		}
		if (value?.startsWith("--endpoint=")) {
			const endpoint = value.slice("--endpoint=".length).trim();
			if (!endpoint) throw new Error("--endpoint 后需要填写 Runtime 连接地址");
			return endpoint;
		}
	}
	return undefined;
}

function runtimeOperationJournalPath(agentDir: string, profile: string | undefined): string {
	const normalized = profile?.replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
	const suffix = normalized && normalized !== "default" ? `-${normalized}` : "";
	return join(agentDir, "host", `operations${suffix}.jsonl`);
}

export async function runWebRuntimeCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
	const agentDir = getRuntimeAgentDir();
	const serviceProfile =
		process.env.PI_WEB_SERVICE_PROFILE?.trim() ||
		(process.env.LYSTAR_CLI_MODE === "development" ? "development" : undefined);
	const command = args[0] ?? "stdio";
	if (command === "stdio" || command === "serve") restoreUserCommandEnvironment();
	const endpoint = endpointFromArgs(args) ?? process.env.PI_WEB_RUNTIME_ENDPOINT ?? defaultRuntimeEndpoint(agentDir);
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

	async function disposeService(): Promise<void> {
		const activeService = service;
		service = undefined;
		await activeService?.dispose();
	}

	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		await closeServer();
		await disposeService();
	};
	const onSignal = () => void shutdown();
	const onRestart = () => {
		process.exitCode = 1;
		void shutdown();
	};
	process.once("SIGTERM", onSignal);
	process.once("SIGINT", onSignal);
	if (process.platform !== "win32") process.once("SIGUSR2", onRestart);

	function print(value: unknown): void {
		process.stdout.write(`${JSON.stringify(value)}\n`);
	}

	try {
		if (command === "connect" && args[1] === "--stdio") {
			await ensureRuntimeService(endpoint);
			await runIpcRelay(endpoint, true);
			return;
		}
		if (command === "probe" || command === "status") {
			print(await getRuntimeServiceStatus(endpoint));
			return;
		}
		if (command === "install") {
			print(await installRuntimeService(endpoint, args.includes("--interactive-admin")));
			return;
		}
		if (command === "ensure") {
			print(await ensureRuntimeService(endpoint, undefined, undefined, args.includes("--interactive-admin")));
			return;
		}
		if (command === "stop") {
			print(
				await stopRuntimeService(
					endpoint,
					args.includes("--force"),
					undefined,
					undefined,
					args.includes("--interactive-admin"),
				),
			);
			return;
		}
		if (command === "uninstall") {
			await stopRuntimeService(
				endpoint,
				args.includes("--force"),
				undefined,
				undefined,
				args.includes("--interactive-admin"),
			);
			removeRuntimeService(endpoint, undefined, undefined, args.includes("--interactive-admin"));
			print({ removed: true, endpoint });
			return;
		}
		if (command === "stdio" || command === "serve") {
			service = new WebRuntimeService(
				new CodingAgentRuntimeAdapter({
					agentDir,
					preferSessionOwnership: serviceProfile === "development",
				}),
				{
					agentDir,
					journalPath: runtimeOperationJournalPath(agentDir, serviceProfile),
					persistent: command === "serve",
					...(startupSessionPath ? { startupSessionPath } : {}),
				},
			);
			if (command === "stdio") {
				await runStdioRuntime(service);
			} else {
				server = await serveIpcRuntime(service, endpoint);
				writeRuntimePid(endpoint);
				await new Promise<void>((resolve, reject) => {
					server?.once("close", resolve);
					server?.once("error", reject);
					if (shuttingDown) void closeServer();
				});
			}
			return;
		}
		throw new Error(
			"用法：lystar-web-runtime [stdio|serve [--endpoint <地址>]|probe|status|install [--interactive-admin]|ensure|connect --stdio|stop [--force]|uninstall [--force]]",
		);
	} finally {
		process.off("SIGTERM", onSignal);
		process.off("SIGINT", onSignal);
		if (process.platform !== "win32") process.off("SIGUSR2", onRestart);
		clearRuntimePid(endpoint);
		await closeServer();
		await disposeService();
	}
}
