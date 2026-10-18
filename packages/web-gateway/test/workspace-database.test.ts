import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionSummary } from "@lystar/code-web-protocol";
import { ProjectGroupRegistry } from "../src/project-group-registry.ts";
import { ProjectRegistry } from "../src/project-registry.ts";
import { SessionResultRegistry } from "../src/session-result-registry.ts";
import { WorkspaceDatabase } from "../src/workspace-database.ts";

function summary(cwd: string, id: string, updatedAt = 1): SessionSummary {
	return { id, cwd, path: join(cwd, `${id}.jsonl`), createdAt: updatedAt, updatedAt, messageCount: 1, firstMessage: id, activity: "completed", writeAccess: "available" };
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "lystar-workspace-"));
	await mkdir(join(root, "web"));
	await writeFile(join(root, "web", "projects.json"), JSON.stringify({ projects: [], migration: { tauriImported: true } }));
	const store = new WorkspaceDatabase(root);
	return { root, store, projects: new ProjectRegistry(root, store), groups: new ProjectGroupRegistry(root, store), results: new SessionResultRegistry(root, () => {}, store) };
}

test("首次启动自动迁移项目、分组和已读记录，重启不重新导入旧 JSON", async (t) => {
	const f = await fixture();
	t.after(async () => { await f.store.close(); await rm(f.root, { recursive: true, force: true }); });
	const child = join(f.root, "child");
	const projects = [
		{ id: "parent", name: "父项目", cwd: f.root, pinned: true, color: "blue", sessionOrder: ["s2", "s1"], pinnedSessionIds: ["s1"], recentSessions: [summary(f.root, "s2"), summary(f.root, "s1")] },
		{ id: "child", name: "子项目", cwd: child, archived: true },
	];
	const groups = [{ id: "g2", name: "第二组", projectIds: ["child", "parent", "missing-project"] }, { id: "g1", name: "第一组", projectIds: [] }];
	const result = { sessionId: "s1", revision: 3, readRevision: 2, updatedAt: 10, activity: "completed", version: 5, viewedAt: 8 };
	const legacyProjects = JSON.stringify({ version: 1, projects, migration: { tauriImported: true } });
	await writeFile(join(f.root, "web", "projects.json"), legacyProjects);
	await writeFile(join(f.root, "project-groups.json"), JSON.stringify({ version: 1, groups }));
	await writeFile(join(f.root, "web", "session-results.json"), JSON.stringify({ initializedAt: 6, results: { s1: result } }));
	await f.groups.load();
	assert.deepEqual(f.projects.list().map(({ id, cwd }) => ({ id, cwd })), projects.map(({ id, cwd }) => ({ id, cwd })));
	assert.deepEqual(f.projects.get("parent")?.sessionOrder, ["s2", "s1"]);
	assert.deepEqual(f.projects.get("parent")?.pinnedSessionIds, ["s1"]);
	assert.equal(f.projects.get("parent")?.color, "blue");
	assert.equal(f.projects.get("child")?.archived, true);
	assert.deepEqual(f.groups.list(), groups);
	assert.deepEqual(f.results.get("s1"), result);
	assert.equal(f.store.readResults().initializedAt, 6);
	assert.equal(await readFile(join(f.root, "web", "projects.json.pre-sqlite"), "utf8"), legacyProjects);
	await f.projects.update("parent", { name: "客户服务平台" });
	await f.projects.remove("child");
	const revision = f.store.revision;
	await f.store.close();
	await f.projects.load();
	assert.equal(f.store.revision, revision);
	assert.equal(f.projects.get("parent")?.name, "客户服务平台");
	assert.equal(f.projects.get("child"), undefined);
	assert.deepEqual(f.groups.list()[0]?.projectIds, ["parent", "missing-project"]);
	assert.equal(await readFile(join(f.root, "web", "projects.json"), "utf8"), legacyProjects);
});

