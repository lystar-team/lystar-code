import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	launchRustTuiProcess,
	type RustTuiFrontend,
	type RustTuiFrontendResult,
	type RustTuiProcess,
	rustTuiLaunchArgv,
} from "@earendil-works/pi-coding-agent";
import { serveIpcHost } from "./ipc.ts";
import { CodingAgentRuntimeAdapter } from "./runtime-adapter.ts";
import { GuiHostService } from "./service.ts";

function executableName(): string {
	return process.platform === "win32" ? "lystar-tui.exe" : "lystar-tui";
}

function isExecutable(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function resolveRustTuiBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env.PI_RUST_TUI_BINARY;
	const executable = executableName();
	const candidates = [
		override,
		join(dirname(process.execPath), executable),
		join(dirname(process.execPath), "rust-tui", executable),
	].filter((path): path is string => Boolean(path));
	return candidates.find(isExecutable);
}

function closeServer(server: Server | undefined): Promise<void> {
	if (!server?.listening) return Promise.resolve();
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
	if (code !== null) return code;
	return signal ? 1 : 0;
}

async function cleanupHost(server: Server | undefined, service: GuiHostService | undefined, directory?: string) {
	let cleanupError: unknown;
	try {
		await closeServer(server);
	} catch (error) {
		cleanupError = error;
	}
	try {
		await service?.dispose();
	} catch (error) {
		cleanupError ??= error;
	}
	if (directory) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch (error) {
			cleanupError ??= error;
		}
	}
	if (cleanupError) throw cleanupError;
}

export const runEmbeddedRustTui: RustTuiFrontend = async (context): Promise<RustTuiFrontendResult> => {
	if (process.platform === "win32") {
		return { handled: false, reason: "当前版本尚未接入 Windows named pipe" };
	}
	const binary = resolveRustTuiBinary();
	if (!binary) return { handled: false, reason: `未找到 ${executableName()} sidecar` };

	let endpointDirectory: string;
	try {
		endpointDirectory = mkdtempSync(join(tmpdir(), "lystar-rust-tui-"));
	} catch (error) {
		return {
			handled: false,
			reason: `无法创建 Host 临时目录：${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const endpoint = join(endpointDirectory, `${process.pid}-${randomUUID()}.sock`);
	const adapter = new CodingAgentRuntimeAdapter({
		agentDir: context.agentDir,
		initialRuntime: context.runtime,
		createRuntime: context.createRuntime,
	});
	let service: GuiHostService | undefined;
	let server: Server | undefined;
	try {
		service = new GuiHostService(adapter, {
			agentDir: context.agentDir,
			startupInput: context.startupInput,
			startupSessionPath: context.launchOptions.sessionPath,
		});
		try {
			server = await serveIpcHost(service, endpoint);
		} catch (error) {
			return {
				handled: false,
				reason: `无法创建 Host endpoint：${error instanceof Error ? error.message : String(error)}`,
			};
		}

		let rust: RustTuiProcess;
		try {
			rust = await launchRustTuiProcess({
				rust: { command: binary, args: rustTuiLaunchArgv(context.launchOptions) },
				endpoint,
			});
		} catch (error) {
			return {
				handled: false,
				reason: `无法启动 ${basename(binary)}：${error instanceof Error ? error.message : String(error)}`,
			};
		}

		const result = await rust.wait();
		if (!adapter.hasClaimedInitialRuntime) {
			return {
				handled: false,
				reason: `Rust TUI 在接管 Session 前退出（code=${result.code ?? "null"}, signal=${result.signal ?? "null"}）`,
			};
		}
		return { handled: true, exitCode: exitCode(result.code, result.signal) };
	} finally {
		await cleanupHost(server, service, endpointDirectory);
	}
};
