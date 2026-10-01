import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findSessionProfile } from "../../coding-agent/src/core/session-profile.ts";
import { createAgentCreationTool } from "../src/agent-creation-tool.ts";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(approved = true) {
	const root = mkdtempSync(join(tmpdir(), "lystar-create-agent-tool-"));
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const adapter = new CodingAgentRuntimeAdapter(agentDir);
	const save = vi.fn((input: Parameters<CodingAgentRuntimeAdapter["saveSubagentConfig"]>[1]) =>
		adapter.saveSubagentConfig(cwd, input, async () => ({ cancelled: true })),
	);
	const tool = createAgentCreationTool({
		cwd,
		agentDir,
		save,
		listSkills: async () => [],
		listTools: () => [
			{ name: "read", description: "读取文件" },
			{ name: "bash", description: "运行命令" },
		],
	});
	const confirm = vi.fn(async () => approved);
	const execute = (params: Parameters<typeof tool.execute>[1]) =>
		tool.execute("test-call", params, undefined, undefined, { ui: { confirm } } as unknown as Parameters<
			typeof tool.execute
		>[4]);
	return { cwd, agentDir, adapter, save, confirm, execute };
}

const input = {
	action: "create" as const,
	scope: "user" as const,
	name: "页面审查",
	description: "检查页面",
	content: "读取页面并检查。",
	icon: "code",
	tools: ["read"],
	excludeTools: ["bash"],
	tags: ["页面", "审查"],
};

describe("create_agent", () => {
	it("creates a directory role in the same registry used by Web and session execution", async () => {
		const { cwd, agentDir, adapter, execute, confirm } = fixture();
		await execute({ action: "suggest", goal: "检查页面" });
		const result = await execute(input);
		const text = result.content.find((item) => item.type === "text");
		expect(text?.type).toBe("text");
		if (text?.type !== "text") throw new Error("Missing tool result");
		const saved = JSON.parse(text.text) as { id: string; name: string; path: string; contentHash: string };
		expect(saved).toMatchObject({ name: "页面审查", id: expect.any(String), contentHash: expect.any(String) });
		expect(saved.path).toBe(join(agentDir, "agents", saved.id));
		expect(confirm).toHaveBeenCalledOnce();
		expect((await adapter.listSubagentConfigs(cwd))[0]).toMatchObject({
			id: saved.id,
			name: "页面审查",
			icon: "code",
			tools: ["read"],
			excludeTools: ["bash"],
			tags: ["页面", "审查"],
		});
		expect(findSessionProfile(cwd, saved.id, agentDir)?.systemPrompt).toBe(input.content);
	});

	it("does not save when confirmation is cancelled", async () => {
		const { execute, save } = fixture(false);
		await execute({ action: "suggest", goal: "检查页面" });
		const result = await execute(input);
		expect(result.content).toEqual([{ type: "text", text: "已取消创建智能体" }]);
		expect(save).not.toHaveBeenCalled();
	});

	it("requires the current catalog and validates excluded tools before saving", async () => {
		const { execute, save, confirm } = fixture();
		await expect(execute(input)).rejects.toThrow("请先查看当前可用");
		await execute({ action: "suggest", goal: "检查页面" });
		await expect(execute({ ...input, excludeTools: ["missing"] })).rejects.toThrow("工具不可用");
		expect(save).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
	});
});
