import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSessionProfiles, findSessionProfile } from "../../coding-agent/src/core/session-profile.ts";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";

const ui = async () => ({ cancelled: true });

describe("subagent config adapter", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	function fixture() {
		const root = mkdtempSync(join(tmpdir(), "lystar-role-crud-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "AGENTS.md"), "公共规则\n");
		return { cwd, agentDir, adapter: new CodingAgentRuntimeAdapter(agentDir) };
	}

	it("creates Chinese directory roles, renames without changing id, and deletes only the role", async () => {
		const { cwd, agentDir, adapter } = fixture();
		let configs = await adapter.saveSubagentConfig(
			cwd,
			{
				scope: "user",
				name: "前端开发",
				description: "实现页面",
				icon: "code",
				provider: "custom",
				model: "review-model",
				thinkingLevel: "high",
				tools: ["read", "edit"],
				skills: ["review", "codegraph"],
				tags: ["页面", "回归"],
				content: "只处理指定页面。",
			},
			ui,
		);
		const saved = configs[0]!;
		expect(saved).toMatchObject({ scope: "user", name: "前端开发", editable: true });
		expect(saved.id).toBeTruthy();
		expect(saved.fileName).toBe(`${saved.id}/profile.json`);
		const roleDir = join(agentDir, "agents", saved.id);
		expect(JSON.parse(readFileSync(join(roleDir, "profile.json"), "utf8"))).toMatchObject({
			name: "前端开发",
			icon: "code",
			provider: "custom",
			model: "review-model",
			thinkingLevel: "high",
			tools: ["read", "edit"],
			skills: ["review", "codegraph"],
			tags: ["页面", "回归"],
		});
		expect(readFileSync(join(roleDir, "PROMPT.md"), "utf8")).toBe("只处理指定页面。\n");
		expect(readFileSync(join(roleDir, "AGENTS.md"), "utf8")).toBe("公共规则\n");
		expect(findSessionProfile(cwd, saved.id, agentDir)).toMatchObject({
			name: "前端开发",
			model: "custom/review-model",
			thinkingLevel: "high",
			systemPrompt: "只处理指定页面。",
			skillNames: ["review", "codegraph"],
			agentsInstructions: "公共规则",
		});

		configs = await adapter.saveSubagentConfig(
			cwd,
			{
				scope: "user",
				id: saved.id,
				name: "页面审查",
				description: "审查页面",
				excludeTools: ["bash", "write"],
				content: "读取页面并检查。",
				expectedHash: saved.contentHash,
			},
			ui,
		);
		const renamed = configs[0]!;
		expect(renamed.id).toBe(saved.id);
		expect(renamed.name).toBe("页面审查");
		expect(renamed.contentHash).not.toBe(saved.contentHash);
		expect(findSessionProfile(cwd, saved.id, agentDir)).toMatchObject({
			systemPrompt: "读取页面并检查。",
			excludeTools: ["bash", "write"],
		});
		await expect(
			adapter.saveSubagentConfig(
				cwd,
				{
					scope: "user",
					id: saved.id,
					name: "页面审查",
					description: "旧版本",
					content: "不能保存",
					expectedHash: saved.contentHash,
				},
				ui,
			),
		).rejects.toMatchObject({ code: "subagent_conflict" });
		await expect(
			adapter.deleteSubagentConfig(
				cwd,
				{
					scope: "user",
					id: saved.id,
					expectedHash: saved.contentHash!,
				},
				ui,
			),
		).rejects.toMatchObject({ code: "subagent_conflict" });
		configs = await adapter.deleteSubagentConfig(
			cwd,
			{
				scope: "user",
				id: renamed.id,
				expectedHash: renamed.contentHash!,
			},
			ui,
		);
		expect(configs).toEqual([]);
		expect(discoverSessionProfiles(cwd, agentDir)).toEqual([]);
		expect(existsSync(roleDir)).toBe(false);
		expect(readFileSync(join(agentDir, "AGENTS.md"), "utf8")).toBe("公共规则\n");
	});

	it("registers create_agent and preserves disabled tools in directory profiles", async () => {
		const { cwd, agentDir, adapter } = fixture();
		const options = await adapter.listSubagentTools(cwd);
		expect(options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "read", description: expect.any(String) }),
				expect.objectContaining({ name: "session_create", description: expect.any(String) }),
				expect.objectContaining({ name: "room_task_update", description: expect.any(String) }),
				expect.objectContaining({ name: "image_gen", description: expect.any(String) }),
				expect.objectContaining({ name: "create_agent", description: expect.any(String) }),
			]),
		);
		const [saved] = await adapter.saveSubagentConfig(
			cwd,
			{
				scope: "user",
				name: "审查",
				description: "读取文件",
				excludeTools: ["bash", "write"],
				content: "检查页面。",
			},
			ui,
		);
		expect(saved).toMatchObject({ excludeTools: ["bash", "write"] });
		expect(findSessionProfile(cwd, saved!.id, agentDir)?.excludeTools).toEqual(["bash", "write"]);
	});

	it("protects same-scope display names and never recreates externally deleted ids", async () => {
		const { cwd, agentDir, adapter } = fixture();
		const input = { scope: "user" as const, name: "审查", description: "检查页面", content: "读取页面。" };
		const [saved] = await adapter.saveSubagentConfig(cwd, input, ui);
		await expect(adapter.saveSubagentConfig(cwd, input, ui)).rejects.toMatchObject({
			code: "subagent_name_conflict",
		});
		await expect(adapter.saveSubagentConfig(cwd, { ...input, id: saved!.id }, ui)).rejects.toMatchObject({
			code: "subagent_conflict",
		});
		rmSync(join(agentDir, "agents", saved!.id), { recursive: true });
		await expect(
			adapter.saveSubagentConfig(
				cwd,
				{
					...input,
					id: saved!.id,
					expectedHash: saved!.contentHash,
				},
				ui,
			),
		).rejects.toMatchObject({ code: "subagent_conflict" });
	});

	it("hashes both JSON and PROMPT but does not edit shared AGENTS instructions", async () => {
		const { cwd, agentDir, adapter } = fixture();
		const input = { scope: "user" as const, name: "审查", description: "检查页面", content: "读取页面。" };
		const [saved] = await adapter.saveSubagentConfig(cwd, input, ui);
		const promptPath = join(agentDir, "agents", saved!.id, "PROMPT.md");
		writeFileSync(promptPath, "外部修改\n");
		await expect(
			adapter.saveSubagentConfig(
				cwd,
				{
					...input,
					id: saved!.id,
					expectedHash: saved!.contentHash,
				},
				ui,
			),
		).rejects.toMatchObject({ code: "subagent_conflict" });
		const [reloaded] = await adapter.listSubagentConfigs(cwd);
		writeFileSync(join(agentDir, "AGENTS.md"), "更新公共规则\n");
		await adapter.saveSubagentConfig(cwd, { ...input, id: saved!.id, expectedHash: reloaded!.contentHash }, ui);
		expect(readFileSync(join(agentDir, "AGENTS.md"), "utf8")).toBe("更新公共规则\n");
		expect(findSessionProfile(cwd, saved!.id, agentDir)?.agentsInstructions).toBe("更新公共规则");
	});

	it("edits existing imported Markdown as a directory with the same id", async () => {
		const { cwd, agentDir, adapter } = fixture();
		const directory = join(agentDir, "agents");
		mkdirSync(directory);
		const oldPath = join(directory, "reviewer.md");
		writeFileSync(oldPath, "---\nname: 审查\ndescription: 检查页面\n---\n旧提示词\n");
		const [old] = await adapter.listSubagentConfigs(cwd);
		const [saved] = await adapter.saveSubagentConfig(
			cwd,
			{
				scope: "user",
				id: old!.id,
				name: "审查",
				description: "检查页面",
				content: "新提示词",
				expectedHash: old!.contentHash,
			},
			ui,
		);
		expect(saved?.id).toBe("reviewer");
		expect(saved?.fileName).toBe("reviewer/profile.json");
		expect(existsSync(oldPath)).toBe(false);
		expect(findSessionProfile(cwd, "reviewer", agentDir)?.systemPrompt).toBe("新提示词");
	});
});
