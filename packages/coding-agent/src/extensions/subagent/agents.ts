/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import {
	formatSubagentModelReference,
	parseSubagentMarkdown,
	parseSubagentModelReference,
	type SubagentThinkingLevel,
} from "../../core/subagent-config.ts";

export type AgentScope = "user" | "project" | "both";
export type AgentDefinitionScope = "builtin" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "builtin" | "user" | "project";
	filePath: string;
}

export interface AgentDefinition {
	name: string;
	description: string;
	provider?: string;
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	tools?: string[];
	content: string;
	scope: AgentDefinitionScope;
	editable: boolean;
	filePath: string;
	rawContent?: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export const BUILTIN_AGENTS: AgentConfig[] = [
	{
		name: "research-specialist",
		description: "只读调查代码、配置和文档，向主代理返回简洁证据",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt: `你是只读研究子代理。严格按任务范围调查代码、配置和文档，不修改文件。先定位入口和调用关系，再读取关键实现；结论必须给出准确路径和证据，无法确认时说明缺口。最终返回简洁、可供主代理继续工作的结果。`,
		source: "builtin",
		filePath: "<builtin:research-specialist>",
	},
	{
		name: "review-specialist",
		description: "只读审查正确性、回归、安全风险和验证缺口",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt: `你是只读审查子代理。独立检查任务范围内的正确性、行为回归、安全风险和验证缺口，不修改文件。问题按严重程度排序，每条写清路径、触发条件和影响；没有发现问题时明确说明剩余验证边界。`,
		source: "builtin",
		filePath: "<builtin:review-specialist>",
	},
	{
		name: "worker",
		description: "在明确文件范围内完成一个实现单元并运行必要验证",
		systemPrompt: `你是实现子代理。只完成任务卡分配的单个工作单元，在指定文件范围内实现和验证。保留其他人的改动，不派发其他代理，不执行破坏性 Git 操作。优先复用现有能力，修正责任位置上的根因，最终只报告实际改动、验证结果和未完成事项。`,
		source: "builtin",
		filePath: "<builtin:worker>",
	},
];

function loadAgentDefinitionsFromDir(dir: string, scope: "user" | "project"): AgentDefinition[] {
	const agents: AgentDefinition[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let rawContent: string;
		try {
			rawContent = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const parsed = parseSubagentMarkdown(rawContent, path.basename(entry.name, ".md"));
		if (!parsed) continue;
		agents.push({
			name: parsed.name,
			description: parsed.description,
			...(parsed.provider ? { provider: parsed.provider } : {}),
			...(parsed.model ? { model: parsed.model } : {}),
			...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
			...(parsed.tools ? { tools: parsed.tools } : {}),
			content: parsed.content,
			scope,
			editable: true,
			filePath,
			rawContent,
		});
	}
	return agents;
}

function isDirectory(value: string): boolean {
	try {
		return fs.statSync(value).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function builtinDefinitions(): AgentDefinition[] {
	return BUILTIN_AGENTS.map((agent) => ({
		name: agent.name,
		description: agent.description,
		...parseBuiltinModel(agent.model),
		...(agent.tools ? { tools: agent.tools } : {}),
		content: agent.systemPrompt,
		scope: "builtin",
		editable: false,
		filePath: agent.filePath,
	}));
}

function parseBuiltinModel(reference: string | undefined): {
	provider?: string;
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
} {
	if (!reference) return {};
	const parsed = parseSubagentModelReference(reference);
	return {
		...(parsed.provider ? { provider: parsed.provider } : {}),
		...(parsed.model ? { model: parsed.model } : {}),
		...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
	};
}

export function discoverAgentDefinitions(
	cwd: string,
	agentDir = getAgentDir(),
): {
	definitions: AgentDefinition[];
	projectAgentsDir: string | null;
} {
	const userDir = path.join(agentDir, "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	return {
		definitions: [
			...builtinDefinitions(),
			...loadAgentDefinitionsFromDir(userDir, "user"),
			...(projectAgentsDir ? loadAgentDefinitionsFromDir(projectAgentsDir, "project") : []),
		],
		projectAgentsDir,
	};
}

function toAgentConfig(definition: AgentDefinition): AgentConfig {
	return {
		name: definition.name,
		description: definition.description,
		...(definition.tools ? { tools: definition.tools } : {}),
		...(definition.model
			? {
					model: formatSubagentModelReference({
						provider: definition.provider,
						model: definition.model,
						thinkingLevel: definition.thinkingLevel,
					}),
				}
			: {}),
		systemPrompt: definition.content,
		source: definition.scope,
		filePath: definition.filePath,
	};
}

export function discoverAgents(cwd: string, scope: AgentScope, agentDir = getAgentDir()): AgentDiscoveryResult {
	const { definitions, projectAgentsDir } = discoverAgentDefinitions(cwd, agentDir);
	const agentMap = new Map<string, AgentConfig>();
	for (const definition of definitions.filter((candidate) => candidate.scope === "builtin")) {
		agentMap.set(definition.name, toAgentConfig(definition));
	}
	if (scope === "both" || scope === "user") {
		for (const definition of definitions.filter((candidate) => candidate.scope === "user")) {
			agentMap.set(definition.name, toAgentConfig(definition));
		}
	}
	if (scope === "both" || scope === "project") {
		for (const definition of definitions.filter((candidate) => candidate.scope === "project")) {
			agentMap.set(definition.name, toAgentConfig(definition));
		}
	}
	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; "),
		remaining,
	};
}