test("迁移失败整批回滚，修复源文件后可以重试", async (t) => {
	const f = await fixture();
	t.after(async () => { await f.store.close(); await rm(f.root, { recursive: true, force: true }); });
	await writeFile(join(f.root, "web", "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "项目", cwd: f.root }], migration: { tauriImported: true } }));
	await writeFile(join(f.root, "project-groups.json"), JSON.stringify({ groups: "invalid" }));
	assert.throws(() => f.store.load(), /项目组列表格式无效/);
	const check = new DatabaseSync(f.store.path);
	assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 0);
	assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='projects'").get()?.count, 0);
	check.close();
	await writeFile(join(f.root, "project-groups.json"), JSON.stringify({ groups: [{ id: "g", name: "项目组", projectIds: ["p"] }] }));
	f.store.load();
	assert.equal(f.projects.list().length, 1);
	assert.deepEqual(f.groups.list()[0]?.projectIds, ["p"]);
});

test("两个数据库连接的项目、分组和字段更新互不覆盖", async (t) => {
	const f = await fixture();
	const secondStore = new WorkspaceDatabase(f.root);
	t.after(async () => { await secondStore.close(); await f.store.close(); await rm(f.root, { recursive: true, force: true }); });
	const second = new ProjectRegistry(f.root, secondStore);
	const secondGroups = new ProjectGroupRegistry(f.root, secondStore);
	await mkdir(join(f.root, "child"));
	await Promise.all([f.projects.load(), second.load()]);
	await Promise.all([f.projects.add({ id: "parent", cwd: f.root }), second.add({ id: "child", cwd: join(f.root, "child") })]);
	const [a, b] = await Promise.all([f.groups.create("第一组"), secondGroups.create("第二组")]);
	await Promise.all([f.groups.assignProject("parent", a.id), secondGroups.assignProject("child", b.id)]);
	await Promise.all([f.projects.update("parent", { name: "商户管理系统" }), second.update("parent", { pinned: true })]);
	assert.deepEqual(second.list(), f.projects.list());
	assert.equal(f.projects.list().length, 2);
	assert.equal(f.projects.get("parent")?.name, "商户管理系统");
	assert.equal(f.projects.get("parent")?.pinned, true);
	assert.deepEqual(f.groups.list(), secondGroups.list());
	assert.equal(secondStore.revision, f.store.revision);
});

test("完整保存超过 100 条会话及其置顶，旧扫描不能覆盖新摘要", async (t) => {
	const f = await fixture();
	t.after(async () => { await f.store.close(); await rm(f.root, { recursive: true, force: true }); });
	await f.projects.add({ id: "p", cwd: f.root });
	const sessions = Array.from({ length: 130 }, (_, index) => summary(f.root, `s${index}`, index + 1));
	await f.projects.setRecentSessions("p", sessions);
	await f.projects.setSessionPinned("p", "s129", true);
	const oldRevision = f.projects.getSessionRevision("p");
	await f.projects.setRecentSessions("p", [summary(f.root, "new", 1000), ...sessions], oldRevision);
	await f.projects.setRecentSessions("p", sessions, oldRevision);
	assert.equal(f.projects.get("p")?.recentSessions?.length, 131);
	assert.equal(f.projects.get("p")?.recentSessions?.[0]?.id, "new");
	assert.deepEqual(f.projects.get("p")?.pinnedSessionIds, ["s129"]);
});

test("不同 Gateway 的结果已读共享，新结果不会被旧页面标记为已读", async (t) => {
	const f = await fixture();
	const secondStore = new WorkspaceDatabase(f.root);
	const second = new SessionResultRegistry(f.root, () => {}, secondStore);
	t.after(async () => { await secondStore.close(); await f.store.close(); await rm(f.root, { recursive: true, force: true }); });
	const firstTime = Date.now() + 1000;
	await f.results.observe([summary(f.root, "s", firstTime)]);
	await second.markRead("s", 1);
	assert.equal(f.results.get("s")?.readRevision, 1);
	await second.observe([summary(f.root, "s", firstTime + 1)]);
	await f.results.markRead("s", 1);
	assert.equal(second.get("s")?.revision, 2);
	assert.equal(second.get("s")?.readRevision, 1);
	await f.results.observe([summary(f.root, "s", firstTime)]);
	assert.equal(second.get("s")?.revision, 2);
	assert.deepEqual(second.get("s"), f.results.get("s"));
});

test("事务失败不改变项目列表和版本，空更新不触发同步", async (t) => {
	const f = await fixture();
	t.after(async () => { await f.store.close(); await rm(f.root, { recursive: true, force: true }); });
	f.store.load();
	const revision = f.store.revision;
	await assert.rejects(f.store.updateProjects((state) => { state.projects.push({ id: "p", name: "项目", cwd: f.root }); throw new Error("abort"); }), /abort/);
	assert.equal(f.projects.list().length, 0);
	assert.equal(f.store.revision, revision);
	await f.results.observe([]);
	assert.equal(f.store.revision, revision);
});


 test("独立进程同时写入同一数据库，保留全部项目和分组归属", async (t) => {
	const f = await fixture();
	t.after(async () => { await f.store.close(); await rm(f.root, { recursive: true, force: true }); });
	await Promise.all(["a", "b"].flatMap((prefix) => Array.from({ length: 12 }, (_, index) => mkdir(join(f.root, `${prefix}-${index}`)))));
	const writer = fileURLToPath(new URL("./fixtures/workspace-writer.ts", import.meta.url));
	await Promise.all(([["a", "门户应用"], ["b", "后台服务"]] as const).map(([prefix, groupName]) => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", writer, f.root, prefix, groupName], { stdio: ["ignore", "ignore", "pipe"] });
		let error = "";
		child.stderr.setEncoding("utf8").on("data", (value: string) => { error += value; });
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolve() : reject(new Error(error)));
	})));
	assert.equal(f.projects.list().length, 24);
	assert.deepEqual(f.groups.list().map((group) => group.projectIds.length), [12, 12]);
	assert.equal(new Set(f.groups.list().flatMap((group) => group.projectIds)).size, 24);
});


test("同一字段的旧修改返回冲突，无关字段仍可提交", async (t) => {
	const f = await fixture();
	t.after(async () => { await f.store.close(); await rm(f.root, { recursive: true, force: true }); });
	await f.projects.add({ id: "p", cwd: f.root, name: "订单管理平台" });
	await f.projects.update("p", { name: "订单运营平台" }, { name: "订单管理平台" });
	await assert.rejects(f.projects.update("p", { name: "订单服务平台" }, { name: "订单管理平台" }), { status: 409, code: "workspace_conflict" });
	await f.projects.update("p", { pinned: true }, { name: "订单管理平台", pinned: false });
	assert.equal(f.projects.get("p")?.name, "订单运营平台");
	assert.equal(f.projects.get("p")?.pinned, true);
	const group = await f.groups.create("内部应用");
	await f.groups.update(group.id, "业务应用", "内部应用");
	await assert.rejects(f.groups.update(group.id, "管理应用", "内部应用"), { status: 409, code: "workspace_conflict" });
	assert.equal(f.groups.list()[0]?.name, "业务应用");
});
