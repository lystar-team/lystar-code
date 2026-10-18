import { ProjectGroupRegistry } from "../../src/project-group-registry.ts";
import { ProjectRegistry } from "../../src/project-registry.ts";
import { WorkspaceDatabase } from "../../src/workspace-database.ts";

const [root, prefix, groupName] = process.argv.slice(2);
if (!root || !prefix || !groupName) throw new Error("缺少并发写入测试参数");
const store = new WorkspaceDatabase(root);
try {
	const projects = new ProjectRegistry(root, store);
	const groups = new ProjectGroupRegistry(root, store);
	await projects.load();
	const group = await groups.create(groupName);
	for (let index = 0; index < 12; index++) {
		const id = `${prefix}-${index}`;
		await projects.add({ id, cwd: `${root}/${id}` });
		await groups.assignProject(id, group.id);
	}
} finally {
	await store.close();
}
