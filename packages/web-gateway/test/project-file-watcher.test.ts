import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { ProjectFileWatcher } from "../../web-runtime/src/project-file-watcher.ts";

const execFileAsync = promisify(execFile);

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 4000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "没有在时限内收到文件变更通知");
		await delay(10);
	}
}

async function fixture(t: TestContext): Promise<{ root: string; batches: string[][]; watcher: ProjectFileWatcher }> {
	const temp = await mkdtemp(join(tmpdir(), "web-project-watcher-"));
	const root = join(temp, "project");
	await mkdir(root);
	const batches: string[][] = [];
	const errors: unknown[] = [];
	const watcher = new ProjectFileWatcher(root, (paths) => batches.push(paths));
	watcher.on("error", (error: unknown) => errors.push(error));
	t.after(async () => {
		watcher.close();
		await rm(temp, { recursive: true, force: true });
		assert.deepEqual(errors, []);
	});
	await watcher.ready;
	await waitFor(() => batches.length > 0);
	assert.deepEqual(batches.splice(0), [[""]]);
	return { root, batches, watcher };
}

test("持续修改同一文件时按最大等待时间发送，并在停止后发送最终状态", async (t) => {
	const { root, batches } = await fixture(t);
	const path = join(root, "active.txt");
	let writes = 0;
	const interval = setInterval(() => {
		writes++;
		void writeFile(path, String(writes));
	}, 30);
	try {
		await waitFor(() => batches.length > 0);
		assert.ok(writes > 5);
		assert.ok(batches.length <= 2);
		assert.deepEqual(batches[0], ["active.txt"]);
	} finally {
		clearInterval(interval);
	}
	batches.splice(0);
	await writeFile(path, "final");
	await waitFor(() => batches.some((paths) => paths.includes("active.txt")));
	assert.equal(await readFile(path, "utf8"), "final");
});

test("合并重复路径，超过路径上限后发送全量失效", async (t) => {
	const { root, batches } = await fixture(t);
	await Promise.all(Array.from({ length: 270 }, (_, index) => writeFile(join(root, `file-${index}.txt`), "x")));
	await waitFor(() => batches.length > 0);
	assert.deepEqual(batches, [[""]]);
});

test("项目根目录删除并重建后重新绑定目录和子目录监听", async (t) => {
	const { root, batches } = await fixture(t);
	await rm(root, { recursive: true });
	await waitFor(() => batches.length > 0);
	batches.splice(0);
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "app.ts"), "initial");
	await waitFor(() => batches.some((paths) => paths.includes("")));
	batches.splice(0);
	await writeFile(join(root, "src", "app.ts"), "updated");
	await waitFor(() => batches.some((paths) => paths.includes("src/app.ts")));
});

test("子目录在同一路径重建后继续收到修改通知", async (t) => {
	const { root, batches } = await fixture(t);
	const directory = join(root, "src");
	await mkdir(directory);
	await writeFile(join(directory, "app.ts"), "before");
	await waitFor(() => batches.length > 0);
	batches.splice(0);
	await rm(directory, { recursive: true });
	await mkdir(directory);
	await writeFile(join(directory, "app.ts"), "after");
	await waitFor(() => batches.length > 0);
	batches.splice(0);
	await writeFile(join(directory, "app.ts"), "updated");
	await waitFor(() => batches.some((paths) => paths.includes("src/app.ts")));
});

test("linked worktree 监听实际 gitdir 和共享 refs，忽略对象库写入", async (t) => {
	const temp = await mkdtemp(join(tmpdir(), "web-worktree-watcher-"));
	const main = join(temp, "main");
	const worktree = join(temp, "linked");
	const git = (cwd: string, args: string[]) => execFileAsync("git", ["-C", cwd, ...args], { timeout: 5000 });
	await mkdir(main);
	await git(main, ["init", "-q"]);
	await git(main, ["-c", "user.name=Watcher", "-c", "user.email=watcher@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
	await git(main, ["worktree", "add", "-qb", "linked", worktree]);
	const batches: string[][] = [];
	const errors: unknown[] = [];
	const watcher = new ProjectFileWatcher(worktree, (paths) => batches.push(paths));
	watcher.on("error", (error: unknown) => errors.push(error));
	t.after(async () => {
		watcher.close();
		await rm(temp, { recursive: true, force: true });
		assert.deepEqual(errors, []);
	});
	await watcher.ready;
	await waitFor(() => batches.length > 0);
	batches.splice(0);
	await git(worktree, ["switch", "-qc", "other"]);
	await waitFor(() => batches.some((paths) => paths.includes(".git")));
	batches.splice(0);
	await git(main, ["branch", "shared-ref"]);
	await waitFor(() => batches.some((paths) => paths.includes(".git")));
	batches.splice(0);
	const objects = join(main, ".git", "objects", "aa");
	await mkdir(objects, { recursive: true });
	await writeFile(join(objects, "object"), "ignored");
	await delay(250);
	assert.deepEqual(batches, []);
});

test("关闭监听会清理待发送通知，关闭发生在初始化期间也不会重新绑定", async (t) => {
	const { root, batches, watcher } = await fixture(t);
	await writeFile(join(root, "pending.txt"), "x");
	watcher.close();
	await delay(200);
	assert.deepEqual(batches, []);
	const early = new ProjectFileWatcher(root, (paths) => batches.push(paths));
	early.close();
	await early.ready;
	await writeFile(join(root, "later.txt"), "x");
	await delay(200);
	assert.deepEqual(batches, []);
});
