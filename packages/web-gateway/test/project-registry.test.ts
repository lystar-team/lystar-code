import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "@lystar/code-web-protocol";
import { ProjectRegistry } from "../src/project-registry.ts";

test("ProjectRegistry 串行处理并发保存并保留完整项目索引", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "lystar-project-registry-"));
	const previousConfigHome = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(root, "config");
	t.after(() => {
		if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousConfigHome;
	});
	t.after(() => rm(root, { recursive: true, force: true }));

	const projectRoot = join(root, "projects");
	const projectDirectories = Array.from({ length: 32 }, (_, index) => join(projectRoot, `project-${index}`));
	await Promise.all(projectDirectories.map((directory) => mkdir(directory, { recursive: true })));

	const registry = new ProjectRegistry(join(root, "agent"));
	await registry.load();
	await Promise.all(
		projectDirectories.map((cwd, index) => registry.add({ id: `project-${index}`, name: `项目 ${index}`, cwd })),
	);

	const saved = JSON.parse(await readFile(registry.path, "utf8")) as {
		projects?: Array<{ id?: string; cwd?: string }>;
	};
	assert.equal(saved.projects?.length, projectDirectories.length);
	assert.deepEqual(
		new Set(saved.projects?.map((project) => project.id)),
		new Set(projectDirectories.map((_, index) => `project-${index}`)),
	);
	assert.deepEqual(new Set(saved.projects?.map((project) => project.cwd)), new Set(projectDirectories));
});

test("ProjectRegistry 持久化项目和项目内会话顺序", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "lystar-project-registry-order-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const previousConfigHome = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(root, "config");
	t.after(() => {
		if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousConfigHome;
	});
	const projectRoots = [join(root, "project-1"), join(root, "project-2")];
	await Promise.all(projectRoots.map((directory) => mkdir(directory, { recursive: true })));
	const registry = new ProjectRegistry(join(root, "agent"));
	await registry.load();
	await registry.add({ id: "project-1", name: "项目 1", cwd: projectRoots[0] });
	await registry.add({ id: "project-2", name: "项目 2", cwd: projectRoots[1] });
	const sessions: SessionSummary[] = ["session-1", "session-2", "session-3"].map((id, index) => ({
		path: join(root, `${id}.jsonl`),
		id,
		cwd: projectRoots[1],
		createdAt: index,
		updatedAt: index,
		messageCount: 0,
		firstMessage: id,
		activity: "idle",
		writeAccess: "available",
	}));
	await registry.setRecentSessions("project-2", sessions);
	await registry.setSessionOrder("project-2", ["session-3", "session-1", "session-2"]);
	await registry.reorderProjects(["project-1", "project-2"]);

	assert.deepEqual(
		registry.list().map((project) => project.id),
		["project-1", "project-2"],
	);
	assert.deepEqual(registry.get("project-2")?.sessionOrder, ["session-3", "session-1", "session-2"]);

	const restored = new ProjectRegistry(join(root, "agent"));
	await restored.load();
	assert.deepEqual(
		restored.list().map((project) => project.id),
		["project-1", "project-2"],
	);
	assert.deepEqual(restored.get("project-2")?.sessionOrder, ["session-3", "session-1", "session-2"]);
});
test("ProjectRegistry 加载已有的最近会话缓存", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "lystar-project-registry-cache-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const projectRoot = join(root, "project");
	await mkdir(join(root, "agent", "web"), { recursive: true });
	await mkdir(projectRoot, { recursive: true });
	await writeFile(
		join(root, "agent", "web", "projects.json"),
		JSON.stringify({
			version: 1,
			projects: [
				{
					id: "project",
					name: "测试项目",
					cwd: projectRoot,
					recentSessions: [
						{
							path: join(root, "session.jsonl"),
							id: "session",
							cwd: projectRoot,
							createdAt: 1,
							updatedAt: 2,
							messageCount: 0,
							firstMessage: "测试会话",
							activity: "interrupted",
							writeAccess: "locked_externally",
						},
					],
				},
			],
		}),
	);

	const registry = new ProjectRegistry(join(root, "agent"));
	await registry.load();
	assert.equal(registry.list()[0]?.recentSessions?.[0]?.id, "session");
});
