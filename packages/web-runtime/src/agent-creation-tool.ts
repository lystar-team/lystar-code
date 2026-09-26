import { join } from "node:path";
import { CONFIG_DIR_NAME, defineTool } from "@earendil-works/pi-coding-agent/core";
import type { SubagentConfig, ThinkingLevel } from "@lystar/code-web-protocol";
import { Type } from "typebox";
import type { SkillSummary } from "./types.ts";

const Name = Type.String({ minLength: 1, maxLength: 128 });
const Selection = Type.Array(Name, { minItems: 1, maxItems: 128 });
const AgentCreationParams = Type.Union([
	Type.Object({
		action: Type.Literal("suggest"),
		goal: Type.String({ minLength: 1, maxLength: 4096, description: "智能体的职责或使用场景" }),
	}),
	Type.Object({
		action: Type.Literal("create"),
		scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
		name: Name,
		description: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
		content: Type.String({ minLength: 1, maxLength: 4 * 1024 * 1024, description: "智能体提示词" }),
		tools: Type.Optional(Selection),
		skills: Type.Optional(Selection),
		provider: Type.Optional(Name),
		model: Type.Optional(Name),
		thinkingLevel: Type.Optional(
			Type.Union([
				Type.Literal("off"),
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
				Type.Literal("max"),
				Type.Literal("ultra"),
			]),
		),
	}),
]);

type CreateInput = {
	scope: "user" | "project";
	name: string;
	description: string;
	content: string;
	tools?: string[];
	skills?: string[];
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
};

export function createAgentCreationTool(options: {
	cwd: string;
	agentDir: string;
	listSkills: () => Promise<SkillSummary[]>;
	listTools: () => Array<{ name: string; description: string }>;
	save: (input: CreateInput) => Promise<SubagentConfig[]>;
}) {
	let catalogViewed = false;
	return defineTool({
		name: "create_agent",
		label: "创建智能体",
		description:
			"为 LYStar Code Web 创建个人或项目智能体。先用 suggest 查看已有 Skill 和 Tool，结合职责向用户说明推荐理由；用户选定后用 create 写入配置。不创建 Skill 或 Tool 定义。",
		promptSnippet: "查看可用 Skill 和 Tool，向用户推荐组合并创建智能体",
		promptGuidelines: [
			"创建智能体前调用 create_agent 的 suggest，依据返回的 Skill 和 Tool 清单向用户推荐相关项并说明理由；用户选择后调用 create。",
			"未选择 Skill 或 Tool 时，配置沿用现有默认能力；不要把空数组解释成禁止使用。",
		],
		parameters: AgentCreationParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.action === "suggest") {
				const skills = (await options.listSkills())
					.filter((skill) => skill.enabled && skill.eligible)
					.map(({ name, description }) => ({ name, description }));
				const tools = options.listTools();
				catalogViewed = true;
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								goal: params.goal,
								skills,
								tools,
								instruction:
									"根据职责向用户推荐现有 Skill 和 Tool，说明理由，询问范围、名称和提示词；用户选择后调用 create。",
							}),
						},
					],
					details: null,
				};
			}
			if (!catalogViewed) throw new Error("请先查看当前可用的 Skill 和 Tool，再向用户推荐配置");
			const skills = (await options.listSkills()).filter((skill) => skill.enabled && skill.eligible);
			const toolNames = new Set(options.listTools().map((tool) => tool.name));
			const skillNames = new Set(skills.map((skill) => skill.name));
			const unknownTools = params.tools?.filter((name) => !toolNames.has(name)) ?? [];
			const unknownSkills = params.skills?.filter((name) => !skillNames.has(name)) ?? [];
			if (unknownTools.length) throw new Error(`工具不可用：${unknownTools.join("、")}`);
			if (unknownSkills.length) throw new Error(`Skill 不可用：${unknownSkills.join("、")}`);
			if (!params.description.trim() || !params.content.trim()) throw new Error("智能体描述和提示词不能为空");
			if (params.provider && !params.model) throw new Error("选择供应商后必须选择模型");
			const approved = await ctx.ui.confirm(
				"创建智能体？",
				`${params.name.trim()} · ${params.scope === "user" ? "个人" : "项目"}\nSkill：${params.skills?.join("、") ?? "沿用现有配置"}\n工具：${params.tools?.join("、") ?? "沿用现有配置"}\n确认后写入智能体配置文件。`,
				{ signal },
			);
			if (!approved) return { content: [{ type: "text", text: "已取消创建智能体" }], details: null };
			const configs = await options.save({
				scope: params.scope,
				name: params.name,
				description: params.description,
				content: params.content,
				...(params.tools ? { tools: [...new Set(params.tools)] } : {}),
				...(params.skills ? { skills: [...new Set(params.skills)] } : {}),
				...(params.provider ? { provider: params.provider } : {}),
				...(params.model ? { model: params.model } : {}),
				...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
			});
			const saved = configs.find((config) => config.name === params.name.trim() && config.scope === params.scope);
			if (!saved) throw new Error("智能体文件已写入，但配置列表中未找到该智能体");
			catalogViewed = false;
			const path = join(
				params.scope === "user" ? options.agentDir : join(options.cwd, CONFIG_DIR_NAME),
				"agents",
				`${saved.name}.md`,
			);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							name: saved.name,
							scope: saved.scope,
							path,
							skills: saved.skills ?? [],
							tools: saved.tools ?? [],
							contentHash: saved.contentHash,
						}),
					},
				],
				details: null,
			};
		},
	});
}
