import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";
import type { RuntimeSession } from "../src/types.ts";

it("资源重载在原会话更新 AGENTS.md 和 Skill，不创建新会话或调用模型", async () => {
	const root = mkdtempSync(join(tmpdir(), "web-resource-reload-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const oldSkill = join(cwd, ".pi", "skills", "reload-old");
	const newSkill = join(cwd, ".pi", "skills", "reload-new");
	const probe = join(root, "probe.ts");
	const captured = join(root, "system-prompt.txt");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(oldSkill, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProjectTrust: "always", extensions: [probe] }),
	);
	writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_INSTRUCTION_BEFORE_RELOAD");
	writeFileSync(join(agentDir, "AGENTS.md"), "GLOBAL_INSTRUCTION_BEFORE_RELOAD");
	writeFileSync(
		join(oldSkill, "SKILL.md"),
		"---\nname: reload-old\ndescription: OLD_SKILL_DESCRIPTION\n---\n旧技能\n",
	);
	writeFileSync(
		probe,
		`import { writeFileSync } from "node:fs";
export default function(pi) {
	pi.registerCommand("reload-probe", {
		description: "读取当前系统提示供测试断言",
		handler: async (_args, ctx) => { writeFileSync(${JSON.stringify(captured)}, ctx.getSystemPrompt()); }
	});
}`,
	);
	let runtime: RuntimeSession | undefined;
	try {
		runtime = await new CodingAgentRuntimeAdapter(agentDir).createSession(cwd, async () => ({ cancelled: true }));
		const originalSessionPath = runtime.sessionPath;
		await runtime.prompt("/reload-probe");
		expect(readFileSync(captured, "utf8")).toContain("PROJECT_INSTRUCTION_BEFORE_RELOAD");
		expect(readFileSync(captured, "utf8")).toContain("GLOBAL_INSTRUCTION_BEFORE_RELOAD");
		expect((await runtime.getCompletions("/skill:", 7))?.items.map((item) => item.label)).toContain(
			"skill:reload-old",
		);

		writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_INSTRUCTION_AFTER_RELOAD");
		writeFileSync(join(agentDir, "AGENTS.md"), "GLOBAL_INSTRUCTION_AFTER_RELOAD");
		rmSync(oldSkill, { recursive: true });
		mkdirSync(newSkill, { recursive: true });
		writeFileSync(
			join(newSkill, "SKILL.md"),
			"---\nname: reload-new\ndescription: NEW_SKILL_DESCRIPTION\n---\n新技能\n",
		);
		await runtime.reloadResources();
		await runtime.prompt("/reload-probe");
		const prompt = readFileSync(captured, "utf8");
		expect(prompt).toContain("PROJECT_INSTRUCTION_AFTER_RELOAD");
		expect(prompt).toContain("GLOBAL_INSTRUCTION_AFTER_RELOAD");
		expect(prompt).toContain("NEW_SKILL_DESCRIPTION");
		expect(prompt).not.toContain("PROJECT_INSTRUCTION_BEFORE_RELOAD");
		expect(prompt).not.toContain("GLOBAL_INSTRUCTION_BEFORE_RELOAD");
		expect(prompt).not.toContain("OLD_SKILL_DESCRIPTION");
		const labels = (await runtime.getCompletions("/skill:", 7))?.items.map((item) => item.label);
		expect(labels).toContain("skill:reload-new");
		expect(labels).not.toContain("skill:reload-old");
		expect(runtime.sessionPath).toBe(originalSessionPath);
	} finally {
		await runtime?.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
