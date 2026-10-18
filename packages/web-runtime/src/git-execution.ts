import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "@earendil-works/pi-coding-agent/core";
import { macosGitCredentialError, webGitArguments } from "./git-environment.ts";

// Gateway 等待 Runtime 响应 30 秒，预留进程退出与错误回传的时间。
export const GIT_OPERATION_TIMEOUT_MS = 25_000;
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

interface GitOperation {
	signal: AbortSignal;
	processes: Set<Promise<string>>;
}

const operations = new AsyncLocalStorage<GitOperation>();

export function assertGitOperationActive(): void {
	operations.getStore()?.signal.throwIfAborted();
}

export async function withGitOperation<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (operations.getStore()) return run();
	const controller = new AbortController();
	const cancel = () =>
		controller.abort(Object.assign(new Error("Git 操作已取消"), { code: "operation_aborted", retryable: false }));
	if (signal?.aborted) cancel();
	else signal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => {
		controller.abort(
			Object.assign(new Error("Git 操作超过 25 秒执行时限，已停止"), { code: "git_timeout", retryable: true }),
		);
	}, GIT_OPERATION_TIMEOUT_MS);
	timer.unref?.();
	const operation: GitOperation = { signal: controller.signal, processes: new Set() };
	try {
		controller.signal.throwIfAborted();
		const result = await operations.run(operation, run);
		controller.signal.throwIfAborted();
		return result;
	} catch (error) {
		throw controller.signal.aborted ? controller.signal.reason : error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
		// 同一读取中的并发命令全部退出后，才归还上层的执行名额。
		controller.abort();
		await Promise.allSettled(operation.processes);
	}
}

function runGit(cwd: string, args: string[], write: boolean): Promise<string> {
	const operation = operations.getStore();
	if (!operation) return withGitOperation(() => runGit(cwd, args, write));
	operation.signal.throwIfAborted();
	const result = new Promise<string>((resolve, reject) => {
		const child = spawn("git", webGitArguments(cwd, args), {
			detached: process.platform !== "win32",
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				GIT_LITERAL_PATHSPECS: "1",
				LC_ALL: "C",
				...(write ? { GIT_TERMINAL_PROMPT: "0" } : { GIT_OPTIONAL_LOCKS: "0" }),
			},
		});
		const cancel = () => {
			if (child.pid) killProcessTree(child.pid);
		};
		if (child.pid) trackDetachedChildPid(child.pid);
		operation.signal.addEventListener("abort", cancel, { once: true });
		if (operation.signal.aborted) cancel();
		let failure: Error | undefined;
		const stdout = { text: "", bytes: 0 };
		const stderr = { text: "", bytes: 0 };
		const capture = (output: typeof stdout, chunk: string) => {
			if (failure) return;
			output.bytes += Buffer.byteLength(chunk);
			if (output.bytes > GIT_MAX_OUTPUT_BYTES) {
				failure = new Error("Git 输出超过 8 MiB 上限");
				cancel();
				return;
			}
			output.text += chunk;
		};
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => capture(stdout, chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => capture(stderr, chunk));
		child.once("error", (error) => {
			failure = error;
		});
		child.once("close", (exitCode) => {
			operation.signal.removeEventListener("abort", cancel);
			if (child.pid) untrackDetachedChildPid(child.pid);
			if (operation.signal.aborted) {
				reject(operation.signal.reason);
				return;
			}
			if (!failure && exitCode === 0) {
				resolve(stdout.text);
				return;
			}
			const output =
				failure?.message ||
				(write ? [stdout.text.trim(), stderr.text.trim()].filter(Boolean).join("\n") : stderr.text.trim()) ||
				`Git 进程退出，状态码 ${exitCode}`;
			let code = output.includes("not a git repository") ? "git_not_repository" : "git_command_failed";
			let message = output;
			if (
				write &&
				args[0] === "merge" &&
				(output.includes("CONFLICT") || output.includes("Automatic merge failed"))
			) {
				code = "git_merge_conflict";
				message = "合并产生冲突，请解决冲突后提交，或中止合并";
			} else if (write && args[0] === "pull" && output.includes("Not possible to fast-forward")) {
				code = "git_fast_forward_required";
				message = "当前分支与远端已分叉，不能快进拉取；请明确执行分支合并";
			} else if (write) {
				const credentialError = macosGitCredentialError(output);
				if (credentialError) ({ code, message } = credentialError);
			}
			reject(Object.assign(new Error(message), { code, retryable: false }));
		});
	});
	operation.processes.add(result);
	void result.then(
		() => operation.processes.delete(result),
		() => operation.processes.delete(result),
	);
	return result;
}

export function git(cwd: string, args: string[]): Promise<string> {
	return runGit(cwd, args, false);
}

export function gitWrite(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	return withGitOperation(() => runGit(cwd, args, true), signal);
}
