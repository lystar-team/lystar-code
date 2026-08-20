import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";

const DEFAULT_STOP_TIMEOUT_MS = 2_000;

export interface ProcessInvocation {
	command: string;
	args: string[];
}

export interface RustTuiProcessOptions {
	rust: ProcessInvocation;
	endpoint: string;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	stdio?: StdioOptions;
	stopTimeoutMs?: number;
}

export interface ProcessExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

export interface RustTuiProcess {
	readonly child: ChildProcess;
	wait(): Promise<ProcessExit>;
	stop(): Promise<void>;
}

function waitForExit(child: ChildProcess): Promise<ProcessExit> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

function waitForSpawn(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const onSpawn = () => {
			child.removeListener("error", onError);
			resolve();
		};
		const onError = (error: Error) => {
			child.removeListener("spawn", onSpawn);
			reject(error);
		};
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
}

async function stopChild(child: ChildProcess, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const exited = await Promise.race([
		waitForExit(child).then(() => true),
		new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			timer.unref?.();
		}),
	]);
	if (!exited && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

export async function launchRustTuiProcess(options: RustTuiProcessOptions): Promise<RustTuiProcess> {
	const child = spawn(options.rust.command, options.rust.args, {
		cwd: options.cwd,
		env: {
			...process.env,
			...options.env,
			PI_RUST_TUI_HOST_ENDPOINT: options.endpoint,
		},
		stdio: options.stdio ?? "inherit",
	});
	await waitForSpawn(child);
	const exit = waitForExit(child);
	return {
		child,
		wait: () => exit,
		stop: () => stopChild(child, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS),
	};
}
