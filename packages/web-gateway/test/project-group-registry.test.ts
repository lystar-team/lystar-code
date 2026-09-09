import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectGroupRegistry } from "../src/project-group-registry.ts";

test("ProjectGroupRegistry 持久化项目组和项目归属", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "lystar-project-groups-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const registry = new ProjectGroupRegistry(join(root, "agent"));
	await registry.load();
	const group = await registry.create("工作项目");
	await registry.assignProject("project-1", group.id);
	assert.deepEqual(registry.list(), [{ id: group.id, name: "工作项目", projectIds: ["project-1"] }]);

	await registry.update(group.id, "重要项目");
	await registry.assignProject("project-1");
	const removableGroup = await registry.create("可删除项目组");
	await registry.assignProject("project-2", removableGroup.id);
	await registry.remove(removableGroup.id);
	assert.deepEqual(registry.list(), [{ id: group.id, name: "重要项目", projectIds: [] }]);

	const restored = new ProjectGroupRegistry(join(root, "agent"));
	await restored.load();
	assert.deepEqual(restored.list(), registry.list());
	assert.equal((await stat(restored.path)).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(await readFile(restored.path, "utf8")), {
		version: 1,
		groups: [{ id: group.id, name: "重要项目", projectIds: [] }],
	});
});

test("ProjectGroupRegistry 串行保存并保留并发创建的全部项目组", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "lystar-project-groups-concurrent-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new ProjectGroupRegistry(join(root, "agent"));
	await registry.load();

	await Promise.all(Array.from({ length: 24 }, (_, index) => registry.create(`项目组 ${index}`)));
	assert.equal(registry.list().length, 24);
	const saved = JSON.parse(await readFile(registry.path, "utf8")) as { groups?: unknown[] };
	assert.equal(saved.groups?.length, 24);
});
