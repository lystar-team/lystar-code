import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
