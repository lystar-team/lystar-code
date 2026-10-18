import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { git, gitWrite, GIT_OPERATION_TIMEOUT_MS, withGitOperation } from "../src/git-execution.ts";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = performance.now() + 3000;
	while (!predicate()) {
		if (performance.now() >= deadline) throw new Error("Git 夹具没有在时限内启动");
		await delay(10);
	}
}

function stalledGit(): { cwd: string; args: string[]; heartbeat: string } {
	const cwd = mkdtempSync(join(tmpdir(), "runtime-git-timeout-"));
	const script = join(cwd, "stall.mjs");
	const heartbeat = join(cwd, "heartbeat");
	writeFileSync(script, `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
let ticks = 0;
setInterval(() => writeFileSync(${JSON.stringify(heartbeat)}, String(++ticks)), 10);
`);
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	return { cwd, args: ["-c", `alias.stall=!exec "${process.execPath}" "${script}"`, "stall"], heartbeat };
}

test("整个 Git 读取共用执行预算，超时终止进程树后后续读取正常", async () => {
	const { cwd, args, heartbeat } = stalledGit();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const controller = new AbortController();
	let firstFinished = false;
	const running = withGitOperation(async () => {
		await git(cwd, ["--version"]);
		firstFinished = true;
		await new Promise<void>((resolve) => setTimeout(resolve, 15_000));
		return git(cwd, args);
	}, controller.signal);
	const assertion = expect(running).rejects.toMatchObject({ code: "git_timeout", retryable: true });
	try {
		await waitFor(() => firstFinished);
		await vi.advanceTimersByTimeAsync(15_000);
		await waitFor(() => existsSync(heartbeat));
		await vi.advanceTimersByTimeAsync(GIT_OPERATION_TIMEOUT_MS - 15_000);
		await assertion;
		const stopped = readFileSync(heartbeat, "utf8");
		await delay(50);
		expect(readFileSync(heartbeat, "utf8")).toBe(stopped);
		expect(await git(cwd, ["--version"])).toContain("git version");
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		controller.abort();
		await running.catch(() => {});
	}
});

test("取消 Git 写入会终止忽略 SIGTERM 的进程，并清理超时定时器", async () => {
	const { cwd, args, heartbeat } = stalledGit();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const controller = new AbortController();
	const running = gitWrite(cwd, args, controller.signal);
	const assertion = expect(running).rejects.toMatchObject({ code: "operation_aborted", retryable: false });
	try {
		await waitFor(() => existsSync(heartbeat));
		controller.abort();
		await assertion;
		const stopped = readFileSync(heartbeat, "utf8");
		await delay(50);
		expect(readFileSync(heartbeat, "utf8")).toBe(stopped);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		controller.abort();
		await running.catch(() => {});
	}
});

test("一个并发命令失败后，其余 Git 子进程退出才结束请求", async () => {
	const { cwd, args, heartbeat } = stalledGit();
	const running = withGitOperation(async () => {
		const stalled = git(cwd, args);
		await waitFor(() => existsSync(heartbeat));
		await Promise.all([stalled, git(cwd, ["unknown-lystar-command"])]);
	});
	await expect(running).rejects.toMatchObject({ code: "git_command_failed" });
	const stopped = readFileSync(heartbeat, "utf8");
	await delay(50);
	expect(readFileSync(heartbeat, "utf8")).toBe(stopped);
});

test("已取消的写操作在仓库解析前终止，并发读取不继承另一个请求的取消信号", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "runtime-git-abort-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, "agent"));
	const adapter = new CodingAgentRuntimeAdapter({ agentDir: join(cwd, "agent") });
	const controller = new AbortController();
	controller.abort();
	await expect(adapter.mutateGit(cwd, undefined, { type: "fetch" }, controller.signal)).rejects.toMatchObject({ code: "operation_aborted" });
	const failed = withGitOperation(() => git(cwd, ["--version"]), controller.signal);
	const successful = withGitOperation(() => git(cwd, ["--version"]));
	const results = await Promise.allSettled([failed, successful]);
	expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "operation_aborted" } });
	expect(results[1]).toMatchObject({ status: "fulfilled", value: expect.stringContaining("git version") });
});
